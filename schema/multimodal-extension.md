# Multimodal Extension — Faceted Extraction Schema
**Version 0.1-multimodal — working draft. Companion to `artistic-research-extraction-schema.md` (v0.1).**
Purpose: extend the text-based extraction to the non-text content of Research Catalogue expositions — images, video, and audio — so that primarily visual/sonic works (the ~25% of the corpus that returns thin text) receive facet assignments from the modality where their research actually lives. This document **adds to** v0.1; it does not replace it. The nine facets, the controlled term lists, the confidence scale, and the "never force an assignment" rule all carry over unchanged. What changes is *where evidence comes from* and *how that provenance is recorded*.
Guiding principle (after Arnold & Tilton, *distant viewing*): describe what is literally present before interpreting it, and treat every translation of an image or sound into words as an interpretive act to be recorded and audited — not as the model "seeing" the work.
---
## 1. The provenance field: `modality_source`
Every facet assignment — old and new — gains a `modality_source` tag. Back-fill existing text runs with `"text"`. New values:
| Value | Meaning |
|---|---|
| `text` | from exposition prose (existing v0.1 pipeline) |
| `image` | from a still image (photograph, scan, screenshot, artwork reproduction) |
| `video-frame` | from a sampled still frame of a video |
| `video-motion` | from a model's description of movement/temporal content in video |
| `audio-speech` | from an ASR transcript of spoken audio |
| `audio-music-tag` | from high-level music tagging (genre, mood, instrumentation) |
| `audio-music-feature` | from numeric MIR descriptors (tempo, key, etc.) — see §6 |
This single field is the analytical payoff: it lets you stratify every finding by the signal that produced it, agree/disagree text-derived against image-derived facets, and quantify how much the sparse records were rescued by non-text analysis.
---
## 2. Media access (do this first — it is the real bottleneck)
RC expositions are built from typed content blocks. The text pilot already surfaced `tool-text` and `tool-simpletext`; the media equivalents are the harvest targets:
- `tool-picture` → still-image source URLs
- `tool-video` → embedded video (often Vimeo/YouTube) or RC-hosted files
- `tool-audio` → audio file URLs
- `tool-pdf` / `tool-iframe` → may wrap further media
**Step 1 — build a media inventory** before any analysis. For each exposition, parse its JSON/HTML, collect every media block, and emit a per-exposition record: counts and URLs by type. The inventory is itself a finding (it characterises RC's compositional makeup) and tells you which expositions are image-led, video-led, or sonic.
**Step 2 — fetch what is fetchable, rights permitting.** RC-hosted images and audio are usually directly downloadable. Third-party *embeds* (Vimeo/YouTube) frequently are **not**, and should be logged as `media_status: "embed_unfetchable"` rather than silently dropped — their absence is data too. Respect RC's terms and any per-exposition licence.
**Pilot caps (cost/throughput control).** For the 150-exposition pilot, cap per exposition: up to **8 images**, keyframes from up to **3 videos**, and the **first audio file**. Record what was skipped so coverage is auditable.
---
## 3. Images — primary route for the pilot
Use a **describe-then-extract** design (two steps), not direct one-shot tagging. The intermediate description is kept as an auditable artifact and serves as the `evidence` for any facet assigned from that image. This is more honest than letting the model jump straight from pixels to `epist-02`, and it makes the translation step inspectable.
### 3a. Image description prompt (step 1)
> You are assisting a study of artistic research. You will be shown one image from a Research Catalogue exposition. **First describe only what is literally visible** — subjects, setting, medium if evident, any visible text (transcribe it verbatim, in its original language), composition, and whether the image appears to be (a) an artwork itself, (b) documentation of a work or performance, (c) process/studio material, or (d) incidental (a venue, a person, a slide). Do **not** speculate about meaning, intent, or research method in this step. Keep to 60–120 words. If the image is decorative or contentless (e.g. a plain divider), say so in five words.
### 3b. Facet extraction from the description (step 2)
Feed the description (plus exposition title/abstract for context) into the **existing v0.1 facet extractor**, with these image-specific overrides added to the v0.1 rules:
1. `modality_source` = `image` (or `video-frame`) on every assignment produced here.
2. **Strong restraint on `mode` and `epist`.** You generally cannot read research mode or an epistemic claim off a single image. Leave these facets empty unless (a) the image contains legible text stating them, or (b) the surrounding abstract licenses the inference. When you do assign them from an image, cap confidence at 0.6 and flag.
3. `med` and `disc` are the facets images support best — assign these where the description gives clear visual evidence.
4. `evidence` = a short span quoted from the description (not invented), naming what in the image justifies the term.
5. Distinguish *the work* from *documentation of the work*: a photo of a gallery wall is `out` = exhibition, not necessarily `med` = photography.
---
## 4. Video — optional second phase
Lightweight pilot recipe per video (defer the heavier version):
1. **Keyframes**: sample 3–5 frames (e.g. evenly spaced, or on shot boundaries via scene detection). Run each through the image route (§3) with `modality_source: video-frame`.
2. **Audio track**: transcribe with ASR (§5) → `audio-speech`.
3. **Motion (optional)**: a short model description of what changes over time — useful for dance/performance — tagged `video-motion`, confidence capped at 0.6, treated as suggestive not decisive.
For choreographic and performance works this is where the research sits, so flag video-led expositions in the inventory for a dedicated phase-2 pass rather than under-serving them in the pilot.
---
## 5. Audio — speech vs music split
**Speech** (talks, interviews, voice-over): ASR (a Whisper-class model) → transcript → the **existing text facet extractor**, tagged `audio-speech`. This folds cleanly into what you already have; an interview audio file becomes `meth-16`, etc., exactly as text would.
**Music / sound art**: two complementary outputs —
- `audio-music-tag`: high-level tags (genre, mood, instrumentation, vocal/instrumental) from a music-tagging model or Essentia's high-level classifiers. These can populate `med` (e.g. detected instrumentation), `disc`, or `uncontrolled_terms`.
- `audio-music-feature`: see §6.
---
## 6. Numeric MIR descriptors — a separate table, not facets
Low-level music-information-retrieval features (tempo/BPM, key, loudness, spectral centroid, onset density, duration) do **not** translate to controlled terms and must **not** be forced into facets. Emit them to a separate per-media numeric record (`modality_source: audio-music-feature`) for clustering and stratification. Tooling: **librosa** or **Essentia** (Essentia also ships pretrained high-level classifiers; AcousticBrainz-style descriptors are derived from it). Keep these as their own analytic layer that sits alongside the faceted data, not inside it.
---
## 7. Output format (extends the v0.1 per-exposition object)
Add a `media_inventory`, keep auditable intermediate artifacts, and extend every facet-assignment object with provenance:
```json
{
  "rc_id": "…",
  "media_inventory": [
    {"media_id": "img_03", "type": "image", "url": "…", "media_status": "fetched"},
    {"media_id": "vid_01", "type": "video", "url": "…", "media_status": "embed_unfetchable"},
    {"media_id": "aud_01", "type": "audio", "url": "…", "media_status": "fetched"}
  ],
  "image_descriptions": [
    {"media_id": "img_03", "description": "…60–120 words, literal…", "image_role": "documentation"}
  ],
  "transcripts": [
    {"media_id": "aud_01", "kind": "speech", "text": "…", "lang": "is"}
  ],
  "facets": {
    "disc": [
      {"id": "disc-04", "term": "dance / choreography", "confidence": 0.85,
       "modality_source": "image", "media_ref": "img_03",
       "locator": "", "evidence": "two dancers mid-lift on a bare stage"}
    ],
    "med": [], "mode": [], "meth": [], "epist": [], "out": [],
    "theo_persons": [], "theo_concepts": [], "ctx": []
  },
  "uncontrolled_terms": [],
  "music_features": [
    {"media_id": "aud_01", "bpm": 92, "key": "D minor", "duration_s": 412,
     "modality_source": "audio-music-feature"}
  ],
  "extractor_notes": "…incl. media coverage, embeds skipped, low-conf flags…"
}
```
`locator` = frame timestamp, page, or region as applicable; empty for whole-image assignments.
---
## 8. Provenance & restraint rules (add to the v0.1 rule list)
7. Tag every assignment with `modality_source` and `media_ref`. Text runs back-fill to `"text"`.
8. For `image` / `video-frame`: assign `mode` and `epist` only on explicit in-image text or abstract support; otherwise leave empty. Cap such inferences at 0.6 and flag.
9. Never merge across modalities silently. If text says one thing and image another, record **both** assignments with their sources; let disagreement be visible, not averaged away.
10. Keep the description/transcript as the `evidence` source — quote from it, do not invent. A facet with no quotable media evidence is not assigned.
11. Log unfetchable embeds; absence of media is recorded, never silently treated as absence of content.
12. Numeric MIR features go to `music_features`, never into facets.
---
## 9. Pilot plan (same 150 expositions)
1. **Inventory pass** on the 150: emit media counts by type per exposition. Deliverable: a table you can read directly — how many are image-led, video-led, sonic, or genuinely text-only. (This alone answers "what is RC made of?" for the sample.)
2. **Image pass** (primary): describe-then-extract on up to 8 images each. This is the cheapest, highest-coverage test and the one most likely to rescue the sparse 25%.
3. **Audio-speech pass** (if time): ASR + text extractor on the first audio file each.
4. **Hold** video-motion and music-feature work for a deliberate phase 2 unless a given exposition is clearly video/sound-led and would otherwise come back empty.
5. **Merge & compare** against the existing `pilot_terms` text run, keyed on `rc_id` + `modality_source`:
   - Coverage: how many previously thin/empty expositions now have facets, and in which facets.
   - Agreement: where both text and image assign the same facet, do they concur?
   - Conflict: catalogue disagreements (these are the methodologically interesting cases).
   - Provenance mix: share of assignments by `modality_source` per facet (expect `med`/`disc` to gain most from images; `mode`/`epist`/`theo_*` to stay text-dominated).
### Cost & model notes
- Images: the Claude API ingests images directly (base64). Use a stronger model for the **describe** step than for plain text extraction — visual interpretation rewards it; the cheap model is fine for step 2. Roughly 150 × up to 8 images is on the order of low single-digit-thousands of image calls — modest, but run a 10-exposition micro-pilot first to get a real per-image cost before committing. Verify current rates and image-token rules at docs.claude.com.
- ASR (Whisper-class) and MIR (librosa/Essentia) run locally/open-source; their cost is compute and time, not API spend.
- Batch the step-2 text extraction as before for the 50% async discount.
---
## 10. The caveat to keep in the paper
Translating an image or a sound into words to make it machine-processable strips the context that often *is* the research — the embodied, tacit, sensory knowledge the `epist` facet tries to name. This is the processability–context aporia, and there is a question of whose categories get imposed on the visual and the sonic. The honest contribution is not "the model sees the work" but "multimodal extraction recovers the text-sparse quarter of the corpus from invisibility, with its translation step recorded, provenance-tagged, and open to audit." Stated plainly, that is a stronger finding than a seamless pipeline would be.
