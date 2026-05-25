-- RC Research Catalogue — Supabase migration
-- Run this once in: Supabase dashboard → SQL Editor → New query → Run
--
-- 1. Table for storing pipeline configuration (extraction schema, filter config)
-- 2. Column for custom extracted metadata not covered by the standard schema

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
