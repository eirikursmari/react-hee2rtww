# Status & Feasibility

*Internal planning assessment for the **12 September 2026** presentation.*
*Prepared 2026-09-01 — ~11 days out. Companion to `excavating-artistic-research-overview.md` (the outward-facing account) and `worklog.md` (the day-by-day). Where they disagree, the worklog and `CLAUDE.md` are the record of fact; this file is the judgement call.*

---

## 1. Verdict

**The presentation is feasible with the system as it stands today.** The tool is built, deployed, and live end-to-end: semantic + keyword search, faceted filtering, custom categories, Corpus Analytics with a working research-themes temporal view, and a demonstrated multimodal recovery. Nothing on the critical path to a credible live demo is unbuilt.

The real work between now and the 12th is **not construction — it is honesty and polish**: making sure every claim made on stage is one the current data actually supports, closing two known correctness/security gaps, and rehearsing the demo so it doesn't depend on a flaky live call. Treat the remaining items as *risk reduction*, not feature work.

The one genuine hazard is the **unrotated `service_role` key** (§5). It doesn't block the demo, but it should be handled deliberately before the presentation, not during it.

---

## 2. Status by component

Maturity labels: **Done** (built, deployed, verified) · **Working, with caveats** (functional but carries known debt) · **Deferred** (scoped out for now, not on the critical path).

| Component | State | Notes |
|---|---|---|
| Frontend (CRA → GitHub Pages) | **Done** | Live at base path `/react-hee2rtww/`; auto-deploys from `main`. |
| Edge functions (search, analytics, claude, media, schema-builder, rc-proxy) | **Done** | All deployed `--no-verify-jwt`. The app now calls `search` directly (repointed from the historical `swift-processor`). |
| Data store (Postgres + pgvector) | **Done** | `expositions`, `exposition_chunks`, `pipeline_config`; `match_exposition_chunks` RPC. |
| Extraction pipeline (v2.4, Sonnet) | **Done** | Full peer-reviewed re-extraction complete: 888/889 have `research_themes`, 887 `relevance_reach`. |
| Two-axis schema (Impact / Relevance) | **Done** | Finalised at v2.4 after three relevance iterations; migration run. |
| Semantic + keyword search | **Done** | Embedding = OpenAI `text-embedding-3-small` (1536-dim), cosine; best-chunk-per-exposition dedupe. |
| Corpus Analytics + Chart Builder | **Working, with caveats** | Research-themes temporal view + truncation fix landed 2026-09-01. See denominator caveat, §4.1. |
| SDG Explorer | **Done** | Aurora SDG classification across the corpus; collapsible, closed by default. |
| Multimodal extension | **Working, with caveats** | Image description + designed-in-text transcription, provenance-tagged. Validated on **one** case; a full rescue run is deferred (§4.3). |
| Technical report | **Deferred** | Not written. `CLAUDE.md` is its seed. Not required for the presentation itself. |

---

## 3. What remains before 12 September

Ordered by priority, not effort. Items 1–2 are the ones that touch what gets said on stage.

1. **Reconcile every on-stage claim to the data's real denominators.** The single biggest correctness risk is stating a corpus-wide figure that only holds for the ~889 peer-reviewed subset, or vice-versa. See §4.1.
2. **Decide and time the `service_role` key rotation.** Security hygiene; disruptive because it regenerates all project keys. See §5.
3. **Rehearse the demo against the live system**, including a fallback if an Anthropic/OpenAI call is slow or rate-limited mid-demo (pre-run the queries you intend to show).
4. **Freeze scope.** Everything in §4.2–§4.4 is deferred *on purpose*; the honest framing (§6) already accounts for it. Resist adding features in the final week.

---

## 4. Feasibility of the open items

### 4.1 Analytics denominator mismatch — *address, low effort, high payoff*

`impact_types` and the SDG dims are populated **corpus-wide** (~3.6k rows, from an older v1 run); `research_themes` / `relevance_reach` exist **only for the ~889 peer-reviewed** (v2.4). Corpus Analytics therefore charts legacy whole-corpus dims alongside peer-reviewed-only new dims with **different denominators**.

- **Feasible in the time?** Yes — this is a labelling/framing fix, not a re-extraction. The analytics function and Chart Builder already scope the theme/reach views to the peer-reviewed subset with a denominator note (done 2026-09-01). What remains is to make sure the *narrative* on stage never blurs the two.
- **Clean fix (out of scope for now):** re-extract or clear the non-peer-reviewed impact rows so every dimension shares one denominator. That's a cost/time call, not required for the 12th.
- **Recommendation:** ship as-is with the denominator note; in the talk, state the peer-reviewed scope (~889 of 6,671, ~13%) explicitly before showing any theme chart.

### 4.2 Full-corpus media survey — *keep deferred*

The overview reports media-heaviness proportions from a **small sample**, flagged as indicative. A full-corpus survey is pending.

- **Feasible in the time?** Possibly, but not worth the risk. The overview already hedges this correctly ("indicative rather than established").
- **Recommendation:** leave deferred; keep the hedge. Do not upgrade "indicative" to "established" on stage.

### 4.3 Full multimodal rescue run — *keep deferred*

Multimodal recovery is validated on **one** exposition (the empty-text work recovered from its images). A full run across all image-bearing works is deferred.

- **Feasible in the time?** No — a full multimodal run needs a calibration pass on coverage and cost first (already on the Future Directions list). Not achievable credibly in 11 days.
- **Recommendation:** present the one validated case as a *proof of concept*, explicitly framed as such. It is a strong demo precisely because it's honest.

### 4.4 Validation study & technical report — *keep deferred*

Neither is on the critical path for the presentation.

- **Recommendation:** defer both. If time appears, spend it on §3 items 1–3, not these.

---

## 5. Risks & mitigations

| Risk | Severity | Mitigation |
|---|---|---|
| **`service_role` key was pasted in chat and is unrotated.** | High (security) | Rotate deliberately before the presentation. It regenerates *all* project keys — schedule it so the redeploy/reconfigure has settling time, not the morning of. |
| Live LLM/embedding call slow or rate-limited mid-demo. | Medium (demo) | Pre-run the exact queries you'll show; have screenshots/recording as fallback. |
| Overstating scope (corpus-wide vs peer-reviewed-only; multimodal one-case vs general). | Medium (credibility) | §4.1 / §4.3 framing; rehearse the wording. |
| Edge functions don't auto-deploy (only the frontend does). | Low | Any last-minute analytics/search change must be manually redeployed; use the `mode:"stats"` probe to confirm the live build. |
| RESEARCH THEMES BY JOURNAL shows 8 rows not 6 (venue-phrase overlap). | Negligible | 5–6 of 889; documented in worklog; leave as-is. |

---

## 6. The honest position to present

The tool's credibility rests on being **auditable, not infallible** — evidence for every extracted term, provenance for every chunk, and a stated limitation for every capability (per the overview §7). The status above is consistent with that stance:

- The **analytical core is done and live** — this is a working system, not a mockup.
- The **peer-reviewed scope (~889, ~13%)** is a deliberate analysis boundary, stated plainly, not a limitation to hide.
- **Multimodal recovery is a validated proof of concept**, not yet a corpus-wide capability — and saying so is stronger than implying otherwise.
- The **deferred items** (full media survey, full multimodal run, validation study, technical report) are named, scoped, and sequenced — evidence of judgement, not gaps.

Present what is built as what it is. It is enough.

---

*Update this file when a status changes or an open item closes — not on a clock.*
