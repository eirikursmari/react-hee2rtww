#!/usr/bin/env python3
"""
rc_extract.py — Faceted metadata extraction for RC expositions.

Two source modes
----------------
Fetch mode (default — no local files needed):
    python3 rc_extract.py OUTPUT.jsonl
    python3 rc_extract.py OUTPUT.jsonl --sample 150

Local-files mode (if you have exposition JSONs downloaded):
    python3 rc_extract.py OUTPUT.jsonl /path/to/expo-jsons
    python3 rc_extract.py OUTPUT.jsonl /path/to/expo-jsons --sample 150

Resumable: already-processed rc_ids are skipped on restart.

Environment variables
---------------------
    ANTHROPIC_API_KEY         required (always)
    SUPABASE_URL              required for fetch mode
    SUPABASE_SERVICE_ROLE_KEY required for fetch mode
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
import requests as req_lib

# ── Constants ──────────────────────────────────────────────────────────────────

SCHEMA_PATH   = Path(__file__).parent.parent / "schema" / "artistic-research-extraction-schema.md"
DEFAULT_MODEL = "claude-haiku-4-5-20251001"
MAX_WORDS     = 4_000
DEFAULT_DELAY = 0.3
RC_EXPO_URL   = "https://map.rcdata.org/rcjson/expo"

SYSTEM_PREAMBLE = (
    "You are a structured metadata extractor for artistic research expositions "
    "from the Research Catalogue (researchcatalogue.net).\n\n"
    "Below is the complete faceted extraction schema you must follow, including "
    "all facet definitions, controlled term lists, the required JSON output format, "
    "and the extraction rules. Read it carefully before processing each exposition."
)

# ── Logging ────────────────────────────────────────────────────────────────────

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-8s  %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger(__name__)

# ── Text helpers ───────────────────────────────────────────────────────────────

def strip_html(text: str) -> str:
    text = re.sub(r"<[^>]+>", " ", text or "")
    text = html_module.unescape(text)
    return re.sub(r"\s+", " ", text).strip()


def extract_text(data: dict) -> str:
    """Pull plain text from an RC exposition content JSON (pages → tools)."""
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


def get_year(data: dict) -> Optional[str]:
    for key in ("created", "date", "created_at", "publication_date", "year"):
        val = str(data.get(key, ""))
        m = re.search(r"(20\d\d|19\d\d)", val)
        if m:
            return m.group(1)
    return None


def build_user_message(meta: dict, content: Optional[dict] = None) -> str:
    """
    Build the user prompt from exposition metadata + optional full-text content.
    `meta` is the Supabase row or local JSON file dict.
    `content` is the RC content JSON (pages) if fetched separately.
    """
    expo_id  = str(meta.get("id") or "unknown")
    title    = meta.get("title", "Untitled")
    abstract = meta.get("abstract") or meta.get("description") or ""

    kw = meta.get("keywords", [])
    if isinstance(kw, str):
        kw = [k.strip() for k in kw.split(",") if k.strip()]
    kw_str = ", ".join(kw[:20]) if kw else ""

    # Full text: from separate content dict (fetch mode) or embedded (local mode)
    body_source = content if content is not None else meta
    body = truncate_words(extract_text(body_source))

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

# ── Supabase fetch ─────────────────────────────────────────────────────────────

def fetch_supabase_rows(sb_url: str, sb_key: str) -> list[dict]:
    """Page through the expositions table and return all non-unavailable rows."""
    headers = {
        "apikey":        sb_key,
        "Authorization": f"Bearer {sb_key}",
        "Range-Unit":    "items",
    }
    PAGE = 1000
    offset = 0
    all_rows: list[dict] = []

    log.info("Fetching exposition index from Supabase…")
    while True:
        r = req_lib.get(
            f"{sb_url}/rest/v1/expositions",
            headers={**headers, "Range": f"{offset}-{offset + PAGE - 1}"},
            params={
                "select":     "id,title,abstract,keywords,created_at",
                "order":      "id",
                "unavailable": "not.eq.true",
            },
            timeout=30,
        )
        r.raise_for_status()
        rows = r.json()
        if not rows:
            break
        all_rows.extend(rows)
        log.info("  …%d rows fetched", len(all_rows))
        if len(rows) < PAGE:
            break
        offset += PAGE

    log.info("Total: %d expositions from Supabase", len(all_rows))
    return all_rows


def fetch_rc_content(expo_id: int, session: req_lib.Session) -> Optional[dict]:
    """Fetch the full exposition content JSON from map.rcdata.org."""
    url = f"{RC_EXPO_URL}/{expo_id}"
    try:
        r = session.get(url, timeout=30)
        if r.status_code == 404:
            log.warning("  404 — skipping %d", expo_id)
            return None
        r.raise_for_status()
        return r.json()
    except req_lib.RequestException as e:
        log.warning("  RC fetch failed for %d: %s", expo_id, e)
        return None

# ── Stratified sampling ────────────────────────────────────────────────────────

def stratified_sample_rows(rows: list[dict], n: int, seed: int) -> list[dict]:
    """Sample n rows proportionally from year strata."""
    strata: dict[str, list[dict]] = {}
    for row in rows:
        year = get_year(row) or "unknown"
        strata.setdefault(year, []).append(row)

    log.info("Year strata: %s", {k: len(v) for k, v in sorted(strata.items())})

    rng   = random.Random(seed)
    total = len(rows)
    sampled: list[dict] = []

    for year, group in sorted(strata.items()):
        quota = max(1, round(n * len(group) / total))
        sampled.extend(rng.sample(group, min(quota, len(group))))

    rng.shuffle(sampled)
    if len(sampled) > n:
        sampled = sampled[:n]
    elif len(sampled) < n:
        extras = [r for r in rows if r not in set(sampled)]
        rng.shuffle(extras)
        sampled.extend(extras[: n - len(sampled)])

    log.info("Stratified sample: %d from %d total", len(sampled), total)
    return sampled


def stratified_sample_files(files: list[Path], n: int, seed: int) -> list[Path]:
    """Sample n files proportionally from year strata."""
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
        sampled.extend(rng.sample(group, min(quota, len(group))))

    rng.shuffle(sampled)
    if len(sampled) > n:
        sampled = sampled[:n]
    elif len(sampled) < n:
        extras = [f for f in files if f not in set(sampled)]
        rng.shuffle(extras)
        sampled.extend(extras[: n - len(sampled)])

    log.info("Stratified sample: %d from %d total", len(sampled), total)
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
                rc_id = json.loads(line).get("rc_id")
                if rc_id:
                    done.add(str(rc_id))
            except Exception:
                pass
    return done

# ── Claude call ────────────────────────────────────────────────────────────────

def build_system_blocks(schema_text: str) -> list[dict]:
    return [{
        "type": "text",
        "text": SYSTEM_PREAMBLE + "\n\n---\n\n" + schema_text,
        "cache_control": {"type": "ephemeral"},
    }]


def call_claude(
    client: anthropic.Anthropic,
    system_blocks: list[dict],
    user_text: str,
    model: str,
) -> tuple[dict, dict]:
    response = client.messages.create(
        model=model,
        max_tokens=8192,
        system=system_blocks,
        messages=[{"role": "user", "content": user_text}],
    )

    raw = response.content[0].text.strip()
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

# ── Shared run loop ────────────────────────────────────────────────────────────

def run_loop(items, get_meta_and_content, client, system_blocks, model,
             output_path, done_ids, delay):
    """
    items              — iterable of whatever the source mode produces
    get_meta_and_content(item) → (expo_id: str, meta: dict, content: dict|None)
    """
    ok = failed = skipped = 0
    totals = dict(input=0, output=0, cache_create=0, cache_read=0)
    n = len(items)

    with output_path.open("a", encoding="utf-8") as out_f:
        for i, item in enumerate(items, 1):
            try:
                expo_id, meta, content = get_meta_and_content(item)
            except Exception as e:
                log.warning("[%d/%d] Could not prepare item: %s", i, n, e)
                failed += 1
                continue

            if expo_id in done_ids:
                skipped += 1
                continue

            log.info("[%d/%d] %s — %s", i, n, expo_id,
                     str(meta.get("title", ""))[:55])

            user_text = build_user_message(meta, content)

            try:
                result, usage = call_claude(client, system_blocks, user_text, model)
                result.setdefault("rc_id", expo_id)
                result["_usage"] = usage

                out_f.write(json.dumps(result, ensure_ascii=False) + "\n")
                out_f.flush()

                totals["input"]        += usage["input_tokens"]
                totals["output"]       += usage["output_tokens"]
                totals["cache_create"] += usage["cache_creation_input_tokens"]
                totals["cache_read"]   += usage["cache_read_input_tokens"]

                status = (
                    "CACHE HIT"  if usage["cache_read_input_tokens"]    > 0 else
                    "CACHE FILL" if usage["cache_creation_input_tokens"] > 0 else
                    "no cache"
                )
                log.info("  OK [%s] in:%d out:%d", status,
                         usage["input_tokens"], usage["output_tokens"])

                if result.get("parse_error"):
                    log.warning("  JSON parse error — raw response saved in output")

                ok += 1

            except anthropic.RateLimitError:
                log.warning("  Rate limited — sleeping 60 s")
                time.sleep(60)
                failed += 1

            except anthropic.APIError as e:
                log.error("  API error for %s: %s", expo_id, e)
                failed += 1

            except Exception as e:
                log.error("  Unexpected error for %s: %s", expo_id, e)
                failed += 1

            if delay > 0:
                time.sleep(delay)

    return ok, skipped, failed, totals

# ── Main ───────────────────────────────────────────────────────────────────────

def main() -> None:
    ap = argparse.ArgumentParser(
        description="Faceted extraction from RC expositions",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "Fetch mode (reads from Supabase + RC):\n"
            "  rc_extract.py output.jsonl --sample 150\n\n"
            "Local-files mode:\n"
            "  rc_extract.py output.jsonl /path/to/jsons --sample 150\n"
        ),
    )
    ap.add_argument("output",
                    help="Output JSONL file (appended; safe to resume)")
    ap.add_argument("input_dir", nargs="?", default=None,
                    help="Directory of local exposition JSON files (omit for fetch mode)")
    ap.add_argument("--sample", type=int, metavar="N",
                    help="Stratified random sample of N expositions (default: all)")
    ap.add_argument("--seed",   type=int, default=42, metavar="N",
                    help="Random seed for reproducible samples (default: 42)")
    ap.add_argument("--delay",  type=float, default=DEFAULT_DELAY, metavar="S",
                    help=f"Seconds between API calls (default: {DEFAULT_DELAY})")
    ap.add_argument("--model",  default=DEFAULT_MODEL,
                    help=f"Claude model (default: {DEFAULT_MODEL})")
    ap.add_argument("--schema", default=str(SCHEMA_PATH),
                    help="Path to extraction schema markdown")
    args = ap.parse_args()

    # ── Validate ──────────────────────────────────────────────────────────────

    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        log.error("ANTHROPIC_API_KEY not set"); sys.exit(1)

    schema_path = Path(args.schema)
    if not schema_path.exists():
        log.error("Schema not found: %s", schema_path); sys.exit(1)

    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    fetch_mode = args.input_dir is None

    if fetch_mode:
        sb_url = os.environ.get("SUPABASE_URL")
        sb_key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
        if not sb_url or not sb_key:
            log.error(
                "Fetch mode requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY env vars"
            )
            sys.exit(1)
    else:
        input_dir = Path(args.input_dir)
        if not input_dir.is_dir():
            log.error("Not a directory: %s", input_dir); sys.exit(1)

    # ── Schema ────────────────────────────────────────────────────────────────

    schema_text   = schema_path.read_text(encoding="utf-8")
    system_blocks = build_system_blocks(schema_text)
    log.info("Schema loaded: %d chars — %s", len(schema_text), schema_path.name)

    # ── Build work list ───────────────────────────────────────────────────────

    if fetch_mode:
        all_rows = fetch_supabase_rows(sb_url, sb_key)
        if args.sample and args.sample < len(all_rows):
            rows = stratified_sample_rows(all_rows, args.sample, args.seed)
        else:
            rows = all_rows

        http = req_lib.Session()
        http.headers["User-Agent"] = "rc-extract/1.0"

        def get_meta_and_content(row):
            expo_id = str(row["id"])
            content = fetch_rc_content(int(row["id"]), http)
            return expo_id, row, content

        items = rows

    else:
        all_files = sorted(input_dir.glob("*.json"))
        if not all_files:
            log.error("No .json files found in %s", input_dir); sys.exit(1)
        log.info("Found %d JSON files", len(all_files))

        if args.sample and args.sample < len(all_files):
            files = stratified_sample_files(all_files, args.sample, args.seed)
        else:
            files = all_files

        def get_meta_and_content(filepath):
            data    = json.loads(filepath.read_text(encoding="utf-8"))
            expo_id = str(data.get("id") or filepath.stem)
            return expo_id, data, None   # content embedded in data

        items = files

    # ── Resume ────────────────────────────────────────────────────────────────

    done_ids = load_done_ids(output_path)
    if done_ids:
        log.info("Resuming — %d already processed, will skip", len(done_ids))

    # ── Run ───────────────────────────────────────────────────────────────────

    client = anthropic.Anthropic(api_key=api_key)

    ok, skipped, failed, totals = run_loop(
        items, get_meta_and_content, client, system_blocks,
        args.model, output_path, done_ids, args.delay,
    )

    # ── Summary ───────────────────────────────────────────────────────────────

    log.info("─" * 60)
    log.info("Done — processed:%d  skipped:%d  failed:%d", ok, skipped, failed)
    log.info("Tokens — input:%d  output:%d  cache_create:%d  cache_read:%d",
             totals["input"], totals["output"], totals["cache_create"], totals["cache_read"])

    # Haiku pricing (2025): input $0.80/M, output $4.00/M,
    #                       cache write $1.00/M, cache read $0.08/M
    cost = (
          totals["input"]        * 0.80 / 1_000_000
        + totals["output"]       * 4.00 / 1_000_000
        + totals["cache_create"] * 1.00 / 1_000_000
        + totals["cache_read"]   * 0.08 / 1_000_000
    )
    log.info("Estimated cost: $%.4f", cost)


if __name__ == "__main__":
    main()
