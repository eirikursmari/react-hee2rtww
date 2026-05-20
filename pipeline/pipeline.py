#!/usr/bin/env python3
"""
RC Indexing Pipeline
====================
Fetches all published expositions from the Research Catalogue,
extracts plain text from every text tool on every page,
generates vector embeddings, and stores them in Supabase/pgvector.

Usage
-----
  # First run: index everything
  python pipeline.py

  # Skip already-indexed expositions (safe to run repeatedly)
  python pipeline.py

  # Force re-index everything (e.g. after a schema change)
  python pipeline.py --force

  # Test with a small batch first
  python pipeline.py --limit 20

Environment variables (see .env.example)
-----------------------------------------
  OPENAI_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY
"""

import os
import sys
import time
import json
import logging
import argparse
from datetime import datetime, timezone
from html.parser import HTMLParser
from typing import Optional

import requests
from dotenv import load_dotenv
from openai import OpenAI
from supabase import create_client, Client

load_dotenv()

# ── Logging ───────────────────────────────────────────────────────────────────

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-8s  %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger(__name__)

# ── Config ────────────────────────────────────────────────────────────────────

RC_INTERNAL_URL  = "https://map.rcdata.org/internal_research.json"
RC_EXPO_JSON_URL = "https://map.rcdata.org/rcjson/expo"
REQUEST_DELAY    = 1.0    # seconds between exposition fetches (be polite)
CHUNK_SIZE       = 6000   # characters per chunk (~1 500 tokens; limit is 8 191)
CHUNK_OVERLAP    = 400    # character overlap between consecutive chunks
EMBED_MODEL      = "text-embedding-3-small"
EMBED_DIMS       = 1536
EMBED_BATCH      = 100    # texts per OpenAI embeddings API call

# ── Clients ───────────────────────────────────────────────────────────────────

def get_clients() -> tuple[OpenAI, Client]:
    missing = [v for v in ("OPENAI_API_KEY", "SUPABASE_URL", "SUPABASE_SERVICE_KEY")
               if not os.environ.get(v)]
    if missing:
        log.error("Missing environment variables: %s", ", ".join(missing))
        sys.exit(1)
    openai   = OpenAI(api_key=os.environ["OPENAI_API_KEY"])
    supabase = create_client(os.environ["SUPABASE_URL"], os.environ["SUPABASE_SERVICE_KEY"])
    return openai, supabase

# ── HTML text extraction ──────────────────────────────────────────────────────

class _TextExtractor(HTMLParser):
    def __init__(self):
        super().__init__()
        self._parts: list[str] = []

    def handle_data(self, data: str):
        t = data.strip()
        if t:
            self._parts.append(t)

    def result(self) -> str:
        return " ".join(self._parts)


def strip_html(html: str) -> str:
    if not html:
        return ""
    p = _TextExtractor()
    p.feed(html)
    return p.result()


def extract_pages(data: dict) -> list[dict]:
    """Return [{page_id, text}, …] for every page that has text content."""
    raw_pages = data.get("pages", data.get("tools", {}))
    result = []

    if isinstance(raw_pages, dict):
        items = raw_pages.items()
    elif isinstance(raw_pages, list):
        items = ((p.get("page_id") or p.get("id", i), p) for i, p in enumerate(raw_pages))
    else:
        return result

    for page_id, page in items:
        texts = []
        for tool_type in ("tool-text", "tool-simpletext"):
            for tool in page.get(tool_type, []):
                text = strip_html(tool.get("content", ""))
                if text:
                    texts.append(text)
        if texts:
            result.append({"page_id": int(page_id), "text": "\n\n".join(texts)})

    return result

# ── Text chunking ─────────────────────────────────────────────────────────────

def chunk_text(text: str) -> list[str]:
    """Split text into overlapping fixed-size character chunks."""
    if len(text) <= CHUNK_SIZE:
        return [text]
    chunks, start = [], 0
    while start < len(text):
        chunks.append(text[start : start + CHUNK_SIZE])
        start += CHUNK_SIZE - CHUNK_OVERLAP
    return chunks

# ── Embedding ─────────────────────────────────────────────────────────────────

def embed_batch(openai: OpenAI, texts: list[str]) -> list[list[float]]:
    resp = openai.embeddings.create(model=EMBED_MODEL, input=texts)
    return [item.embedding for item in resp.data]


def embed_all(openai: OpenAI, texts: list[str]) -> list[list[float]]:
    embeddings = []
    for i in range(0, len(texts), EMBED_BATCH):
        batch = texts[i : i + EMBED_BATCH]
        embeddings.extend(embed_batch(openai, batch))
    return embeddings

# ── Metadata helpers ──────────────────────────────────────────────────────────

def author_name(author) -> str:
    if not author:                return "Unknown"
    if isinstance(author, str):   return author
    if isinstance(author, dict):
        if author.get("name"):    return author["name"]
        return f"{author.get('firstName','')} {author.get('lastName','')}".strip()
    return "Unknown"


