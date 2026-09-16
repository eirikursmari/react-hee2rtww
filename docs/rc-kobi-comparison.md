# RC / RCdata / KOBI vs. *Excavating Artistic Research*

*Technical-report seed. A structured comparison of the Research Catalogue's own
search-and-classification tooling — the RC portal, the RCdata interface
(`map.rcdata.org`), and the KOBI referencing system — against this project's
enrichment layers, framed around a single exemplary artefact: exposition
**4667244**, the COST Action "Artistic Intelligence" Training School. Prepared
2026-09-16. Companion to `rc-crosswalk.md` (the vocabulary mapping),
`excavating-artistic-research-overview.md` (outward account), and
`status-and-feasibility.md` (the judgement call).*

---

## 0. What could and couldn't be verified

Stated up front, because the report must be auditable:

- **RCdata Search + Keyword Map** — observed directly from screenshots of the
  live `map.rcdata.org` interface (search fields; the "by use" keyword head).
  Confident.
- **Exposition 4667244** — observed from its full RCdata JSON export (metadata,
  pages, tools). Confident on its contents (abstract, blackboard keyword cloud,
  the ten lenses, participants).
- **KOBI internals** — the "referencing table", the lemma-graph, the "Knowledge
  Universe", the augmented-reality constellation view — are **inferred** from
  the exposition's own description of the method and from prior analysis, **not**
  verified against KOBI's own documentation. The remote environment's egress
  policy blocks `researchcatalogue.net` and `map.rcdata.org`, so KOBI's tool
  pages could not be fetched. Claims about KOBI mechanics below are marked
  *(inferred)* and should be checked before the report cites them as fact.

---

## 1. Three tools, one design space

RC's ecosystem and this project are not the same kind of instrument. They sit at
different points on a single axis — from **divergent / serendipitous** discovery
to **convergent / verifiable** retrieval:

| Tool | Primary act | Position |
|---|---|---|
| **RCdata Search** | String-match over metadata | Convergent but shallow — finds what you can already name |
| **KOBI referencing / Knowledge Universe** *(inferred)* | Follow reference links between works as a visual/AR constellation | **Divergent** — surfaces unexpected correlations; idea-generating |
| **Excavating Artistic Research** | Semantic retrieval + faceted enrichment over embedded text | **Convergent + deep** — find-and-verify, with evidence for every term |

The honest framing: **KOBI and this project are complementary, not rival.** KOBI
occupies the pure-serendipity end (browse the graph, chance on a connection);
*Excavating* occupies the find-and-verify end (retrieve by meaning, filter by
audited dimension, trace provenance). That KOBI sits at the serendipity extreme
is itself an argument *for* this project — the two cover different moments of a
research process. RCdata Search is the weakest of the three at both ends: it can
neither retrieve by meaning nor surface the unexpected.

---

## 2. RC's classification model

### 2.1 Retrieval: metadata string-match

The RCdata **Search** screen is the whole retrieval model: free-text fields
(title, author, keyword, abstract), plus `portal`, `status`, `sort by`, and a
date range. There is **no semantic layer** and **no content facet** — the only
"facets" are provenance and workflow state (which portal, published vs. in
progress), not what a work is *about*. A search for `listening` returns works
whose author *typed* "listening", not works *about* listening that used other
words.

### 2.2 Vocabulary: an uncontrolled folksonomy

The **Keyword Map** is RC's content vocabulary at corpus scale: a flat,
author-supplied folksonomy of **~11,005 distinct keywords** ranked by use,
filterable by string and portal. Its genuine head is field-native and healthy —
`artistic research` (455), `performance` (261), `improvisation` (164),
`music` (158), `sound` (99), `dance` (97), … down through `voice` (68),
`listening` (67), `memory` (66). See `rc-crosswalk.md` for the full mapping onto
`research_themes`.

### 2.3 The failure mode: folksonomy pollution

