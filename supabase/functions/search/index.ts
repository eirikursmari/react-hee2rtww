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
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS });
  }
  if (req.method === "GET") {
    return Response.json({ status: "RC Semantic Search — POST {query, limit, filters}" }, { headers: CORS });
  }
  if (req.method !== "POST") {
    return Response.json({ error: "POST required" }, { status: 405, headers: CORS });
  }

  let query, limit, filters;
  try {
    ({ query, limit = 10, filters = {} } = await req.json());
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400, headers: CORS });
  }
  if (!query?.trim()) {
    return Response.json({ error: "query is required" }, { status: 400, headers: CORS });
  }

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SUPABASE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const sbHeaders = {
    "Content-Type":  "application/json",
    "apikey":        SUPABASE_KEY,
    "Authorization": "Bearer " + SUPABASE_KEY,
  };

  const hasFilters = Object.values(filters).some(
    (arr) => Array.isArray(arr) && (arr as string[]).length > 0
  );

  try {
    // 1. Embed via OpenAI
    const embRes = await fetch("https://api.openai.com/v1/embeddings", {
      method:  "POST",
      headers: {
        "Content-Type":  "application/json",
        "Authorization": "Bearer " + Deno.env.get("OPENAI_API_KEY"),
      },
      body: JSON.stringify({ model: "text-embedding-3-small", input: query.trim() }),
    });
    if (!embRes.ok) {
      const e = await embRes.json().catch(() => ({}));
      throw new Error("OpenAI " + embRes.status + ": " + (e.error?.message ?? embRes.statusText));
    }
    const embedding = (await embRes.json()).data[0].embedding;

    // 2. Supabase vector search — fetch more candidates when filtering
    const matchCount = hasFilters ? limit * 20 : limit * 4;
    const sbRes = await fetch(
      SUPABASE_URL + "/rest/v1/rpc/match_exposition_chunks",
      {
        method:  "POST",
        headers: sbHeaders,
        body: JSON.stringify({
          query_embedding: embedding,
          match_count:     matchCount,
          match_threshold: 0.1,
        }),
      }
    );
    if (!sbRes.ok) {
      const e = await sbRes.json().catch(() => ({}));
      throw new Error("Supabase " + sbRes.status + ": " + (e.message ?? sbRes.statusText));
    }
    const rows = await sbRes.json();

    // 3. Deduplicate — best chunk per exposition
    const best = new Map();
    for (const row of rows ?? []) {
      const prev = best.get(row.exposition_id);
      if (!prev || row.similarity > prev.similarity) best.set(row.exposition_id, row);
    }

    // 4. Apply category filters if present
    if (hasFilters && best.size > 0) {
      const ids = [...best.keys()].join(",");
      const metaRes = await fetch(
        SUPABASE_URL +
          "/rest/v1/expositions?select=id,research_approach,artistic_medium," +
          "methodological_framing,impact_types,geographic_context&id=in.(" + ids + ")",
        { headers: sbHeaders }
      );
      if (metaRes.ok) {
        const metaRows = await metaRes.json();
        const metaMap = new Map(metaRows.map((m: Record<string, unknown>) => [m.id, m]));
        for (const expoId of [...best.keys()]) {
          const m = (metaMap.get(expoId) ?? {}) as Record<string, string[]>;
          for (const [key, selected] of Object.entries(filters)) {
            if (!Array.isArray(selected) || selected.length === 0) continue;
            const expoVals: string[] = m[key] ?? [];
            if (!selected.some((v: string) => expoVals.includes(v))) {
              best.delete(expoId);
              break;
            }
          }
        }
      }
    }

    const results = [...best.values()]
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, limit)
      .map((r) => ({
        id:          r.exposition_id,
        title:       r.title,
        author:      r.author,
        abstract:    r.abstract,
        keywords:    r.keywords ?? [],
        created:     r.created_at,
        url:         r.url,
        similarity:  Math.round(r.similarity * 1000) / 1000,
        matchedText: r.text,
      }));

    return Response.json({ results }, { headers: CORS });

  } catch (err) {
    console.error(err);
    return Response.json({ error: err.message ?? "Internal error" }, { status: 500, headers: CORS });
  }
});
