-- Impact/relevance scheme v2 migration
-- Run in the Supabase SQL editor. Safe to re-run (idempotent).
--
--   • impact_evidence_level: free text  → controlled array (asserted/documented/externally validated)
--   • impact_scope (old free text)      → dropped (replaced by impact_scope_domain)
--   • impact_scope_domain               → new array filter (field-internal / societal)
--   • debates_addressed                 → new text (relevance)
--   • match_exposition_chunks RPC recreated WITHOUT the two now-unused impact
--     columns (the app never read them from the RPC; filtering uses a separate fetch).
--   • any stored extraction_schema in pipeline_config is cleared so the pipeline
--     uses the local v2 file.

-- 1. Drop the RPC first (it references the columns we're about to change).
DROP FUNCTION IF EXISTS match_exposition_chunks(vector, integer, double precision);

-- 2. Columns
ALTER TABLE expositions DROP COLUMN IF EXISTS impact_scope;                 -- old free-text scope
ALTER TABLE expositions DROP COLUMN IF EXISTS impact_evidence_level;        -- was TEXT
ALTER TABLE expositions ADD  COLUMN impact_evidence_level  TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE expositions ADD  COLUMN IF NOT EXISTS impact_scope_domain TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE expositions ADD  COLUMN IF NOT EXISTS debates_addressed   TEXT;

-- 3. Recreate the search RPC without impact_scope / impact_evidence_level
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
  impact_types           TEXT[]
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
    e.impact_types
  FROM exposition_chunks c
  JOIN expositions e ON e.id = c.exposition_id
  WHERE 1 - (c.embedding <=> query_embedding) > match_threshold
  ORDER BY c.embedding <=> query_embedding
  LIMIT match_count;
$$;

-- 4. Clear any stored extraction schema so the pipeline uses the local v2 file.
DELETE FROM pipeline_config WHERE key = 'extraction_schema';
