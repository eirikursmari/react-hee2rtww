/**
 * Vercel Serverless Function — Semantic Search API
 * CommonJS module (no "type":"module" in package.json, so .js = CJS)
 *
 * POST /api/search   Body: { "query": "...", "limit": 10 }
 * Env:  OPENAI_API_KEY  SUPABASE_URL  SUPABASE_SERVICE_KEY
 */

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin",  "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Max-Age",       "86400");

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method === "GET")     return res.json({ status: "RC Semantic Search API — POST {query, limit} to search" });
  if (req.method !== "POST")   return res.status(405).json({ error: "POST required" });

  const body  = req.body ?? {};
  const query = body.query;
  const limit = body.limit ?? 10;

  if (!query || !String(query).trim()) {
    return res.status(400).json({ error: "query is required" });
  }

  try {
    // 1. Embed via OpenAI REST
    const embRes = await fetch("https://api.openai.com/v1/embeddings", {
      method:  "POST",
      headers: {
        "Content-Type":  "application/json",
        "Authorization": "Bearer " + process.env.OPENAI_API_KEY,
      },
      body: JSON.stringify({ model: "text-embedding-3-small", input: String(query).trim() }),
    });
    if (!embRes.ok) {
      const e = await embRes.json().catch(() => ({}));
      throw new Error("OpenAI " + embRes.status + ": " + (e.error && e.error.message ? e.error.message : embRes.statusText));
    }
    const embJson   = await embRes.json();
    const embedding = embJson.data[0].embedding;

    // 2. Vector search via Supabase REST
    const sbRes = await fetch(
      process.env.SUPABASE_URL + "/rest/v1/rpc/match_exposition_chunks",
      {
        method:  "POST",
        headers: {
          "Content-Type":  "application/json",
          "apikey":        process.env.SUPABASE_SERVICE_KEY,
          "Authorization": "Bearer " + process.env.SUPABASE_SERVICE_KEY,
        },
        body: JSON.stringify({
          query_embedding: embedding,
          match_count:     limit * 4,
          match_threshold: 0.3,
        }),
      }
    );
    if (!sbRes.ok) {
      const e = await sbRes.json().catch(() => ({}));
      throw new Error("Supabase " + sbRes.status + ": " + (e.message || sbRes.statusText));
    }
    const rows = await sbRes.json();

    // 3. Deduplicate — best chunk per exposition
    const best = new Map();
    for (const row of rows || []) {
      const prev = best.get(row.exposition_id);
      if (!prev || row.similarity > prev.similarity) best.set(row.exposition_id, row);
    }

    // 4. Sort, slice, shape
    const results = Array.from(best.values())
      .sort(function(a, b) { return b.similarity - a.similarity; })
      .slice(0, limit)
      .map(function(row) {
        return {
          id:          row.exposition_id,
          title:       row.title,
          author:      row.author,
          abstract:    row.abstract,
          keywords:    row.keywords || [],
          created:     row.created_at,
          url:         row.url,
          similarity:  Math.round(row.similarity * 1000) / 1000,
          matchedText: row.text,
        };
      });

    return res.json({ results: results });

  } catch (err) {
    console.error("Search error:", err);
    return res.status(500).json({ error: err.message || "Internal error" });
  }
};
