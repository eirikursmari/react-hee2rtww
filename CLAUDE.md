# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A search/discovery frontend for the [Research Catalogue](https://www.researchcatalogue.net) (RC), an
international database of artistic research. It offers keyword search (proxied straight to RC), semantic
(vector) search over an independently-built index, an AI Q&A layer on top of search results, and a
"corpus analytics" chat that lets users ask aggregate questions about the whole indexed corpus. All AI
calls go through Claude; embeddings go through OpenAI.

The system has three independently deployed parts that only agree with each other via HTTP contracts —
there is no shared build or shared types:

1. **`src/`** — the React frontend (Create React App), deployed to GitHub Pages.
2. **`supabase/functions/`** — Deno edge functions that the frontend calls for anything requiring a
   secret (Anthropic key, Supabase service key) or server-side logic. This is the primary backend.
3. **`pipeline/`** — a standalone Python batch job (run via GitHub Actions on a schedule, or manually)
   that crawls RC, embeds exposition text, and extracts structured metadata into Supabase/pgvector.
   It does not run as part of the request path — it populates the data the edge functions query.

`api/search.js` is a legacy/alternate Vercel serverless function duplicating the `supabase/functions/search`
logic, kept for the Vercel deployment path referenced in `vercel.json` (deployment via Vercel is otherwise
disabled — see `vercel.json`'s `ignoreCommand`). The canonical deployment is GitHub Pages + Supabase edge
functions.

## Commands

```bash
npm start           # CRA dev server (localhost:3000)
npm run build        # production build to build/
npm test             # react-scripts test --env=jsdom (Jest, watch mode by default)
npm test -- --watchAll=false --testPathPattern=<name>   # single test run / single file
npm run deploy       # build + push build/ to gh-pages branch (requires push access)
```

There is no lint script configured; CRA's built-in ESLint runs as part of `npm start` / `npm run build`.

Pipeline (Python, run from `pipeline/`):

```bash
pip install -r requirements.txt
python pipeline.py                    # index new expositions + extract metadata (safe to re-run)
python pipeline.py --force            # re-index and re-extract everything
python pipeline.py --limit 20         # test with a small batch
python pipeline.py --extract-only     # metadata extraction only, no re-embedding (queries Supabase, not RC)
python pipeline.py --portals-only     # fast pass: update published_in only, no Claude calls
python pipeline.py --language-only    # fast pass: detect + store language, no Claude calls
python pipeline.py --classify-only    # run classifiers configured in Supabase pipeline_config
python rc_extract.py OUTPUT.jsonl [--sample N]   # standalone faceted-metadata extraction sample/export tool
```

Pipeline env vars (see `pipeline/.env.example`): `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `SUPABASE_URL`,
`SUPABASE_SERVICE_KEY`. `ANTHROPIC_API_KEY` is optional for the main indexing pass (metadata extraction is
skipped without it) but required for `--extract-only`, `--classify-only`, and `rc_extract.py`.

Supabase edge functions (`supabase/functions/*/index.ts`) are deployed independently via the Supabase CLI
(`supabase functions deploy <name>`); there's no deploy step for them in this repo's CI.

## Architecture

### Frontend (`src/App.js`)

Everything lives in one large file: a single `App` component (~80KB) holding all state via `useState`,
plus free functions above it for networking, text extraction, and Claude prompt-building. There's no
router, no component library, no state management library — just `useState`/`useEffect`/`useCallback` and
plain CSS (`src/style.css`). When making changes, find the relevant section by its `// ── Section ──`
comment banner rather than assuming a directory-per-feature layout.

Key runtime concepts:

- **Config via `localStorage`, not env vars.** The frontend has no build-time secrets. Users paste a
  Supabase edge function URL (`rc_semantic_url`) and a shared access passphrase (`rc_app_key`) into an
  in-app settings panel; both are read from `localStorage` on every request. All other edge function URLs
  (`claude`, `analytics`, `schema-builder`, `rc-proxy`) are derived from the semantic search URL via
  `siblingFnUrl()` — they're assumed to be deployed side-by-side in the same Supabase project.
- **Two search modes**: keyword search hits RC's own `portal/search-result` endpoint directly (proxied
  through `corsproxy.io` or the `rc-proxy` edge function on CORS failure — see `proxiedFetch`); semantic
  search POSTs to the user-configured Supabase `search` edge function, which does the embedding + pgvector
  lookup server-side.
- **Claude calls never touch the Anthropic API directly from the browser.** They always go through the
  `claude` edge function (`claudePost` → `siblingFnUrl(auth.semanticUrl, "claude")`), authenticated with
  the `x-app-key` header. This is what lets the app ship with no baked-in API key. `claudePost` retries
  on overload (HTTP 529) with backoff.
- **RAG context building** (`buildContext`) truncates and formats search results (and, for "deep search",
  full exposition body text fetched per-exposition) into a numbered list that's cited by Claude as `[N]`.
- Selecting expositions from results enables a per-selection conversational Q&A mode (`expoConversation`)
  that sends full exposition text as system context, distinct from the top-level RAG answer.

### Backend (`supabase/functions/`)

Deno edge functions, each a self-contained `index.ts` with no shared code between them (duplicate CORS
headers, duplicate Supabase REST calls) — that duplication is intentional per-function isolation, not an
oversight to "fix" by extracting a shared module, since Supabase deploys each function independently.

- **`search`**: embeds the query (OpenAI), calls the `match_exposition_chunks` Postgres function
  (see `pipeline/schema.sql`), dedupes to best chunk per exposition, returns ranked results. `GET` returns
  the live filter config from `pipeline_config` (for dynamically-generated filter UI, no redeploy needed).
- **`claude`**: thin authenticated proxy to the Anthropic API. Requires `x-app-key` to match the
  `APP_PASSPHRASE` secret.
- **`analytics`**: pages through all exposition metadata, computes aggregate stats, asks Claude to
  interpret them for a natural-language question.
- **`schema-builder`**: accepts an uploaded document, asks Claude to propose new extraction dimensions,
  persists them to `pipeline_config` so the pipeline's classifiers pick them up.
- **`rc-proxy`**: narrow allowlisted proxy for two RC endpoints that lack CORS headers (see
  `ALLOWED_PREFIXES`) — do not widen this without checking why it's restricted.

All functions that call Claude or read secrets gate on `x-app-key === APP_PASSPHRASE`; `search` and
`rc-proxy` (read-only, non-secret) do not.

### Pipeline (`pipeline/pipeline.py`, `pipeline/rc_extract.py`)

`pipeline.py` is the scheduled job (`.github/workflows/update-index.yml`, weekly cron + manual dispatch):
fetch exposition list from RC → for each, fetch full JSON → strip HTML from `tool-text`/`tool-simpletext`
page content → chunk (`CHUNK_SIZE=6000`, `CHUNK_OVERLAP=400`) → embed via OpenAI
(`text-embedding-3-small`) → upsert into Supabase (`expositions` + `exposition_chunks` with pgvector
column) → optionally extract structured metadata via Claude (`EXTRACTION_MODEL =
claude-haiku-4-5-20251001`) using the schema from `pipeline_config` (falls back to
`extraction_schema.json`). Re-running without `--force` skips already-indexed expositions
(`is_indexed`); a 404 from RC during fetch marks the row `unavailable` rather than treating it as a
transient failure (see the `NOT_FOUND` sentinel), which excludes it from future extraction passes.

`rc_extract.py` is a separate, standalone CLI (not invoked by `pipeline.py` or CI) for producing sampled
JSONL extraction datasets against the schema in `schema/artistic-research-extraction-schema.md` — used for
building/evaluating the extraction schema itself, not for populating the live app.

### Database (Supabase/Postgres + pgvector)

Schema lives in `pipeline/schema.sql` (base tables + `match_exposition_chunks` RPC) and
`pipeline/supabase_migration.sql` (later additive columns: `pipeline_config` table, `custom_metadata`,
`published_in`, `language`, `unavailable`). Apply these by hand in the Supabase SQL editor — there is no
migration runner. `expositions` holds one row per RC exposition (metadata + classifier dimensions +
extracted fields); `exposition_chunks` holds embedded text chunks (many per exposition, FK
`exposition_id ON DELETE CASCADE`); `pipeline_config` is a key/value store (`extraction_schema`,
`filter_config`, `classifier_config`) that both the pipeline and the edge functions read, so schema/filter
changes propagate without redeploying either side.

## Conventions

- No TypeScript in the frontend or pipeline; the Supabase edge functions are TypeScript (Deno runtime,
  no `package.json`/`node_modules` — imports are URL or built-in only).
- No test suite currently exists beyond CRA's default Jest setup (no test files present).
- Secrets are never embedded in frontend code — they're either edge-function environment secrets
  (`ANTHROPIC_API_KEY`, `APP_PASSPHRASE`, `OPENAI_API_KEY`) or user-supplied at runtime via the in-app
  settings panel (persisted to `localStorage` only).
