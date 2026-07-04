# Project State

A point-in-time snapshot of the RC (Research Catalogue search) project. This file gets
overwritten as things change — it describes "where things stand now," not history. For durable
decisions and gotchas that don't change, see `memory.md`. For architecture/conventions, see
`CLAUDE.md`.

_Last updated: 2026-07-04_

## What's built and working

- **Keyword search** — direct proxy to RC's `portal/search-result` endpoint (via `corsproxy.io`
  or the `rc-proxy` edge function on CORS failure).
- **Semantic search** — pgvector similarity search over indexed exposition chunks, via the
  `search` edge function, with dynamic filter dimensions read from `pipeline_config`.
- **RAG answer panel** — Claude answers a query citing retrieved expositions by `[N]`, for both
  search modes; "deep search" additionally fetches full exposition body text for up to 5 results.
- **Per-exposition conversational Q&A** — select expositions, ask follow-up questions with full
  text as context, conversation history retained in-session.
- **Corpus analytics chat** — aggregate stats over the whole indexed corpus, interpreted by
  Claude, with follow-up/conversation support.
- **Custom classifiers** — user-configurable external classifiers (e.g. Aurora SDG) run by the
  pipeline, editable via the in-app settings panel.
- **Schema builder** — upload a document, Claude proposes new extraction dimensions, persisted to
  `pipeline_config` so the pipeline's classifiers pick them up without a redeploy.
- **Indexing pipeline** — `pipeline.py` crawls RC, chunks + embeds text, extracts structured
  metadata via Claude; runs weekly via GitHub Actions (`update-index.yml`) plus manual dispatch
  with `--force` / `--extract-only` / `--limit` inputs.

## Recent work (most recent first)

- Fixed Vercel preview builds failing on every push: replaced the non-working
  `ignoreCommand` echo trick with `git.deploymentEnabled: false` in `vercel.json`, which actually
  stops the deployment from being created (see `memory.md` for why the old approach didn't work).
- Added `state.md` and `memory.md` for cross-session project context.
- Added `CLAUDE.md` documenting architecture and dev workflows.
- Added fetch mode to `rc_extract.py` (no local JSON files needed) and the faceted extraction
  schema doc (`schema/artistic-research-extraction-schema.md`).
- Replaced hard category intersection with score blending in semantic search ranking.
- Moved Claude calls server-side (`claude` edge function) and added the `rc-proxy` edge function
  so the app needs no baked-in API key and CORS-blocked RC endpoints are reachable.
- Made `--extract-only` more robust: retries rows with empty `research_approach`, no longer
  depends on `map.rcdata.org` being reachable.
- Added `unavailable` tracking for expositions whose content has been removed from RC (404s).

## Known issues / open items

None currently tracked (no open GitHub issues or PRs as of this writing). No test suite exists
beyond CRA's default Jest setup — untested surface area if you're making non-trivial frontend
changes.

## Deployment status

- Frontend: GitHub Pages, deployed via `.github/workflows/deploy.yml` on push to `main`.
- Supabase edge functions: deployed independently via Supabase CLI — **not** part of this repo's
  CI. Verify a function is actually redeployed after editing its `index.ts`.
- Vercel path (`api/search.js`, `vercel.json`) is intentionally disabled
  (`git.deploymentEnabled: false` in `vercel.json`) — treat as a legacy fallback, not the live deployment.

## How to keep this file useful

Update it when: a feature ships, a deployment target changes, or a known issue is found/fixed.
Don't let it grow into a changelog — prune completed/stale entries under "Recent work" rather than
appending forever.
