-- Run this once in your Supabase SQL editor before running the pipeline.

CREATE EXTENSION IF NOT EXISTS vector;

-- ── Exposition metadata ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS expositions (
  id          INTEGER PRIMARY KEY,
  title       TEXT    NOT NULL DEFAULT '',
  author      TEXT    NOT NULL DEFAULT '',
  abstract    TEXT    NOT NULL DEFAULT '',
  keywords    TEXT[]  NOT NULL DEFAULT '{}',
  created_at  TEXT    NOT NULL DEFAULT '',
  url         TEXT    NOT NULL DEFAULT '',
  indexed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Generic classifier dimensions
  research_approach      TEXT[]  NOT NULL DEFAULT '{}',
  artistic_medium        TEXT[]  NOT NULL DEFAULT '{}',
  methodological_framing TEXT[]  NOT NULL DEFAULT '{}',
  geographic_context     TEXT[]  NOT NULL DEFAULT '{}',

  -- Extracted metadata
  research_question  TEXT,
  methods_described  TEXT,
  key_findings       TEXT,
  materials_tools    TEXT,
  theoretical_refs   TEXT,

  -- Societal impact classifier
  impact_types           TEXT[]  NOT NULL DEFAULT '{}',
  impact_scope           TEXT,
  impact_evidence_level  TEXT,

  -- Societal impact metadata (potential vs actual)
  impact_potential  JSONB,
  impact_actual     JSONB,

  extracted_at  TIMESTAMPTZ
);

-- ── Migration: add columns to an existing expositions table ───────────────────
-- Safe to run even if the columns already exist (IF NOT EXISTS).

ALTER TABLE expositions ADD COLUMN IF NOT EXISTS research_approach      TEXT[]  NOT NULL DEFAULT '{}';
ALTER TABLE expositions ADD COLUMN IF NOT EXISTS artistic_medium        TEXT[]  NOT NULL DEFAULT '{}';
ALTER TABLE expositions ADD COLUMN IF NOT EXISTS methodological_framing TEXT[]  NOT NULL DEFAULT '{}';
ALTER TABLE expositions ADD COLUMN IF NOT EXISTS geographic_context     TEXT[]  NOT NULL DEFAULT '{}';
ALTER TABLE expositions ADD COLUMN IF NOT EXISTS research_question      TEXT;
ALTER TABLE expositions ADD COLUMN IF NOT EXISTS methods_described      TEXT;
ALTER TABLE expositions ADD COLUMN IF NOT EXISTS key_findings           TEXT;
ALTER TABLE expositions ADD COLUMN IF NOT EXISTS materials_tools        TEXT;
ALTER TABLE expositions ADD COLUMN IF NOT EXISTS theoretical_refs       TEXT;
ALTER TABLE expositions ADD COLUMN IF NOT EXISTS impact_types           TEXT[]  NOT NULL DEFAULT '{}';
ALTER TABLE expositions ADD COLUMN IF NOT EXISTS impact_scope           TEXT;
ALTER TABLE expositions ADD COLUMN IF NOT EXISTS impact_evidence_level  TEXT;
ALTER TABLE expositions ADD COLUMN IF NOT EXISTS impact_potential       JSONB;
ALTER TABLE expositions ADD COLUMN IF NOT EXISTS impact_actual          JSONB;
ALTER TABLE expositions ADD COLUMN IF NOT EXISTS extracted_at           TIMESTAMPTZ;

-- ── Text chunks with embeddings ───────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS exposition_chunks (
  id             BIGSERIAL PRIMARY KEY,
  exposition_id  INTEGER NOT NULL REFERENCES expositions(id) ON DELETE CASCADE,
  page_id        INTEGER NOT NULL DEFAULT 0,
  chunk_index    INTEGER NOT NULL DEFAULT 0,
  text           TEXT    NOT NULL,
  embedding      vector(1536) NOT NULL,
  indexed_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS exposition_chunks_embedding_idx
  ON exposition_chunks
  USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);

-- ── Semantic search function ──────────────────────────────────────────────────

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
