#!/usr/bin/env python3
"""
RC Indexing Pipeline
====================
Fetches all published expositions from the Research Catalogue,
extracts plain text from every text tool on every page,
generates vector embeddings, extracts structured metadata via Claude,
and stores everything in Supabase/pgvector.

Usage
-----
  # First run: index + extract everything
  python pipeline.py

  # Skip already-indexed expositions (safe to run repeatedly)
  python pipeline.py

  # Force re-index + re-extract everything
  python pipeline.py --force

  # Only run extraction on expositions not yet extracted (no re-embedding)
  python pipeline.py --extract-only

  # Test with a small batch first
  python pipeline.py --limit 20

Environment variables (see .env.example)
-----------------------------------------
  OPENAI_API_KEY       — for embeddings
  ANTHROPIC_API_KEY    — for metadata extraction (optional; skipped if absent)
  SUPABASE_URL
  SUPABASE_SERVICE_KEY
"""

import os
import sys
import time
import json
import logging
import argparse
from datetime import datetime, timezone
from html.parser import HTMLParser
from pathlib import Path
from typing import Optional

import requests
from dotenv import load_dotenv
from openai import OpenAI
from supabase import create_client, Client

load_dotenv()

try:
    from langdetect import detect as _langdetect, LangDetectException
    LANGDETECT = True
except ImportError:
    LANGDETECT = False

def detect_language(text: str) -> Optional[str]:
    if not LANGDETECT or not text or len(text) < 40:
        return None
    try:
        return _langdetect(text)
    except Exception:
        return None

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
REQUEST_DELAY    = 1.0    # seconds between RC API fetches
CLAUDE_DELAY     = 0.5    # seconds between Claude API calls
CHUNK_SIZE       = 6000
CHUNK_OVERLAP    = 400
EMBED_MODEL      = "text-embedding-3-small"
EMBED_DIMS       = 1536
EMBED_BATCH      = 100
EXTRACTION_MODEL = "claude-haiku-4-5-20251001"   # cheap + fast for batch extraction
EXTRACT_TEXT_MAX = 6000  # chars of body text sent to Claude for extraction

# ── Clients ───────────────────────────────────────────────────────────────────

def get_clients():
    missing = [v for v in ("OPENAI_API_KEY", "SUPABASE_URL", "SUPABASE_SERVICE_KEY")
               if not os.environ.get(v)]
    if missing:
        log.error("Missing environment variables: %s", ", ".join(missing))
        sys.exit(1)

    openai_client   = OpenAI(api_key=os.environ["OPENAI_API_KEY"])
    supabase_client = create_client(os.environ["SUPABASE_URL"], os.environ["SUPABASE_SERVICE_KEY"])

    anthropic_client = None
    if os.environ.get("ANTHROPIC_API_KEY"):
        try:
            import anthropic
            anthropic_client = anthropic.Anthropic(api_key=os.environ["ANTHROPIC_API_KEY"])
            log.info("Anthropic client ready — metadata extraction enabled")
        except ImportError:
            log.warning("anthropic package not installed — metadata extraction disabled")
    else:
        log.warning("ANTHROPIC_API_KEY not set — metadata extraction will be skipped")

    return openai_client, supabase_client, anthropic_client

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
        tools = page.get("tools", page)  # tools nested under "tools" key
        if not isinstance(tools, dict):
            tools = page
        for tool_type in ("tool-text", "tool-simpletext"):
            for tool in tools.get(tool_type, []):
                text = strip_html(tool.get("content", ""))
                if text:
                    texts.append(text)
        if texts:
            result.append({"page_id": int(page_id), "text": "\n\n".join(texts)})

    return result

# ── Text chunking ─────────────────────────────────────────────────────────────

def chunk_text(text: str) -> list[str]:
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


# Sentinel distinguishing a definitive 404 (exposition gone from RC) from a
# transient fetch failure (timeout, DNS) — only the former marks `unavailable`.
NOT_FOUND = object()