Below the genuine head, the "by use" list shows an unnatural plateau — ~40 terms
at an identical **~59–61** count: `witness aesthetics`, `hauntmark theory`,
`theory of misplacement`, `aesthetic recursion`, `post-interpretive criticism`,
alongside self-referential author epithets (`dorian vale`, `founder of
post-interpretive criticism`, `independent philosopher of art`, `custodian of
witness aesthetics`, `post-aesthetic critic`, `museum of one`). The identical
counts and the self-descriptive character indicate **one contributor stuffing a
fixed ~40-term tag-set across ~60 expositions** — ≈2,400 tag instances sorted
into the upper-middle of the ranking, above real field terms. (Inference from
the visible pattern; checkable by filtering the Keyword Map to `dorian vale`.)

An uncontrolled keyword space has no defence against this: no curation, no
corpus-derivation, no evidence link. It is the clearest empirical argument for a
curated, corpus-derived vocabulary.

---

## 3. KOBI referencing / the Knowledge Universe *(inferred)*

KOBI is RC's referencing system: works are linked to one another through shared
**reference points** (a lemma-graph — a controlled-ish layer of entities/terms
that expositions cite), and the resulting network — the "Knowledge Universe" —
is **explorable as a visual constellation, including through an augmented-reality
interface**, to surface unexpected correlations between works.

Two observations for the report:

