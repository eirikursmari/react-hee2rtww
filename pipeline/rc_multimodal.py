#!/usr/bin/env python3
"""
rc_multimodal.py — Image-based faceted extraction for RC expositions.

Two-step pipeline per image:
  1. Describe (--describe-model, default claude-opus-4-8):
     Claude vision → 60-120 word literal description of what is visible.
  2. Extract (--extract-model, default claude-haiku-4-5-20251001):
     Same schema as text pipeline → facets tagged modality_source = "image".

Reads from rc_inventory.py output; only processes expositions that have
at least one RC-hosted (fetchable) image.

Usage
-----
    # Micro-pilot: 10 expositions, up to 8 images each
    python3 pipeline/rc_multimodal.py \\
        output/inventory.jsonl output/multimodal.jsonl \\
        --sample 10

    # Full image pass on all inventoried expositions
    python3 pipeline/rc_multimodal.py \\
        output/inventory.jsonl output/multimodal.jsonl

Resumable: already-processed rc_ids are skipped on restart.

Environment variables
---------------------
    ANTHROPIC_API_KEY   required
"""

import argparse
import base64
import html
import json
import logging
import os
import random
import re
import sys
import time
from pathlib import Path
from typing import Optional

import anthropic
import requests as req_lib

SCHEMA_PATH     = Path(__file__).parent.parent / "schema" / "artistic-research-extraction-schema.md"
MULTIMODAL_PATH = Path(__file__).parent.parent / "schema" / "multimodal-extension.md"

DESCRIBE_MODEL   = "claude-opus-4-8"
EXTRACT_MODEL    = "claude-haiku-4-5-20251001"
MAX_IMAGE_BYTES  = 5 * 1024 * 1024   # 5 MB — skip larger files
DEFAULT_MAX_IMGS = 8
DEFAULT_DELAY    = 0.5
DECORATIVE_MAX_WORDS = 12            # descriptions this short → skip extract step

DESCRIBE_SYSTEM = (
    "You are assisting a study of artistic research on the Research Catalogue "
    "(researchcatalogue.net). Your task is to describe images from RC expositions "
    "accurately and literally — only what you can see, nothing inferred."
)

DESCRIBE_PROMPT = (
    "Exposition title: {title}\n\n"
    "Describe only what is literally visible in this image — subjects, setting, "
    "medium if evident, any visible text (transcribe it verbatim in its original "
    "language), composition, and whether the image appears to be:\n"
    "(a) an artwork itself\n"
    "(b) documentation of a work or performance\n"
    "(c) process / studio material\n"
    "(d) incidental (a venue, a person, a slide)\n\n"
    "Do NOT speculate about meaning, intent, or research method in this step. "
    "Keep to 60–120 words. If the image is decorative or contentless "
    "(e.g. a plain colour block, a divider), say so in five words and stop."
)

# Combined describe + verbatim transcription (used when --ocr is set). Many RC
# expositions typeset their prose *inside* designed image elements, so the text
# extractor sees nothing — but it is authored text and must be recovered.
DESCRIBE_OCR_PROMPT = (
    "Exposition title: {title}\n\n"
    "This image is from a Research Catalogue exposition where text is often part "
    "of the visual design. Return EXACTLY two labelled sections:\n\n"
    "DESCRIPTION:\n"
    "A 60–120 word literal description of what is visible — subjects, setting, "
    "medium if evident, composition, and whether the image is (a) an artwork, "
    "(b) documentation, (c) process material, or (d) incidental. Do not speculate "
    "about meaning or method.\n\n"
    "TRANSCRIPTION:\n"
    "Transcribe ONLY text you can read clearly and with high confidence, word for "
    "word, in its original language and reading order. You MUST obey these rules:\n"
    "• Do NOT guess, complete, reconstruct, or infer any text that is small, "
    "blurry, cut off, rotated, or only partially visible.\n"
    "• Where text is present but not clearly legible, write [illegible] for that "
    "region — never invent plausible words to fill the gap.\n"
    "• Never end a phrase with '...' as if continuing text you cannot actually "
    "read; that is fabrication.\n"
    "• Do not translate, paraphrase, correct grammar, or improve wording.\n"
    "• Omitting uncertain text is REQUIRED: a short faithful transcription is far "
    "better than a complete-looking but partly invented one.\n"
    "If there is no clearly readable text, write exactly: [no text]."
)

