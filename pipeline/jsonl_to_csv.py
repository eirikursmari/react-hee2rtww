#!/usr/bin/env python3
"""
jsonl_to_csv.py — Flatten rc_extract.py output into a review spreadsheet.

Produces one row per assigned term, so a human can scan term / confidence /
evidence side by side and accept or reject each assignment.

Usage
-----
    python3 pipeline/jsonl_to_csv.py output/pilot.jsonl
    python3 pipeline/jsonl_to_csv.py output/pilot.jsonl output/pilot_terms.csv

If the output path is omitted, it is derived from the input
(output/pilot.jsonl → output/pilot_terms.csv).

Columns
-------
    rc_id              exposition id
    source_language    e.g. "en" (joined with ";" if several)
    facet              disc | med | mode | meth | epist | out |
                       theo_persons | theo_concepts | ctx
    term_id            controlled-list id (disc-03, meth-12, …) — blank if none
    term               the assigned / extracted term
    confidence         0–1 — blank for uncontrolled terms (no score in schema)
    low_confidence     TRUE when confidence < 0.5 (flagged, not dropped)
    kind               controlled | uncontrolled
    evidence           verbatim snippet (≤20 words per the schema)
    extractor_notes    per-exposition notes (repeated on each of its rows)

A trailing summary is printed: rows written, expositions covered, and any
records that failed to parse (carried as parse_error in the JSONL).
"""

import csv
import json
import sys
from pathlib import Path

# Facets that live under record["facets"], in a sensible review order.
FACET_KEYS = [
    "disc", "med", "mode", "meth", "epist", "out",
    "theo_persons", "theo_concepts", "ctx",
]

COLUMNS = [
    "rc_id", "source_language", "text_words", "facet", "term_id", "term",
    "confidence", "low_confidence", "kind", "evidence", "extractor_notes",
]


def term_text(entry: dict) -> str:
    """Pull the human-readable label from a facet entry, tolerating key drift."""
    for key in ("term", "name", "label", "value"):
        val = entry.get(key)
        if val:
            return str(val).strip()
    return ""


def low_conf(confidence) -> str:
    try:
        return "TRUE" if float(confidence) < 0.5 else ""
    except (TypeError, ValueError):
        return ""


def rows_for_record(rec: dict):
    """Yield one flat dict per assigned/extracted term in a single record."""
    rc_id = rec.get("rc_id", "")
    langs = rec.get("source_language", [])
    if isinstance(langs, str):
        langs = [langs]
    lang_str = ";".join(str(l) for l in langs) if langs else ""
    text_words = rec.get("_text_words", "")
    notes = rec.get("extractor_notes", "") or ""

    # Records the extractor could not parse as JSON are carried through so the
    # reviewer still sees them — surface them as a single explicit row.
    if rec.get("parse_error"):
        yield {
            "rc_id": rc_id, "source_language": lang_str, "text_words": text_words,
            "facet": "", "term_id": "", "term": "", "confidence": "",
            "low_confidence": "", "kind": "parse_error", "evidence": "",
            "extractor_notes": (rec.get("raw_response", "") or "")[:500],
        }
        return

    facets = rec.get("facets") or {}
    for facet in FACET_KEYS:
        for entry in facets.get(facet, []) or []:
            if not isinstance(entry, dict):
                continue
            conf = entry.get("confidence", "")
            yield {
                "rc_id": rc_id,
                "source_language": lang_str,
                "text_words": text_words,
                "facet": facet,
                "term_id": entry.get("id", "") or "",
                "term": term_text(entry),
                "confidence": conf if conf != "" else "",
                "low_confidence": low_conf(conf),
                "kind": "controlled",
                "evidence": (entry.get("evidence", "") or "").strip(),
                "extractor_notes": notes,
            }

    # Inductive overflow channel — no id, no confidence in the schema.
    for entry in rec.get("uncontrolled_terms", []) or []:
        if not isinstance(entry, dict):
            continue
        yield {
            "rc_id": rc_id,
            "source_language": lang_str,
            "text_words": text_words,
            "facet": entry.get("facet", "") or "",
            "term_id": "",
            "term": term_text(entry),
            "confidence": "",
            "low_confidence": "",
            "kind": "uncontrolled",
            "evidence": (entry.get("evidence", "") or "").strip(),
            "extractor_notes": notes,
        }


def main() -> None:
    if len(sys.argv) < 2:
        sys.exit("usage: jsonl_to_csv.py INPUT.jsonl [OUTPUT.csv]")

    in_path = Path(sys.argv[1])
    if not in_path.exists():
        sys.exit(f"Input not found: {in_path}")

    out_path = (
        Path(sys.argv[2]) if len(sys.argv) > 2
        else in_path.with_name(in_path.stem + "_terms.csv")
    )

    rows_written = 0
    expos = set()
    bad_lines = 0
    parse_errors = 0

    # utf-8-sig so Excel opens accented evidence snippets correctly.
    with in_path.open(encoding="utf-8") as f, \
         out_path.open("w", newline="", encoding="utf-8-sig") as out_f:
        writer = csv.DictWriter(out_f, fieldnames=COLUMNS)
        writer.writeheader()

        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                bad_lines += 1
                continue

            if rec.get("rc_id"):
                expos.add(str(rec["rc_id"]))
            if rec.get("parse_error"):
                parse_errors += 1

            for row in rows_for_record(rec):
                writer.writerow(row)
                rows_written += 1

    print(f"Wrote {rows_written} term rows from {len(expos)} expositions")
    print(f"  → {out_path}")
    if parse_errors:
        print(f"  ⚠ {parse_errors} exposition(s) had parse_error (see kind=parse_error rows)")
    if bad_lines:
        print(f"  ⚠ {bad_lines} JSONL line(s) could not be parsed and were skipped")


if __name__ == "__main__":
    main()
