-- Relevance axis migration (schema v2.4)
-- Run in the Supabase SQL editor. Safe to re-run (idempotent). This one file
-- brings any earlier state up to v2.4, so it is fine whether or not you ran the
-- interim v2.2 / v2.3 versions.
--
--   • relevance_type (v2.2) and fields_engaged (v2.3) are REMOVED — the first
--     saturated (no discrimination), the second was too academic/humanities.
--   • research_themes: a 16-theme vocabulary DERIVED FROM THE PEER-REVIEWED
--     CORPUS itself via BERTopic, then curated — the artistic-research concerns
--     a work engages (sound, voice, place, body, ecology, archive, …).
--   • relevance_reach: mono- / cross- / transdisciplinary breadth.
--
-- Both are RELEVANCE (positioning), separate from impact, and carry NO evidence
-- level. No change to match_exposition_chunks is needed: filtering reads these
-- via the search function's separate metadata fetch, not the RPC.

ALTER TABLE expositions DROP COLUMN IF EXISTS relevance_type;
ALTER TABLE expositions DROP COLUMN IF EXISTS fields_engaged;
ALTER TABLE expositions ADD  COLUMN IF NOT EXISTS research_themes  TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE expositions ADD  COLUMN IF NOT EXISTS relevance_reach  TEXT[] NOT NULL DEFAULT '{}';