EXTRACT_PREAMBLE = (
    "You are a structured metadata extractor for artistic research expositions "
    "from the Research Catalogue (researchcatalogue.net).\n\n"
    "Below is the complete faceted extraction schema (v0.1) followed by the "
    "multimodal extension rules. Read both carefully before processing."
)

# Facet extraction over text transcribed from designed image elements. Unlike a
# single image's visual inference, this is authored text, so the full facet range
# applies (mode/epist/theo included) — same rules as the text pipeline.
EXTRACT_TEXT_PROMPT = (
    "RC_ID: {rc_id}\n"
    "TITLE: {title}\n\n"
    "TEXT TRANSCRIBED FROM THE EXPOSITION'S DESIGNED/VISUAL ELEMENTS:\n{text}\n\n"
    "This text was written by the researcher but rendered inside images rather "
    "than stored as machine-readable text. Treat it as primary authored text: the "
    "FULL facet range applies (mode, epist, theo included), exactly as for the "
    "prose pipeline — the image-only restraint rules do NOT apply here.\n"
    "• evidence must be a short verbatim quote from the transcribed text above.\n"
    "• Assign only terms the text supports; empty facets are fine.\n\n"
    "Return ONLY a valid JSON object — no prose, no markdown fences."
)

EXTRACT_PROMPT = (
    "RC_ID: {rc_id}\n"
    "TITLE: {title}\n\n"
    "IMAGE DESCRIPTION (media_id: {media_id}):\n{description}\n\n"
    "Extract faceted metadata from this image description following the schema "
    "and multimodal extension rules above. Apply these image-specific rules:\n"
    "• Set modality_source = \"image\" on every assignment.\n"
    "• For mode and epist: assign ONLY if the description quotes in-image text "
    "that states them explicitly; otherwise leave empty.\n"
    "• med and disc are the facets best supported by images — assign these freely "
    "where the description gives clear visual evidence.\n"
    "• evidence must be a short verbatim quote from the description above.\n"
    "• If image role is (d) incidental or decorative, return empty facets.\n\n"
    "Return ONLY a valid JSON object — no prose, no markdown fences."
)

FACET_KEYS = ["disc", "med", "mode", "meth", "epist", "out",
              "theo_persons", "theo_concepts", "ctx"]

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-8s  %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger(__name__)


# ── Live media harvesting ──────────────────────────────────────────────────────
#
# map.rcdata.org stores exposition *structure* (page ids, text) reliably, but its
# media URLs are a 2025 snapshot with long-expired signed tokens. The live RC
# viewer embeds freshly-signed media URLs in each page's HTML, so we harvest those
# per page and download within the same session (cookies + fresh token → 200).

RC_SNAPSHOT_URL = "https://map.rcdata.org/rcjson/expo"
RC_VIEW_URL     = "https://www.researchcatalogue.net/view"
RC_REFERER      = "https://www.researchcatalogue.net/"
BROWSER_UA      = ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
                   "(KHTML, like Gecko) Chrome/120.0 Safari/537.36")
IMG_EXTS        = (".png", ".jpg", ".jpeg", ".gif", ".webp")
MAX_PAGES_SCAN  = 15   # stop harvesting after this many pages even if under cap
VARIANT_TARGET  = 1568 # Claude vision downscales beyond this — saturate detail here
MEDIA_URL_RE    = re.compile(r'https://media\.researchcatalogue\.net/[^\s"\'<>)]+')
HASH_RE         = re.compile(r'/([0-9a-f]{32})')
DIMS_RE         = re.compile(r'_(\d+)x(\d+)\.(?:png|jpe?g|gif|webp)', re.IGNORECASE)


