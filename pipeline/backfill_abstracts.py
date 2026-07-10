#!/usr/bin/env python3
"""
backfill_abstracts.py — Add a title+abstract search chunk to already-indexed
expositions, without re-embedding body text or re-running extraction.

pipeline.py now indexes a dedicated title+abstract chunk (page_id -3,
source='abstract') for every exposition it processes. This backfills that
chunk for expositions already in the table — the cheapest way to lift recall
across the existing corpus, and the single biggest win for text-sparse /
media-heavy expositions whose abstract is their only clean thematic text.

Usage
-----
    python3 pipeline/backfill_abstracts.py
    python3 pipeline/backfill_abstracts.py --limit 500   # first N (testing)

Idempotent: each exposition's abstract chunk is replaced, not duplicated.

Environment
-----------
    OPENAI_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY
"""

import argparse
import logging
import os
import sys

from openai import OpenAI
from supabase import create_client

# pipeline.py sits alongside this script; reuse its exact chunking/embedding.
from pipeline import (
    ABSTRACT_PAGE, EMBED_BATCH, abstract_chunk_text, embed_all, upsert_chunks,
)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-8s  %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger(__name__)

PAGE = 1000   # Supabase REST page size


def main() -> None:
    ap = argparse.ArgumentParser(description="Backfill title+abstract search chunks")
    ap.add_argument("--limit", type=int, default=None,
                    help="Only process the first N expositions (testing)")
    args = ap.parse_args()

    for var in ("OPENAI_API_KEY", "SUPABASE_URL", "SUPABASE_SERVICE_KEY"):
        if not os.environ.get(var):
            sys.exit(f"{var} not set")

    openai = OpenAI(api_key=os.environ["OPENAI_API_KEY"])
    sb = create_client(os.environ["SUPABASE_URL"], os.environ["SUPABASE_SERVICE_KEY"])

    done = skipped = 0
    offset = 0
    while True:
        rows = (sb.table("expositions")
                  .select("id,title,abstract")
                  .order("id")
                  .range(offset, offset + PAGE - 1)
                  .execute().data)
        if not rows:
            break

        # Build (id, text) for rows that have any title/abstract text.
        pending = []
        for r in rows:
            text = abstract_chunk_text(r.get("title") or "", r.get("abstract") or "")
            if text:
                pending.append((r["id"], text))
            else:
                skipped += 1

        # Embed in batches and upsert one chunk per exposition.
        for i in range(0, len(pending), EMBED_BATCH):
            batch = pending[i:i + EMBED_BATCH]
            embeddings = embed_all(openai, [t for _, t in batch])
            for (expo_id, text), emb in zip(batch, embeddings):
                upsert_chunks(sb, expo_id, ABSTRACT_PAGE, [text], [emb],
                              source="abstract")
                done += 1

        log.info("…%d abstract chunks written (offset %d)", done, offset)
        offset += PAGE
        if args.limit and done + skipped >= args.limit:
            break

    log.info("─" * 50)
    log.info("Done — %d abstract chunk(s) written, %d skipped (no text)",
             done, skipped)


if __name__ == "__main__":
    main()