def fetch_expo_json(expo_id: int):
    url = f"{RC_EXPO_JSON_URL}/{expo_id}"
    try:
        r = requests.get(url, timeout=30)
        if r.status_code == 404:
            log.warning("  404 for exposition %d", expo_id)
            return NOT_FOUND
        r.raise_for_status()
        return r.json()
    except Exception as e:
        log.error("  Failed to fetch %d: %s", expo_id, e)
        return None


def mark_unavailable(sb: Client, expo_id: int):
    """Flag an exposition whose content 404s on RC so it is excluded from
    pending-extraction counts and skipped by future --extract-only runs."""
    try:
        sb.table("expositions").update({"unavailable": True}).eq("id", expo_id).execute()
        log.info("  Marked %d unavailable (404 from RC)", expo_id)
    except Exception as e:
        log.warning("  Could not mark %d unavailable: %s", expo_id, e)

# ── Schema loading ────────────────────────────────────────────────────────────

def load_schema(sb: Optional[Client] = None) -> dict:
    """Load extraction schema: try Supabase pipeline_config first, fall back to local JSON."""
    if sb:
        try:
            r = sb.table("pipeline_config").select("value").eq("key", "extraction_schema").execute()
            if r.data:
                log.info("Loaded extraction schema from Supabase")
                return r.data[0]["value"]
        except Exception as e:
            log.warning("Could not load schema from Supabase (%s), trying local file", e)

    local = Path(__file__).parent / "extraction_schema.json"
    if local.exists():
        with open(local) as f:
            schema = json.load(f)
        log.info("Loaded extraction schema from %s", local)
        return schema

    log.error("No extraction schema found — create pipeline/extraction_schema.json")
    sys.exit(1)


def build_schema_string(schema: dict) -> str:
    """Generate the JSON schema string for the extraction prompt."""
    lines = ["{"]
    for dim in schema.get("array_dimensions", []):
        lines.append(f'  "{dim["key"]}": [],')
        lines.append(f'    // {dim["prompt"]}')
        lines.append("")
    for dim in schema.get("text_dimensions", []):
        lines.append(f'  "{dim["key"]}": null,')
        lines.append(f'    // {dim["prompt"]}')
        lines.append("")
    for dim in schema.get("custom_dimensions", []):
        default = "[]" if dim.get("type") == "array" else "null"
        lines.append(f'  "{dim["key"]}": {default},')
        lines.append(f'    // {dim.get("prompt", dim.get("label", dim["key"]))}')
        lines.append("")
    for key, nested in schema.get("nested_dimensions", {}).items():
        fields = {k: "null" for k in nested.get("fields", {})}
        lines.append(f'  "{key}": {json.dumps(fields)},')
        lines.append(f'    // {nested.get("prompt", "")}')
        lines.append("")
    lines.append("}")
    return "\n".join(lines)

# ── Metadata extraction via Claude ────────────────────────────────────────────

def build_extraction_prompt(title: str, author: str, abstract: str, body: str,
                            schema: Optional[dict] = None) -> str:
    schema_str = build_schema_string(schema) if schema else ""
    excerpt    = body[:EXTRACT_TEXT_MAX] if body else ""
    truncated  = "…[truncated]" if len(body) > EXTRACT_TEXT_MAX else ""
    return (
        f"Title: {title}\n"
        f"Author: {author}\n"
        f"Abstract: {abstract[:800] if abstract else '(none)'}\n"
        f"Content: {excerpt}{truncated}\n\n"
        f"Extract metadata using this JSON structure:\n{schema_str}"
    )


