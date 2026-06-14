#!/usr/bin/env python3
"""
rc_inventory.py — Media inventory for RC expositions.

Reads rc_ids from an existing extraction JSONL, fetches the RC content
JSON for each exposition, and records every media block (image, video,
audio, PDF). Outputs a per-exposition inventory JSONL and prints a
summary table.

Usage
-----
    python3 pipeline/rc_inventory.py output/pilot.jsonl output/inventory.jsonl

Resumable: already-inventoried rc_ids are skipped on restart.

Environment variables
---------------------
    (none — no API keys required)
"""

import argparse
import html as html_module
import json
import logging
import re
import time
from pathlib import Path

import requests as req_lib

RC_EXPO_URL   = "https://map.rcdata.org/rcjson/expo"
DEFAULT_DELAY = 0.2

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-8s  %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger(__name__)

EMBED_DOMAINS = frozenset({
    "vimeo.com", "player.vimeo.com",
    "youtube.com", "www.youtube.com", "youtu.be",
    "soundcloud.com", "spotify.com",
})

# RC tool-type → canonical media category
MEDIA_TOOL_MAP = {
    "tool-picture": "image",
    "tool-image":   "image",
    "tool-video":   "video",
    "tool-audio":   "audio",
    "tool-pdf":     "pdf",
    "tool-iframe":  "iframe",
}

# Substrings that hint a URL is a real media file (not a style/thumbnail link)
_MEDIA_HINTS = (
    ".jpg", ".jpeg", ".png", ".gif", ".webp",
    ".mp4", ".webm", ".mp3", ".wav", ".ogg", ".pdf",
    "vimeo.com", "youtube.com", "youtu.be", "soundcloud.com",
    "/rc/cache/", "/rc/media/",
)


def extract_src_urls(html: str) -> list[str]:
    if not html:
        return []
    return re.findall(
        r'(?:src|href|data-src)=[\'"]([^\'"]+)[\'"]',
        html_module.unescape(html),
    )


def pick_primary_url(urls: list[str]) -> str | None:
    for u in urls:
        if any(h in u.lower() for h in _MEDIA_HINTS):
            return u
    return urls[0] if urls else None


def url_status(url: str | None) -> str:
    if not url:
        return "no_url"
    for domain in EMBED_DOMAINS:
        if domain in url:
            return "embed_unfetchable"
    if "researchcatalogue.net" in url or "rcdata.org" in url:
        return "rc_hosted"
    return "external"


def parse_media_blocks(data: dict) -> list[dict]:
    pages = data.get("pages", {})
    if isinstance(pages, dict):
        page_list = list(pages.values())
    elif isinstance(pages, list):
        page_list = pages
    else:
        page_list = []

    blocks: list[dict] = []
    for page in page_list:
        if not isinstance(page, dict):
            continue
        tools = page.get("tools", {})
        if not isinstance(tools, dict):
            continue
        for tool_type, items in tools.items():
            media_type = MEDIA_TOOL_MAP.get(tool_type)
            if not media_type:
                continue
            for item in (items or []):
                if not isinstance(item, dict):
                    continue
                urls = extract_src_urls(item.get("content", ""))
                primary = pick_primary_url(urls)
                blocks.append({
                    "media_id":   item.get("id", ""),
                    "tool_type":  tool_type,
                    "media_type": media_type,
                    "url":        primary,
                    "url_status": url_status(primary),
                })
    return blocks


def exposition_type(counts: dict) -> str:
    has = {k for k, v in counts.items() if v > 0}
    media = has & {"image", "video", "audio"}
    if len(media) > 1:
        return "mixed"
    if "video"  in media: return "video_led"
    if "audio"  in media: return "audio_led"
    if "image"  in media: return "image_led"
    return "text_only"


def fetch_rc_json(expo_id: int, session: req_lib.Session) -> dict | None:
    try:
        r = session.get(f"{RC_EXPO_URL}/{expo_id}", timeout=30)
        if r.status_code == 404:
            log.warning("  404 — %d", expo_id)
            return None
        r.raise_for_status()
        return r.json()
    except req_lib.RequestException as exc:
        log.warning("  fetch error %d: %s", expo_id, exc)
        return None


def read_rc_ids(path: Path) -> list[str]:
    ids: list[str] = []
    with path.open(encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                rc_id = json.loads(line).get("rc_id")
                if rc_id:
                    ids.append(str(rc_id))
            except Exception:
                pass
    return ids


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


def main() -> None:
    ap = argparse.ArgumentParser(description="RC media inventory")
    ap.add_argument("input_jsonl",  help="Existing extraction JSONL (provides rc_ids)")
    ap.add_argument("output_jsonl", help="Inventory output JSONL (appended; resumable)")
    ap.add_argument("--delay", type=float, default=DEFAULT_DELAY,
                    help=f"Seconds between RC fetches (default {DEFAULT_DELAY})")
    args = ap.parse_args()

    in_path  = Path(args.input_jsonl)
    out_path = Path(args.output_jsonl)
    out_path.parent.mkdir(parents=True, exist_ok=True)

    rc_ids  = read_rc_ids(in_path)
    done    = load_done(out_path)
    pending = [x for x in rc_ids if x not in done]

    log.info("%d expositions in input; %d already done; %d to process",
             len(rc_ids), len(done), len(pending))

    session = req_lib.Session()
    session.headers["User-Agent"] = "rc-inventory/1.0"

    n = len(pending)
    type_tally:  dict[str, int] = {}
    total_media: dict[str, int] = {}

    with out_path.open("a", encoding="utf-8") as out_f:
        for i, rc_id in enumerate(pending, 1):
            log.info("[%d/%d] %s", i, n, rc_id)

            data   = fetch_rc_json(int(rc_id), session)
            title  = (data or {}).get("title", "") or ""
            blocks = parse_media_blocks(data or {})

            counts: dict[str, int] = {}
            for b in blocks:
                counts[b["media_type"]] = counts.get(b["media_type"], 0) + 1
                total_media[b["media_type"]] = total_media.get(b["media_type"], 0) + 1

            exp_type = exposition_type(counts)
            type_tally[exp_type] = type_tally.get(exp_type, 0) + 1

            fetchable_images = sum(
                1 for b in blocks
                if b["media_type"] == "image" and b["url_status"] == "rc_hosted"
            )

            record = {
                "rc_id":            rc_id,
                "title":            title,
                "exposition_type":  exp_type,
                "media_counts":     counts,
                "fetchable_images": fetchable_images,
                "media_inventory":  blocks,
            }
            out_f.write(json.dumps(record, ensure_ascii=False) + "\n")
            out_f.flush()

            log.info("  %s  counts=%s  fetchable_images=%d",
                     exp_type, counts, fetchable_images)

            if args.delay > 0:
                time.sleep(args.delay)

    log.info("─" * 60)
    log.info("Exposition types: %s", type_tally)
    log.info("Total media blocks: %s", total_media)

    # Print a readable summary table
    total = sum(type_tally.values())
    if total:
        print("\nMedia composition of the corpus sample")
        print(f"{'Type':<16} {'Count':>6}  {'%':>5}")
        print("-" * 30)
        for t in ("image_led", "video_led", "audio_led", "mixed", "text_only"):
            n = type_tally.get(t, 0)
            print(f"  {t:<14} {n:>6}  {100*n/total:>4.0f}%")
        print("-" * 30)
        print(f"  {'TOTAL':<14} {total:>6}")
        print(f"\nMedia blocks: {total_media}")


if __name__ == "__main__":
    main()
