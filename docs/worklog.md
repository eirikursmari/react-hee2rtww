# Worklog

Dated narrative of what changed and why. `CLAUDE.md` holds the distilled current
state; this file holds the story. Newest entries at the top.

## 2026-09-18 — Full multimodal enrichment: cohort sized, capped-cost tool added

Sized a full multimodal enrichment of the peer-reviewed corpus (not just the
sparse-text rescue cohort) ahead of deciding whether to run it.

**Tooling added.** `scope_rescue.py` gained `--peer-reviewed` (scope the free
sizing report to the ~889 peer-reviewed expositions via a new
`peer_reviewed_exposition_ids()`, reusing `pipeline.is_peer_reviewed()` +
`pipeline.fetch_all_expositions_from_db()`) and documented that pairing it
with an absurdly high `--max-words` disables the sparseness filter, sizing a
full enrichment instead of just the rescue cohort. Added
`pipeline/peer_reviewed_ids.py` (writes the 889 ids as the `{"rc_id": ...}`
JSONL `rc_inventory.py` expects) and `pipeline/cap_cost.py` (recomputes cost
from an already-fetched cohort file with a real `--max-images` cap applied —
see below for why that matters).

**Measured, full scan** (`--peer-reviewed --max-words 999999999 --full`, ~3.5
min on the server): of 889 peer-reviewed expositions, **805 are image-bearing**;
**26,649 fetchable images total (uncapped)**, mean **33.1**/median **13** per
exposition. Uncapped cost: Opus $654.42 / Sonnet $398.59 / Haiku $142.76;
~29.6h wall-clock.

**This is far denser than the earlier 10-exposition pilot's 6.4 images/exposition
average** — expected in hindsight, since the peer-reviewed set includes the
visual- and sonic-arts journals (VIS, RUUKKU, Journal of Sonic Studies), not a
general corpus spread.

**The uncapped number overstates real cost.** `rc_multimodal.py` caps at
`--max-images` (default 8) per exposition; the median exposition here already
has 13, well over that. `cap_cost.py` re-derives the true capped total from
the saved cohort file (`output/pr_enrichment_cohort.jsonl`) with zero network
calls, so the real cost at the default cap — or any other cap — can be checked
instantly before committing spend.

**Status: not yet run.** Next step is deciding a describe model and
`--max-images` value from the capped numbers, not the uncapped ceiling above.

## 2026-09-16 — RC/KOBI interoperability, lens presets, deadline retired

**Deadline retired.** There is no longer a fixed 12 September 2026 presentation
date; the project continues as an ongoing research tool. Scrubbed the deadline
from `CLAUDE.md` (intro + the security note) and left a one-line note that the
date is retired.

**Analysed RC's own tooling against ours**, prompted by exposition **4667244** —
the COST Action "Artistic Intelligence" Training School (Daniele Pozzi + ~20
coauthors, Rome Fine Arts Academy, June 2026; WG3 "Reference Frameworks"). Worked
from the exposition's full RCdata JSON and from screenshots of the live
`map.rcdata.org` interface (both hosts are egress-blocked in the build
environment, so nothing could be fetched directly).

- **RCdata Search** is pure metadata string-match (title/author/keyword/abstract
  + portal/status/date) — no semantic layer, no content facet. A weaker retrieval
  model than ours by design.
- **Keyword Map** is a flat, uncontrolled folksonomy of **~11,005** author tags.
  Its genuine head independently reproduces our `research_themes` (sound, voice,
  dance, embodiment, memory, …) — a *third* human corroboration of the
  BERTopic-derived vocabulary (after the corpus itself and the 4667244 blackboard
  cloud).
- **Folksonomy-pollution finding.** Below the head sits an unnatural plateau of
  ~40 terms at an identical ~59–61 count — self-referential author epithets
  (`dorian vale`, `founder of post-interpretive criticism`, `custodian of witness
  aesthetics`, …) plus coined neologisms (`hauntmark theory`, `aesthetic
  recursion`, …). Almost certainly one contributor stuffing a fixed tag-set
  across ~60 works (≈2,400 tag instances). Inference from the pattern; checkable
  by filtering the Keyword Map to `dorian vale`. It's the clearest empirical
  argument for a curated, corpus-derived vocabulary over an open folksonomy.
