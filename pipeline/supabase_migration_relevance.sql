-- Relevance axis migration (schema v2.2)
-- Run in the Supabase SQL editor. Safe to re-run (idempotent).
--
--   • relevance_type: new controlled array capturing HOW the work contributes to
--     the debates it engages (extends / challenges / reframes / bridges /
--     recovers). This is RELEVANCE — positioning in the field — and is separate
--     from impact; it carries NO evidence level.
--
-- No change to match_exposition_chunks is needed: filtering reads relevance_type
-- via the search function's separate metadata fetch, not the RPC.

ALTER TABLE expositions ADD COLUMN IF NOT EXISTS relevance_type TEXT[] NOT NULL DEFAULT '{}';
