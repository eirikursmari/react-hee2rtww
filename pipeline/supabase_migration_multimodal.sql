-- Multimodal extension migration — run once in the Supabase SQL editor.
-- Adds provenance to search chunks and a table for per-image multimodal content.
-- Safe to re-run (IF NOT EXISTS / OR REPLACE).

-- ── 1. Provenance on search chunks ────────────────────────────────────────────
-- Image descriptions and OCR'd text are stored as ordinary chunks so they are
-- searched by the same vector index. `source` records where a chunk came from.
--   'text'       — exposition prose (existing rows; the DEFAULT keeps them valid)
--   'image'      — a literal visual description of one image
--   'image-text' — text transcribed (OCR) out of designed image elements
-- Multimodal chunks use negative page_id namespaces (-1 image, -2 image-text) so
-- the text pipeline's delete-by-(exposition_id, page_id) never touches them.

ALTER TABLE exposition_chunks
  ADD COLUMN IF NOT EXISTS source   TEXT NOT NULL DEFAULT 'text';
ALTER TABLE exposition_chunks
  ADD COLUMN IF NOT EXISTS media_id TEXT;

CREATE INDEX IF NOT EXISTS exposition_chunks_source_idx
  ON exposition_chunks (source);

-- ── 2. Per-image multimodal content (for display / Tier B) ────────────────────
CREATE TABLE IF NOT EXISTS exposition_media (
  id             BIGSERIAL PRIMARY KEY,
  exposition_id  INTEGER NOT NULL REFERENCES expositions(id) ON DELETE CASCADE,
  media_id       TEXT    NOT NULL DEFAULT '',
  media_type     TEXT    NOT NULL DEFAULT 'image',   -- image | video | audio
  url            TEXT    NOT NULL DEFAULT '',          -- last-known RC URL (tokens expire)
  size           TEXT    NOT NULL DEFAULT '',          -- e.g. 1024x768
  image_role     TEXT,                                  -- artwork|documentation|process|incidental
  description    TEXT,                                  -- literal visual description
  ocr_text       TEXT,                                  -- text transcribed from THIS image
  media_status   TEXT    NOT NULL DEFAULT '',
  indexed_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS exposition_media_expo_idx
  ON exposition_media (exposition_id);

-- ── 3. Recreate the search RPC to surface `source` ────────────────────────────
-- DROP first: Postgres refuses to change an existing function's return type
-- (adding the `source` column) via CREATE OR REPLACE.
DROP FUNCTION IF EXISTS match_exposition_chunks(vector, integer, double precision);

CREATE FUNCTION match_exposition_chunks(
  query_embedding  vector(1536),
  match_count      INTEGER DEFAULT 30,
  match_threshold  FLOAT   DEFAULT 0.3
)
RETURNS TABLE (
  exposition_id  INTEGER,
  page_id        INTEGER,
  chunk_index    INTEGER,
  text           TEXT,
  source         TEXT,
  similarity     FLOAT,
  title          TEXT,
  author         TEXT,
  abstract       TEXT,
  keywords       TEXT[],
  created_at     TEXT,
  url            TEXT,
  research_approach      TEXT[],
  artistic_medium        TEXT[],
  methodological_framing TEXT[],
  geographic_context     TEXT[],
  impact_types           TEXT[],
  impact_scope           TEXT,
  impact_evidence_level  TEXT
)
LANGUAGE sql STABLE AS $$
  SELECT
    c.exposition_id,
    c.page_id,
    c.chunk_index,
    c.text,
    c.source,
    1 - (c.embedding <=> query_embedding) AS similarity,
    e.title,
    e.author,
    e.abstract,
    e.keywords,
    e.created_at,
    e.url,
    e.research_approach,
    e.artistic_medium,
    e.methodological_framing,
    e.geographic_context,
    e.impact_types,
    e.impact_scope,
    e.impact_evidence_level
  FROM exposition_chunks c
  JOIN expositions e ON e.id = c.exposition_id
  WHERE 1 - (c.embedding <=> query_embedding) > match_threshold
  ORDER BY c.embedding <=> query_embedding
  LIMIT match_count;
$$;
