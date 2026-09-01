# Worklog

Dated narrative of what changed and why. `CLAUDE.md` holds the distilled current
state; this file holds the story. Newest entries at the top.

## 2026-09-01 — Impact/relevance schema finalised (v2.4) and full re-extraction run

**Extraction quality tuning (eyeball-driven).** Ran two-model tests and a curated
peer-reviewed eyeball. Findings and fixes:
- Confirmed **Sonnet** over Opus (Opus under-tagged defensible impacts to empty).
- Impact was being **inferred from subject matter**; sharpened so impact is only
  an EXPLICIT claim (empty is the right answer for many works) — fixed spurious
  "asserted".
- `epistemic / methodological` over-applied; reserved for distinctive nameable
  contributions.
- `impact_scope_domain` judged by the **target of change**, not the register of
  the writing (societal vs field-internal).

**Inclusion scope.** Restricted analysis to the **six peer-reviewed journals**
(~889 of the corpus) via `pipeline.is_peer_reviewed()` + `PEER_REVIEWED_VENUE_PHRASES`.
Added a `--peer-reviewed` flag to the extract path and fixed the test sampler to
draw across all years (was locked to the earliest ids).

**Relevance axis — three iterations to something useful:**
1. `relevance_type` (extends/challenges/reframes/bridges/recovers) — **saturated**
   (nearly every work got most values); useless as a filter. Dropped.
2. `fields_engaged` (academic-discipline taxonomy) — discriminated, but **too
   academic / humanities-flavoured** for artistic research. Dropped.
3. **`research_themes`** — 16-theme vocabulary **derived from the corpus itself**
   via BERTopic (`pipeline/topic_model.py`, KMeans over multilingual embeddings of
   the 889 abstracts), then curated. Native to AR (sound/listening, voice, place,
   body, ecology, archive, …). Kept. Plus `relevance_reach` (mono-/cross-/trans-
   disciplinary). Relevance carries **no evidence level** by design.
Tightened `artistic-research method & pedagogy` after it drifted toward a
near-universal tag (same failure mode as epistemic/methodological).

**Bugs found and fixed during the run:**
- Extract-only DB write was **hardcoded and stale** — wrote the dropped
  `impact_scope` column (400 on every row), wrote `impact_evidence_level` as a
  string not an array, and omitted all v2.4 fields. `test_extraction.py` never
  caught it because it doesn't write to the DB. Made the write schema-driven.
- Two duplicate old-code runs were left running in parallel (nohup), burning
  paid Sonnet calls to write nothing — killed with `pkill -f pipeline.py`.
- Anthropic credits ran dry mid-run (~603 of 889 written). Enabled auto-reload.
- **Resume skipped stale rows**: the non-force filter treated any row with an
  `extracted_at` as done, but ~286 rows had OLD v1 extractions (timestamp set,
  no v2.4 fields). Fixed the filter to also re-do rows missing `research_themes`.
  Resume then correctly picked up the 287 stragglers.

**Result.** 888/889 peer-reviewed rows carry the full two-axis scheme (verified
by SQL count). `analytics` + `search` edge functions redeployed. Frontend merged
to `main` → Pages auto-deploy. Migrations run: `supabase_migration_relevance.sql`
(v2.4).

**Follow-ups noted:** analytics mixes whole-corpus legacy impact data with
peer-reviewed-only new dims (differing denominators); technical report still to
write; Supabase `service_role` key still unrotated.
