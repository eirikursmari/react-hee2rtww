# Excavating Artistic Research — project brief

AI/RAG search-and-analysis tool over the **Research Catalogue** (RC,
researchcatalogue.net) corpus of ~6,671 artistic-research expositions. Built for
a presentation on **12 September 2026**. This file is the durable state so a
fresh session starts up to speed — keep it concise; update it when a decision or
milestone lands, not on a clock. Put dated narrative in `docs/worklog.md`, not
here.

## Architecture

- **Frontend** — Create React App (`src/App.js`, `src/style.css`). Built with
  `npm run build`; deployed to GitHub Pages at base path `/react-hee2rtww/`
  (`npm run deploy`, gh-pages). Talks to the backend via a semantic-search URL +
  an `x-app-key` header (value = `APP_PASSPHRASE`); there is no Supabase JWT.
- **Backend** — Supabase Postgres + pgvector, plus Deno **edge functions** in
  `supabase/functions/`: `search`, `analytics`, `claude`, `media`,
  `schema-builder`, `rc-proxy`. All deployed `--no-verify-jwt`.
  Project ref: `tnxmralkmylmkeesblvj`.
- **Pipeline** — Python in `pipeline/`. `pipeline.py` is the indexer/extractor;
  supporting scripts alongside it (see below). Embeddings: OpenAI
  `text-embedding-3-small` (1536-dim). Extraction: Claude (see decisions).
- **Data** — `expositions` table (metadata + extracted dimensions),
  `exposition_chunks` (embedded text, `source` tag), `pipeline_config`
  (filter_config etc.). Vector search via the `match_exposition_chunks` RPC.
- **What semantic search covers**: everything embedded in `exposition_chunks` —
  prose (`source` = `text`/`abstract`) **plus** multimodal text: per-image
  **descriptions** (`source=image`) and **OCR'd designed-in text**
  (`source=image-text`), all via the same `text-embedding-3-small` index. So
  descriptions *and* OCR are searchable. Retrieval is **text-mediated, not
  visual** — no pixel/CLIP embedding; an image is found only through the text
  generated about it. `exposition_media` is **display-only** (per-image
  description + OCR + thumbnail for the app panel), never embedded.

### Gotcha: the live search function is named `swift-processor`
The app's semantic-search URL points at a function deployed under the name
`swift-processor` (historical), now aligned to the `search` source. When
deploying search changes, deploy the function the app actually calls.

## Extraction schema (`pipeline/extraction_schema.json`) — current: **v2.4**

Schema-driven: `array_dimensions` become filter chips + Chart Builder dims;
`text_dimensions` are searchable text; `nested_dimensions` are grouped records.
`load_schema()` prefers a stored `pipeline_config.extraction_schema`, else this
local file (the impact-v2 migration cleared the stored copy, so the local file
is authoritative).

**Two axes, by deliberate design:**
- **IMPACT** = a *claimed kind of change* the work produces. Must be an EXPLICIT
  claim in the text — never inferred from subject matter; empty is the right
  answer for many works. Fields: `impact_types` (11 values),
  `impact_evidence_level` (asserted → documented → externally validated — the
  strongest tier that the impact ITSELF occurred), `impact_scope_domain`
  (field-internal vs societal, judged by the *target* of change, not the
  register of the writing), and nested `impact_potential` / `impact_actual`.
- **RELEVANCE** = the work's *positioning in the field's concerns*. Carries NO
  evidence level (positioning is textually self-evident, not something that
  "occurs"). Fields: `research_themes` (16-value vocabulary **derived from the
  877 peer-reviewed expositions themselves** via BERTopic, then curated — the
  AR concerns a work engages, e.g. sound/listening, voice, place/site,
  body/embodiment, ecology, memory & archive), `relevance_reach` (mono- /
  cross- / transdisciplinary), and the `debates_addressed` text.

Extraction window is title + author + abstract[:800] + body[:6000]
(`EXTRACT_TEXT_MAX`) — abstract + opening sections, not full text.

## Decisions that stuck

- **Extraction model = Claude Sonnet** (`claude-sonnet-4-6`), chosen over Haiku
  (under-calibrated) and Opus (over-strict) by two-model eyeball tests. Pass
  `--model claude-sonnet-4-6`. (`EXTRACTION_MODEL` default in code is still
  Haiku; the flag overrides it.)
- **Analysis scope = peer-reviewed journals only** (~877 of 6,671, ~13%). Six
  venues, matched by distinctive name-phrase in `pipeline.is_peer_reviewed()` /
  `PEER_REVIEWED_VENUE_PHRASES`: Journal of Sonic Studies, Journal for Artistic
  Research, RUUKKU, VIS, HUB, ArteActa.
- **Relevance evolution**: relevance_type (saturated → useless) → fields_engaged
  (too academic) → **research_themes** (corpus-derived, current). See git log.
- **SDG** classification (Aurora) exists across the corpus; SDG Explorer +
  general Chart Builder in Corpus Analytics; semantic filters + explorer are
  collapsible, closed by default.

