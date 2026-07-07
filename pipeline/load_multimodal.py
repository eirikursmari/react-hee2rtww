#!/usr/bin/env python3
"""
load_multimodal.py — Load rc_multimodal output into Supabase for the app.

Makes photographs and OCR'd text searchable and displayable:
  • Each image's literal description  → a search chunk  (source='image',      page_id=-1)
  • The exposition's OCR'd text        → search chunk(s) (source='image-text', page_id=-2)
  • Per-image metadata + text          → exposition_media rows (for UI display)

Embeddings use the same model/dimensions as pipeline.py so multimodal chunks
rank alongside prose in the existing vector index. Idempotent per exposition:
prior image/image-text chunks and media rows are deleted before re-insert, so
re-running is safe and the text pipeline (which deletes by real page_id) is
never disturbed.

Usage
-----
    python3 pipeline/load_multimodal.py output/deepdive.jsonl
    python3 pipeline/load_multimodal.py output/rescue_ocr.jsonl output/deepdive.jsonl

Environment
-----------
    OPENAI_API_KEY        (embeddings)
    SUPABASE_URL
    SUPABASE_SERVICE_KEY
"""

import argparse
import json
import logging
import os
import sys
from pathlib import Path

from openai import OpenAI
from supabase import create_client

EMBED_MODEL   = "text-embedding-3-small"
EMBED_BATCH   = 100
CHUNK_SIZE    = 6000
CHUNK_OVERLAP = 400
PAGE_IMAGE      = -1   # negative page_id namespaces — never collide with RC pages
PAGE_IMAGE_TEXT = -2

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-8s  %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger(__name__)


def chunk_text(text: str) -> list[str]:
    text = (text or "").strip()
    if len(text) <= CHUNK_SIZE:
        return [text] if text else []
    chunks, start = [], 0
    while start < len(text):
        chunks.append(text[start:start + CHUNK_SIZE])
        start += CHUNK_SIZE - CHUNK_OVERLAP
    return chunks


def embed_all(openai: OpenAI, texts: list[str]) -> list[list[float]]:
    out: list[list[float]] = []
    for i in range(0, len(texts), EMBED_BATCH):
        batch = texts[i:i + EMBED_BATCH]
        resp = openai.embeddings.create(model=EMBED_MODEL, input=batch)
        out.extend(item.embedding for item in resp.data)
    return out


def described_images(rec: dict) -> list[dict]:
    return [d for d in rec.get("image_descriptions", [])
            if isinstance(d, dict) and d.get("media_status") == "described"]


def load_record(openai: OpenAI, sb, rec: dict) -> tuple[int, int]:
    """Return (chunks_written, media_written) for one exposition record."""
    try:
        expo_id = int(rec["rc_id"])
    except (KeyError, ValueError, TypeError):
        return 0, 0

    # Only load expositions already present in the index (FK safety).
    if not sb.table("expositions").select("id").eq("id", expo_id).execute().data:
        log.warning("  %s not in expositions table — skipping (index it first)", expo_id)
        return 0, 0

    imgs       = described_images(rec)
    image_text = (rec.get("image_text") or "").strip()

    # ── Idempotency: clear this exposition's prior multimodal rows ──────────────
    sb.table("exposition_chunks").delete() \
        .eq("exposition_id", expo_id).in_("source", ["image", "image-text"]).execute()
    sb.table("exposition_media").delete().eq("exposition_id", expo_id).execute()

    # ── Build the texts to embed ───────────────────────────────────────────────
    # One chunk per image description (visual) AND one per image's OCR text.
    # Per-image OCR keeps each text card focused — a diffuse aggregate chunk
    # buries a clean thematic sentence among unrelated fragments and ranks poorly.
    texts:  list[str]  = []
    metas:  list[dict] = []   # parallel: {page_id, chunk_index, source, media_id}
    img_ci = txt_ci = 0
    any_ocr = False

    for d in imgs:
        mid  = d.get("media_id", "")
        desc = (d.get("description") or "").strip()
        if desc:
            texts.append(desc)
            metas.append({"page_id": PAGE_IMAGE, "chunk_index": img_ci,
                          "source": "image", "media_id": mid})
            img_ci += 1
        for ck in chunk_text((d.get("ocr_text") or "").strip()):
            any_ocr = True
            texts.append(ck)
            metas.append({"page_id": PAGE_IMAGE_TEXT, "chunk_index": txt_ci,
                          "source": "image-text", "media_id": mid})
            txt_ci += 1

    # Fallback for older runs that stored only the aggregate image_text.
    if not any_ocr and image_text:
        for ck in chunk_text(image_text):
            texts.append(ck)
            metas.append({"page_id": PAGE_IMAGE_TEXT, "chunk_index": txt_ci,
                          "source": "image-text", "media_id": ""})
            txt_ci += 1

    chunks_written = 0
    if texts:
        embeddings = embed_all(openai, texts)
        rows = [{
            "exposition_id": expo_id,
            "page_id":       m["page_id"],
            "chunk_index":   m["chunk_index"],
            "text":          t,
            "embedding":     emb,
            "source":        m["source"],
            "media_id":      m["media_id"] or None,
        } for t, emb, m in zip(texts, embeddings, metas)]
        sb.table("exposition_chunks").insert(rows).execute()
        chunks_written = len(rows)

    # ── exposition_media rows (per-image, for display) ─────────────────────────
    media_rows = [{
        "exposition_id": expo_id,
        "media_id":      d.get("media_id", ""),
        "media_type":    "image",
        "url":           d.get("url", ""),
        "size":          d.get("size", ""),
        "description":   d.get("description", ""),
        "ocr_text":      d.get("ocr_text", ""),
        "media_status":  d.get("media_status", ""),
    } for d in imgs]
    if media_rows:
        sb.table("exposition_media").insert(media_rows).execute()

    log.info("  %s — %d chunk(s) [%d img desc + OCR], %d media row(s)",
             expo_id, chunks_written, len(imgs), len(media_rows))
    return chunks_written, len(media_rows)


def main() -> None:
    ap = argparse.ArgumentParser(description="Load rc_multimodal output into Supabase")
    ap.add_argument("jsonl", nargs="+", help="rc_multimodal output JSONL file(s)")
    args = ap.parse_args()

    for var in ("OPENAI_API_KEY", "SUPABASE_URL", "SUPABASE_SERVICE_KEY"):
        if not os.environ.get(var):
            sys.exit(f"{var} not set")

    openai = OpenAI(api_key=os.environ["OPENAI_API_KEY"])
    sb = create_client(os.environ["SUPABASE_URL"], os.environ["SUPABASE_SERVICE_KEY"])

    total_c = total_m = total_e = 0
    for path_str in args.jsonl:
        path = Path(path_str)
        if not path.exists():
            log.warning("Not found: %s", path); continue
        log.info("Loading %s", path)
        for line in path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue
            c, m = load_record(openai, sb, rec)
            total_c += c
            total_m += m
            total_e += 1 if (c or m) else 0

    log.info("─" * 50)
    log.info("Done — %d exposition(s), %d chunk(s), %d media row(s)",
             total_e, total_c, total_m)


if __name__ == "__main__":
    main()