def extract_metadata(anthropic_client, title: str, author: str,
                     abstract: str, body: str,
                     schema: Optional[dict] = None) -> Optional[dict]:
    """Call Claude Haiku to extract structured metadata. Returns dict or None."""
    system = schema.get("system_prompt", "") if schema else ""
    try:
        resp = anthropic_client.messages.create(
            model=EXTRACTION_MODEL,
            max_tokens=1024,
            system=system,
            messages=[{
                "role": "user",
                "content": build_extraction_prompt(title, author, abstract, body, schema),
            }],
        )
        raw = resp.content[0].text.strip()
        if raw.startswith("```"):
            parts = raw.split("```")
            raw = parts[1].lstrip("json").strip() if len(parts) > 1 else raw
        return json.loads(raw)
    except json.JSONDecodeError as e:
        log.warning("  Extraction JSON parse error: %s", e)
        return None
    except Exception as e:
        log.warning("  Extraction failed: %s", e)
        return None


def _clean_array(val) -> list:
    """Return a list, empty list if None or wrong type."""
    if isinstance(val, list):
        return [str(v) for v in val if v]
    return []


def _clean_str(val) -> Optional[str]:
    if isinstance(val, str) and val.strip():
        return val.strip()
    return None


def _clean_impact_block(val) -> Optional[dict]:
    if not isinstance(val, dict):
        return None
    cleaned = {k: _clean_str(v) for k, v in val.items()}
    return cleaned if any(cleaned.values()) else None

# ── Supabase writes ───────────────────────────────────────────────────────────

STANDARD_ARRAY_KEYS = {"research_approach", "artistic_medium", "methodological_framing",
                       "geographic_context", "impact_types"}
STANDARD_TEXT_KEYS  = {"research_question", "methods_described", "key_findings",
                       "materials_tools", "theoretical_refs", "impact_scope",
                       "impact_evidence_level"}
STANDARD_NESTED_KEYS = {"impact_potential", "impact_actual"}


def upsert_exposition(sb: Client, expo: dict, metadata: Optional[dict] = None,
                      schema: Optional[dict] = None):
    row = {
        "id":         expo["id"],
        "title":      expo.get("title", "Untitled"),
        "author":     author_name(expo.get("author")),
        "abstract":   expo.get("abstract") or expo.get("description") or "",
        "keywords":   keywords(expo),
        "created_at": expo.get("created") or expo.get("date") or "",
        "url":        expo_url(expo),
        "indexed_at": datetime.now(timezone.utc).isoformat(),
    }

    row["published_in"] = [
        p.get("name", "") for p in expo.get("published_in", []) if p.get("name")
    ]
    lang_text = expo.get("abstract") or expo.get("description") or expo.get("title") or ""
    row["language"] = detect_language(lang_text)

    if metadata:
        for k in STANDARD_ARRAY_KEYS:
            row[k] = _clean_array(metadata.get(k))
        for k in STANDARD_TEXT_KEYS:
            row[k] = _clean_str(metadata.get(k))
        for k in STANDARD_NESTED_KEYS:
            row[k] = _clean_impact_block(metadata.get(k))
        row["extracted_at"] = datetime.now(timezone.utc).isoformat()

        # Custom dimensions → custom_metadata JSONB
        if schema:
            custom = {}
            for dim in schema.get("custom_dimensions", []):
                key = dim["key"]
                val = metadata.get(key)
                if val is None:
                    continue
                custom[key] = _clean_array(val) if dim.get("type") == "array" else _clean_str(val)
            if custom:
                row["custom_metadata"] = custom

    sb.table("expositions").upsert(row).execute()


def upsert_chunks(sb: Client, expo_id: int, page_id: int,
                  chunks: list[str], embeddings: list[list[float]]):
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


def needs_extraction(sb: Client, expo_id: int) -> bool:
    """True if the exposition has no extracted_at timestamp.
    Expositions marked unavailable (404 on RC) are excluded — use --force to retry them."""
    r = sb.table("expositions").select("extracted_at,unavailable").eq("id", expo_id).execute()
    if not r.data:
        return True
    row = r.data[0]
    if row.get("unavailable"):
        return False
    return row.get("extracted_at") is None

# ── Core indexing logic ───────────────────────────────────────────────────────

