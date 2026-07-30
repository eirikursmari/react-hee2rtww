#!/usr/bin/env python3
"""
scope_rescue.py — Measure the text-sparse cohort and estimate the cost/time
of a full multimodal rescue run, BEFORE committing to it.

For every exposition (or a sample), fetches the map.rcdata.org snapshot and
records two things — the extracted text word count and the number of
fetchable, RC-hosted images — then:

  • classifies the rescue cohort  = text-sparse AND image-bearing
  • projects vision-call volume    = Σ fetchable_images over the cohort
  • estimates API cost and wall-clock time for the rescue

Measuring is FREE: only RC snapshot fetches, no OpenAI/Anthropic calls.

Usage
-----
    # Fast estimate from a spread sample (default 400), ~2 min:
    python3 pipeline/scope_rescue.py

    # Exact, whole-corpus scan + write the rescue work-list (~20-30 min):
    python3 pipeline/scope_rescue.py --full --out output/rescue_cohort.jsonl

    # Tune the sparseness threshold:
    python3 pipeline/scope_rescue.py --max-words 500

Environment
-----------
    SUPABASE_URL, SUPABASE_SERVICE_KEY   (no API keys needed)
"""

import argparse
import json
import logging
import os
import statistics
import sys
import time

import requests as req_lib
from supabase import create_client

# Reuse the canonical text extraction and media parsing already in the pipeline.
from backfill_wordcount import extract_text
from rc_inventory import parse_media_blocks

logging.basicConfig(level=logging.INFO,
                    format="%(asctime)s  %(levelname)-8s  %(message)s",
                    datefmt="%H:%M:%S")
log = logging.getLogger(__name__)

RC_EXPO_URL = "https://map.rcdata.org/rcjson/expo"

# ── Cost model ────────────────────────────────────────────────────────────────
# The rescue (rc_multimodal.py --ocr) makes, per image, ONE combined
# describe+OCR vision call on the describe model, then ONE Haiku extract call
# per exposition over the pooled description+OCR text. Token figures are
# deliberate averages — printed in the report so the assumptions are visible.
IMG_INPUT_TOKENS      = 2000   # a 1568px-long-edge image, Claude vision
DESCRIBE_PROMPT_TOKENS = 300
DESCRIBE_OUTPUT_TOKENS = 500   # describe+OCR reply (cap is 1600; text-heavy runs higher)
PER_IMAGE_TEXT_TOKENS  = 400   # pooled desc+OCR fed to the extract call
EXTRACT_PROMPT_TOKENS  = 1200
EXTRACT_OUTPUT_TOKENS  = 800

# $ per 1M tokens (input, output)
PRICE = {
    "claude-opus-4-8":  (5.0, 25.0),   # rc_multimodal default describe model
    "claude-sonnet-5":  (3.0, 15.0),   # a mid alternative
    "claude-haiku-4-5": (1.0,  5.0),   # extract model (and a cheap describe option)
}
EXTRACT_MODEL = "claude-haiku-4-5"

SECONDS_PER_IMAGE = 4.0   # rough: API latency + rate-limit spacing, mostly sequential


def describe_cost_per_image(model: str) -> float:
    pin, pout = PRICE[model]
    return ((IMG_INPUT_TOKENS + DESCRIBE_PROMPT_TOKENS) / 1e6) * pin \
         + (DESCRIBE_OUTPUT_TOKENS / 1e6) * pout


def extract_cost_per_expo(images: int) -> float:
    pin, pout = PRICE[EXTRACT_MODEL]
    return ((images * PER_IMAGE_TEXT_TOKENS + EXTRACT_PROMPT_TOKENS) / 1e6) * pin \
         + (EXTRACT_OUTPUT_TOKENS / 1e6) * pout


# ── Supabase helpers ──────────────────────────────────────────────────────────
def all_exposition_ids(sb) -> list[int]:
    ids, offset, page = [], 0, 1000
    while True:
        rows = (sb.table("expositions").select("id").order("id")
                  .range(offset, offset + page - 1).execute().data)
        if not rows:
            break
        ids.extend(r["id"] for r in rows)
        offset += page
    return ids


def already_rescued_ids(sb) -> set[int]:
    rows = (sb.table("exposition_chunks").select("exposition_id")
              .in_("source", ["image", "image-text"]).execute().data)
    return {r["exposition_id"] for r in rows}


# ── Per-exposition measurement ────────────────────────────────────────────────
def measure(expo_id: int, session) -> tuple[int, int] | None:
    """Return (text_word_count, fetchable_image_count) or None on fetch failure."""
    try:
        r = session.get(f"{RC_EXPO_URL}/{expo_id}", timeout=30)
        if r.status_code == 404:
            return None
        r.raise_for_status()
        data = r.json()
    except (req_lib.RequestException, ValueError):
        return None
    words = len(extract_text(data).split())
    images = sum(1 for b in parse_media_blocks(data)
                 if b["media_type"] == "image" and b["url_status"] == "rc_hosted")
    return words, images


