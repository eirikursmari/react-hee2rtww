# Status & Feasibility — Excavating Artistic Research

*Rebuilt 2026-09-01 to reflect current state. The original lived in a session
scratchpad and was lost; this version supersedes it and is the committed record.
Target: the presentation on **12 September 2026**.*

---

## 1. Status — what is built and live

| Area | State |
|---|---|
| **Semantic + keyword search** over the RC corpus | Live (pgvector, OpenAI embeddings, edge functions). |
| **Corpus Analytics** — Chart Builder (bar / trend / heatmap) + SDG Explorer | Live; charts any metadata dimension client-side. |
| **Extraction scheme v2.4** — two axes | Live across the peer-reviewed corpus. |
| ├ **Impact** (kind of *claimed* change; evidence ladder; domain scope) | Done; conservative — empty where no claim, by design. |
| └ **Relevance** (`research_themes`, `relevance_reach`, `debates_addressed`) | Done; `research_themes` is a 16-theme vocabulary **derived from the corpus itself** via BERTopic. |
| **Full re-extraction** (Sonnet, peer-reviewed scope) | Done — 888/889 expositions carry the new scheme. |
| **SDG classification** (Aurora) across the corpus | Done. |
| **Multimodal "rescue"** (image description + OCR of designed-in text) | **Proof of concept only — 1 exposition.** |

**Analysis scope:** peer-reviewed journals only (~889 of ~6,700; six venues).
This is a deliberate quality boundary, defensible in the talk.

---

## 2. Remaining before 12 September

Ordered by presentation value. Effort/risk are rough.

### 2.1 Multimodal 50-exposition test  *(effort: medium · risk: low)*
Expand the image-description + OCR pipeline from **1 → ~50** expositions as a
live demo. The pipeline exists (`rc_multimodal.py`, `load_multimodal.py`, the
`media` edge function, the app's "Images & recovered text" panel); this is a
scaled batch run, not new development. Makes the strongest visual demo — shows
the tool recovering meaning from image-only expositions that text search misses.
Cost is small (vision calls on ~50 works). **Highest-value remaining build item.**

### 2.2 Ethics assessment / local-LLM option  *(effort: low · risk: low)*
Finalize as a slide/section (substance in §3 below). No build required unless you
want to *demonstrate* a local model, which is a larger lift — recommend
presenting it as an option, not building it for the 12th.

### 2.3 Analytics scope clean-up  *(effort: low–medium · risk: medium if ignored)*
`impact_types` etc. are populated **corpus-wide (~3.6k rows) from an old v1 run**,
but `research_themes` / `relevance_reach` exist **only for the ~889 peer-reviewed**.
So the Chart Builder mixes whole-corpus legacy dims with peer-reviewed-only new
dims — the denominators differ. Before charting impact live, either:
- **(quick)** scope the analytics fetch to peer-reviewed only — one filter in the
  `analytics` function; keeps every chart on the same ~889 basis; **recommended**; or
- **(thorough)** re-extract or clear the non-peer-reviewed rows.
Left unaddressed, an impact chart would silently compare 3.6k-row impact against
889-row themes. Worth a decision.

### 2.4 Technical report  *(effort: medium · risk: low)*
`docs/excavating-artistic-research-overview.md` exists as the narrative overview.
A fuller technical writeup (architecture, the two-axis method and its rationale,
the BERTopic theme derivation, limitations) is still to write. `docs/worklog.md`
is its raw material.

### 2.5 Rotate the Supabase `service_role` key  *(effort: low · risk: low, do deliberately)*
The key was pasted in chat earlier and is unrotated. Rotating regenerates all
project keys (disruptive — edge-function secrets must be updated after), so time
it deliberately, ideally just before presenting publicly.

---

## 3. Ethics assessment

- **Data provenance.** The corpus is public RC expositions. Analysis is scoped to
  peer-reviewed journals — a transparency and quality choice, stated openly.
- **LLM extraction risk.** Structured metadata is produced by an LLM (Sonnet), so
  bias and hallucination are live concerns. Mitigations already in place: the
  extraction is deliberately **conservative** (impact only on an *explicit* claim;
  empty is a valid, common answer), the vocabulary for themes is **corpus-derived**
  rather than imposed, and evidence is tiered rather than asserted. Findings are
  positioned as *machine-assisted readings*, not ground truth.
- **Attribution & authorship.** Expositions remain their authors'; the tool
  surfaces and classifies, and should link back to originals.
- **Local-LLM option.** Running extraction on a local open model would improve
  privacy, cost, and reproducibility, at some cost to calibration quality (the
  two-model tests showed model choice matters). Recommended stance for the talk:
  present as a viable, principled alternative; not required for the current scope.

---

## 4. Deferred (post-presentation)

- **Validation study** — human-vs-model agreement on a labelled sample, to quantify
  extraction reliability.
- **Full multimodal rescue run** across the whole peer-reviewed set (beyond the
  50-exposition demo).

---

## Feasibility summary

| Item | Before Sept 12? | Effort | Notes |
|---|---|---|---|
| Multimodal 50-exposition test | Yes — recommended | Medium | Scaled batch, pipeline exists |
| Ethics slide (+ local-LLM as option) | Yes | Low | Content ready in §3 |
| Analytics scope clean-up | Yes — decide | Low–Med | Recommend scoping analytics to peer-reviewed |
| Technical report | Optional | Medium | Overview doc already exists |
| Rotate service_role key | Yes — timed | Low | Disruptive; do deliberately |
| Validation study | No — after | High | Deferred |
