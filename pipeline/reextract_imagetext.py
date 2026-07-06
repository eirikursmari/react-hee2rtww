#!/usr/bin/env python3
"""
reextract_imagetext.py — (re)run facet extraction over already-OCR'd image_text.

The OCR (vision) step is the expensive part and its output is saved as
`image_text` in each rc_multimodal record. This tool re-runs ONLY the cheap
text facet-extraction over that saved text — to diagnose or repair runs where
the image-text facets came out empty (e.g. the aggregate extraction hit a
parse error and was silently dropped).

Usage
-----
    # Diagnose (dry run): print what extraction returns per exposition
    python3 pipeline/reextract_imagetext.py output/deepdive.jsonl

    # Repair: merge image-text facets into the records, rewrite in place (+ .bak)
    python3 pipeline/reextract_imagetext.py output/deepdive.jsonl --write

Environment: ANTHROPIC_API_KEY required.
"""

import argparse
import json
import os
import sys
from pathlib import Path

import anthropic

# rc_multimodal lives alongside this script (sys.path[0] is this dir when run)
from rc_multimodal import (
    EXTRACT_PREAMBLE, SCHEMA_PATH, MULTIMODAL_PATH, EXTRACT_MODEL,
    call_extract_text, tag_provenance, merge_facets,
)


def build_system_blocks() -> list[dict]:
    schema = (Path(SCHEMA_PATH).read_text(encoding="utf-8")
              + "\n\n---\n\n"
              + Path(MULTIMODAL_PATH).read_text(encoding="utf-8"))
    return [{
        "type": "text",
        "text": EXTRACT_PREAMBLE + "\n\n---\n\n" + schema,
        "cache_control": {"type": "ephemeral"},
    }]


def strip_image_text(facets: dict) -> dict:
    """Drop existing image-text entries so a re-run doesn't duplicate them."""
    out = {}
    for k, entries in (facets or {}).items():
        if isinstance(entries, list):
            out[k] = [e for e in entries
                      if not (isinstance(e, dict)
                              and e.get("modality_source") == "image-text")]
        else:
            out[k] = entries
    return out


def main() -> None:
    ap = argparse.ArgumentParser(description="Re-extract facets from saved image_text")
    ap.add_argument("jsonl", help="rc_multimodal output JSONL")
    ap.add_argument("--write", action="store_true",
                    help="Merge image-text facets into records and rewrite (+ .bak)")
    ap.add_argument("--model", default=EXTRACT_MODEL)
    args = ap.parse_args()

    key = os.environ.get("ANTHROPIC_API_KEY")
    if not key:
        sys.exit("ANTHROPIC_API_KEY not set")

    path = Path(args.jsonl)
    if not path.exists():
        sys.exit(f"Not found: {path}")

    client = anthropic.Anthropic(api_key=key)
    system = build_system_blocks()

    records = [json.loads(l) for l in path.read_text(encoding="utf-8").splitlines()
               if l.strip()]

    changed = 0
    for rec in records:
        image_text = (rec.get("image_text") or "").strip()
        if not image_text:
            continue
        rc_id = str(rec.get("rc_id") or "")
        title = rec.get("title", "") or ""

        result, _ = call_extract_text(client, system, rc_id, title,
                                      image_text, args.model)

        if result.get("parse_error"):
            print(f"{rc_id}: PARSE_ERROR — raw head: "
                  f"{result.get('raw_response', '')[:160]!r}")
            continue

        facets = result.get("facets", {}) or {}
        n = sum(len(v) for v in facets.values() if isinstance(v, list))
        by_facet = {k: len(v) for k, v in facets.items()
                    if isinstance(v, list) and v}
        print(f"{rc_id}: {n} image-text facets  ({len(image_text.split())} words in)"
              + (f"  {by_facet}" if by_facet else ""))

        if args.write and n:
            base = strip_image_text(rec.get("facets") or {})
            tagged = tag_provenance(facets, "image-text", modality="image-text")
            rec["facets"] = merge_facets(base, tagged)
            for u in (result.get("uncontrolled_terms") or []):
                if isinstance(u, dict):
                    rec.setdefault("uncontrolled_terms", []).append({
                        **u, "modality_source": "image-text",
                        "media_ref": "image-text",
                    })
            changed += 1

    if args.write and changed:
        backup = path.with_suffix(path.suffix + ".bak")
        backup.write_text(path.read_text(encoding="utf-8"), encoding="utf-8")
        with path.open("w", encoding="utf-8") as f:
            for rec in records:
                f.write(json.dumps(rec, ensure_ascii=False) + "\n")
        print(f"\nRewrote {changed} record(s). Backup: {backup}")
    elif args.write:
        print("\nNothing written (no image-text facets produced).")


if __name__ == "__main__":
    main()
