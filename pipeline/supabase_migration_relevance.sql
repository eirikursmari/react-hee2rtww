-- Relevance axis migration (schema v2.3)
-- Run in the Supabase SQL editor. Safe to re-run (idempotent).
--
--   • relevance_type (v2.2) is REMOVED — it saturated (nearly every work got
--     most values) and gave no analytical discrimination.
--   • fields_engaged: controlled ~17-field taxonomy of the scholarly/artistic
--     discourses a work substantively engages (its relevance to the wider
--     intellectual landscape).
--   • relevance_reach: mono- / cross- / transdisciplinary breadth.
--
-- Both are RELEVANCE (positioning), separate from impact, and carry NO evidence
-- level. No change to match_exposition_chunks is needed: filtering reads these
-- via the search function's separate metadata fetch, not the RPC.

ALTER TABLE expositions DROP COLUMN IF EXISTS relevance_type;
ALTER TABLE expositions ADD  COLUMN IF NOT EXISTS fields_engaged  TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE expositions ADD  COLUMN IF NOT EXISTS relevance_reach TEXT[] NOT NULL DEFAULT '{}';
