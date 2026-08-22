#!/usr/bin/env python3
"""
openalex_probe.py — Quality probe for the OpenAlex topic taxonomy on THIS corpus.

Sends a small sample of expositions (title + abstract) to the OpenAlex
"aboutness" text endpoint and prints, side by side, what topics / keywords /
concepts it predicts — so you can eyeball whether OpenAlex's scheme is any
good on artistic-research text BEFORE investing in a full (local) classifier.

This does NOT index anything in OpenAlex and does NOT fetch citation impact —
it only applies OpenAlex's *classifier* to your own text.

Usage
-----
    python3 pipeline/openalex_probe.py                 # 20 expositions
    python3 pipeline/openalex_probe.py --limit 30
    python3 pipeline/openalex_probe.py --out probe.jsonl   # also save raw JSON

Environment
-----------
    SUPABASE_URL, SUPABASE_SERVICE_KEY   (to pull the sample)
    OPENALEX_MAILTO    optional — your email, for OpenAlex's "polite pool"
    OPENALEX_API_KEY   optional — only if the /text endpoint requires a premium key

Notes
-----
- The /text endpoints are rate-limited (~1 req/sec) and the classification
  ("aboutness") endpoint is deprecated by OpenAlex; this is a probe, not a
  production layer. If OpenAlex's scheme looks useful here, the real path is
  the open-source model (github.com/ourresearch/openalex-topic-classification)
  run locally.
"""

import argparse
import json
import logging
import os
import sys
import time

import requests as req
from supabase import create_client

logging.basicConfig(level=logging.INFO, format="%(asctime)s  %(levelname)-7s  %(message)s",
                    datefmt="%H:%M:%S")
log = logging.getLogger(__name__)

TEXT_URL   = "https://api.openalex.org/text"   # returns topics + keywords + concepts
ABS_MAX    = 1200                              # keep the GET URL a sane length
REQ_DELAY  = 1.2                               # respect ~1 req/sec


def sample_expositions(sb, want: int) -> list[dict]:
    """Fetch expositions that actually have text to classify (title + abstract)."""
    rows = (sb.table("expositions")
              .select("id,title,abstract")
              .order("id")
              .limit(1200)
              .execute().data)
    usable = [r for r in rows
              if (r.get("title") or "").strip() and len((r.get("abstract") or "").strip()) > 40]
    if not usable:  # fall back to title-only if abstracts are sparse
        usable = [r for r in rows if (r.get("title") or "").strip()]
    stride = max(1, len(usable) // want)          # spread across the id range
    return usable[::stride][:want]


def classify(title: str, abstract: str, params_base: dict) -> tuple[dict | None, str]:
    """Call the OpenAlex /text endpoint. Returns (json, error)."""
    params = dict(params_base)
    params["title"] = title[:300]
    if abstract:
        params["abstract"] = abstract[:ABS_MAX]
    try:
        r = req.get(TEXT_URL, params=params, timeout=30)
        if r.status_code in (401, 403):
            return None, f"auth ({r.status_code}) — endpoint likely needs a premium OPENALEX_API_KEY"
        if r.status_code == 404:
            return None, "404 — endpoint moved/removed (aboutness is deprecated)"
        if r.status_code == 429:
            return None, "429 — rate limited"
        r.raise_for_status()
        return r.json(), ""
    except req.RequestException as e:
        return None, str(e)


def fmt_items(items, n=4) -> str:
    """Format a list of OpenAlex prediction dicts as 'name (field) 0.87'."""
    out = []
    for it in (items or [])[:n]:
        if not isinstance(it, dict):
            continue
        name  = it.get("display_name") or it.get("keyword") or "?"
        score = it.get("score")
        field = (it.get("field") or {}).get("display_name") if isinstance(it.get("field"), dict) else None
        tag   = f" [{field}]" if field else ""
        sc    = f" {score:.2f}" if isinstance(score, (int, float)) else ""
        out.append(f"{name}{tag}{sc}")
    return "; ".join(out) if out else "—"


def main() -> None:
    ap = argparse.ArgumentParser(description="OpenAlex topic-classifier quality probe")
    ap.add_argument("--limit", type=int, default=20, help="Sample size (default 20)")
    ap.add_argument("--out", default=None, help="Optional JSONL of raw responses")
    args = ap.parse_args()

    for v in ("SUPABASE_URL", "SUPABASE_SERVICE_KEY"):
        if not os.environ.get(v):
            sys.exit(f"{v} not set")
    sb = create_client(os.environ["SUPABASE_URL"], os.environ["SUPABASE_SERVICE_KEY"])

    params_base = {}
    if os.environ.get("OPENALEX_MAILTO"):  params_base["mailto"]  = os.environ["OPENALEX_MAILTO"]
    if os.environ.get("OPENALEX_API_KEY"): params_base["api_key"] = os.environ["OPENALEX_API_KEY"]

    sample = sample_expositions(sb, args.limit)
    log.info("Probing %d expositions against OpenAlex /text …\n", len(sample))

    out_f = open(args.out, "w", encoding="utf-8") if args.out else None
    ok = failed = 0
    topic_counts = 0

    for i, ex in enumerate(sample, 1):
        title    = (ex.get("title") or "").strip()
        abstract = (ex.get("abstract") or "").strip()
        data, err = classify(title, abstract, params_base)

        print("─" * 78)
        print(f"[{i}/{len(sample)}] {title[:90]}")
        if err:
            print(f"  ERROR: {err}")
            failed += 1
        else:
            topics   = data.get("topics")   or data.get("results")  # tolerate key drift
            keywords = data.get("keywords")
            concepts = data.get("concepts")
            primary  = data.get("primary_topic")
            if primary and isinstance(primary, dict):
                print(f"  primary topic : {primary.get('display_name', '?')}")
            print(f"  topics        : {fmt_items(topics)}")
            print(f"  keywords      : {fmt_items(keywords)}")
            if concepts:
                print(f"  concepts      : {fmt_items(concepts)}")
            if topics:
                topic_counts += 1
            ok += 1
            if out_f:
                out_f.write(json.dumps({"id": ex.get("id"), "title": title, "response": data},
                                       ensure_ascii=False) + "\n")
        time.sleep(REQ_DELAY)

    if out_f:
        out_f.close()
    print("─" * 78)
    log.info("Done — %d ok, %d failed; %d returned topics. %s",
             ok, failed, topic_counts,
             f"Raw saved to {args.out}" if args.out else "")
    if failed and not ok:
        log.info("If all calls failed with auth/404: the hosted /text endpoint is "
                 "gated/deprecated — use the local model instead "
                 "(github.com/ourresearch/openalex-topic-classification).")


if __name__ == "__main__":
    main()
