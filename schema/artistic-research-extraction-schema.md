# Faceted Extraction Schema for Research Catalogue Expositions

**Version 0.1 — working draft**
Purpose: structured extraction of artistic-research metadata from RC exposition full text + existing metadata (title, abstract, open keywords). Designed for LLM-based extraction over ~6,000 JSON records, producing analysis-ready faceted data with a controlled core and an inductive overflow channel.

---

## Design principles

1. **Controlled core + open overflow.** Each facet has a closed starter list. The extractor must also return free-text candidate terms in `uncontrolled_terms` so the vocabulary can grow inductively from the corpus (hybrid deductive–inductive, same logic as a coding framework).
2. **Multi-label everywhere.** Expositions are routinely transdisciplinary; every facet accepts an array.
3. **Evidence-anchored.** Every assigned term carries a short verbatim evidence snippet and a confidence score (0–1). Terms below 0.5 confidence are flagged, not dropped.
4. **Mapping-ready.** Each controlled term names its external mapping target (AAT, COAR, LCMPT, Wikidata). Resolve actual URIs programmatically later (Getty SPARQL endpoint, id.loc.gov, Wikidata reconciliation API) — do not let the LLM generate URIs.
5. **Language-aware.** RC is multilingual. Extract in the source language, normalize to the English preferred label, record `source_language`.

---

## Facet 1 — DISCIPLINE (`disc`)

*The art-practice field(s) the research operates in. Anchored in the Vienna Declaration enumeration, extended for RC realities.*

| ID | Term | Mapping target |
|---|---|---|
| disc-01 | music — composition | AAT / Wikidata |
| disc-02 | music — performance / interpretation | AAT / Wikidata |
| disc-03 | sound art / sonic arts | AAT / Wikidata |
| disc-04 | dance / choreography | AAT / Wikidata |
| disc-05 | theatre / performance art | AAT / Wikidata |
| disc-06 | fine / visual art | AAT |
| disc-07 | film / moving image | AAT |
| disc-08 | photography | AAT |
| disc-09 | media & digital arts (incl. net art, games, AI art) | AAT / Wikidata |
| disc-10 | design (graphic, product, fashion, interaction) | AAT |
| disc-11 | architecture / spatial practice | AAT |
| disc-12 | literature / language-based practice / poetry | AAT |
| disc-13 | craft / material practice (ceramics, textiles, etc.) | AAT |
| disc-14 | curatorial practice | AAT |
| disc-15 | pedagogy / arts education as practice | Wikidata |
| disc-16 | transdisciplinary / unclassifiable | — |

---

## Facet 2 — MEDIUM & MATERIALS (`med`)

*What the work is physically/digitally made with or in. Open-ended facet: use the starter list, but free extraction is expected here more than anywhere else. All terms should later reconcile to AAT (Materials and Activities facets).*

Starter terms: voice; acoustic instrument (specify); electronics / live electronics; field recording; video; 16mm/analogue film; photographic print; installation; sculpture; painting; drawing; text / spoken word; the performing body / movement; textile; ceramic; wood; found objects; software / code; machine learning model; VR / XR; web-based work; score / notation; archive material; site (site-specific); food; light; smell / taste (multisensory).

Extraction rule: capture the **specific** term used by the author (e.g., "contrabass clarinet", "risograph") in `uncontrolled_terms` even when a broader controlled term is assigned.

---

## Facet 3 — RESEARCH MODE (`mode`)

*The relation between practice and inquiry. Frayling-derived, mutually non-exclusive.*

