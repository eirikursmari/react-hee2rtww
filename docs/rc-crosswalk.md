# RC folksonomy ↔ `research_themes` crosswalk

*Seed material for the technical report. Maps the v2.4 `research_themes`
vocabulary (16 curated, corpus-derived values) onto the Research Catalogue's
author-supplied keyword folksonomy, as a vocabulary bridge for interoperability
and as evidence for the curated-vs-accreted argument. Prepared 2026-09-16.*

## Sources

- **Your side** — the 16 `research_themes` values in
  `pipeline/extraction_schema.json` (v2.4), derived from the ~877 peer-reviewed
  expositions via BERTopic and then curated. These are RELEVANCE concerns, kept
  deliberately distinct from method (`methods_described`), discipline, and
  impact.
- **RC side** — the `map.rcdata.org` **Keyword Map**: a flat, uncontrolled
  folksonomy of **~11,005 distinct author-supplied keywords** ranked by use.
  The counts below are from the visible "by use" head of that list. RC's
  **Search** screen is pure metadata string-match (title / author / keyword /
  abstract + portal / status / date) — there is no semantic layer and no
  content facet, so this folksonomy *is* RC's whole-corpus content vocabulary.

The crosswalk covers the visible **head** of the RC distribution. The ~11k-term
tail is unverified (see caveat 2).

## Crosswalk

| # | `research_themes` value | RC folksonomy terms (by-use count) | Fit |
|---|---|---|---|
| 1 | sound, listening & the sonic | sound (99), sound art (84), listening (67) | Direct |
| 2 | voice & the vocal | voice (68) | Direct |
| 3 | music & performance practice | performance (261), improvisation (164), music (158), composition (140), piano (60) | Rich — RC's densest zone (but see caveat 3) |
| 4 | time, duration & repetition | — *(not in visible head)* | Tail only |
| 5 | body, movement & embodiment | dance (97), embodiment (71) | Direct |
| 6 | place, landscape & site | — *(not in visible head)* | Tail only |
| 7 | urban space, the public & the social | — *(not in visible head)* | Tail only |
| 8 | ecology & the more-than-human | — *(not in visible head)* | Tail only |
| 9 | material practice & making | design (71) | Partial — design ≈ making, loosely |
| 10 | drawing, diagram & the graphic | drawing (75) | Direct |
| 11 | photography, image & the visual | photography (89), visual art (69), visual culture studies (60) | Direct |
| 12 | digital, computation & AI | — *(not in visible head)* | Tail only |
| 13 | writing, language & translation | — *(not in visible head)* | Tail only |
| 14 | memory & the archive | memory (66) | Direct |
| 15 | indigenous, community & decolonial knowledge | collaboration (91) *(partial)* | Weak — collaboration is a mode, not this theme |
| 16 | artistic-research method & pedagogy | *(meta-labels only — see orphan block)* | Not thematic in RC |

## RC head terms with no theme home

The analytically important half. Roughly a third of the RC head maps to a theme;
the rest is non-thematic by kinds the v2.4 schema **deliberately** excludes.

| RC term (count) | Kind | Why it has no theme |
|---|---|---|
| artistic research (455), art (161) | Disciplinary self-label / too generic | Themes describe *concerns*, not the field itself |
| aesthetics (96), art theory (73), contemporary aesthetics (63), phenomenology and art (59), visual culture studies (60) | Discipline / theory labels | Exactly the `fields_engaged` dimension dropped in v2.4 for being "too academic". RC's folksonomy is full of them; themes capture what works are *about*, not which theory shelf they sit on |
| improvisation (164), collaboration (91) | Modes / methods | Belong to `methods_described`, not RELEVANCE themes |
| witness aesthetics (61), hauntmark theory (61), theory of misplacement (61), aesthetic recursion (61), post-interpretive criticism (63), dorian vale (60), founder of post-interpretive criticism (60), custodian of witness aesthetics (60), independent philosopher of art (60), post-aesthetic critic (59), + ~30 more at 59–61 | Single-contributor pollution cluster | No theme, no field — noise the curation is immune to (see below) |