def _variant_rank(url: str) -> tuple[int, int]:
    """Rank a size variant. Usable detail is min(long_edge, VARIANT_TARGET) — the
    API downscales past that — so maximise usable detail, then prefer the smaller
    file. Unknown/original size ranks lowest (may exceed the 5MB API limit)."""
    m = DIMS_RE.search(url)
    if not m:
        return (0, 0)               # unknown/original — last resort
    long_edge = max(int(m.group(1)), int(m.group(2)))
    return (min(long_edge, VARIANT_TARGET), -long_edge)


def _get_retry(session: req_lib.Session, url: str,
               retries: int = 3, timeout: int = 30):
    """GET with small exponential backoff; return Response or None."""
    for attempt in range(retries):
        try:
            return session.get(url, timeout=timeout)
        except req_lib.RequestException as exc:
            if attempt < retries - 1:
                time.sleep(2 ** attempt)
            else:
                log.warning("    GET failed after %d tries: %s (%s)",
                            retries, url[:70], exc)
    return None


def fetch_structure(expo_id: str, session: req_lib.Session) -> tuple[list[str], str]:
    """Page ids + title from the snapshot (structure valid; only its media is stale)."""
    r = _get_retry(session, f"{RC_SNAPSHOT_URL}/{expo_id}")
    if r is None or r.status_code != 200:
        log.warning("    structure fetch failed for %s (status %s)",
                    expo_id, getattr(r, "status_code", "n/a"))
        return [], ""
    try:
        data = r.json()
    except ValueError as exc:
        log.warning("    structure JSON error for %s: %s", expo_id, exc)
        return [], ""
    pages = data.get("pages", {})
    page_ids = list(pages.keys()) if isinstance(pages, dict) else []
    return page_ids, (data.get("title") or "")


def harvest_image_urls(expo_id: str, page_ids: list[str],
                       session: req_lib.Session, max_images: int,
                       max_pages: int = MAX_PAGES_SCAN) -> list[dict]:
    """Fetch each live page, group image URLs by content hash, and keep the
    largest useful size variant of each (up to VARIANT_CAP for legibility)."""
    by_hash: dict[str, list[str]] = {}
    order: list[str] = []              # first-seen order of distinct images
    for pid in page_ids[:max_pages]:
        r = _get_retry(session, f"{RC_VIEW_URL}/{expo_id}/{pid}", timeout=20)
        if r is None or r.status_code != 200:
            continue
        for u in MEDIA_URL_RE.findall(html.unescape(r.text)):
            if not u.split("?")[0].lower().endswith(IMG_EXTS):
                continue
            m = HASH_RE.search(u)
            key = m.group(1) if m else u.split("?")[0]
            if key not in by_hash:
                by_hash[key] = []
                order.append(key)
            by_hash[key].append(u)
        if len(order) >= max_images:   # enough distinct images collected
            break

    result: list[dict] = []
    for key in order[:max_images]:
        ranked = sorted(set(by_hash[key]), key=_variant_rank, reverse=True)
        result.append({"media_id": key[:16], "urls": ranked})
    return result


# ── Image fetching ─────────────────────────────────────────────────────────────

def detect_media_type(url: str, content_type: str) -> str:
    ct = content_type.split(";")[0].strip().lower()
    if ct in ("image/jpeg", "image/png", "image/gif", "image/webp"):
        return ct
    ext = url.rsplit(".", 1)[-1].lower().split("?")[0]
    return {"jpg": "image/jpeg", "jpeg": "image/jpeg", "png": "image/png",
            "gif": "image/gif",  "webp": "image/webp"}.get(ext, "image/jpeg")


def fetch_image(url: str, session: req_lib.Session) -> Optional[tuple[str, str]]:
    """Return (base64_data, media_type) or None on failure."""
    try:
        r = session.get(url, timeout=20)
        if r.status_code != 200:
            log.warning("    image %s: HTTP %d", url[:60], r.status_code)
            return None
        if len(r.content) > MAX_IMAGE_BYTES:
            log.warning("    image too large (%d bytes) — skipping", len(r.content))
            return None
        media_type = detect_media_type(url, r.headers.get("content-type", ""))
        return base64.standard_b64encode(r.content).decode(), media_type
    except req_lib.RequestException as exc:
        log.warning("    image fetch error: %s", exc)
        return None


