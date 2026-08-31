#!/usr/bin/env python3
"""
test_extraction.py — Eyeball the v2.1 extraction schema on a curated sample.

Runs the metadata extraction on a small, curated sample of expositions and
prints the impact/relevance fields for review — so you can judge classification
quality on real artistic-research text before committing to a full
re-extraction. **Writes nothing to the database**; it also saves the full
extractions to a JSON file for review.

Curation (from the 10-exposition eyeball, 31.8.2026):
  • INCLUSION — only expositions published in a peer-reviewed artistic-research
    journal (see pipeline.PEER_REVIEWED_VENUE_PHRASES). This drops MA-thesis
    PDF dumps, conference documentation, and works-in-progress.
  • COVERAGE — sampled across the WHOLE corpus, not the first 800 ids, so the
    sample is not locked into the earliest cohort / a narrow year range.

By default runs a SINGLE model (Sonnet, confirmed) so you can eyeball the
sharpened-prompt output. Pass --model-b to also compare a second model.

Usage
-----
    python3 pipeline/test_extraction.py                       # Sonnet only, 12 peer-reviewed
    python3 pipeline/test_extraction.py --limit 15
    python3 pipeline/test_extraction.py --model-b claude-opus-4-8   # Sonnet vs Opus
    python3 pipeline/test_extraction.py --no-body                   # title+abstract only (faster)

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

# Reuse the pipeline's extraction (uses the LOCAL extraction_schema.json — v2.1)
# and the shared peer-reviewed inclusion rule.
from pipeline import (
    extract_metadata, fetch_expo_json, extract_pages, author_name,
    is_peer_reviewed, PEER_REVIEWED_VENUE_PHRASES,
    NOT_FOUND, EXTRACT_TEXT_MAX,
)

# The dimensions the prompt sharpenings target — shown for quick eyeballing.
FOCUS = [
    "impact_types", "impact_evidence_level",
    "impact_scope_domain", "debates_addressed",
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


def fetch_all_peer_reviewed(sb):
    """Page through the whole table and keep peer-reviewed expositions with a
    usable abstract. Covers all years, not just the earliest ids."""
    usable, offset, page = [], 0, 1000
    while True:
        rows = (sb.table("expositions")
                  .select("id,title,author,abstract,published_in")
                  .order("id").range(offset, offset + page - 1).execute().data)
        if not rows:
            break
        for r in rows:
            if not is_peer_reviewed(r.get("published_in")):
                continue
            if not (r.get("title") or "").strip():
                continue
            if len((r.get("abstract") or "").strip()) <= 60:
                continue
            usable.append(r)
        if len(rows) < page:
            break
        offset += page
    return usable


def venue_label(published_in) -> str:
    names = published_in or []
    if isinstance(names, str):
        names = [names]
    for n in names:
        low = (n or "").lower()
        if any(p in low for p in PEER_REVIEWED_VENUE_PHRASES):
            return n
    return ", ".join(names) if names else "?"


def main() -> None:
    ap = argparse.ArgumentParser(description="Curated extraction quality eyeball (peer-reviewed only)")
    ap.add_argument("--limit", type=int, default=12, help="Sample size (default 12)")
    ap.add_argument("--model-a", default="claude-sonnet-4-6", help="Model A (default Sonnet, confirmed)")
    ap.add_argument("--model-b", default=None, help="Optional second model to compare (e.g. claude-opus-4-8)")
    ap.add_argument("--no-body", action="store_true", help="Use title+abstract only (skip RC body fetch)")
    ap.add_argument("--out", default="output/extraction_test.json", help="Save full JSON here")
    args = ap.parse_args()

    for v in ("ANTHROPIC_API_KEY", "SUPABASE_URL", "SUPABASE_SERVICE_KEY"):
        if not os.environ.get(v):
            sys.exit(f"{v} not set")

    ant = anthropic.Anthropic(api_key=os.environ["ANTHROPIC_API_KEY"])
    sb  = create_client(os.environ["SUPABASE_URL"], os.environ["SUPABASE_SERVICE_KEY"])
    schema = json.load(open(Path(__file__).parent / "extraction_schema.json"))  # v2.1, local

    # Curated pool: peer-reviewed venues, across the whole corpus.
    pool = fetch_all_peer_reviewed(sb)
    if not pool:
        sys.exit("No peer-reviewed expositions found — has published_in been populated? "
                 "(run: python3 pipeline.py --portals-only)")
    stride = max(1, len(pool) // args.limit)
    sample = pool[::stride][:args.limit]

    two_model = bool(args.model_b)
    print(f"Schema {schema.get('version')} — peer-reviewed pool: {len(pool)} expositions"
          f" (sampling {len(sample)} across all years)")
    if two_model:
        print(f"Comparing  A = {args.model_a}   vs   B = {args.model_b}"
              f"{'' if args.no_body else '  (title + abstract + body)'}\n")
    else:
        print(f"Model: {args.model_a}"
              f"{'' if args.no_body else '  (title + abstract + body)'}\n")

    records = []
    for i, ex in enumerate(sample, 1):
        title    = (ex.get("title") or "").strip()
        abstract = (ex.get("abstract") or "").strip()
        author   = author_name(ex.get("author"))
        body     = "" if args.no_body else body_text(str(ex["id"]))

        a = extract_metadata(ant, title, author, abstract, body, schema, model=args.model_a)
        b = extract_metadata(ant, title, author, abstract, body, schema, model=args.model_b) if two_model else None

        print("═" * 92)
        print(f"[{i}/{len(sample)}]  {title[:78]}   (id {ex['id']})")
        print(f"      venue: {venue_label(ex.get('published_in'))}")
        for k in FOCUS:
            if two_model:
                print(f"  {k}")
                print(f"     A: {json.dumps((a or {}).get(k), ensure_ascii=False)}")
                print(f"     B: {json.dumps((b or {}).get(k), ensure_ascii=False)}")
            else:
                print(f"  {k}: {json.dumps((a or {}).get(k), ensure_ascii=False)}")
        rec = {"id": ex["id"], "title": title,
               "venue": venue_label(ex.get("published_in")),
               "model_a": args.model_a, "a": a}
        if two_model:
            rec.update({"model_b": args.model_b, "b": b})
        records.append(rec)
        time.sleep(0.3)

    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    json.dump(records, open(args.out, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
    print("═" * 92)
    print(f"Done — {len(records)} expositions. Full extractions (all fields) saved to {args.out}")
    print("Eyeball the focus fields above, or open the JSON for every field.")


if __name__ == "__main__":
    main()
