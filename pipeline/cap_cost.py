#!/usr/bin/env python3
"""
cap_cost.py — Recompute the multimodal cost estimate from a scope_rescue.py
--out cohort file, applying rc_multimodal.py's real --max-images cap.

scope_rescue.py sums ALL fetchable images per exposition uncapped. The actual
rc_multimodal.py run caps at --max-images per exposition (default 8), so for a
cohort with a skewed image-count distribution — a handful of image-heavy
expositions pulling the mean far above the median — the capped total run can
be dramatically cheaper than scope_rescue.py's uncapped report suggests. This
reads the already-fetched cohort file (no RC/API calls, instant) and reports
the capped total + cost using the same cost model as scope_rescue.py.

Usage
-----
    python3 pipeline/cap_cost.py output/pr_enrichment_cohort.jsonl
    python3 pipeline/cap_cost.py output/pr_enrichment_cohort.jsonl --max-images 12
"""

import argparse
import json
import statistics
from pathlib import Path

# Mirrors scope_rescue.py's cost model exactly — keep these two in sync.
IMG_INPUT_TOKENS       = 2000
DESCRIBE_PROMPT_TOKENS = 300
DESCRIBE_OUTPUT_TOKENS = 500
PER_IMAGE_TEXT_TOKENS  = 400
EXTRACT_PROMPT_TOKENS  = 1200
EXTRACT_OUTPUT_TOKENS  = 800

PRICE = {
    "claude-opus-4-8":  (5.0, 25.0),
    "claude-sonnet-5":  (3.0, 15.0),
    "claude-haiku-4-5": (1.0,  5.0),
}
EXTRACT_MODEL     = "claude-haiku-4-5"
SECONDS_PER_IMAGE = 4.0


def describe_cost_per_image(model: str) -> float:
    pin, pout = PRICE[model]
    return ((IMG_INPUT_TOKENS + DESCRIBE_PROMPT_TOKENS) / 1e6) * pin \
         + (DESCRIBE_OUTPUT_TOKENS / 1e6) * pout


def extract_cost_per_expo(images: int) -> float:
    pin, pout = PRICE[EXTRACT_MODEL]
    return ((images * PER_IMAGE_TEXT_TOKENS + EXTRACT_PROMPT_TOKENS) / 1e6) * pin \
         + (EXTRACT_OUTPUT_TOKENS / 1e6) * pout


def main() -> None:
    ap = argparse.ArgumentParser(description="Recompute cost with a real --max-images cap")
    ap.add_argument("cohort_jsonl", help="The --out file from a scope_rescue.py --full run")
    ap.add_argument("--max-images", type=int, default=8,
                    help="Per-exposition image cap, matching rc_multimodal.py's "
                         "--max-images (default 8)")
    args = ap.parse_args()

    raw, capped = [], []
    for line in Path(args.cohort_jsonl).read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        rec = json.loads(line)
        n = int(rec["fetchable_images"])
        raw.append(n)
        capped.append(min(n, args.max_images))

    if not raw:
        raise SystemExit(f"No records found in {args.cohort_jsonl}")

    cohort_n     = len(raw)
    total_raw    = sum(raw)
    total_capped = sum(capped)

    def run_cost(model: str) -> float:
        return total_capped * describe_cost_per_image(model) \
             + sum(extract_cost_per_expo(c) for c in capped)

    hours = total_capped * SECONDS_PER_IMAGE / 3600

    print("\n" + "═" * 64)
    print(f"  CAPPED COST — matches an actual rc_multimodal.py --max-images {args.max_images} run")
    print("═" * 64)
    print(f"  Cohort: {cohort_n} expositions")
    print(f"  Uncapped fetchable images: {total_raw:>6}  "
          f"(mean {statistics.mean(raw):.1f}, median {statistics.median(raw):.0f})")
    print(f"  Capped images (this run):  {total_capped:>6}  "
          f"(mean {statistics.mean(capped):.1f})")
    saved_pct = (total_raw - total_capped) / total_raw if total_raw else 0
    print(f"  Images the cap saves:      {total_raw - total_capped:>6}  ({saved_pct:.0%})")
    print("-" * 64)
    print("  Estimated API cost (describe+OCR model → total):")
    for m in ("claude-opus-4-8", "claude-sonnet-5", "claude-haiku-4-5"):
        tag = "  (rc_multimodal default)" if m == "claude-opus-4-8" else ""
        print(f"    {m:<18} ${run_cost(m):>8.2f}{tag}")
    print(f"  Estimated wall-clock: ~{hours:.1f} h  (at {SECONDS_PER_IMAGE:.0f}s/image, mostly sequential)")
    print("═" * 64 + "\n")


if __name__ == "__main__":
    main()