def expo_url(expo: dict) -> str:
    if expo.get("url"):
        return expo["url"]
    eid = expo.get("id", "")
    dp  = expo.get("default-page", {})
    pid = dp.get("id", "") if isinstance(dp, dict) else ""
    if eid and pid:
        return f"https://www.researchcatalogue.net/view/{eid}/{pid}"
    if eid:
        return f"https://www.researchcatalogue.net/view/{eid}"
    return "https://www.researchcatalogue.net"


def keywords(expo: dict) -> list[str]:
    kw = expo.get("keywords", [])
    if isinstance(kw, str):
        return [k.strip() for k in kw.split(",") if k.strip()]
    return kw if isinstance(kw, list) else []

# ── Network ───────────────────────────────────────────────────────────────────

def fetch_internal_research() -> list[dict]:
    log.info("Fetching master exposition list from %s", RC_INTERNAL_URL)
    r = requests.get(RC_INTERNAL_URL, timeout=30)
    r.raise_for_status()
    data = r.json()
    if isinstance(data, list):
        return data
    return data.get("expositions", data.get("results", []))


def fetch_expo_json(expo_id: int) -> Optional[dict]:
    url = f"{RC_EXPO_JSON_URL}/{expo_id}"
    try:
        r = requests.get(url, timeout=30)
        if r.status_code == 404:
            log.warning("  404 for exposition %d", expo_id)
            return None
        r.raise_for_status()
        return r.json()
    except Exception as e:
        log.error("  Failed to fetch %d: %s", expo_id, e)
        return None

# ── Supabase writes ───────────────────────────────────────────────────────────

def upsert_exposition(sb: Client, expo: dict):
    sb.table("expositions").upsert({
        "id":         expo["id"],
        "title":      expo.get("title", "Untitled"),
        "author":     author_name(expo.get("author")),
        "abstract":   expo.get("abstract") or expo.get("description") or "",
        "keywords":   keywords(expo),
        "created_at": expo.get("created") or expo.get("date") or "",
        "url":        expo_url(expo),
        "indexed_at": datetime.now(timezone.utc).isoformat(),
    }).execute()


def upsert_chunks(sb: Client, expo_id: int, page_id: int,
                  chunks: list[str], embeddings: list[list[float]]):
    # Remove stale chunks for this page before inserting fresh ones
    sb.table("exposition_chunks") \
      .delete() \
      .eq("exposition_id", expo_id) \
      .eq("page_id", page_id) \
      .execute()

    rows = [
        {"exposition_id": expo_id, "page_id": page_id,
         "chunk_index": i, "text": chunk, "embedding": emb}
        for i, (chunk, emb) in enumerate(zip(chunks, embeddings))
    ]
    if rows:
        sb.table("exposition_chunks").insert(rows).execute()


def is_indexed(sb: Client, expo_id: int) -> bool:
    r = sb.table("expositions").select("id").eq("id", expo_id).execute()
    return len(r.data) > 0

# ── Core indexing logic ───────────────────────────────────────────────────────

def index_exposition(openai: OpenAI, sb: Client, expo: dict):
    expo_id = expo["id"]
    title   = expo.get("title", "Untitled")[:70]
    log.info("  Fetching full JSON for '%s' (%d)", title, expo_id)

    content = fetch_expo_json(expo_id)

    # Always store metadata even if we can't fetch full content
    upsert_exposition(sb, expo)

    if not content:
        return

    pages = extract_pages(content)
    if not pages:
        log.info("  No text content found")
        return

    total_chunks = 0
    for page in pages:
        chunks = chunk_text(page["text"])
        if not chunks:
            continue
        embeddings = embed_all(openai, chunks)
        upsert_chunks(sb, expo_id, page["page_id"], chunks, embeddings)
        total_chunks += len(chunks)

    log.info("  Stored %d chunk(s) across %d page(s)", total_chunks, len(pages))

# ── Pipeline entry point ──────────────────────────────────────────────────────

def run(force: bool = False, limit: Optional[int] = None):
    openai, sb = get_clients()

    expositions = fetch_internal_research()
    log.info("Found %d expositions in master list", len(expositions))

    if limit:
        expositions = expositions[:limit]
        log.info("Processing first %d (--limit)", limit)

    done = skipped = failed = 0

    for i, expo in enumerate(expositions, 1):
        expo_id = expo.get("id")
        if not expo_id:
            continue

        prefix = f"[{i}/{len(expositions)}]"

        if not force and is_indexed(sb, expo_id):
            log.info("%s Already indexed %d — skipping", prefix, expo_id)
            skipped += 1
            continue

        log.info("%s Indexing %d", prefix, expo_id)
        try:
            index_exposition(openai, sb, expo)
            done += 1
        except Exception as e:
            log.error("%s Failed %d: %s", prefix, expo_id, e)
            failed += 1

        time.sleep(REQUEST_DELAY)

    log.info("Done — indexed: %d  skipped: %d  failed: %d", done, skipped, failed)


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="RC Indexing Pipeline")
    ap.add_argument("--force", action="store_true",
                    help="Re-index even if already indexed")
    ap.add_argument("--limit", type=int, metavar="N",
                    help="Process only the first N expositions (for testing)")
    args = ap.parse_args()
    run(force=args.force, limit=args.limit)