1. **KOBI's referencing is manual and intentional.** Links exist because a human
   asserted a shared reference. This is a strength (high precision, meaningful
   edges) and a limit (low coverage, labour-bound, no links a human didn't draw).
2. **It is a browsing instrument, not a retrieval one.** Its value is
   serendipity — chancing on a correlation — not answering a specific query with
   evidence.

This project has both halves of what KOBI does, but automatically and separated:
- the **entity/lemma layer** ≈ this project's **authority-file mapping**;
- the **latent-link layer** ≈ **pgvector cosine similarity** over
  `text-embedding-3-small` embeddings.

Where KOBI links explicitly and manually, this project links semantically and at
scale — at the cost of KOBI's deliberate, human-curated intent.

---

## 4. Exposition 4667244 as a classification event

4667244 is not a work with metadata applied to it; it is **a classification
event** — the documentation of a COST Action Training School (WG3, "Reference
Frameworks", Rome Fine Arts Academy, June 2026) whose purpose is to generate a
shared vocabulary and referencing method for "artistic intelligence." It
contains four distinct classification instruments:

| Instrument | What it is | Nearest analogue here |
|---|---|---|
| **Blackboard keyword cloud** | Emergent participant-generated term pile (memory, water, LLMs, hyperlocality, referencing, body, sound art, choreography, authorship, ethnography, non-human intelligence, …) | `research_themes`, *pre*-curation |
| **The ten lenses** (Resonance, Ambiguity, Locality, Transfer, Connections, Bodies, Perspective, Moving, Transition, Tool) | Reflective reading positions applied *to* works | Custom semantic categories (now shipped as lens presets) |
| **KOBI referencing / Knowledge Universe** | Manual lemma-graph of shared references | Authority-file mapping + semantic similarity |
| **COST collective impact/value framing** | "Impact and value beyond the singular outcomes of individual projects" | The IMPACT axis, stated as a research question |

The blackboard cloud independently reproduces this project's `research_themes`
head (sound/listening, voice, body/embodiment, memory & archive, ecology,
place/site). Together with the RC folksonomy head (§2.2), that is **three
independent human corroborations** of a vocabulary derived unsupervised via
BERTopic — a strong, defensible claim.

---

## 5. Point-by-point comparison

| Dimension | RCdata Search | KOBI *(inferred)* | Excavating Artistic Research |
|---|---|---|---|
| **Retrieval** | Metadata string-match | Graph browsing / AR constellation | Semantic (pgvector) + keyword |
| **Content facets** | None (portal/status/date only) | Reference links | IMPACT + RELEVANCE dims, SDG |
| **Vocabulary** | 11,005-term uncontrolled folksonomy | Manual reference lemmas | 16-value corpus-derived, curated |
| **Pollution resistance** | None (demonstrably polluted) | High (manual) but low coverage | Structural (BERTopic + curation) |
| **Evidence discipline** | Tag = assertion | Link = assertion | `impact_evidence_level` ladder (asserted → documented → externally validated) |
| **Two-axis separation** | — | — | IMPACT (has evidence) vs RELEVANCE (no evidence) |
| **Multimodal reach** | Typed metadata only | — | Image descriptions + OCR'd designed-in text, embedded and searchable |
| **Scale / automation** | Whole corpus, manual tags | Manual links | ~889 peer-reviewed deep-extracted; semantic index automatic |
| **Best at** | Known-item lookup | Serendipity / divergent discovery | Find-and-verify / convergent, auditable |

---

## 6. Where this project goes further

1. **Evidence discipline.** RC/KOBI/COST all treat a tag or a claim as a fact.
   The IMPACT axis refuses to: impact must be an *explicit textual claim*, never
   inferred, and `impact_evidence_level` records only the strongest tier that
   the impact *itself* occurred. Their vocabulary cannot tell you whether a
   claimed change happened; this schema is built around that distinction.
2. **Two-axis separation.** 4667244 blends positioning and impact freely (the
   lenses are positioning, the abstract is impact, the cloud is both). The
   deliberate split — RELEVANCE carries no evidence level, IMPACT does — is a
   conceptual advance over the undifferentiated pile.
3. **Scale + reproducibility.** The blackboard is one room, one week; the
   folksonomy accretes unchecked. `research_themes` is re-runnable over 877
   peer-reviewed expositions with per-term provenance retrievable via chunks.
4. **Multimodal recovery.** Nothing in RC/KOBI recovers designed-in text from
   images. This project would ingest a blackboard photo like 4667244's own
   keyword cloud as searchable OCR'd text.

## 7. Where RC/KOBI go further (honest)

1. **Coverage.** The folksonomy spans all ~6,671 works and every portal; KOBI's
   graph spans whatever has been referenced. This project deep-extracts ~889
   peer-reviewed works. Breadth is theirs.
2. **Intentionality.** KOBI's links are human-asserted and meaningful; semantic
   similarity is inferred and occasionally spurious. Precision of *intent* is
   theirs.
3. **Serendipity.** The AR constellation is a genuinely different affordance —
   divergent, browsing-first discovery this project does not attempt.

---

## 8. Interoperability plan

1. **Publish the `research_themes` ↔ folksonomy crosswalk** (`rc-crosswalk.md`)
   as the mapping surface — curated themes expressed in RC's own genuine
   high-frequency terms, dropping the noise. Offer **RELEVANCE** as the bridge.
2. **Adopt the ten lenses as retrieval-side overlays**, not schema fields — done:
   shipped as custom-category presets (see PR). Reading positions belong on the
   query side, not in extraction.
3. **KOBI as an export target** *(inferred, dependent on KOBI's ID scheme):* if
   KOBI exposes lemma/reference IDs, the authority-file mapping could emit
   KOBI-compatible reference edges, feeding semantically-discovered links into
   the Knowledge Universe.
4. **Keep the IMPACT axis unmapped.** The COST/KOBI framing is aspirational;
   folding it in would import exactly the asserted-as-fact conflation the
   evidence ladder exists to prevent. Interoperate on positioning, not on impact.

---

## 9. Open items before this becomes report prose

- Verify the KOBI *(inferred)* claims against KOBI's own documentation (needs
  network access to `map.rcdata.org`, currently egress-blocked).
- Confirm the pollution-cluster inference by filtering the Keyword Map to
  `dorian vale`.
- Fill the six "tail-only" crosswalk rows (place/site, ecology, urban/social,
  digital/AI, writing/language, time/duration) from the folksonomy tail.
- Decide whether to cite 4667244 by name (it is a real, attributed exposition —
  Daniele Pozzi et al.); if so, frame the pollution finding about the *anonymous*
  cluster carefully and separately from 4667244 itself.