def main() -> None:
    ap = argparse.ArgumentParser(description="Scope the multimodal rescue cohort")
    ap.add_argument("--full", action="store_true",
                    help="Scan the whole corpus (else sample). Enables --out.")
    ap.add_argument("--sample", type=int, default=400,
                    help="Sample size when not --full (default 400)")
    ap.add_argument("--max-words", type=int, default=300,
                    help="Text-sparse threshold in words (default 300)")
    ap.add_argument("--out", default=None,
                    help="With --full: write the cohort work-list JSONL here")
    ap.add_argument("--delay", type=float, default=0.15,
                    help="Seconds between RC fetches (default 0.15)")
    args = ap.parse_args()

    for var in ("SUPABASE_URL", "SUPABASE_SERVICE_KEY"):
        if not os.environ.get(var):
            sys.exit(f"{var} not set")
    sb = create_client(os.environ["SUPABASE_URL"], os.environ["SUPABASE_SERVICE_KEY"])

    log.info("Loading exposition ids…")
    ids = all_exposition_ids(sb)
    rescued = already_rescued_ids(sb)
    todo = [i for i in ids if i not in rescued]
    total = len(todo)
    log.info("%d expositions indexed; %d already rescued; %d candidates",
             len(ids), len(rescued), total)
    if total == 0:
        sys.exit("Nothing to scope.")

    if args.full:
        work = todo
    else:
        stride = max(1, total // args.sample)          # spread across the id range
        work = todo[::stride][: args.sample]
    log.info("Measuring %d exposition(s)%s…", len(work),
             "" if args.full else f" (sample of {total})")

    session = req_lib.Session()
    session.headers["User-Agent"] = "rc-scope/1.0"

    cohort: list[tuple[int, int]] = []   # (expo_id, images)
    measured = failed = 0
    for n, expo_id in enumerate(work, 1):
        res = measure(expo_id, session)
        if res is None:
            failed += 1
        else:
            measured += 1
            words, images = res
            if words < args.max_words and images >= 1:
                cohort.append((expo_id, images))
        if n % 100 == 0:
            log.info("  %d/%d measured, %d in cohort so far", n, len(work), len(cohort))
        if args.delay:
            time.sleep(args.delay)

    if measured == 0:
        sys.exit("No expositions could be measured (RC unreachable?).")

    # ── Cohort statistics (measured set) ─────────────────────────────────────
    cohort_n = len(cohort)
    imgs = [c[1] for c in cohort]
    total_imgs_measured = sum(imgs)
    mean_imgs = statistics.mean(imgs) if imgs else 0
    med_imgs  = statistics.median(imgs) if imgs else 0

    # ── Project to the full candidate set when sampling ──────────────────────
    if args.full:
        est_cohort, est_images, scope = cohort_n, total_imgs_measured, "measured (full scan)"
    else:
        frac = cohort_n / measured
        est_cohort = round(frac * total)
        est_images = round(est_cohort * mean_imgs)
        scope = f"projected from a {measured}-exposition sample"

    # ── Cost + time ──────────────────────────────────────────────────────────
    def run_cost(describe_model: str) -> float:
        return est_images * describe_cost_per_image(describe_model) \
             + est_cohort * extract_cost_per_expo(mean_imgs)

    hours = est_images * SECONDS_PER_IMAGE / 3600

    print("\n" + "═" * 64)
    print("  MULTIMODAL RESCUE — SCOPING REPORT")
    print("═" * 64)
    print(f"  Candidate expositions (not yet rescued): {total}")
    print(f"  Sparseness threshold: < {args.max_words} words AND ≥ 1 fetchable image")
    print(f"  Basis: {scope}")
    print("-" * 64)
    print(f"  Rescue cohort:        {est_cohort:>6}  expositions")
    print(f"  Fetchable images:     {est_images:>6}  (≈ vision calls)")
    print(f"  Images per exposition: mean {mean_imgs:.1f}, median {med_imgs:.0f}")
    print("-" * 64)
    print("  Estimated API cost (describe+OCR model → total):")
    for m in ("claude-opus-4-8", "claude-sonnet-5", "claude-haiku-4-5"):
        tag = "  (rc_multimodal default)" if m == "claude-opus-4-8" else ""
        print(f"    {m:<18} ${run_cost(m):>8.2f}{tag}")
    print(f"  Estimated wall-clock:  ~{hours:.1f} h  (at {SECONDS_PER_IMAGE:.0f}s/image, mostly sequential)")
    print("-" * 64)
    print("  Token assumptions (per image unless noted):")
    print(f"    image {IMG_INPUT_TOKENS} in + {DESCRIBE_PROMPT_TOKENS} prompt → {DESCRIBE_OUTPUT_TOKENS} out;"
          f"  extract/expo {EXTRACT_OUTPUT_TOKENS} out ({EXTRACT_MODEL})")
    print(f"  Measured {measured}, fetch-failed {failed}.")
    print("═" * 64 + "\n")

    if args.full and args.out:
        with open(args.out, "w", encoding="utf-8") as f:
            for expo_id, images in sorted(cohort):
                f.write(json.dumps({"rc_id": str(expo_id), "fetchable_images": images}) + "\n")
        log.info("Wrote %d cohort ids → %s (feed to the rescue run)", cohort_n, args.out)
    elif args.out and not args.full:
        log.warning("--out is only written with --full (sample runs don't enumerate the cohort)")


if __name__ == "__main__":
    main()