- **KOBI** ("Knowledge Universe" lemma-graph, AR constellation view) ≈ our
  authority-file mapping + pgvector similarity, but manual/intentional vs.
  automatic/inferred. KOBI internals stay marked **inferred** — unverified.

**Seed docs written** (toward the technical report):
- `docs/rc-crosswalk.md` — the 16-value `research_themes` ↔ RC folksonomy bridge
  (7 direct / 2 partial / 1 weak / 6 tail-only), the discipline/method/noise
  orphans the schema excludes, and the pollution cluster.
- `docs/rc-kobi-comparison.md` — the three-tool comparison (RCdata / KOBI / us) on
  a divergent-serendipity → convergent-verify axis, point-by-point table,
  interoperability plan, and an explicit auditability §0 (verified vs. inferred).

**Shipped: the ten reflective lenses as search presets.** Recovered the exact
lens wording from 4667244 (Resonance, Ambiguity, Locality, Transfer, Connections,
Bodies, Perspective, Moving, Transition, Tool) and wired them into the Custom
semantic categories panel as one-click preset chips (`LENS_PRESETS` in
`src/App.js`, styles in `src/style.css`). Design decision: each lens's original
second-person *workshop question* is kept as the chip tooltip, but the embedded
`description` is rewritten **declaratively** so it matches against third-person
exposition prose/abstracts/image-text (the query side, not extraction). A preset
becomes a normal custom category (stable `lens:<name>` id, persisted, toggleable,
deletable) and drops out of the preset row once added. They **re-rank** via the
existing 50/50 blend in the `search` function — no backend change, no
edge-function redeploy. Verified with `CI=false` and `CI=true` production builds.

**Merge/deploy.** PR #10 → `main` (rebased onto latest `main` first, since the
`claude/docs-review-qbbjh9` branch name had been reused through PRs #4–#9). Two
red **Vercel** checks were noise — this project deploys to **GitHub Pages**, not
Vercel; the "Deploy to GitHub Pages" workflow ran green on the merge commit.

## 2026-09-02 — Multimodal micro-pilot (validated end-to-end)

Validated the image pipeline (`rc_multimodal.py` → `load_multimodal.py`) end to
end — inventory → vision describe/OCR → facet extract → embed/load → live
semantic retrieval — before committing to a full rescue run.

**Smoke test** (`--only 281999`): 8/8 images described faithfully; facets
(sound art, field recording, site-specific, walking/site-based methods) extracted
from the images *alone* for an exposition with no title in the DB, each tagged
`modality_source=image` with verbatim evidence. ~$0.11.

**Sample of 10** (`--sample 10 --ocr` → `output/multimodal_ocr.jsonl`): 10/10 ok,
64 images described, **$1.26** (so ~$0.11–0.13/exposition at 8 images). Loaded
8 expositions, 103 chunks, 64 media rows — 2 records had 0 *fetchable* images
(external embeds, not RC-hosted) and contributed nothing, correctly skipped.

**Anti-confabulation safeguard holding**: 7/10 records carry `illegible` markers
— the vision step flags unreadable text rather than inventing it (overview §7).

**Showcase / validated case = `2064153`** — Fabio Bonizzoni, *"With trumpets? The
use of trumpets in Roman Sinfonie around 1700"*. OCR recovered the designed-in
title-page text **and** a faithful transcription of a 1720 primary source
(*Notizie Istoriche degli Arcadi Morti*, Roma, Stamperia di Antonio de Rossi — the
Arcangelo Corelli biography), period Italian intact, incl. a "HARVARD JUL 2"
library stamp. In-app: a semantic search surfaces it with the images +
"Text in image" panel populated. Caveat: this exposition also has prose, so that
hit matched on text; retrieval *only* possible via recovered text is cleanest on a
text-sparse work (search e.g. "Vallemani" to isolate the image-text path, or a
future `scope_rescue.py` rescue cohort).