## Key commands

```bash
source ~/rc-keys.env          # ANTHROPIC/OPENAI/SUPABASE keys (on the server, not in repo)

# Curated extraction eyeball (peer-reviewed, no DB writes)
python3 pipeline/test_extraction.py --limit 8

# Topic modelling (needs the venv: ~/bertopic-venv, CPU-only torch)
~/bertopic-venv/bin/python pipeline/topic_model.py

# Full re-extraction, scoped to the 877 peer-reviewed expositions
python3 pipeline/pipeline.py --extract-only --force --peer-reviewed --model claude-sonnet-4-6

# Top up ONLY never-extracted rows (no extracted_at) — not the broad resume
# filter, which also re-does older-schema rows missing research_themes
python3 pipeline/pipeline.py --extract-only --pending-only --model claude-sonnet-4-6

# Frontend
CI=false npm run build

# Deploy an edge function
npx supabase@latest functions deploy <name> --no-verify-jwt --project-ref tnxmralkmylmkeesblvj
```

## Full re-extraction runbook (completed 2026-09-01; kept as reference)

1. Run the DB migration(s) in the Supabase SQL editor — latest is
   `pipeline/supabase_migration_relevance.sql` (v2.4: drops relevance_type +
   fields_engaged; adds research_themes + relevance_reach). "Success. No rows
   returned" is the expected result for these DDL batches.
2. Redeploy the search function (reads the new filter columns).
3. Full extraction with Sonnet, scoped by `--peer-reviewed` so it runs ~877
   (~$20, <1h) not all 6,671 (~$150). Use `nohup`/`screen`; needs all keys
   sourced:
   `python3 pipeline/pipeline.py --extract-only --force --peer-reviewed --model claude-sonnet-4-6`
4. Frontend auto-deploys via Pages; hard-refresh to see new filters/dims.

## Status

- **Full re-extraction DONE** (v2.4, Sonnet, peer-reviewed): 888/889 have
  `research_themes`, 887 `relevance_reach` (one journal home-page legitimately
  empty). `analytics` + `search` edge functions redeployed; frontend on `main`
  (auto-deploys to Pages). See `docs/worklog.md` for the day-by-day.
- **Corpus Analytics subset scope** (2026-09-02): a **Whole corpus / Peer-reviewed
  journals** selector scopes every question, chart, and count to the chosen slice
  with a single denominator. Frontend `scopedRows` + scope-aware `buildStats(rows,
  scope)` in `analytics/index.ts`; the peer-reviewed scope filters by *venue*
  (`isPeerReviewed`), not by whether theme fields exist.
- **Analytics scope caveat**: `impact_types` etc. are populated corpus-wide
  (~3.6k rows) from an OLD v1 run. `research_themes`/`relevance_reach` were v2.4
  extractions: the ~889 peer-reviewed, **plus ~228 mostly-non-PR rows from the
  2026-09-02 pending top-up**. So whole-corpus theme charts are partial (that
  ~1.1k, not the full corpus) while impact/SDG span ~3.6k — mind the differing
  denominators, or use the peer-reviewed scope for a clean one. (A clean fix
  later: finish extracting or clear the remaining non-peer-reviewed rows.)

## Pending / open

- **Technical report** covering what's been built (later — this file is its seed;
  `docs/status-and-feasibility.md` and `docs/excavating-artistic-research-overview.md`
  are drafts toward it).
- **~169 extracted-but-empty rows**: carry an `extracted_at` but an empty
  `research_approach` (extracted before, returned nothing). They're the gap
  between the analytics "pending" count (~397, keyed off `research_approach`) and
  the never-extracted set the 2026-09-02 top-up cleared (228). Decide per-row
  whether they're legitimately thin or an old Haiku under-tag worth a Sonnet
  re-extract (would want a `--reextract-empty` targeting mode).
- **Multimodal**: pipeline validated end-to-end via a 10-exposition micro-pilot
  (2026-09-02) — describe/OCR → facet → embed → live search, ~$0.12/exposition
  at 8 images; showcase recovery = exposition 2064153 (Corelli/Roman-trumpets,
  text recovered from scanned title pages). Full rescue run still deferred: size
  the cohort with `scope_rescue.py` first.
- Deferred: BERTopic prototype done for vocabulary; full multimodal rescue run;
  validation study.
- **Security**: the Supabase `service_role` key was pasted in chat earlier and
  has not been rotated. Rotating regenerates all project keys (disruptive) —
  worth doing before the presentation, timed deliberately.

## Conventions

- **Develop on branch `claude/rag-research-catalogue-interface-HTls8`.** Not
  `main`.
- Migrations are hand-run in the Supabase SQL editor (files in `pipeline/*.sql`,
  idempotent). No automated migration runner.
- **No secrets in the repo.** Keys live in `~/rc-keys.env` on the server.
- Verify App.js changes with a production build before committing (a prior
  hook-ordering bug shipped a blank page).
