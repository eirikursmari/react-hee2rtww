#!/usr/bin/env python3
"""
rc_extract.py — Faceted metadata extraction for RC exposition JSON files.

Reads RC exposition JSONs from a directory, sends each to Claude with the
artistic-research extraction schema as a cached system prompt, and writes
one result per line to a JSONL file. Resumable: already-processed IDs are
skipped on restart.

Usage
-----
    python3 rc_extract.py EXPO_DIR OUTPUT.jsonl
    python3 rc_extract.py EXPO_DIR OUTPUT.jsonl --sample 150
    python3 rc_extract.py EXPO_DIR OUTPUT.jsonl --sample 150 --seed 99

Environment
-----------
    ANTHROPIC_API_KEY   required
"""

import argparse
import html as html_module
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

# ── Constants ──────────────────────────────────────────────────────────────────

SCHEMA_PATH  = Path(__file__).parent.parent / "schema" / "artistic-research-extraction-schema.md"
DEFAULT_MODEL = "claude-haiku-4-5-20251001"
MAX_WORDS    = 4_000          # ~5 k tokens; keeps prompts well under the context limit
DEFAULT_DELAY = 0.3           # seconds between calls; raise if you hit rate limits

SYSTEM_PREAMBLE = """\
You are a structured metadata extractor for artistic research expositions from \
the Research Catalogue (researchcatalogue.net).

Below is the complete faceted extraction schema you must follow, including \
all facet definitions, controlled term lists, the required JSON output format, \
and the extraction rules. Read it carefully before processing each exposition.\
"""

# ── Logging ────────────────────────────────────────────────────────────────────

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-8s  %(message)s",
    datefmt="%H:%M:%S",
    handlers=[logging.StreamHandler()],
)
log = logging.getLogger(__name__)

# ── Text helpers ───────────────────────────────────────────────────────────────

def strip_html(text: str) -> str:
    text = re.sub(r"<[^>]+>", " ", text or "")
    text = html_module.unescape(text)
    return re.sub(r"\s+", " ", text).strip()


def extract_text(data: dict) -> str:
    """Pull plain text from an RC exposition content JSON."""
    pages = data.get("pages", {})
    if isinstance(pages, dict):
        page_list = list(pages.values())
    elif isinstance(pages, list):
        page_list = pages
    else:
        page_list = []

    texts: list[str] = []
    for page in page_list:
        if not isinstance(page, dict):
            continue
        tools = page.get("tools", page)
        if not isinstance(tools, dict):
            continue
        for tool_type in ("tool-text", "tool-simpletext"):
            for tool in tools.get(tool_type, []):
                t = strip_html(tool.get("content", ""))
                if t:
                    texts.append(t)

    # Fall back to top-level text fields for non-standard formats
    if not texts:
        for key in ("text", "content", "body", "fulltext"):
            val = data.get(key, "")
            if isinstance(val, str) and val.strip():
                texts.append(strip_html(val))
                break

    return "\n\n".join(texts)


def truncate_words(text: str, max_words: int = MAX_WORDS) -> str:
    words = text.split()
    if len(words) <= max_words:
        return text
    return " ".join(words[:max_words]) + "\n\n[… truncated at 4 000 words …]"


def get_expo_id(data: dict, filepath: Path) -> str:
    return str(data.get("id") or filepath.stem)


def get_year(data: dict) -> Optional[str]:
    for key in ("created", "date", "created_at", "publication_date", "year"):
        val = str(data.get(key, ""))
        m = re.search(r"(20\d\d|19\d\d)", val)
        if m:
            return m.group(1)
    return None


def build_user_message(data: dict, filepath: Path) -> str:
    expo_id  = get_expo_id(data, filepath)
    title    = data.get("title", "Untitled")
    abstract = data.get("abstract") or data.get("description") or ""
    kw       = data.get("keywords", [])
    if isinstance(kw, str):
        kw = [k.strip() for k in kw.split(",") if k.strip()]
    kw_str = ", ".join(kw[:20]) if kw else ""

    body = truncate_words(extract_text(data))

    parts = [f"RC_ID: {expo_id}", f"TITLE: {title}"]
    if abstract:
        parts.append(f"ABSTRACT:\n{abstract.strip()}")
    if kw_str:
        parts.append(f"KEYWORDS: {kw_str}")
    if body:
        parts.append(f"FULL TEXT:\n{body}")

    parts.append(
        "\nExtract faceted metadata for this exposition following the schema above. "
        "Return ONLY a valid JSON object — no prose, no markdown fences."
    )

    return "\n\n".join(parts)