**Fix during the pilot**: `_images_described` was written per-record from a
module-level counter that accumulates across expositions (hence nonsensical
`38/0`); now derived per-record from the exposition's own `image_descriptions`.

**Next**: `scope_rescue.py` (free) to size the text-sparse + image-bearing cohort
and project a full-rescue cost from the ~$0.12/exposition calibration; look into
the 2 non-fetchable-embed cases if image coverage matters.

## 2026-09-02 — Analytics subset scope, UI for sharing, and a pending-extraction top-up

Ahead of sharing the app with colleagues (and before the multimodal test).

**Corpus Analytics — subset scope filter.** Added a **Whole corpus / Peer-reviewed
journals** selector to the analytics tab. When a subset is chosen, *every*
dimension — impact, medium, SDG, research themes, relevance reach, and all
by-year / by-journal trends — is computed and denominated over that subset alone,
so there is a single honest denominator instead of the whole-corpus-vs-peer-reviewed
split. It threads through all three surfaces:
- **Claude Q&A** — `analytics/index.ts` `buildStats(rows, scope)` and the system
  prompt are now scope-aware; in peer-reviewed mode the two-denominator caveat
  collapses into one. The function returns `scopedTotal` + `scope`; a `scope`
  arg was also wired into the `mode:"stats"` probe.
- **Chart Builder + SDG Explorer** — a client-side `scopedRows` memo filters
  `corpusRows` by the selected scope; every count/chart/denominator follows.
- Changing scope starts a fresh analytics thread (stats live only in the first
  message, so an in-place switch would otherwise be silently ignored). Built so
  more subsets are a one-line addition.

**UI polish for a wider audience.** Collapsible **About** panel at the top
(purpose + what each approach is good for; open by default, dismissal persisted).
Model buttons now show versions (**Haiku 4.5 / Sonnet 4.6 / Opus 4.7**). Refreshed
the (i) "How it works" panels: complete Semantic filter list and accurate two-tier
extraction-coverage wording in place of the stale "~96%". Verified with a prod
build; merged to `main` (PR #3) → Pages; `analytics` edge function redeployed.

**Pending-extraction top-up (+228).** Corpus Analytics reported ~397 "pending".
Root-caused the number: analytics defines pending as *no `research_approach`*,
but the pipeline's `--extract-only` resume filter treats *any* row missing
`research_themes` as needing work — which would have swept in the ~2,700 non-PR
v1 rows (they have `research_approach` but not the v2.4 themes), turning a top-up
into a near-full re-extraction.
- Added **`--pending-only`** to `pipeline.py`: with `--extract-only`, it targets
  *only* rows with no `extracted_at` (and not unavailable) — the genuinely
  never-extracted set. That came to **228**, not 397; the ~169 gap is rows that
  carry an `extracted_at` but an empty `research_approach` (extracted before,
  returned nothing) — left as-is for now, a separate re-extract question.
- Ran `--extract-only --pending-only --model claude-sonnet-4-6`: **228 processed
  (5 test + 223), 0 failed** (~$6, extract-only so no embeddings). Rows that
  404'd on RC were auto-marked `unavailable` rather than extracted.
- Consequence: these ~228 (mostly non-peer-reviewed) now carry `research_themes` /
  `relevance_reach` too. The peer-reviewed analytics scope is unaffected (it
  filters by venue, not by whether themes exist); whole-corpus theme charts are
  now a bit more populated. Denominator caveat in `CLAUDE.md` updated.

## 2026-09-01 — Corpus Analytics: research-themes temporal view, truncation fix

**The symptom.** Asking Corpus Analytics for a *temporal* analysis of research
themes (scoped to the ~889 peer-reviewed) got a "the theme-by-year breakdown is
not available" hedge, and long answers broke off mid-sentence, needing a manual
"please continue".

**Root cause — analytics never aggregated the theme dims.** The `analytics`
edge function selected `research_themes` / `relevance_reach` into `FIELDS` but
`buildStats()` built *no* distribution for them — no overall, no by-year, no
by-journal. Only `impact_types` and SDG had by-year cross-tabs, all corpus-wide.
So a temporal theme question had literally zero theme-with-time data, and the
year totals the model saw were whole-corpus (6,722), not peer-reviewed — the two
things the model's answer complained about. (Its earlier claim that themes
existed "per journal" was a confabulation; nothing of the sort was in the stats.)

