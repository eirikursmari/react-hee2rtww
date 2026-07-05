#!/usr/bin/env python3
"""
backfill_wordcount.py — Add _text_words to extraction records that lack it.

Early rc_extract.py runs did not record the extracted text word count.
This backfills it by re-fetching each exposition's structure from the
map.rcdata.org snapshot (whose *text* is still valid — only its media
tokens expired) and counting words with the same extract_text() the
pipeline uses. No API keys, no cost.

Usage
-----
    python3 pipeline/backfill_wordcount.py output/pilot.jsonl
    python3 pipeline/backfill_wordcount.py output/pilot.jsonl --force

Safe: writes a .bak backup, then rewrites atomically. Resumable —
records that already have _text_words are skipped unless --force.
"""

import argparse
import html as html_module
import json
import logging
import re
import sys
import time
from pathlib import Path

import requests as req_lib

RC_EXPO_URL   = "https://map.rcdata.org/rcjson/expo"
DEFAULT_DELAY = 0.2


# ── Text extraction (kept in sync with rc_extract.py — same word count) ─────────
# Vendored so this utility needs only `requests`, not the Anthropic SDK that
# importing rc_extract would pull in. If rc_extract.extract_text changes, mirror
# it here so backfilled counts match what the pipeline records live.

def strip_html(text: str) -> str:
    text = re.sub(r"<[^>]+>", " ", text or "")
    text = html_module.unescape(text)
    return re.sub(r"\s+", " ", text).strip()


def extract_text(data: dict) -> str:
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

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-8s  %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger(__name__)


def fetch_word_count(rc_id: str, session: req_lib.Session) -> int | None:
    try:
        r = session.get(f"{RC_EXPO_URL}/{rc_id}", timeout=30)
        if r.status_code == 404:
            log.warning("  404 — %s", rc_id)
            return None
        r.raise_for_status()
        return len(extract_text(r.json()).split())
    except (req_lib.RequestException, ValueError) as exc:
        log.warning("  fetch failed for %s: %s", rc_id, exc)
        return None


def main() -> None:
    ap = argparse.ArgumentParser(description="Backfill _text_words into a run JSONL")
    ap.add_argument("jsonl", help="Extraction JSONL to update in place")
    ap.add_argument("--force", action="store_true",
                    help="Recompute even for records that already have _text_words")
    ap.add_argument("--delay", type=float, default=DEFAULT_DELAY,
                    help=f"Seconds between RC fetches (default {DEFAULT_DELAY})")
    args = ap.parse_args()

    path = Path(args.jsonl)
    if not path.exists():
        sys.exit(f"Not found: {path}")

    # Read all records
    records: list[dict] = []
    with path.open(encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                records.append(json.loads(line))
            except json.JSONDecodeError:
                log.warning("skipping unparseable line")

    todo = [r for r in records
            if r.get("rc_id") and (args.force or r.get("_text_words") is None)]
    log.info("%d records total; %d need a word count", len(records), len(todo))
    if not todo:
        log.info("Nothing to do.")
        return

    session = req_lib.Session()
    session.headers["User-Agent"] = "rc-backfill/1.0"

    filled = failed = 0
    for i, rec in enumerate(todo, 1):
        rc_id = str(rec["rc_id"])
        wc = fetch_word_count(rc_id, session)
        if wc is None:
            failed += 1
        else:
            rec["_text_words"] = wc
            filled += 1
            log.info("[%d/%d] %s — %d words", i, len(todo), rc_id, wc)
        if args.delay > 0:
            time.sleep(args.delay)

    # Backup, then atomic rewrite
    backup = path.with_suffix(path.suffix + ".bak")
    backup.write_text(path.read_text(encoding="utf-8"), encoding="utf-8")

    tmp = path.with_suffix(path.suffix + ".tmp")
    with tmp.open("w", encoding="utf-8") as out:
        for rec in records:
            out.write(json.dumps(rec, ensure_ascii=False) + "\n")
    tmp.replace(path)

    log.info("─" * 50)
    log.info("Backfilled %d, failed %d. Backup: %s", filled, failed, backup)


if __name__ == "__main__":
    main()
