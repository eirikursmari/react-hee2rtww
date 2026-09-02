# Working from an iPad (travel checklist)

Reference for running this project with only an iPad Pro, up to the
**12 Sept 2026** presentation. The collaborative part (Claude Code on the web +
this chat) runs in a cloud container you drive from the browser, so most work is
iPad-native. The one hard dependency is **SSH access to the server**
(`ubuntu-4gb-fsn1-1`) for pipeline runs and edge-function deploys.

## Before you travel

- [ ] **Install an SSH client** — Blink Shell or Termius (both good on iPad).
- [ ] **Test it now, away from your usual setup:** SSH in and run
      `cd ~/react-hee2rtww && git status` to confirm your key/access works.
- [ ] **Learn `tmux`** for long jobs on flaky wifi: start with `tmux`, run the
      job, detach with `Ctrl-b d`, reattach later with `tmux attach`. Combine
      with `nohup` so jobs survive a dropped connection.
- [ ] A Bluetooth/Magic Keyboard makes SSH + multi-tab much easier (optional).
- [ ] If you can, clear the server-side open items (below) before losing your
      usual connection — or at least confirm SSH works.

## Works iPad-only — no server needed

- **Code & doc changes** — ask in the Claude Code web chat; it edits in the
  cloud, opens/merges a PR, and the **frontend auto-deploys to GitHub Pages**.
  App.js / style.css / docs never touch your server.
- **Using the app** (live on Pages), the **Supabase dashboard** (SQL editor,
  edge-function secrets), **Canva**, and the published artifacts — all web apps.
- **GitHub** — review/merge PRs at github.com in Safari if you prefer.

## Needs the server (SSH from the iPad)

Claude Code's cloud container has **no access to your VPS or `~/rc-keys.env`**,
so these are always "you, via terminal":

- **Deploying edge functions** (search / analytics / claude / media / …):
  ```bash
  cd ~/react-hee2rtww && git pull
  npx supabase@latest functions deploy search --no-verify-jwt --project-ref tnxmralkmylmkeesblvj
  ```
  (swap `search` for the function you changed; edge functions do **not**
  auto-deploy — only the frontend does.)
- **Pipeline runs** — always `source ~/rc-keys.env` first:
  ```bash
  source ~/rc-keys.env
  # size the multimodal rescue cohort (free, no API calls):
  python3 pipeline/scope_rescue.py
  # top up never-extracted rows:
  python3 pipeline/pipeline.py --extract-only --pending-only --model claude-sonnet-4-6
  ```
- **Verify a deploy** (search fn needs no passphrase):
  ```bash
  curl -s -X POST "https://tnxmralkmylmkeesblvj.supabase.co/functions/v1/search" \
    -H "Content-Type: application/json" \
    -d '{"query":"trumpets in Roman sinfonia","limit":5}' \
    | grep -oE '"(title|media_count)":("[^"]*"|[0-9]+)'
  ```

## Key rotation — time it deliberately

The Supabase `service_role` key still needs rotating before the presentation.
It regenerates **all** project keys (disruptive), so do it on a **stable
connection**, not in transit. Afterwards: update `~/rc-keys.env`, re-set the
edge-function secrets in the Supabase dashboard, and redeploy the functions.

## Remaining open items — where each runs

| Item | Where |
|---|---|
| Further app / doc / chart changes | iPad-only (chat → PR → Pages) |
| Size the full multimodal rescue (`scope_rescue.py`) | server (SSH) |
| The ~169 extracted-but-empty rows | server (SSH) |
| Full multimodal rescue run | server (SSH) |
| Rotate the `service_role` key | Supabase dashboard (web) + server redeploy |
| Present the deck | Canva on iPad; app live on Pages |

**Bottom line:** get an SSH client working before you leave and the whole
workflow — collaboration in the cloud, server tasks over SSH — is fully
iPad-capable through the 12th.