def index_exposition(openai: OpenAI, sb: Client, expo: dict, anthropic_client=None,
                     schema: Optional[dict] = None):
    expo_id = expo["id"]
    title   = expo.get("title", "Untitled")[:70]
    log.info("  Fetching full JSON for '%s' (%d)", title, expo_id)

    content = fetch_expo_json(expo_id)
    if content is NOT_FOUND:
        upsert_exposition(sb, expo, None, schema)
        mark_unavailable(sb, expo_id)
        return

    metadata = None
    if anthropic_client and content:
        pages    = extract_pages(content)
        body     = "\n\n".join(p["text"] for p in pages)
        abstract = expo.get("abstract") or expo.get("description") or ""
        log.info("  Extracting metadata…")
        metadata = extract_metadata(
            anthropic_client, title,
            author_name(expo.get("author")), abstract, body, schema,
        )
        if metadata:
            log.info("  Extraction OK — approach: %s  impact: %s",
                     metadata.get("research_approach", []),
                     metadata.get("impact_types", []))
        time.sleep(CLAUDE_DELAY)

    upsert_exposition(sb, expo, metadata, schema)

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


def _parse_published_in(pub) -> list:
    """Accept RC API format (list of dicts with 'name') or Supabase format (list of strings)."""
    if not pub:
        return []
    if isinstance(pub[0], dict):
        return [p.get("name", "") for p in pub if p.get("name")]
    return [p for p in pub if isinstance(p, str) and p]


def extract_only_exposition(sb: Client, expo: dict, anthropic_client,
                            schema: Optional[dict] = None):
    """Run extraction on an already-indexed exposition without re-embedding."""
    expo_id = expo["id"]
    title   = expo.get("title", "Untitled")[:70]
    log.info("  Fetching JSON for extraction: '%s' (%d)", title, expo_id)

    content = fetch_expo_json(expo_id)
    if content is NOT_FOUND:
        mark_unavailable(sb, expo_id)
        return
    if not content:
        return

    pages    = extract_pages(content)
    body     = "\n\n".join(p["text"] for p in pages)
    abstract = expo.get("abstract") or expo.get("description") or ""

    metadata = extract_metadata(
        anthropic_client, title,
        author_name(expo.get("author")), abstract, body, schema,
    )
    if not metadata:
        return

    log.info("  Extraction OK — approach: %s  impact: %s",
             metadata.get("research_approach", []),
             metadata.get("impact_types", []))

    # Update only the extracted fields, leave embeddings untouched
    update = {
        "research_approach":      _clean_array(metadata.get("research_approach")),
        "artistic_medium":        _clean_array(metadata.get("artistic_medium")),
        "methodological_framing": _clean_array(metadata.get("methodological_framing")),
        "geographic_context":     _clean_array(metadata.get("geographic_context")),
        "research_question":      _clean_str(metadata.get("research_question")),
        "methods_described":      _clean_str(metadata.get("methods_described")),
        "key_findings":           _clean_str(metadata.get("key_findings")),
        "materials_tools":        _clean_str(metadata.get("materials_tools")),
        "theoretical_refs":       _clean_str(metadata.get("theoretical_refs")),
        "impact_types":           _clean_array(metadata.get("impact_types")),
        "impact_scope":           _clean_str(metadata.get("impact_scope")),
        "impact_evidence_level":  _clean_str(metadata.get("impact_evidence_level")),
        "impact_potential":       _clean_impact_block(metadata.get("impact_potential")),
        "impact_actual":          _clean_impact_block(metadata.get("impact_actual")),
        "extracted_at": datetime.now(timezone.utc).isoformat(),
        "published_in": _parse_published_in(expo.get("published_in")),
        "language":     detect_language(expo.get("abstract") or expo.get("description") or expo.get("title") or ""),
    }

    # Custom dimensions → custom_metadata JSONB
    if schema:
        custom = {}
        for dim in schema.get("custom_dimensions", []):
            key = dim["key"]
            val = metadata.get(key)
            if val is None:
                continue
            custom[key] = _clean_array(val) if dim.get("type") == "array" else _clean_str(val)
        if custom:
            update["custom_metadata"] = custom

    sb.table("expositions").update(update).eq("id", expo_id).execute()
    time.sleep(CLAUDE_DELAY)

