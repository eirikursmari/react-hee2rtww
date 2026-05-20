-- Run this once in your Supabase SQL editor before running the pipeline.

CREATE EXTENSION IF NOT EXISTS vector;

-- ── Exposition metadata ──────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS expositions (
  id          INTEGER PRIMARY KEY,
  title       TEXT    NOT NULL DEFAULT '',
  author      TEXT    NOT NULL DEFAULT '',
  abstract    TEXT    NOT NULL DEFAULT '',
  keywords    TEXT[]  NOT NULL DEFAULT '{}',
  created_at  TEXT    NOT NULL DEFAULT '',
  url         TEXT    NOT NULL DEFAULT '',
  indexed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Text chunks with embeddings ───────────────────────────────────────────────
-- Each exposition is split into page-level chunks so large expositions
-- don't exceed the embedding model's token limit (8191 tokens).

CREATE TABLE IF NOT EXISTS exposition_chunks (
  id             BIGSERIAL PRIMARY KEY,
  exposition_id  INTEGER NOT NULL REFERENCES expositions(id) ON DELETE CASCADE,
  page_id        INTEGER NOT NULL DEFAULT 0,
  chunk_index    INTEGER NOT NULL DEFAULT 0,
  text           TEXT    NOT NULL,
  embedding      vector(1536) NOT NULL,  -- text-embedding-3-small dimensions
  indexed_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- IVFFlat index for approximate nearest-neighbour search.
-- lists = 100 is appropriate for ~5 000 expositions (sqrt of corpus size).
-- Rebuild with higher lists if corpus grows beyond 50 000 chunks.
CREATE INDEX IF NOT EXISTS exposition_chunks_embedding_idx
  ON exposition_chunks
  USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);

-- ── Semantic search function ──────────────────────────────────────────────────
-- Called by the Vercel API. Returns chunks ranked by cosine similarity,
-- joined with exposition metadata, filtered by a minimum threshold.

CREATE OR REPLACE FUNCTION match_exposition_chunks(
  query_embedding  vector(1536),
  match_count      INTEGER DEFAULT 30,
  match_threshold  FLOAT   DEFAULT 0.3
)
RETURNS TABLE (
  exposition_id  INTEGER,
  page_id        INTEGER,
  chunk_index    INTEGER,
  text           TEXT,
  similarity     FLOAT,
  title          TEXT,
  author         TEXT,
  abstract       TEXT,
  keywords       TEXT[],
  created_at     TEXT,
  url            TEXT
)
LANGUAGE sql STABLE AS $$
  SELECT
    c.exposition_id,
    c.page_id,
    c.chunk_index,
    c.text,
    1 - (c.embedding <=> query_embedding) AS similarity,
    e.title,
    e.author,
    e.abstract,
    e.keywords,
    e.created_at,
    e.url
  FROM exposition_chunks c
  JOIN expositions e ON e.id = c.exposition_id
  WHERE 1 - (c.embedding <=> query_embedding) > match_threshold
  ORDER BY c.embedding <=> query_embedding
  LIMIT match_count;
$$;
