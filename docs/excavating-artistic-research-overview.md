# Excavating Artistic Research
### A Semantic Interface to the Research Catalogue

*Report for cross-disciplinary readers, v1.*

---

## 1. Overview

**Excavating Artistic Research** is a search and analysis interface for the **Research Catalogue (RC)**, the international repository of artistic research hosted at researchcatalogue.net. It lets a researcher move through roughly 6,500 "expositions" — the multimedia research documents artists publish on RC — not only by matching words, but by matching *meaning*, and increasingly by reaching content that lives inside images and sound rather than in prose.

The problem it addresses is simple to state and hard to solve: artistic research resists the keyword. Its vocabulary is unstable, multilingual, and often deliberately non-propositional; its arguments are frequently made *through* practice — a performance, a score, a photographic series — rather than stated in an abstract. A conventional search engine indexes the words an author happened to type. This tool tries to index what an exposition is *about*.

---

## 2. Objectives

**2.1 The research need.** Keyword search rewards authors who describe their work in the reader's terms. In artistic research that assumption breaks down: two expositions on the same concern — say, grief and listening — may share no vocabulary at all, while the same word ("score", "site", "voice") means different things across disciplines. The tool is built to surface conceptual neighbours that keyword search would never connect, and to make the collection's implicit structure explicit.

**2.2 Intended users and use cases.** Three audiences, three modes of use:

- **Researchers and artists** discovering related work across disciplinary boundaries.
- **Supervisors, examiners, and institutions** surveying how a field, method, or theme is represented across the corpus.
- **Meta-researchers** asking questions *of the collection as a whole* — how a method has spread, which theoretical references recur, what the corpus is made of.

---

## 3. The Data

**3.1 Source and scale.** The corpus is the public Research Catalogue: ~6,500 available expositions spanning music, performance, visual and media arts, design, and more. Text and structure are drawn from a research mirror of RC's data; media (images, audio, video) are referenced on RC's own servers and retrieved live when needed.

**3.2 Structure.** Each exposition carries three kinds of content:
- **Metadata** — title, author, abstract, keywords, date, portal/journal.
- **Full text** — the prose woven through the exposition's pages.
- **Media** — the images, audio, and video that, for a large minority of works, *are* the research.

A preliminary survey of a small sample suggests that a substantial share of expositions are media-heavy — many combining images, audio, and video, and some so text-sparse that prose alone barely represents them. A full-corpus survey is still pending and these proportions should be read as indicative rather than established; even so, the media-rich portion is clearly large enough to matter, and it is what drives the multimodal work in §6.

**3.3 The pipeline.** An ingestion pipeline fetches each exposition, extracts its text, generates a numerical representation of that text (see §5.2), classifies it against a controlled vocabulary (§4), and stores everything in a database (PostgreSQL with the `pgvector` extension for similarity search). The index is refreshed on a schedule so new expositions are picked up as they are published.

---

## 4. Structuring the Corpus: Extraction and Controlled Vocabularies

Before search, the corpus is *structured*. A large language model reads each exposition and assigns it terms from a **faceted extraction schema** — a curated framework of the dimensions along which artistic research varies.

**4.1 The facets.** The schema organises meaning into distinct facets, each a controlled list of terms:

| Facet | What it captures |
|---|---|
| Discipline | the art-practice field(s) |
| Medium & materials | what the work is made with or in |
| Research mode | how practice relates to inquiry (through / into / for practice) |
| Method | the concrete techniques of inquiry |
| Epistemic claim | what *kind* of knowledge is claimed |
| Output type | what the exposition presents |
| Theory | theorists and concepts invoked |
| Context | doctoral, funded, peer-reviewed, and so on |

**4.2 Controlled core, inductive overflow.** Each facet has a closed starter list *and* an open channel: the extractor must also return free-text candidate terms it could not fit. The vocabulary therefore grows from the corpus rather than being frozen in advance — a hybrid of top-down framework and bottom-up coding.

**4.3 External anchoring.** Controlled terms name their mapping targets in established authority files — the Getty Art & Architecture Thesaurus (AAT), COAR resource types, LCMPT, and Wikidata. This makes the tool's categories *interoperable* with the wider cultural-heritage data ecosystem rather than private to this project.