# ── Pipeline entry points ─────────────────────────────────────────────────────

def run_language_only(limit: Optional[int] = None):
    """Fast pass: detect and store language for all expositions. No Claude calls."""
    _, sb, _ = get_clients()
    if not LANGDETECT:
        log.error("langdetect not installed — run: pip3 install --break-system-packages langdetect")
        sys.exit(1)
    expositions = fetch_internal_research()
    log.info("Detecting language for %d expositions", len(expositions))
    if limit:
        expositions = expositions[:limit]
    done = failed = 0
    for i, expo in enumerate(expositions, 1):
        expo_id = expo.get("id")
        if not expo_id:
            continue
        text = expo.get("abstract") or expo.get("description") or expo.get("title") or ""
        lang = detect_language(text)
        try:
            sb.table("expositions").update({"language": lang}).eq("id", expo_id).execute()
            done += 1
        except Exception as e:
            log.warning("[%d/%d] Failed %d: %s", i, len(expositions), expo_id, e)
            failed += 1
        if i % 200 == 0:
            log.info("  %d / %d updated", i, len(expositions))
    log.info("Done — updated: %d  failed: %d", done, failed)


def fetch_all_expositions_from_db(sb: Client, fields: str) -> list[dict]:
    """Paginate through all exposition rows in Supabase."""
    PAGE, offset, all_rows = 1000, 0, []
    while True:
        r = sb.table("expositions").select(fields).range(offset, offset + PAGE - 1).execute()
        if not r.data:
            break
        all_rows.extend(r.data)
        if len(r.data) < PAGE:
            break
        offset += PAGE
    return all_rows


def get_nested_path(data, path: str):
    """Follow a dot-separated path into a nested dict/list."""
    if not path:
        return data
    current = data
    for key in path.split("."):
        if isinstance(current, dict):
            current = current.get(key)
        else:
            return None
    return current


def extract_classifier_labels(response_json: dict, clf: dict) -> list[str]:
    """Parse a classifier API response into a flat list of label strings."""
    resp = clf.get("response", {})
    array_path  = resp.get("array_path", "")
    label_field = resp.get("label_field", "")
    score_field = resp.get("score_field", "")
    try:
        threshold = float(resp.get("threshold", 0.5))
    except (TypeError, ValueError):
        threshold = 0.5

    items = get_nested_path(response_json, array_path) if array_path else response_json
    if not isinstance(items, list):
        return []

    labels = []
    for item in items:
        if isinstance(item, str):
            labels.append(item)
        elif isinstance(item, dict):
            if score_field:
                try:
                    score = float(item.get(score_field, 0))
                except (TypeError, ValueError):
                    continue
                if score < threshold:
                    continue
            if label_field:
                lbl = item.get(label_field)
                if lbl:
                    labels.append(str(lbl))
    return labels


def update_classifier_filter_config(sb: Client, clf: dict, rows: list[dict]):
    """Add or refresh the classifier's filter dimension in pipeline_config.filter_config."""
    storage_key = clf["storage_key"]

    all_labels: set[str] = set()
    for row in rows:
        meta = row.get("custom_metadata") or {}
        for lbl in (meta.get(storage_key) or []):
            if lbl:
                all_labels.add(str(lbl))

    if not all_labels:
        return

    try:
        r = sb.table("pipeline_config").select("value").eq("key", "filter_config").execute()
        filter_config = list(r.data[0]["value"]) if r.data else []
    except Exception:
        filter_config = []

    filter_config = [f for f in filter_config if f.get("key") != storage_key]
    filter_config.append({
        "key":    storage_key,
        "label":  clf["name"],
        "tip":    clf.get("tip", ""),
        "values": sorted(all_labels),
    })

    sb.table("pipeline_config").upsert({
        "key":        "filter_config",
        "value":      filter_config,
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }).execute()
    log.info("  filter_config updated — %d distinct labels for '%s'", len(all_labels), clf["name"])