| ID | Term | Gloss |
|---|---|---|
| mode-01 | research **through** practice | practice is the method of inquiry |
| mode-02 | research **into** practice | practice is the object of study (incl. studying others' practice) |
| mode-03 | research **for** practice | research serves the making of work |
| mode-04 | practice-based | artefact is part of the claim to knowledge |
| mode-05 | practice-led | practice generates the questions; findings reported conventionally |
| mode-06 | mixed / hybrid mode | explicit combination with non-arts methods |
| mode-07 | reflection on completed practice | retrospective exegesis |

Rule: assign mode-01..03 only when the relation is inferable from the text; otherwise leave empty rather than guess.

---

## Facet 4 — METHOD (`meth`)

*The custom layer — no external vocabulary exists. This list is the seed of the SKOS vocabulary; expect heavy inductive growth.*

| ID | Term | Notes / near-synonyms |
|---|---|---|
| meth-01 | artistic experimentation / studio inquiry | open-ended making as method |
| meth-02 | iterative prototyping / versioning | design-derived cycles |
| meth-03 | improvisation | musical, movement, or material |
| meth-04 | composition / devising | creating new work as inquiry |
| meth-05 | scoring / notation experiments | graphic scores, instruction pieces |
| meth-06 | performance / enactment | performing as testing |
| meth-07 | documentation-as-method | photo/video/journal as epistemic device |
| meth-08 | reflective writing / journaling | diaries, logbooks |
| meth-09 | exegesis / critical reflection | accompanying analytical text |
| meth-10 | autoethnography / first-person inquiry | incl. autotheory |
| meth-11 | a/r/tography | artist–researcher–teacher inquiry |
| meth-12 | somatic / embodied inquiry | body-based knowing, movement research |
| meth-13 | walking / site-based methods | dérive, fieldwork-as-art |
| meth-14 | field recording / sonic ethnography | listening-based inquiry |
| meth-15 | participatory / co-creation | community, collective making |
| meth-16 | interviews / oral history | qualitative borrowings |
| meth-17 | archival research | incl. artistic reuse of archives |
| meth-18 | curatorial method | exhibition-making as inquiry |
| meth-19 | re-enactment / reconstruction | historically informed performance, restaging |
| meth-20 | computational / algorithmic method | generative systems, ML, data-driven |
| meth-21 | speculative / fictioning methods | design fiction, worldbuilding |
| meth-22 | collaboration with nonhumans / materials | new-materialist method talk |
| meth-23 | conventional empirical methods | surveys, experiments imported wholesale |

---

## Facet 5 — EPISTEMIC CLAIM (`epist`)

*What kind of knowledge the exposition claims to produce. Often implicit; extract conservatively.*

| ID | Term |
|---|---|
| epist-01 | tacit knowledge made explicit |
| epist-02 | embodied / somatic knowledge |
| epist-03 | material knowledge (knowing through/with materials) |
| epist-04 | propositional findings (conventional claims) |
| epist-05 | procedural / craft skill |
| epist-06 | affective / experiential insight |
| epist-07 | situated / contextual knowledge |
| epist-08 | sensory / aesthetic knowledge |
| epist-09 | critical / political intervention |
| epist-10 | methodological contribution (new way of researching) |

---

## Facet 6 — OUTPUT TYPE (`out`)

*What the exposition presents or documents. Align to COAR Resource Types v3.2 (first-level "artistic work" and narrower) at reconciliation stage.*

Starter terms: performance; concert; composition / musical work; exhibition; installation; film / video work; sound work / album; artist's book / publication; design object; software / interactive work; score; workshop / event; lecture-performance; archive / dataset; the exposition itself as the artwork (born-digital RC work); doctoral documentation; work-in-progress documentation.

---

## Facet 7 — THEORETICAL REFERENCES (`theo`)

*Two sub-extractions:*

- **theo_persons**: named theorists/artists cited as framing references (free extraction; reconcile to Wikidata/VIAF later). Examples to recognize: Deleuze & Guattari, Barad, Haraway, Merleau-Ponty, Ingold, Rancière, Benjamin, Ahmed, Cage.
- **theo_concepts** (controlled starter): phenomenology; new materialism; posthumanism; embodiment / enactivism; affect theory; decolonial / postcolonial theory; feminist theory / écriture féminine; ecology / environmental humanities; psychoanalysis; semiotics; pragmatism; systems / cybernetics; sound studies; performance studies; media archaeology.

---

## Facet 8 — CONTEXT (`ctx`)

| ID | Term |
|---|---|
| ctx-01 | doctoral / third-cycle research |
| ctx-02 | funded research project (name in `ctx_detail`) |
| ctx-03 | institutional portal publication / peer-reviewed (e.g., JAR, VIS, RUUKKU) |
| ctx-04 | self-published exposition |
| ctx-05 | pedagogical / course context |
| ctx-06 | exhibition / festival linked |
| ctx-07 | collective / group research (SIG, lab, ensemble) |

---

## Output format (per exposition)

```json
{
  "rc_id": "…",
  "source_language": ["en"],
  "facets": {
    "disc": [{"id": "disc-03", "term": "sound art", "confidence": 0.9,
              "evidence": "…verbatim snippet ≤20 words…"}],
    "med":  [],
    "mode": [],
    "meth": [],
    "epist": [],
    "out":  [],
    "theo_persons": [],
    "theo_concepts": [],
    "ctx":  []
  },
  "uncontrolled_terms": [
    {"facet": "meth", "term": "deep listening", "evidence": "…"}
  ],
  "extractor_notes": "ambiguities, multilingual issues, low-confidence flags"
}
```

## Extraction prompt rules (paste into your app's system prompt)

1. Assign only terms supported by explicit textual evidence; quote ≤20 words as evidence.
2. Multiple terms per facet allowed; empty facets allowed. Never force an assignment.
3. If a relevant concept is absent from the controlled list, put it in `uncontrolled_terms` with its facet — do not invent new controlled IDs.
4. Confidence: 0.9+ explicit statement; 0.6–0.8 strong inference; <0.6 weak inference (flag).
5. Distinguish what the *author claims* from what the extractor *infers*; prefer claims.
6. Non-English text: extract from the original, output English preferred labels, note language.

## Pipeline suggestion

1. **Pilot**: run on a stratified sample (~150 expositions across portals/years), review, revise term lists.
2. **Inductive pass**: cluster `uncontrolled_terms` (embeddings + manual review) → promote frequent stable clusters into the controlled lists → v0.2.
3. **Full run**, then **reconciliation**: map controlled terms to AAT / COAR / LCMPT / Wikidata URIs via their APIs.
4. **Publish** the resulting methods/mode vocabulary as SKOS (e.g., on Zenodo or a vocabulary server) — citable output in its own right.