**4.4 Evidence, confidence, provenance.** Every assigned term carries a short verbatim quotation as evidence, a confidence score, and — since the multimodal work — a record of *which modality* it came from. Nothing is asserted without something a human can check. This audit trail is central to the tool's claim to trustworthiness (§7).

---

## 5. Search Functions

**5.1 Keyword search.** Direct term matching against titles, metadata, and RC's own index. Precise and predictable — the right tool when you know the exact word, name, or phrase. Its limitation is exactly its literalism: it cannot see past vocabulary.

**5.2 Semantic search — the semantic mapping.** This is the heart of the tool. Each chunk of text — an abstract, a passage of prose, an image description — is passed through an **embedding model** that converts it into a vector: a list of 1,536 numbers locating that text as a single point in a high-dimensional "meaning space." Texts about similar things land near one another, *regardless of shared words*. "Grief and hearing loss" and "mourning through listening" sit close together even with no vocabulary in common.

A search works by embedding the query the same way and returning the corpus points nearest to it, measured by cosine similarity (the angle between vectors). In practice the tool:

1. splits each exposition into overlapping chunks and embeds each one;
2. embeds the incoming query;
3. retrieves the nearest chunks across the whole corpus;
4. keeps each exposition's single best-matching chunk, so one text-rich work cannot flood the results;
5. optionally re-ranks by blending in user-defined "custom categories" (see 5.4).

Because meaning is captured numerically rather than lexically, semantic search is naturally **multilingual and paraphrase-robust** — and, crucially, it extends to any text the tool can generate *about* non-textual content, which is what makes §6 possible.

**5.3 Corpus / analytical query.** Beyond retrieving individual works, the tool can query the collection as an object of study — summarising what a set of results has in common, tracing a theme across the corpus, or answering a question grounded in the retrieved expositions with citations back to them. This turns search into a lens on the field, not just a finding aid.

**5.4 Custom categories and faceted filters.** Users can narrow results with the controlled facets of §4 (discipline, medium, method, and so on) and can define their own semantic categories on the fly — a short description that the tool embeds and blends into the ranking, re-weighting results toward a dimension the user cares about without excluding everything else.

---

## The two senses of "semantics"

*A note for a mixed-field audience, because the word does double duty in this tool and the two meanings come from different intellectual traditions.*

The tool operates on **meaning** in two fundamentally different ways, and naming them apart prevents a great deal of cross-talk.

**Controlled semantics** (§4) is the librarian's and humanist's sense: meaning as *category*. A human-curated vocabulary of discrete terms, each defined, each mapped to an authority file. Its model of meaning is "does this term apply?" Its virtues are precision, transparency, and interoperability — you can see exactly why a work was tagged, and the tag means the same thing here as in a museum catalogue. Its costs are rigidity and labour: someone must design the categories, and works that don't fit get forced or dropped. Epistemologically, it *imposes* a structure — which, for artistic research, raises a live question: *whose* categories?

**Distributional semantics** (§5.2) is the machine-learning sense, rooted in the linguist J.R. Firth's dictum that "you shall know a word by the company it keeps." Meaning is *position*: a point in a continuous space learned from the statistics of how language is used, with no fixed categories at all. Its model of meaning is "what is this near?" Its virtues are recall, fluidity, and reach across languages and phrasings — it discovers relatedness no one thought to encode. Its costs are opacity and unaccountability: the 1,536 numbers are not interpretable, a match cannot be justified term-by-term, and the space inherits whatever biases sit in the model's training data. Epistemologically, it *discovers* proximity rather than imposing structure — but a proximity whose reasoning is inaccessible.

The tool deliberately uses **both, and plays them against each other**:

- Controlled semantics gives **precision, filtering, and interoperability** — the scaffolding.
- Distributional semantics gives **recall, discovery, and cross-lingual reach** — the search.
- The extraction layer is itself a *bridge* between them: a distributional model (an LLM) is harnessed to produce controlled, auditable output — machine intuition disciplined into human-legible categories, with evidence attached.

