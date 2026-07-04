# Project Memory

An append-only log of decisions, gotchas, and context worth remembering across sessions for the
RC project. Unlike `state.md`, entries here don't get deleted when things move on — they explain
*why* something is the way it is, so nobody re-litigates or accidentally "fixes" it later. Add a
dated entry when you make a non-obvious decision or discover a quirk; don't rewrite old entries,
append new ones (strike through only if a later decision fully supersedes one).

Format: `## YYYY-MM-DD — Title`, one paragraph.

---

## 2026-07-04 — state.md / memory.md introduced

Split "current state" and "durable memory" into separate files rather than one running doc:
`state.md` is a snapshot that gets overwritten as the project evolves; this file is an append-only
log. Both are manually referenced (not auto-loaded from `CLAUDE.md`) — read them explicitly at the
start of a session if you want them in context.

## Edge function duplication is intentional

`supabase/functions/*/index.ts` each duplicate their own CORS headers and Supabase REST calls
rather than sharing a module. This is deliberate: Supabase deploys each function independently, so
a shared module would need its own publish/versioning story for no real benefit at this scale.
Don't "clean this up" by extracting a shared lib.

## RC 404s are terminal, not transient

`pipeline.py`'s `fetch_expo_json` distinguishes a definitive 404 (`NOT_FOUND` sentinel) from other
fetch failures (timeout, DNS, etc). Only a 404 marks the exposition `unavailable` in Supabase,
which excludes it from future extraction passes. A network blip must never trip this path, since
it would wrongly and permanently write off an exposition that's actually fine.

## Vercel deployment is disabled on purpose

`vercel.json`'s `ignoreCommand` unconditionally echoes and exits, so Vercel never builds this repo
even if a Vercel project is still wired to it. `api/search.js` is kept only because it duplicates
`supabase/functions/search` logic for that dormant path — it is not the canonical backend and
changes to `supabase/functions/search` do not need to be mirrored there unless someone explicitly
revives the Vercel deployment.

## `rc-proxy`'s allowlist is narrow by design

`ALLOWED_PREFIXES` in `supabase/functions/rc-proxy/index.ts` only covers two RC endpoints
(`portal/search-result`, `rcjson/expo/`). It's an open proxy otherwise, so widening it is a real
exposure — anyone can make the edge function fetch any URL matching an allowed prefix. Don't add a
prefix without checking it's actually needed and can't be abused to hit internal/unintended hosts.

## No secret gate on `search` and `rc-proxy`

Unlike `claude`, `analytics`, and `schema-builder`, the `search` and `rc-proxy` edge functions
don't check `x-app-key`. This is intentional — neither reads a paid/rate-limited secret or an
Anthropic key, so there's nothing to protect by gating them, and gating would just add friction
for no security benefit.

## Claude retries only on overload, not other errors

`claudePost` (`src/App.js`) retries with backoff (3s/6s/12s) specifically on HTTP 529 / overloaded
responses. Other 4xx/5xx errors surface immediately rather than retrying — most of those (bad
request, auth failure) won't resolve by waiting, so blind retries would just mask a real
misconfiguration (e.g. wrong `x-app-key`, malformed body) behind a delay.

## Migrations are hand-applied, not scripted

`pipeline/schema.sql` and `pipeline/supabase_migration.sql` are meant to be pasted into the
Supabase SQL editor manually — there is no migration runner in this repo. If you add a new column
or table, add the `ALTER TABLE ... IF NOT EXISTS` (or equivalent idempotent) statement to one of
these files so the next person applying migrations by hand doesn't have to hunt through git
history for what changed.