### The pollution cluster

Below the genuine head, the "by use" list shows an unnatural plateau of ~40
terms at **exactly 59–61**. Two tells indicate a single contributor stuffing a
fixed tag-set across ~60 expositions:

1. **Counts cluster at one value.** A real folksonomy tail is a smooth
   power-law; a spike of ~40 distinct terms at an identical count is the
   signature of the *same batch of works* carrying the *same tag list*.
2. **The terms are self-referential author epithets, not research concepts** —
   "dorian vale", "founder of post-interpretive criticism", "independent
   philosopher of art", "custodian of witness aesthetics", "art writer and
   theorist", "post-aesthetic critic", "museum of one" — describing a person
   and their coined -isms, riding alongside invented "-theory"/"-aesthetics"
   neologisms (hauntmark, stillmark, absential, aesthetic recursion,
   message-transfer).

This is an inference from the visible pattern, not a certainty, but it is
checkable: filter the Keyword Map to `dorian vale` (or search that author) and
the same ~60 expositions should carry the whole cluster.

**Effect on RC's vocabulary.** An uncontrolled keyword space lets one prolific
contributor inject ~40 neologisms x ~60 works ≈ **2,400 tag instances** that
sort into the upper-middle of the "by use" ranking — above real field terms.
The folksonomy has no defense: no curation, no corpus-derivation, no evidence
link. `research_themes` is immune by construction (BERTopic over the
peer-reviewed corpus, then curated to 16 values), so a single author's coinages
cannot colonise the vocabulary.

## What the crosswalk shows

1. **Where RC and this project agree, they agree cleanly.** The seven Direct
   rows (sound, voice, music/performance, body, drawing, photography, memory)
   are both the genuine head of RC's distribution and the pipeline's
   highest-frequency themes. Together with the COST Action "Artistic
   Intelligence" blackboard keyword cloud (exposition 4667244), this is a
   **third independent human corroboration** of a vocabulary derived
   unsupervised.
2. **The orphan/partial rows are the schema working as designed.** RC's
   folksonomy cannot distinguish a *concern* (embodiment) from a *discipline*
   (aesthetics), a *method* (improvisation), or *noise* (hauntmark theory) —
   all sit in one flat frequency list. The three-way separation (themes =
   RELEVANCE, methods = `methods_described`, and no room at all for
   self-promotional coinage) is precisely the structure the folksonomy lacks.

## Caveats

1. **Loose mappings are marked, not forced.** `design (71) → material practice`
   and `collaboration (91) → indigenous/community` are partial; they are not
   clean equivalences.
2. **Head only.** Place/site, ecology, urban/social, digital/AI,
   writing/language, and time/duration are absent from the *visible* RC head but
   almost certainly live in the ~11k-term tail (RC's most prolific taggers skew
   music / sound / performance / visual). Confirm by sorting the Keyword Map
   `alphabetical` or using the keyword filter, then extend rows 4, 6, 7, 8, 12,
   13.
3. **A crosswalk is a vocabulary bridge, not an auto-labelling rule.** Per the
   v2.4 prompt, RC's large `performance` / `improvisation` counts do **not**
   automatically imply theme #3 ("being a musical work is not automatically
   'music & performance practice'"). A naive tag-to-theme port would
   over-assign #3.

## Interoperability recommendation

Publish this table (or its Direct-row subset) as the mapping surface between the
project's curated `research_themes` and RC's genuine high-frequency tags — a
clean interoperability story that drops the folksonomy noise. Offer RELEVANCE as
the bridge; keep the IMPACT axis unmapped (RC/KOBI framing is aspirational and
would import the asserted-as-fact conflation the evidence ladder exists to
prevent).