For artistic research this pairing is not merely convenient. A field wary of having external categories imposed on it gains a discovery mechanism (distributional) that needs no categories, checked and made accountable by a controlled layer (symbolic) whose every judgement is evidenced and mapped to shared authorities. The honest position is that neither sense of "semantics" is sufficient alone; the tool's contribution is holding them together.

---

## 6. Beyond Text: The Multimodal Extension

**6.1 Why.** A substantial part of the corpus keeps its research in images and sound; for those works, text-only indexing renders the research nearly invisible. The multimodal extension addresses this directly.

**6.2 How.** For image-bearing expositions, a vision-capable model produces, for each image, (a) a literal description of what is visible and (b) a verbatim transcription of any text *designed into* the image — prose that artists frequently typeset as part of the work and that no text extractor can see. Both are then embedded and enter semantic search exactly like prose. Every resulting term is tagged with its **provenance** — whether it came from the exposition's text, from an image's visual content, or from text recovered out of an image — so a reader always knows on what basis a work was retrieved.

What this means for what semantic search actually covers is worth stating plainly. **Both** the description *and* the recovered text become ordinary entries in the same vector index as the exposition's prose, so a query can match either: an image surfaces either because the model *described* it (a match tagged as visual content) or because text was *transcribed out of* it (a match tagged as recovered text). The retrieval is therefore **text-mediated, not visual** — there is no pixel-level or CLIP-style image embedding, and the tool cannot find images by visual resemblance to one another or to a query. An image is findable only through the *meaning of the text generated about it*. The photographs themselves are referenced for display alongside a result but are never embedded or searched directly.

**6.3 What it enables.** Content that previously had no textual trace becomes searchable. In one validated case, an exposition that the text pipeline recorded as effectively empty was recovered — its medium and discipline from the images, and its research framing, method, and theoretical references from text transcribed out of its designed pages.

---

## 7. Reliability, Limitations, and Ethics

A tool that generates descriptions of works must be candid about how it can be wrong.

- **Hallucination.** Vision models, asked to read text too small or blurred to resolve, will *confabulate* — inventing plausible but false wording. The tool counters this with an explicit instruction to mark unreadable text as illegible rather than guess, by feeding images at the highest useful resolution, and by keeping every transcription auditable against its source. This was not theoretical: confabulation was observed, diagnosed, and constrained during development, and the safeguard is part of the method, not an afterthought.
- **Resolution dependence.** Faithful transcription depends on image quality; below a legibility threshold the honest output is "illegible", which under-recovers rather than fabricates.
- **Opacity of semantic matching.** As above, distributional matches cannot be justified term-by-term. The controlled, evidenced facet layer is the counterweight.
- **Text-mediated image retrieval.** Images are searchable only through the text generated about them — a description of what is visible and any transcribed in-image text — never by visual similarity; there is no pixel-level image embedding. A photograph whose salient content the description happens to miss, or whose designed-in text falls below legibility, is correspondingly harder to surface. "Multimodal search" here means *more text, from more sources*, entering one shared index — not visual matching.
- **Coverage and currency.** The index reflects the corpus as last ingested; media behind third-party embeds may be inaccessible; extraction is probabilistic and can vary between runs.
- **Rights.** Media remains RC's and the artists'; the tool references rather than re-hosts it, and rights metadata is treated as a first-class concern for any published dataset.

The through-line is that the tool's trustworthiness rests not on being infallible but on being **auditable**: evidence for every claim, provenance for every term, and a stated limitation for every capability.

---

## 8. Related Work: Where *Excavating* Sits

*Excavating Artistic Research* belongs to a fast-growing family of AI systems working over cultural-heritage collections. Setting it beside two — one from information retrieval, one from its own field of artistic research — sharpens what is distinctive about it.

### 8.1 A retrieval comparator — Topic-RAG

**Topic-RAG** (Murugaraj et al., 2025, University of Luxembourg) is the nearest comparator by design. Working over 4,711 historical Swiss newspaper articles on nuclear energy (the *Impresso* corpus), it inserts a **topic-modeling gate** in front of retrieval: BERTopic clusters the corpus into latent topics; a query is matched to its most relevant topics (an anchor topic plus any scoring at least 50% of it); and retrieval is then confined to documents within those topics before an LLM generates the answer. Against a standard RAG baseline it reports consistently higher BERTScore, ROUGE, and UniEval, and faster retrieval — because it never scans the whole corpus. A companion variant, *Topic-RAG+*, adds semantic chunking for long documents.