# ── Claude calls ───────────────────────────────────────────────────────────────

def split_describe_ocr(raw: str) -> tuple[str, str]:
    """Split a combined DESCRIPTION/TRANSCRIPTION response into (description, ocr)."""
    m = re.search(r'TRANSCRIPTION:\s*', raw, re.IGNORECASE)
    if not m:
        return raw.strip(), ""
    description = raw[:m.start()]
    description = re.sub(r'^\s*DESCRIPTION:\s*', "", description,
                         flags=re.IGNORECASE).strip()
    ocr = raw[m.end():].strip()
    if re.fullmatch(r'\[?\s*no text\s*\]?\.?', ocr, re.IGNORECASE):
        ocr = ""
    return description, ocr


def call_describe(
    client: anthropic.Anthropic,
    b64: str,
    media_type: str,
    title: str,
    model: str,
    ocr: bool = False,
) -> tuple[Optional[str], str, dict]:
    """Return (description, ocr_text, usage). ocr_text is '' unless ocr=True."""
    prompt = DESCRIBE_OCR_PROMPT if ocr else DESCRIBE_PROMPT
    try:
        resp = client.messages.create(
            model=model,
            max_tokens=1600 if ocr else 300,   # transcription can be long
            system=DESCRIBE_SYSTEM,
            messages=[{
                "role": "user",
                "content": [
                    {"type": "image",
                     "source": {"type": "base64", "media_type": media_type, "data": b64}},
                    {"type": "text",
                     "text": prompt.format(title=title)},
                ],
            }],
        )
        usage = {
            "input_tokens":  resp.usage.input_tokens,
            "output_tokens": resp.usage.output_tokens,
        }
        raw = resp.content[0].text.strip()
        if ocr:
            description, ocr_text = split_describe_ocr(raw)
            return description, ocr_text, usage
        return raw, "", usage
    except anthropic.RateLimitError:
        log.warning("    rate limited (describe) — sleeping 60s")
        time.sleep(60)
        return None, "", {}
    except anthropic.APIError as exc:
        log.warning("    describe API error: %s", exc)
        return None, "", {}


def call_extract(
    client: anthropic.Anthropic,
    system_blocks: list[dict],
    rc_id: str,
    title: str,
    media_id: str,
    description: str,
    model: str,
) -> tuple[dict, dict]:
    user_text = EXTRACT_PROMPT.format(
        rc_id=rc_id, title=title, media_id=media_id, description=description,
    )
    resp = client.messages.create(
        model=model,
        max_tokens=2048,
        system=system_blocks,
        messages=[{"role": "user", "content": user_text}],
    )
    raw = resp.content[0].text.strip()
    if raw.startswith("```"):
        raw = re.sub(r"^```[a-z]*\n?", "", raw).rstrip("`").strip()
    try:
        result = json.loads(raw)
    except json.JSONDecodeError:
        result = {"parse_error": True, "raw_response": raw[:1000]}

    usage = {
        "input_tokens":                resp.usage.input_tokens,
        "output_tokens":               resp.usage.output_tokens,
        "cache_creation_input_tokens": getattr(resp.usage, "cache_creation_input_tokens", 0),
        "cache_read_input_tokens":     getattr(resp.usage, "cache_read_input_tokens", 0),
    }
    return result, usage


def call_extract_text(
    client: anthropic.Anthropic,
    system_blocks: list[dict],
    rc_id: str,
    title: str,
    text: str,
    model: str,
) -> tuple[dict, dict]:
    """Facet extraction over text transcribed from designed image elements."""
    user_text = EXTRACT_TEXT_PROMPT.format(rc_id=rc_id, title=title, text=text)
    resp = client.messages.create(
        model=model,
        max_tokens=8192,   # aggregate transcription can yield many facets
        system=system_blocks,
        messages=[{"role": "user", "content": user_text}],
    )
    raw = resp.content[0].text.strip()
    if raw.startswith("```"):
        raw = re.sub(r"^```[a-z]*\n?", "", raw).rstrip("`").strip()
    try:
        result = json.loads(raw)
    except json.JSONDecodeError:
        result = {"parse_error": True, "raw_response": raw[:1000]}

    usage = {
        "input_tokens":                resp.usage.input_tokens,
        "output_tokens":               resp.usage.output_tokens,
        "cache_creation_input_tokens": getattr(resp.usage, "cache_creation_input_tokens", 0),
        "cache_read_input_tokens":     getattr(resp.usage, "cache_read_input_tokens", 0),
    }
    return result, usage


