/**
 * Vercel Edge Function — Semantic Search API
 *
 * POST /api/search
 * Body: { "query": "...", "limit": 10 }
 *
 * Returns: { "results": [ { id, title, author, abstract, keywords,
 *                           created, url, similarity, matchedText } ] }
 *
 * Deploy: push to a Vercel project connected to this repo.
 * Set env vars OPENAI_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY
 * in the Vercel dashboard (Project → Settings → Environment Variables).
 */

import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";

export const config = { runtime: "edge" };

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export default async function handler(req) {
  // Preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS });
  }

  if (req.method !== "POST") {
    return Response.json({ error: "POST required" }, { status: 405, headers: CORS });
  }

  let query, limit;
  try {
    ({ query, limit = 10 } = await req.json());
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400, headers: CORS });
  }

  if (!query?.trim()) {
    return Response.json({ error: "query is required" }, { status: 400, headers: CORS });
  }

  const openai   = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
  );

  try {
    // 1. Embed the query
    const embResp = await openai.embeddings.create({
      model: "text-embedding-3-small",
      input: query.trim(),
    });
    const queryEmbedding = embResp.data[0].embedding;

    // 2. Vector similarity search — fetch more than needed to allow deduplication
    const { data, error } = await supabase.rpc("match_exposition_chunks", {
      query_embedding:  queryEmbedding,
      match_count:      limit * 4,
      match_threshold:  0.3,
    });

    if (error) throw new Error(error.message);

    // 3. Deduplicate: keep only the best-scoring chunk per exposition
    const best = new Map();
    for (const row of data ?? []) {
      const prev = best.get(row.exposition_id);
      if (!prev || row.similarity > prev.similarity) {
        best.set(row.exposition_id, row);
      }
    }

    // 4. Sort and shape the response
    const results = [...best.values()]
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, limit)
      .map((row) => ({
        id:          row.exposition_id,
        title:       row.title,
        author:      row.author,
        abstract:    row.abstract,
        keywords:    row.keywords ?? [],
        created:     row.created_at,
        url:         row.url,
        similarity:  Math.round(row.similarity * 1000) / 1000,
        matchedText: row.text,
      }));

    return Response.json({ results }, { headers: CORS });

  } catch (err) {
    console.error("Search error:", err);
    return Response.json(
      { error: err.message ?? "Internal error" },
      { status: 500, headers: CORS }
    );
  }
}