The parallel to *Excavating* is exact in structure and instructive in contrast. Both systems **scope retrieval to a thematically coherent subset before ranking** — the move that lifts precision. But they build that subset from opposite ends of the axis this report calls the two senses of "semantics" (see the note after §5):

- **Topic-RAG scopes with distributional structure** — unsupervised BERTopic clusters, discovered from the data, requiring no human vocabulary.
- ***Excavating* scopes with controlled structure** — LLM-extracted facets drawn from a curated vocabulary mapped to authority files (§4).

Each choice carries the costs its tradition predicts, and Topic-RAG's own results make the tradeoff legible. Its authors report a **"Topic 0" bias**: one cluster absorbed 1,966 of the 4,711 articles (the rest held between 23 and 326 each), and queries were pulled toward that oversized topic — a failure mode of *emergent* categories on an imbalanced corpus that a *controlled* scheme is designed to avoid. Conversely, their topics need no curation and can surface structure no one thought to name — something a controlled scheme cannot. Tellingly, two items on Topic-RAG's own future-work list — **preserving provenance** and adding **explainable-AI transparency** — are properties *Excavating* builds in from the start, through per-term evidence, confidence, and modality provenance (§4.4, §6.2).

Three things set *Excavating* apart from Topic-RAG and adjacent archive-RAG systems (such as HistoRAG and the broader body of work on RAG over digitized archives), which are almost all **text-only** and **historical**:

1. **Domain** — artistic rather than textual/historical research, where the object of inquiry is often a practice, not a document.
2. **Multimodality** — recovering research content from images and their designed-in text (§6), reaching works that leave little or no textual trace; the comparator systems index prose alone.
3. **Auditable controlled vocabulary** — scoping terms are evidenced and mapped to shared authority files, making the tool's categories interoperable and inspectable rather than emergent and opaque.

In short, *Excavating* and Topic-RAG address the same core problem — thematic scoping for humanities retrieval — from complementary halves of the semantic field. Topic-RAG is the strongest recent evidence that pre-retrieval scoping works; its limitations are a map of what a controlled, provenance-first, multimodal alternative is positioned to address.

*Reference:* Murugaraj, K., Lamsiyah, S., Düring, M., & Theobald, M. (2025). *Topic-RAG for Historical Newspapers: Enhancing Information Retrieval in Humanities Research through Topic-Based Retrieval-Augmented Generation.* Computational Humanities Research (Open Access). Code: github.com/KeerthanaMurugaraj/Topic-RAG-for-Historical-Newspapers

### 8.2 A comparator from the same field — °'°KOBI

Closer to home than Topic-RAG — the same domain, the opposite paradigm — is **°'°KOBI** (Andrea Guidi), an AI "knowledge ecosystem for creativity, research, and design" that also draws on the Research Catalogue: through a collaboration with the Society for Artistic Research, students contribute RC projects that expand its knowledge base. A large language model transforms a corpus of artistic *and* scientific publications into a dynamic "Universe" of semantic nodes — each knowledge fragment placed in an interdisciplinary space and linked to others by *thematic resonance*, which users explore as a visual constellation (including through an augmented-reality interface) to surface unexpected correlations and "counterfactual" lines of thought.

KOBI and *Excavating* sit at opposite ends of a *different* axis from the Topic-RAG contrast — not controlled-versus-distributional, but **divergent-versus-convergent**. KOBI is a *generative* instrument: it optimises for serendipity, dissolving disciplinary silos and provoking new ideas by making a browsable map of connections. *Excavating* is an *analytical* one: it optimises for findability and defensibility, returning ranked, cited results to a specific query. One invites you to wander and be surprised; the other answers a question you can act on — and the interaction models mirror this, KOBI's spatial/AR constellation of fragments against *Excavating*'s query-and-rank search with grounded answers.

