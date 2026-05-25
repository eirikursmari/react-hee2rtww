/**
 * Vercel Serverless Function — Semantic Search API
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

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export default async function handler(req, res) {
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method === "GET") return res.json({ status: "RC Semantic Search API — POST {query, limit} to search" });
  if (req.method !== "POST") return res.status(405).json({ error: "POST required" });

  const { query, limit = 10 } = req.body ?? {};
  if (!query?.trim()) return res.status(400).json({ error: "query is required" });

  const openai   = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
  );

  try {
    const embResp = await openai.embeddings.create({
      model: "text-embedding-3-small",
      input: query.trim(),
    });
    const queryEmbedding = embResp.data[0].embedding;

    const { data, error } = await supabase.rpc("match_exposition_chunks", {
      query_embedding:  queryEmbedding,
      match_count:      limit * 4,
      match_threshold:  0.3,
    });
    if (error) throw new Error(error.message);

    const best = new Map();
    for (const row of data ?? []) {
      const prev = best.get(row.exposition_id);
      if (!prev || row.similarity > prev.similarity) best.set(row.exposition_id, row);
    }

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

    return res.json({ results });

  } catch (err) {
    console.error("Search error:", err);
    return res.status(500).json({ error: err.message ?? "Internal error" });
  }
}