def run_classifiers(force: bool = False, limit: Optional[int] = None):
    """Call all enabled external classifiers and store labels in custom_metadata."""
    _, sb, _ = get_clients()

    try:
        r = sb.table("pipeline_config").select("value").eq("key", "classifier_config").execute()
        configs = r.data[0]["value"] if r.data else []
    except Exception as e:
        log.error("Could not load classifier_config from Supabase: %s", e)
        sys.exit(1)

    enabled = [c for c in (configs or []) if c.get("enabled", True)]
    if not enabled:
        log.info("No enabled classifiers in pipeline_config.classifier_config")
        return

    log.info("Found %d enabled classifier(s)", len(enabled))

    rows = fetch_all_expositions_from_db(sb, "id,title,keywords,abstract,custom_metadata")
    log.info("Loaded %d expositions from Supabase", len(rows))
    if limit:
        rows = rows[:limit]

    for clf in enabled:
        name        = clf["name"]
        storage_key = clf["storage_key"]
        endpoint    = clf["endpoint"]
        method      = clf.get("method", "POST").upper()
        inp         = clf.get("input", {})
        input_field = inp.get("field", "text")
        text_fields = inp.get("text_fields", ["title", "keywords", "abstract"])
        try:
            rate_limit = float(clf.get("rate_limit", 5))
        except (TypeError, ValueError):
            rate_limit = 5.0
        delay = 1.0 / max(rate_limit, 0.1)
        hdrs  = {"Content-Type": "application/json", **clf.get("headers", {})}

        log.info("\nClassifier: %s  [storage_key=%s]", name, storage_key)
        done = skipped = failed = 0

        for i, expo in enumerate(rows, 1):
            meta = dict(expo.get("custom_metadata") or {})
            if not force and meta.get(storage_key) is not None:
                skipped += 1
                continue

            parts = []
            if "title"    in text_fields and expo.get("title"):
                parts.append(expo["title"])
            if "keywords" in text_fields and expo.get("keywords"):
                kw = expo["keywords"]
                parts.append(", ".join(str(k) for k in kw if k) if isinstance(kw, list) else str(kw))
            if "abstract" in text_fields and expo.get("abstract"):
                parts.append(expo["abstract"])

            text = " ".join(parts).strip()
            if not text:
                skipped += 1
                continue

            try:
                if method == "GET":
                    resp = requests.get(endpoint, params={input_field: text},
                                        headers=hdrs, timeout=30)
                else:
                    resp = requests.post(endpoint, json={input_field: text},
                                         headers=hdrs, timeout=30)
                resp.raise_for_status()
                response_json = resp.json()
            except Exception as e:
                log.warning("[%d/%d] API error for expo %d: %s", i, len(rows), expo["id"], e)
                failed += 1
                time.sleep(delay)
                continue

            labels = extract_classifier_labels(response_json, clf)
            meta[storage_key] = labels
            sb.table("expositions").update({"custom_metadata": meta}).eq("id", expo["id"]).execute()
            done += 1

            if done % 100 == 0:
                log.info("  %d classified…", done)

            time.sleep(delay)

        log.info("  %s — done: %d  skipped: %d  failed: %d", name, done, skipped, failed)

        # Reload rows with fresh custom_metadata for filter_config update
        if done > 0 or force:
            fresh = fetch_all_expositions_from_db(sb, "id,custom_metadata")
            update_classifier_filter_config(sb, clf, fresh)


