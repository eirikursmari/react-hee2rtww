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
    return Response.json({ status: "RC Semantic Search — POST {query, limit}" }, { headers: CORS });
  }
  if (req.method !== "POST") {
    return Response.json({ error: "POST required" }, { status: 405, headers: CORS });
  }

  let query, limit;
  try {
    ({ query, limit = 10 } = await req.json());
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400, headers: CORS });
  }
  if (!query?.trim()) {
    return Response.json({ error: "query is required" }, { status: 400, headers: CORS });
  }

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

    // 2. Supabase vector search (service role key has full access)
    const sbRes = await fetch(
      Deno.env.get("SUPABASE_URL") + "/rest/v1/rpc/match_exposition_chunks",
      {
        method:  "POST",
        headers: {
          "Content-Type":  "application/json",
          "apikey":        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"),
          "Authorization": "Bearer " + Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"),
        },
        body: JSON.stringify({
          query_embedding: embedding,
          match_count:     limit * 4,
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