**Fixes (all in `supabase/functions/analytics/index.ts`):**
- Ported `PEER_REVIEWED_VENUE_PHRASES` + an `isPeerReviewed()` helper (kept in
  sync with `pipeline.py`) and emitted, scoped to and denominated by the
  peer-reviewed subset: research-themes and relevance-reach distributions,
  **RESEARCH THEMES BY YEAR**, RELEVANCE REACH BY YEAR, PEER-REVIEWED
  EXPOSITIONS BY YEAR (the denominator), and RESEARCH THEMES BY JOURNAL.
- Rewrote the system prompt to separate the two denominators (corpus-wide
  impact/SDG/year vs peer-reviewed-only theme/reach) so the model stops
  conflating them, and to state that a theme-by-year breakdown *is* available.
- **Truncation:** the Claude call was capped at `max_tokens: 2048` and took
  `content[0].text` without checking `stop_reason`, so long analyses returned
  half-finished. Raised the ceiling to 8192 and added auto-continuation — on
  `stop_reason:"max_tokens"` feed the partial back and ask it to continue
  seamlessly, concatenated with no separator, guarded by `MAX_CONTINUATIONS`.
  Response now also carries a `truncated` flag.
- Added a `mode:"stats"` diagnostic branch that returns the exact stats string
  with no Anthropic call — for confirming which build is live.

**Chart Builder parity (`src/App.js`).** Surfaced the same views client-side.
Two correctness gaps fixed: `crossTab` took the top-N years by frequency,
unordered, so a themes×year heatmap showed ~8 arbitrary non-chronological
columns — year is now a temporal axis (every year, chronological); and
charts over `research_themes` / `relevance_reach` (bar, trend, either heatmap
axis) are now scoped to the peer-reviewed subset with a denominator note,
instead of sitting against the whole-corpus base. Verified with a prod build.

**Debugging note — the fix looked broken twice because the function wasn't
deployed.** Edge functions don't auto-deploy (only the frontend does, via
Pages), and the server's checkout was behind the branch, so early tests hit the
old build. The `mode:"stats"` probe made this visible: `{"error":"question is
required"}` = old build lacking the branch; once the checkout was synced and
`analytics` redeployed, the stats showed a populated RESEARCH THEMES BY YEAR
(2011–2026) and the app produced a real year × theme table with per-year
percentages. Confirmed live.

**Known wrinkle (left as-is).** RESEARCH THEMES BY JOURNAL lists 8 rows, not 6:
a few peer-reviewed expositions are co-listed with non-PR portals (Konstfack
n=6), and ARJAZZ (n=5) is caught by the `"journal for artistic research"`
substring. The pipeline uses the identical phrase list, so the edge function and
the extracted data *agree* — tightening it means realigning both together,
deliberately, not as a drive-by. 5–6 of 889; negligible for trends.

**Deploy state.** `analytics` edge function deployed and confirmed live; branch
merged to `main` (frontend auto-deploys to Pages).

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

**Post-deploy testing (same day).** Two analytics gaps found and fixed while
testing the live Q&A:
- The Q&A "Analyse" path builds a separate stats summary (`buildStats`) that the
  Chart Builder doesn't use — it never included the v2.4 dims, so Claude reported
  it had no research-themes data. Added research_themes/relevance_reach/evidence/
  scope + a themes-by-journal cross-tab + a scope note (peer-reviewed vs
  whole-corpus base).
- The themes-by-journal used the corpus-wide top-8 journals, dropping HUB and
  ArteActa. Scoped it to all peer-reviewed journals via `isPeerReviewed()`.
- Confirmed by SQL: all six journals extracted (ArteActa 24/24). The
  "journal for artistic research" phrase also matches **ARJAZZ – Journal for
  Artistic Research in Jazz** (5) — kept deliberately, so scope = 7 journals /
  889. No false positives among other performing-arts portals (0 themed).