def run_portals_only(limit: Optional[int] = None):
    """Fast pass: update only the published_in column from the RC master list. No Claude calls."""
    _, sb, _ = get_clients()
    expositions = fetch_internal_research()
    log.info("Updating published_in for %d expositions", len(expositions))
    if limit:
        expositions = expositions[:limit]
    done = skipped = 0
    for i, expo in enumerate(expositions, 1):
        expo_id = expo.get("id")
        if not expo_id:
            continue
        portals = [p.get("name", "") for p in expo.get("published_in", []) if p.get("name")]
        try:
            sb.table("expositions").update({"published_in": portals}).eq("id", expo_id).execute()
            done += 1
        except Exception as e:
            log.warning("[%d/%d] Failed %d: %s", i, len(expositions), expo_id, e)
            skipped += 1
        if i % 100 == 0:
            log.info("  %d / %d updated", i, len(expositions))
    log.info("Done — updated: %d  failed: %d", done, skipped)


def run(force: bool = False, extract_only: bool = False, limit: Optional[int] = None):
    openai, sb, anthropic_client = get_clients()
    schema = load_schema(sb)
    log.info("Schema loaded — %d array + %d text + %d custom dimensions",
             len(schema.get("array_dimensions", [])),
             len(schema.get("text_dimensions", [])),
             len(schema.get("custom_dimensions", [])))

    if extract_only:
        # Avoid the map.rcdata.org dependency — query Supabase directly for rows
        # that need extraction (no extracted_at, not marked unavailable).
        all_rows = fetch_all_expositions_from_db(
            sb, "id,title,author,abstract,published_in,unavailable,extracted_at,research_approach"
        )
        if force:
            expositions = all_rows
        else:
            expositions = [r for r in all_rows
                           if not r.get("unavailable") and (
                               r.get("extracted_at") is None or
                               not r.get("research_approach")
                           )]
        log.info("Found %d expositions needing extraction (from Supabase)", len(expositions))
    else:
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

        if extract_only:
            # List was pre-filtered from Supabase (already indexed, not yet extracted).
            if not anthropic_client:
                log.error("--extract-only requires ANTHROPIC_API_KEY to be set")
                sys.exit(1)
            log.info("%s Extracting %d", prefix, expo_id)
            try:
                extract_only_exposition(sb, expo, anthropic_client, schema)
                done += 1
            except Exception as e:
                log.error("%s Failed %d: %s", prefix, expo_id, e)
                failed += 1
        else:
            if not force and is_indexed(sb, expo_id):
                log.info("%s Already indexed %d — skipping", prefix, expo_id)
                skipped += 1
                continue
            log.info("%s Indexing %d", prefix, expo_id)
            try:
                index_exposition(openai, sb, expo, anthropic_client, schema)
                done += 1
            except Exception as e:
                log.error("%s Failed %d: %s", prefix, expo_id, e)
                failed += 1

        time.sleep(REQUEST_DELAY)

    log.info("Done — processed: %d  skipped: %d  failed: %d", done, skipped, failed)


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="RC Indexing Pipeline")
    ap.add_argument("--force", action="store_true",
                    help="Re-index / re-extract even if already processed")
    ap.add_argument("--extract-only", action="store_true",
                    help="Only run metadata extraction (skip embedding); "
                         "targets expositions with no extracted_at timestamp")
    ap.add_argument("--limit", type=int, metavar="N",
                    help="Process only the first N expositions (for testing)")
    ap.add_argument("--portals-only", action="store_true",
                    help="Fast pass: update only published_in from RC API, no Claude calls")
    ap.add_argument("--language-only", action="store_true",
                    help="Fast pass: detect and store language for all expositions, no Claude calls")
    ap.add_argument("--classify-only", action="store_true",
                    help="Run all enabled external classifiers (reads config from Supabase pipeline_config)")
    args = ap.parse_args()
    if args.portals_only:
        run_portals_only(limit=args.limit)
    elif args.language_only:
        run_language_only(limit=args.limit)
    elif args.classify_only:
        run_classifiers(force=args.force, limit=args.limit)
    else:
        run(force=args.force, extract_only=args.extract_only, limit=args.limit)