Read against KOBI, three of *Excavating*'s commitments show up as deliberate choices rather than defaults: **retrieval precision with citations** (versus open-ended browsing), the **controlled, auditable vocabulary** of §4 (KOBI links by emergent resonance, with no controlled layer evident), and the **multimodal recovery** of §6, which reaches content locked inside images. The two are best read as complementary tools for different moments of research — KOBI for the divergent, idea-generating phase; *Excavating* for the convergent, find-and-verify phase. That KOBI occupies the pure-serendipity end of the design space is itself an argument for *Excavating*'s precision-and-provenance stance.

*This comparison is drawn from KOBI's published descriptions and the exposition's abstract; the exposition's full text could not be retrieved directly, so specific implementation details (exact model, whether it performs retrieval-augmented generation, the visualisation stack) are characterised only at the level its public materials state.*

*Reference:* Guidi, A. *AI for Collective Intelligence and Creativity: The Case of °'°KOBI — a Tool for Interdisciplinary and Artistic Research.* Research Catalogue, exposition 3101870. See also Guidi, A. (2023), *KOBI 3.0: A Knowledge Ecosystem for Creativity, Research and Design.*

---

## 9. Future Directions

- Extending multimodal analysis to **video and audio** (keyframe description and speech transcription).
- Promoting stable inductive terms into the controlled vocabulary and **publishing it as an open, citable resource** (e.g. as SKOS), so the methods vocabulary becomes an output in its own right.
- Reconciling controlled terms to live authority-file URIs for full interoperability.
- A calibration pass to firm up coverage and cost before a full-corpus multimodal run.

---

## Appendix: Technical Reference

*For readers who want the machinery under the account above. One page; skippable.*

**Architecture.** A browser-based interface (React, served as a static site) talks to a set of small server-side functions (Deno edge functions) that mediate all access to data, embeddings, and language models — so no keys or privileged operations live in the browser. Persistent data sits in a managed PostgreSQL database with the **`pgvector`** extension, which adds vector columns and nearest-neighbour search to an ordinary relational store.

**Data store.** Two main tables: one row per exposition (metadata plus extracted controlled dimensions), and one row per *chunk* of searchable text, each carrying the text, its embedding vector, and a `source` tag. A separate table holds per-image multimodal content (descriptions, transcribed text) for display.

**Embeddings (the semantic mapping).** Text is embedded with OpenAI's `text-embedding-3-small` model, which maps any passage to a **1,536-dimensional** vector. Similarity is **cosine distance** between vectors; nearest-neighbour retrieval is served by a `pgvector` index. The same model embeds both stored chunks and incoming queries, so the two are directly comparable.

**Chunking and ranking.** Expositions are split into overlapping passages (on the order of a few thousand characters, with overlap to avoid cutting ideas at boundaries). Retrieval gathers the nearest chunks corpus-wide, then keeps each exposition's single best-scoring chunk so text-rich works cannot dominate. User-defined "custom categories" are embedded and blended into the score to re-rank without hard filtering. A dedicated **title-plus-abstract chunk** is indexed for every exposition, so a work's cleanest thematic statement is searchable even when its body text is thin.

**Provenance tags.** Every chunk is labelled by origin — `text` (exposition prose), `abstract` (title + abstract), `image` (a visual description), or `image-text` (text transcribed out of an image) — and this label is surfaced in results, so a reader always knows on what basis a work matched.

**Extraction models.** Faceted classification and metadata extraction use a Claude model (a fast, cost-efficient tier for batch work). The multimodal pipeline uses a vision-capable Claude model in two steps per image: a literal description, then a verbatim text transcription, with an explicit instruction to mark unreadable text as illegible rather than guess. Images are fetched at the largest useful resolution to maximise legibility.

**Data provenance and currency.** Exposition text and structure are drawn from a research mirror of the Research Catalogue; media are retrieved live from RC with freshly issued access URLs (RC's media links are short-lived by design). A scheduled job re-indexes the corpus so newly published expositions are picked up.

**Reproducibility note.** Language-model extraction is probabilistic: repeated runs on the same input can differ slightly. Confidence scores and verbatim evidence accompany every assignment so that variation is visible and checkable rather than hidden.

---

*Prepared as an overview for colleagues across fields.*