# ── Facet helpers ──────────────────────────────────────────────────────────────

def tag_provenance(facets: dict, media_id: str,
                   modality: str = "image") -> dict:
    """Add modality_source + media_ref to every entry in a facets dict."""
    result = {}
    for key, entries in facets.items():
        if not isinstance(entries, list):
            result[key] = entries
            continue
        result[key] = [
            {**e, "modality_source": modality, "media_ref": media_id}
            if isinstance(e, dict) else e
            for e in entries
        ]
    return result


def merge_facets(base: dict, extra: dict) -> dict:
    merged = {k: list(v) for k, v in base.items() if isinstance(v, list)}
    for k, v in extra.items():
        if isinstance(v, list):
            merged.setdefault(k, []).extend(v)
    return merged


def empty_facets() -> dict:
    return {k: [] for k in FACET_KEYS}


# ── I/O helpers ────────────────────────────────────────────────────────────────

def load_inventory(path: Path) -> list[dict]:
    """All image-bearing expositions from the inventory (no sampling here)."""
    records = []
    with path.open(encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
                if rec.get("media_counts", {}).get("image", 0) > 0:
                    records.append(rec)
            except Exception:
                pass
    return records


def load_text_words(path: Path) -> dict[str, int]:
    """rc_id -> _text_words from a text run (for rescue targeting)."""
    words: dict[str, int] = {}
    with path.open(encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue
            rc_id = str(rec.get("rc_id") or "")
            if rc_id and rec.get("_text_words") is not None:
                words[rc_id] = rec["_text_words"]
    return words


def load_done(path: Path) -> set[str]:
    done: set[str] = set()
    if not path.exists():
        return done
    with path.open(encoding="utf-8") as f:
        for line in f:
            try:
                rc_id = json.loads(line.strip()).get("rc_id")
                if rc_id:
                    done.add(str(rc_id))
            except Exception:
                pass
    return done


# ── Main ───────────────────────────────────────────────────────────────────────

def main() -> None:
    ap = argparse.ArgumentParser(
        description="RC multimodal (image) faceted extraction",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "Micro-pilot (random sample):\n"
            "  rc_multimodal.py output/inventory.jsonl output/multimodal.jsonl --sample 10\n\n"
            "Rescue mode (target the text-thinnest expositions that have images):\n"
            "  rc_multimodal.py output/inventory.jsonl output/multimodal.jsonl \\\n"
            "      --text-run output/pilot.jsonl --rescue --max-text-words 50 --sample 30\n\n"
            "Single-exposition deep dive (all images, all pages, read designed-in text):\n"
            "  rc_multimodal.py output/inventory.jsonl output/deepdive.jsonl \\\n"
            "      --only 3001569 --all-images --ocr\n\n"
            "Full pass:\n"
            "  rc_multimodal.py output/inventory.jsonl output/multimodal.jsonl\n"
        ),
    )
    ap.add_argument("inventory_jsonl", help="Inventory JSONL from rc_inventory.py")
    ap.add_argument("output_jsonl",    help="Output JSONL (appended; resumable)")
    ap.add_argument("--only", metavar="RC_ID",
                    help="Process a single exposition by id (bypasses inventory)")
    ap.add_argument("--all-images", action="store_true",
                    help="No per-exposition image cap; scan all pages")
    ap.add_argument("--ocr", action="store_true",
                    help="Also transcribe text rendered inside images and extract "
                         "facets from it (modality_source 'image-text')")
    ap.add_argument("--sample", type=int, metavar="N",
                    help="Limit to N expositions (micro-pilot / rescue cap)")
    ap.add_argument("--text-run", metavar="PATH",
                    help="Text run JSONL (rc_extract.py output) with _text_words, "
                         "for rescue targeting")
    ap.add_argument("--rescue", action="store_true",
                    help="Select the text-thinnest image-bearing expositions "
                         "(requires --text-run)")
    ap.add_argument("--max-text-words", type=int, default=50, metavar="N",
                    help="Rescue: only expositions with fewer than N text words "
                         "(default 50)")
    ap.add_argument("--seed",        type=int,   default=42)
    ap.add_argument("--max-images",  type=int,   default=DEFAULT_MAX_IMGS,
                    help=f"Max images per exposition (default {DEFAULT_MAX_IMGS})")
    ap.add_argument("--delay",       type=float, default=DEFAULT_DELAY)
    ap.add_argument("--describe-model", default=DESCRIBE_MODEL)
    ap.add_argument("--extract-model",  default=EXTRACT_MODEL)
    ap.add_argument("--schema",  default=str(SCHEMA_PATH))
    ap.add_argument("--schema2", default=str(MULTIMODAL_PATH))
    args = ap.parse_args()

    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        log.error("ANTHROPIC_API_KEY not set"); sys.exit(1)

    for p in (Path(args.schema), Path(args.schema2)):
        if not p.exists():
            log.error("Schema not found: %s", p); sys.exit(1)

    schema_text = (
        Path(args.schema).read_text(encoding="utf-8")
        + "\n\n---\n\n"
        + Path(args.schema2).read_text(encoding="utf-8")
    )
    system_blocks = [{
        "type": "text",
        "text": EXTRACT_PREAMBLE + "\n\n---\n\n" + schema_text,
        "cache_control": {"type": "ephemeral"},
    }]
    log.info("Schemas loaded: %d chars", len(schema_text))

    if args.rescue and not args.text_run:
        log.error("--rescue requires --text-run"); sys.exit(1)

    # ── Single-exposition deep dive bypasses the inventory entirely ─────────────
    if args.only:
        records = [{"rc_id": str(args.only), "title": "",
                    "exposition_type": "deep-dive"}]
        log.info("Deep-dive mode: exposition %s", args.only)
    else:
        records = load_inventory(Path(args.inventory_jsonl))
        log.info("%d image-bearing expositions in inventory", len(records))

    # ── Rescue targeting: keep the text-thinnest, thinnest first ────────────────
    if args.rescue and not args.only:
        words = load_text_words(Path(args.text_run))
        thin, unknown = [], 0
        for r in records:
            w = words.get(str(r["rc_id"]))
            if w is None:
                unknown += 1
            elif w < args.max_text_words:
                thin.append((w, r))
        thin.sort(key=lambda x: x[0])          # thinnest first
        records = [r for _, r in thin]
        log.info("Rescue: %d text-thin (<%d words) of image-bearing; "
                 "%d had no word count (run backfill_wordcount.py)",
                 len(records), args.max_text_words, unknown)
        if args.sample:
            records = records[:args.sample]    # already sorted thinnest-first
    elif args.sample and args.sample < len(records):
        rng = random.Random(args.seed)
        records = rng.sample(records, args.sample)

    done    = load_done(Path(args.output_jsonl))
    pending = [r for r in records if str(r["rc_id"]) not in done]

    log.info("%d expositions selected; %d pending", len(records), len(pending))

    client  = anthropic.Anthropic(api_key=api_key)

    # Browser-like session for the live RC viewer + media CDN (fresh tokens).
    session = req_lib.Session()
    session.headers.update({"User-Agent": BROWSER_UA, "Referer": RC_REFERER})

    # Plain session for the map.rcdata.org structure snapshot (page ids only).
    snapshot_session = req_lib.Session()
    snapshot_session.headers["User-Agent"] = "rc-multimodal/1.0"

    out_path = Path(args.output_jsonl)
    out_path.parent.mkdir(parents=True, exist_ok=True)

    expos_ok = expos_failed = images_described = images_skipped = 0
    tok = dict(desc_in=0, desc_out=0, ext_in=0, ext_out=0,
               cache_create=0, cache_read=0)

    with out_path.open("a", encoding="utf-8") as out_f:
        n = len(pending)
        for i, inv in enumerate(pending, 1):
            rc_id = str(inv["rc_id"])
            title = inv.get("title", "") or ""

            page_ids, fetched_title = fetch_structure(rc_id, snapshot_session)
            if not title:
                title = fetched_title
            log.info("[%d/%d] %s — %s", i, n, rc_id, title[:55])

            max_images = 10**6            if args.all_images else args.max_images
            max_pages  = len(page_ids)    if args.all_images else MAX_PAGES_SCAN
            candidates = harvest_image_urls(rc_id, page_ids, session,
                                            max_images, max_pages)
            log.info("    harvested %d fresh image URLs from %d pages%s",
                     len(candidates), len(page_ids),
                     " (OCR on)" if args.ocr else "")

            image_descs:     list[dict] = []
            merged_facets    = empty_facets()
            merged_unctrl:   list[dict] = []
            per_img_usage:   list[dict] = []
            ocr_chunks:      list[str]  = []

            for block in candidates:
                variants = block.get("urls") or ([block["url"]] if block.get("url") else [])
                media_id = block.get("media_id") or (variants[0] if variants else "")

                # Try variants largest-first; fall back if one is >5MB or errors.
                img = url = None
                for candidate_url in variants:
                    img = fetch_image(candidate_url, session)
                    if img is not None:
                        url = candidate_url
                        break
                if img is None:
                    images_skipped += 1
                    image_descs.append({"media_id": media_id,
                                        "url": variants[0] if variants else "",
                                        "size": "",
                                        "media_status": "fetch_failed"})
                    continue

                b64, media_type_str = img
                m_size = DIMS_RE.search(url)
                used_size = f"{m_size.group(1)}x{m_size.group(2)}" if m_size else "orig"

                # Step 1 — describe (+ transcribe designed-in text when --ocr)
                description, ocr_text, d_usage = call_describe(
                    client, b64, media_type_str, title, args.describe_model,
                    ocr=args.ocr,
                )
                tok["desc_in"]  += d_usage.get("input_tokens",  0)
                tok["desc_out"] += d_usage.get("output_tokens", 0)

                if not description:
                    images_skipped += 1
                    image_descs.append({"media_id": media_id, "url": url,
                                        "size": used_size,
                                        "media_status": "describe_failed"})
                    continue

                word_count = len(description.split())
                if ocr_text:
                    ocr_chunks.append(ocr_text)
                    log.info("    %s → %d words desc, %d words text",
                             media_id[:24], word_count, len(ocr_text.split()))
                else:
                    log.info("    %s → %d words", media_id[:24], word_count)

                desc_entry = {
                    "media_id":    media_id,
                    "url":         url,
                    "size":        used_size,
                    "media_status": "described",
                    "description": description,
                }
                if ocr_text:
                    desc_entry["ocr_text"] = ocr_text
                image_descs.append(desc_entry)

                # Skip extract step for decorative/blank images
                if word_count <= DECORATIVE_MAX_WORDS:
                    log.info("    (decorative — skipping extract)")
                    images_described += 1
                    if args.delay > 0:
                        time.sleep(args.delay)
                    continue

                # Step 2 — extract facets from description
                try:
                    result, e_usage = call_extract(
                        client, system_blocks, rc_id, title,
                        media_id, description, args.extract_model,
                    )
                    per_img_usage.append(e_usage)
                    tok["ext_in"]      += e_usage["input_tokens"]
                    tok["ext_out"]     += e_usage["output_tokens"]
                    tok["cache_create"]+= e_usage["cache_creation_input_tokens"]
                    tok["cache_read"]  += e_usage["cache_read_input_tokens"]

                    if not result.get("parse_error"):
                        tagged = tag_provenance(result.get("facets", {}), media_id)
                        merged_facets = merge_facets(merged_facets, tagged)
                        for u in (result.get("uncontrolled_terms") or []):
                            if isinstance(u, dict):
                                merged_unctrl.append({
                                    **u,
                                    "modality_source": "image",
                                    "media_ref":       media_id,
                                })

                    cache_status = (
                        "CACHE HIT"  if e_usage["cache_read_input_tokens"]    > 0 else
                        "CACHE FILL" if e_usage["cache_creation_input_tokens"] > 0 else
                        "no cache"
                    )
                    log.info("    extract [%s] in:%d out:%d",
                             cache_status, e_usage["input_tokens"], e_usage["output_tokens"])
                    images_described += 1

                except anthropic.RateLimitError:
                    log.warning("    rate limited (extract) — sleeping 60s")
                    time.sleep(60)
                    images_skipped += 1
                    continue
                except anthropic.APIError as exc:
                    log.error("    extract API error: %s", exc)
                    images_skipped += 1
                    continue

                if args.delay > 0:
                    time.sleep(args.delay)

            # ── OCR aggregate: facets from text designed into the images ────────
            image_text = "\n\n".join(ocr_chunks).strip()
            out_image_text_raw = ""
            if args.ocr and image_text:
                log.info("    OCR aggregate: %d words of designed-in text → facets",
                         len(image_text.split()))
                try:
                    tresult, t_usage = call_extract_text(
                        client, system_blocks, rc_id, title,
                        image_text, args.extract_model,
                    )
                    per_img_usage.append(t_usage)
                    tok["ext_in"]       += t_usage["input_tokens"]
                    tok["ext_out"]      += t_usage["output_tokens"]
                    tok["cache_create"] += t_usage["cache_creation_input_tokens"]
                    tok["cache_read"]   += t_usage["cache_read_input_tokens"]
                    if tresult.get("parse_error"):
                        log.warning("    image-text extract PARSE ERROR — "
                                    "raw saved in _image_text_raw")
                        out_image_text_raw = tresult.get("raw_response", "")
                    else:
                        tagged = tag_provenance(tresult.get("facets", {}),
                                                "image-text", modality="image-text")
                        n_added = sum(len(v) for v in tagged.values()
                                      if isinstance(v, list))
                        merged_facets = merge_facets(merged_facets, tagged)
                        for u in (tresult.get("uncontrolled_terms") or []):
                            if isinstance(u, dict):
                                merged_unctrl.append({
                                    **u, "modality_source": "image-text",
                                    "media_ref": "image-text",
                                })
                        log.info("    image-text → %d facets from designed-in text",
                                 n_added)
                except anthropic.APIError as exc:
                    log.error("    image-text extract API error: %s", exc)

            out_rec = {
                "rc_id":               rc_id,
                "title":               title,
                "exposition_type":     inv.get("exposition_type", ""),
                "image_descriptions":  image_descs,
                "image_text":          image_text,
                "_image_text_raw":     out_image_text_raw,
                "facets":              merged_facets,
                "uncontrolled_terms":  merged_unctrl,
                "_images_attempted":   len(candidates),
                # Per-record count from this exposition's own results — NOT the
                # module-level `images_described`, which is a running total across
                # all expositions (used only for the final summary line).
                "_images_described":   sum(1 for d in image_descs
                                           if d.get("media_status") == "described"),
                "_usage_per_image":    per_img_usage,
            }
            out_f.write(json.dumps(out_rec, ensure_ascii=False) + "\n")
            out_f.flush()
            expos_ok += 1

    log.info("─" * 60)
    log.info("Expositions: ok=%d  failed=%d", expos_ok, expos_failed)
    log.info("Images: described=%d  skipped=%d", images_described, images_skipped)
    log.info("Tokens — describe in:%d out:%d | extract in:%d out:%d | cache_create:%d cache_read:%d",
             tok["desc_in"], tok["desc_out"],
             tok["ext_in"],  tok["ext_out"],
             tok["cache_create"], tok["cache_read"])

    # Cost estimate: Opus for describe, Haiku for extract
    cost = (
        tok["desc_in"]  * 5.00 / 1_000_000
        + tok["desc_out"] * 25.00 / 1_000_000
        + tok["ext_in"]   * 1.00 / 1_000_000
        + tok["ext_out"]  * 5.00 / 1_000_000
        + tok["cache_create"] * 1.00 / 1_000_000
        + tok["cache_read"]   * 0.08 / 1_000_000
    )
    log.info("Estimated cost: $%.4f", cost)


if __name__ == "__main__":
    main()
