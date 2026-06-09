-- RC Research Catalogue — Supabase migration
-- Run this once in: Supabase dashboard → SQL Editor → New query → Run
--
-- 1. Table for storing pipeline configuration (extraction schema, filter config)
-- 2. Column for custom extracted metadata not covered by the standard schema
-- 3. Column for RC portal/journal names (published_in)

CREATE TABLE IF NOT EXISTS pipeline_config (
  key        text PRIMARY KEY,
  value      jsonb        NOT NULL,
  updated_at timestamptz  DEFAULT now()
);

-- Allow the app to read config without authentication (public read-only)
ALTER TABLE pipeline_config ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Public read" ON pipeline_config FOR SELECT USING (true);

-- Custom metadata column for storing dimensions added via extraction_schema.json
ALTER TABLE expositions ADD COLUMN IF NOT EXISTS custom_metadata jsonb;

-- Portal/journal column — populated from RC API published_in field
ALTER TABLE expositions ADD COLUMN IF NOT EXISTS published_in text[];

-- Language column — ISO 639-1 code detected from abstract/title
ALTER TABLE expositions ADD COLUMN IF NOT EXISTS language text;

-- Unavailable flag — set when the RC content API returns 404 for an exposition
-- (unpublished, deleted, or made private after indexing). These are excluded
-- from "pending extraction" counts and skipped by --extract-only runs.
ALTER TABLE expositions ADD COLUMN IF NOT EXISTS unavailable boolean DEFAULT false;

-- After running: python3 pipeline.py --portals-only
-- Run this query to see all distinct portal/journal names in your data:
--
-- SELECT unnest(published_in) AS portal, count(*) AS count
-- FROM expositions
-- WHERE published_in IS NOT NULL
-- GROUP BY portal ORDER BY count DESC;