# ── Stratified sampling ────────────────────────────────────────────────────────

def stratified_sample(files: list[Path], n: int, seed: int) -> list[Path]:
    """
    Sample n files proportionally from year strata so the sample mirrors
    the corpus's temporal distribution. Files with no extractable year go
    into an 'unknown' stratum.
    """
    strata: dict[str, list[Path]] = {}

    log.info("Building strata — reading %d files for year…", len(files))
    for f in files:
        try:
            data = json.loads(f.read_text(encoding="utf-8"))
            year = get_year(data) or "unknown"
        except Exception:
            year = "unknown"
        strata.setdefault(year, []).append(f)

    log.info("Year strata: %s", {k: len(v) for k, v in sorted(strata.items())})

    rng   = random.Random(seed)
    total = len(files)
    sampled: list[Path] = []

    for year, group in sorted(strata.items()):
        quota = max(1, round(n * len(group) / total))
        pick  = rng.sample(group, min(quota, len(group)))
        sampled.extend(pick)

    # Exact trim / top-up
    rng.shuffle(sampled)
    if len(sampled) > n:
        sampled = sampled[:n]
    elif len(sampled) < n:
        extras = [f for f in files if f not in set(sampled)]
        rng.shuffle(extras)
        sampled.extend(extras[: n - len(sampled)])

    log.info("Stratified sample: %d files selected from %d total", len(sampled), total)
    return sampled

# ── Resume ─────────────────────────────────────────────────────────────────────

