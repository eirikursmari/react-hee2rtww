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

EXTRACT_PREAMBLE = (
    "You are a structured metadata extractor for artistic research expositions "
    "from the Research Catalogue (researchcatalogue.net).\n\n"
    "Below is the complete faceted extraction schema (v0.1) followed by the "
    "multimodal extension rules. Read both carefully before processing."
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

def call_describe(
    client: anthropic.Anthropic,
    b64: str,
    media_type: str,
    title: str,
    model: str,
) -> tuple[Optional[str], dict]:
    try:
        resp = client.messages.create(
            model=model,
            max_tokens=300,
            system=DESCRIBE_SYSTEM,
            messages=[{
                "role": "user",
                "content": [
                    {"type": "image",
                     "source": {"type": "base64", "media_type": media_type, "data": b64}},
                    {"type": "text",
                     "text": DESCRIBE_PROMPT.format(title=title)},
                ],
            }],
        )
        usage = {
            "input_tokens":  resp.usage.input_tokens,
            "output_tokens": resp.usage.output_tokens,
        }
        return resp.content[0].text.strip(), usage
    except anthropic.RateLimitError:
        log.warning("    rate limited (describe) — sleeping 60s")
        time.sleep(60)
        return None, {}
    except anthropic.APIError as exc:
        log.warning("    describe API error: %s", exc)
        return None, {}


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


# ── Facet helpers ──────────────────────────────────────────────────────────────

def tag_provenance(facets: dict, media_id: str) -> dict:
    """Add modality_source + media_ref to every entry in a facets dict."""
    result = {}
    for key, entries in facets.items():
        if not isinstance(entries, list):
            result[key] = entries
            continue
        result[key] = [
            {**e, "modality_source": "image", "media_ref": media_id}
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

def load_inventory(path: Path, sample: Optional[int], seed: int) -> list[dict]:
    records = []
    with path.open(encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
                if rec.get("fetchable_images", 0) > 0:
                    records.append(rec)
            except Exception:
                pass
    if sample and sample < len(records):
        rng = random.Random(seed)
        records = rng.sample(records, sample)
    return records


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
            "Micro-pilot (recommended first run):\n"
            "  rc_multimodal.py output/inventory.jsonl output/multimodal.jsonl --sample 10\n\n"
            "Full pass:\n"
            "  rc_multimodal.py output/inventory.jsonl output/multimodal.jsonl\n"
        ),
    )
    ap.add_argument("inventory_jsonl", help="Inventory JSONL from rc_inventory.py")
    ap.add_argument("output_jsonl",    help="Output JSONL (appended; resumable)")
    ap.add_argument("--sample", type=int, metavar="N",
                    help="Limit to N expositions (micro-pilot)")
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

    records = load_inventory(Path(args.inventory_jsonl), args.sample, args.seed)
    done    = load_done(Path(args.output_jsonl))
    pending = [r for r in records if str(r["rc_id"]) not in done]

    log.info("%d expositions with fetchable images; %d pending",
             len(records), len(pending))

    client  = anthropic.Anthropic(api_key=api_key)
    session = req_lib.Session()
    session.headers["User-Agent"] = "rc-multimodal/1.0"

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
            log.info("[%d/%d] %s — %s", i, n, rc_id, title[:55])

            candidates = [
                b for b in inv.get("media_inventory", [])
                if b["media_type"] == "image"
                and b["url_status"] == "rc_hosted"
                and b.get("url")
            ][: args.max_images]

            image_descs:     list[dict] = []
            merged_facets    = empty_facets()
            merged_unctrl:   list[dict] = []
            per_img_usage:   list[dict] = []

            for block in candidates:
                media_id = block.get("media_id") or block["url"]
                url      = block["url"]

                img = fetch_image(url, session)
                if img is None:
                    images_skipped += 1
                    image_descs.append({"media_id": media_id, "url": url,
                                        "media_status": "fetch_failed"})
                    continue

                b64, media_type_str = img

                # Step 1 — describe
                description, d_usage = call_describe(
                    client, b64, media_type_str, title, args.describe_model,
                )
                tok["desc_in"]  += d_usage.get("input_tokens",  0)
                tok["desc_out"] += d_usage.get("output_tokens", 0)

                if not description:
                    images_skipped += 1
                    image_descs.append({"media_id": media_id, "url": url,
                                        "media_status": "describe_failed"})
                    continue

                word_count = len(description.split())
                log.info("    %s → %d words", media_id[:24], word_count)

                image_descs.append({
                    "media_id":    media_id,
                    "url":         url,
                    "media_status": "described",
                    "description": description,
                })

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

            out_rec = {
                "rc_id":               rc_id,
                "title":               title,
                "exposition_type":     inv.get("exposition_type", ""),
                "image_descriptions":  image_descs,
                "facets":              merged_facets,
                "uncontrolled_terms":  merged_unctrl,
                "_images_attempted":   len(candidates),
                "_images_described":   images_described,
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
