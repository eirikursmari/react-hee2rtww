// Supabase Edge Function — Semantic Search
// Deno runtime: fetch is built-in, no package.json needed.
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected automatically.
// You must add OPENAI_API_KEY in: Supabase dashboard → Edge Functions → Secrets

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Max-Age":       "86400",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SUPABASE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const sbHeaders = {
    "Content-Type":  "application/json",
    "apikey":        SUPABASE_KEY,
    "Authorization": "Bearer " + SUPABASE_KEY,
  };

  if (req.method === "GET") {
    // Return live filter config from pipeline_config so the app can display
    // dynamically-generated filter dimensions without redeployment.
    try {
      const r = await fetch(
        SUPABASE_URL + "/rest/v1/pipeline_config?select=value&key=eq.filter_config",
        { headers: sbHeaders }
      );
      const rows = r.ok ? await r.json() : [];
      return Response.json(
        { status: "RC Semantic Search — POST {query, limit, filters, customCategories}", filterConfig: rows[0]?.value ?? null },
        { headers: CORS }
      );
    } catch {
      return Response.json({ status: "RC Semantic Search" }, { headers: CORS });
    }
  }

  if (req.method !== "POST") {
    return Response.json({ error: "POST required" }, { status: 405, headers: CORS });
  }

  let query: string, limit: number, filters: Record<string, string[]>,
      customCategories: { description: string }[];
  try {
    ({ query, limit = 10, filters = {}, customCategories = [] } = await req.json());
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400, headers: CORS });
  }
  if (!query?.trim()) {
    return Response.json({ error: "query is required" }, { status: 400, headers: CORS });
  }

  const hasFilters = Object.values(filters).some(
    (arr) => Array.isArray(arr) && arr.length > 0
  );
  const activeCustomCats = customCategories.filter((c) => c.description?.trim());
  const hasCustomCats    = activeCustomCats.length > 0;

  try {
    // 1. Embed query via OpenAI
    const embRes = await fetch("https://api.openai.com/v1/embeddings", {
      method:  "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + Deno.env.get("OPENAI_API_KEY") },
      body: JSON.stringify({ model: "text-embedding-3-small", input: query.trim() }),
    });
    if (!embRes.ok) {
      const e = await embRes.json().catch(() => ({}));
      throw new Error("OpenAI " + embRes.status + ": " + (e.error?.message ?? embRes.statusText));
    }
    const embedding = (await embRes.json()).data[0].embedding;

    // 2. Vector search — fetch more candidates when filtering
    const matchCount = (hasFilters || hasCustomCats) ? limit * 20 : limit * 4;
    const sbRes = await fetch(
      SUPABASE_URL + "/rest/v1/rpc/match_exposition_chunks",
      {
        method:  "POST",
        headers: sbHeaders,
        body: JSON.stringify({ query_embedding: embedding, match_count: matchCount, match_threshold: 0.1 }),
      }
    );
    if (!sbRes.ok) {
      const e = await sbRes.json().catch(() => ({}));
      throw new Error("Supabase " + sbRes.status + ": " + (e.message ?? sbRes.statusText));
    }
    const rows = await sbRes.json();

    // 3. Deduplicate — best chunk per exposition
    const best = new Map<number, any>();
    for (const row of rows ?? []) {
      const prev = best.get(row.exposition_id);
      if (!prev || row.similarity > prev.similarity) best.set(row.exposition_id, row);
    }

    // 4. Apply standard metadata filters (OR within category, AND between categories)
    if (hasFilters && best.size > 0) {
      const ids      = [...best.keys()].join(",");
      const metaRes  = await fetch(
        SUPABASE_URL + "/rest/v1/expositions?select=id,research_approach,artistic_medium," +
          "methodological_framing,impact_types,geographic_context,published_in,custom_metadata&id=in.(" + ids + ")",
        { headers: sbHeaders }
      );
      if (metaRes.ok) {
        const metaRows = await metaRes.json();
        const metaMap  = new Map(metaRows.map((m: any) => [m.id, m]));
        for (const expoId of [...best.keys()]) {
          const m = (metaMap.get(expoId) ?? {}) as Record<string, string[]>;
          for (const [key, selected] of Object.entries(filters)) {
            if (!Array.isArray(selected) || selected.length === 0) continue;
            // Check standard columns and custom_metadata
            const expoVals: string[] = m[key] ?? (m.custom_metadata as any)?.[key] ?? [];
            if (!selected.some((v) => expoVals.includes(v))) {
              best.delete(expoId);
              break;
            }
          }
        }
      }
    }

    // 5. Blend custom semantic category scores into query similarity.
    // Each active category contributes equally to half the final score;
    // the query keeps the other half. Missing category scores default to 0
    // so results always exist — adding categories re-ranks rather than filters.
    if (hasCustomCats && best.size > 0) {
      const catScoreMaps = await Promise.all(activeCustomCats.map(async (cat) => {
        const catEmbRes = await fetch("https://api.openai.com/v1/embeddings", {
          method:  "POST",
          headers: { "Content-Type": "application/json", "Authorization": "Bearer " + Deno.env.get("OPENAI_API_KEY") },
          body: JSON.stringify({ model: "text-embedding-3-small", input: cat.description.trim() }),
        });
        if (!catEmbRes.ok) return null;
        const catEmb = (await catEmbRes.json()).data[0].embedding;

        const catRes = await fetch(SUPABASE_URL + "/rest/v1/rpc/match_exposition_chunks", {
          method:  "POST",
          headers: sbHeaders,
          body: JSON.stringify({ query_embedding: catEmb, match_count: 2000, match_threshold: 0.1 }),
        });
        if (!catRes.ok) return null;

        const scoreMap = new Map<number, number>();
        for (const r of await catRes.json()) {
          const prev = scoreMap.get(r.exposition_id) ?? 0;
          if (r.similarity > prev) scoreMap.set(r.exposition_id, r.similarity);
        }
        return scoreMap;
      }));

      const validMaps = catScoreMaps.filter((m): m is Map<number, number> => m !== null);
      if (validMaps.length > 0) {
        const queryWeight = 0.5;
        const catWeight   = 0.5 / validMaps.length;
        for (const [expoId, row] of best.entries()) {
          const catScore = validMaps.reduce((sum, map) => sum + (map.get(expoId) ?? 0), 0);
          row.blendedScore = queryWeight * row.similarity + catWeight * catScore;
        }
      }
    }

    const results = [...best.values()]
      .sort((a, b) => (b.blendedScore ?? b.similarity) - (a.blendedScore ?? a.similarity))
      .slice(0, limit)
      .map((r) => ({
        id:          r.exposition_id,
        title:       r.title,
        author:      r.author,
        abstract:    r.abstract,
        keywords:    r.keywords ?? [],
        created:     r.created_at,
        url:         r.url,
        similarity:  Math.round((r.blendedScore ?? r.similarity) * 1000) / 1000,
        matchedText: r.text,
      }));

    return Response.json({ results }, { headers: CORS });

  } catch (err) {
    console.error(err);
    return Response.json({ error: err.message ?? "Internal error" }, { status: 500, headers: CORS });
  }
});