def load_done_ids(output_path: Path) -> set[str]:
    done: set[str] = set()
    if not output_path.exists():
        return done
    with output_path.open(encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
                rc_id = obj.get("rc_id")
                if rc_id:
                    done.add(str(rc_id))
            except Exception:
                pass
    return done

# ── Claude call ────────────────────────────────────────────────────────────────

def build_system_blocks(schema_text: str) -> list[dict]:
    """
    System prompt in two blocks so the schema (the expensive part) is cached.
    The preamble is tiny and not worth caching separately.
    """
    return [
        {
            "type": "text",
            "text": SYSTEM_PREAMBLE + "\n\n---\n\n" + schema_text,
            "cache_control": {"type": "ephemeral"},
        }
    ]


def call_claude(
    client: anthropic.Anthropic,
    system_blocks: list[dict],
    user_text: str,
    model: str,
) -> tuple[dict, dict]:
    """
    Returns (parsed_result, usage_dict).
    Raises on network/API errors; caller logs and counts failures.
    """
    response = client.messages.create(
        model=model,
        max_tokens=2048,
        system=system_blocks,
        messages=[{"role": "user", "content": user_text}],
        extra_headers={"anthropic-beta": "prompt-caching-2024-07-31"},
    )

    raw = response.content[0].text.strip()

    # Strip accidental markdown fences
    if raw.startswith("```"):
        raw = re.sub(r"^```[a-z]*\n?", "", raw).rstrip("`").strip()

    try:
        result = json.loads(raw)
    except json.JSONDecodeError:
        result = {"parse_error": True, "raw_response": raw[:2000]}

    usage = {
        "input_tokens":                response.usage.input_tokens,
        "output_tokens":               response.usage.output_tokens,
        "cache_creation_input_tokens": getattr(response.usage, "cache_creation_input_tokens", 0),
        "cache_read_input_tokens":     getattr(response.usage, "cache_read_input_tokens", 0),
    }

    return result, usage

# ── Main ───────────────────────────────────────────────────────────────────────

def main() -> None:
    ap = argparse.ArgumentParser(description="Faceted extraction from RC exposition JSONs")
    ap.add_argument("input_dir", help="Directory of exposition JSON files")
    ap.add_argument("output",    help="Output JSONL file (appended; safe to resume)")
    ap.add_argument("--sample",  type=int, metavar="N",
                    help="Stratified random sample of N expositions (default: all)")
    ap.add_argument("--seed",    type=int, default=42, metavar="N",
                    help="Random seed for reproducible samples (default: 42)")
    ap.add_argument("--delay",   type=float, default=DEFAULT_DELAY, metavar="S",
                    help=f"Seconds between API calls (default: {DEFAULT_DELAY})")
    ap.add_argument("--model",   default=DEFAULT_MODEL,
                    help=f"Claude model (default: {DEFAULT_MODEL})")
    ap.add_argument("--schema",  default=str(SCHEMA_PATH),
                    help="Path to extraction schema markdown")
    args = ap.parse_args()

    # ── Validate env + paths ──────────────────────────────────────────────────

    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        log.error("ANTHROPIC_API_KEY not set")
        sys.exit(1)

    input_dir = Path(args.input_dir)
    if not input_dir.is_dir():
        log.error("Not a directory: %s", input_dir)
        sys.exit(1)

    schema_path = Path(args.schema)
    if not schema_path.exists():
        log.error("Schema file not found: %s", schema_path)
        sys.exit(1)

    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    # ── Load schema ───────────────────────────────────────────────────────────

    schema_text    = schema_path.read_text(encoding="utf-8")
    system_blocks  = build_system_blocks(schema_text)
    log.info("Schema loaded: %d chars — %s", len(schema_text), schema_path.name)

    # ── Collect files ─────────────────────────────────────────────────────────

    all_files = sorted(input_dir.glob("*.json"))
    if not all_files:
        log.error("No .json files found in %s", input_dir)
        sys.exit(1)
    log.info("Found %d JSON files", len(all_files))

    if args.sample and args.sample < len(all_files):
        files = stratified_sample(all_files, args.sample, args.seed)
    else:
        files = all_files

    # ── Resume: skip already done ─────────────────────────────────────────────

    done_ids = load_done_ids(output_path)
    if done_ids:
        log.info("Resuming — %d already processed, will skip", len(done_ids))

    # ── Run ───────────────────────────────────────────────────────────────────

    client = anthropic.Anthropic(api_key=api_key)

    ok = failed = skipped = 0
    totals = dict(input=0, output=0, cache_create=0, cache_read=0)

    with output_path.open("a", encoding="utf-8") as out_f:
        for i, filepath in enumerate(files, 1):
            try:
                data = json.loads(filepath.read_text(encoding="utf-8"))
            except Exception as e:
                log.warning("[%d/%d] Unreadable %s: %s", i, len(files), filepath.name, e)
                failed += 1
                continue

            expo_id = get_expo_id(data, filepath)

            if expo_id in done_ids:
                skipped += 1
                continue

            title_preview = str(data.get("title", ""))[:55]
            log.info("[%d/%d] %s — %s", i, len(files), expo_id, title_preview)

            user_text = build_user_message(data, filepath)

            try:
                result, usage = call_claude(client, system_blocks, user_text, args.model)

                # Ensure rc_id is always present
                result.setdefault("rc_id", expo_id)
                result["_usage"] = usage

                out_f.write(json.dumps(result, ensure_ascii=False) + "\n")
                out_f.flush()

                totals["input"]        += usage["input_tokens"]
                totals["output"]       += usage["output_tokens"]
                totals["cache_create"] += usage["cache_creation_input_tokens"]
                totals["cache_read"]   += usage["cache_read_input_tokens"]

                cache_status = (
                    "CACHE HIT"  if usage["cache_read_input_tokens"]   > 0 else
                    "CACHE FILL" if usage["cache_creation_input_tokens"] > 0 else
                    "no cache"
                )
                log.info("  OK [%s] in:%d out:%d",
                         cache_status, usage["input_tokens"], usage["output_tokens"])

                if result.get("parse_error"):
                    log.warning("  JSON parse error — raw response saved in output")

                ok += 1

            except anthropic.RateLimitError:
                log.warning("  Rate limited — sleeping 60 s")
                time.sleep(60)
                failed += 1     # skip for now; re-run to pick it up

            except anthropic.APIError as e:
                log.error("  API error for %s: %s", expo_id, e)
                failed += 1

            except Exception as e:
                log.error("  Unexpected error for %s: %s", expo_id, e)
                failed += 1

            if args.delay > 0:
                time.sleep(args.delay)

    # ── Summary ───────────────────────────────────────────────────────────────

    log.info("─" * 60)
    log.info("Done — processed:%d  skipped:%d  failed:%d", ok, skipped, failed)
    log.info("Tokens — input:%d  output:%d  cache_create:%d  cache_read:%d",
             totals["input"], totals["output"], totals["cache_create"], totals["cache_read"])

    # Rough cost estimate (Haiku pricing as of 2025)
    # Standard input: $0.80/M, output: $4.00/M, cache write: $1.00/M, cache read: $0.08/M
    cost = (
        totals["input"]        * 0.80  / 1_000_000
        + totals["output"]     * 4.00  / 1_000_000
        + totals["cache_create"] * 1.00 / 1_000_000
        + totals["cache_read"] * 0.08  / 1_000_000
    )
    log.info("Estimated cost: $%.4f", cost)


if __name__ == "__main__":
    main()
