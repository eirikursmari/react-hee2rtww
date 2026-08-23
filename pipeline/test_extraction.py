#!/usr/bin/env python3
"""
test_extraction.py — Compare two Claude models on the v2 extraction schema.

Runs the metadata extraction on a small sample of expositions under TWO
models (default Haiku vs Sonnet) and prints their outputs side by side —
so you can judge classification quality on real artistic-research text
before committing to a full re-extraction. **Writes nothing to the
database**; it also saves the full extractions to a JSON file for review.

Usage
-----
    python3 pipeline/test_extraction.py
    python3 pipeline/test_extraction.py --limit 10
    python3 pipeline/test_extraction.py --model-b claude-opus-4-8      # Haiku vs Opus
    python3 pipeline/test_extraction.py --no-body                      # title+abstract only (faster)

Environment
-----------
    ANTHROPIC_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY
"""

import argparse
import json
import os
import sys
import time
from pathlib import Path

import anthropic
from supabase import create_client

# Reuse the pipeline's extraction (uses the LOCAL extraction_schema.json — the v2 we just wrote).
from pipeline import (
    extract_metadata, fetch_expo_json, extract_pages, author_name,
    NOT_FOUND, EXTRACT_TEXT_MAX,
)

# The dimensions the model choice most affects — shown side by side.
FOCUS = [
    "impact_types", "impact_evidence_level",
    "impact_scope_geographic", "impact_scope_domain", "debates_addressed",
]


def body_text(rc_id: str) -> str:
    try:
        content = fetch_expo_json(int(rc_id))
        if content is NOT_FOUND or not content:
            return ""
        pages = extract_pages(content)
        return ("\n\n".join(p["text"] for p in pages))[:EXTRACT_TEXT_MAX] if pages else ""
    except Exception:
        return ""


def main() -> None:
    ap = argparse.ArgumentParser(description="Two-model extraction quality comparison")
    ap.add_argument("--limit", type=int, default=10, help="Sample size (default 10)")
    ap.add_argument("--model-a", default="claude-haiku-4-5", help="Model A (default Haiku)")
    ap.add_argument("--model-b", default="claude-sonnet-4-6", help="Model B (default Sonnet)")
    ap.add_argument("--no-body", action="store_true", help="Use title+abstract only (skip RC body fetch)")
    ap.add_argument("--out", default="output/extraction_test.json", help="Save full JSON here")
    args = ap.parse_args()

    for v in ("ANTHROPIC_API_KEY", "SUPABASE_URL", "SUPABASE_SERVICE_KEY"):
        if not os.environ.get(v):
            sys.exit(f"{v} not set")

    ant = anthropic.Anthropic(api_key=os.environ["ANTHROPIC_API_KEY"])
    sb  = create_client(os.environ["SUPABASE_URL"], os.environ["SUPABASE_SERVICE_KEY"])
    schema = json.load(open(Path(__file__).parent / "extraction_schema.json"))  # v2, local

    # Sample expositions that actually have text to classify.
    rows = (sb.table("expositions").select("id,title,author,abstract")
              .order("id").limit(800).execute().data)
    usable = [r for r in rows
              if (r.get("title") or "").strip() and len((r.get("abstract") or "").strip()) > 60]
    stride = max(1, len(usable) // args.limit)
    sample = usable[::stride][:args.limit]

    print(f"Comparing  A = {args.model_a}   vs   B = {args.model_b}")
    print(f"on {len(sample)} expositions"
          f"{'' if args.no_body else ' (title + abstract + body)'}\n")

    records = []
    for i, ex in enumerate(sample, 1):
        title    = (ex.get("title") or "").strip()
        abstract = (ex.get("abstract") or "").strip()
        author   = author_name(ex.get("author"))
        body     = "" if args.no_body else body_text(str(ex["id"]))

        a = extract_metadata(ant, title, author, abstract, body, schema, model=args.model_a)
        b = extract_metadata(ant, title, author, abstract, body, schema, model=args.model_b)

        print("═" * 92)
        print(f"[{i}/{len(sample)}]  {title[:82]}   (id {ex['id']})")
        for k in FOCUS:
            print(f"  {k}")
            print(f"     A: {json.dumps((a or {}).get(k), ensure_ascii=False)}")
            print(f"     B: {json.dumps((b or {}).get(k), ensure_ascii=False)}")
        records.append({
            "id": ex["id"], "title": title,
            "model_a": args.model_a, "a": a,
            "model_b": args.model_b, "b": b,
        })
        time.sleep(0.3)

    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    json.dump(records, open(args.out, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
    print("═" * 92)
    print(f"Done — {len(records)} expositions. Full extractions (all fields) saved to {args.out}")
    print(f"Eyeball the focus fields above, or open the JSON for every field, then pick a model.")


if __name__ == "__main__":
    main()
