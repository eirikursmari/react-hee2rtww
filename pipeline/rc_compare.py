#!/usr/bin/env python3
"""
rc_compare.py — Join the text and image extraction runs and report §9.5 analysis.

Compares the text pipeline output (rc_extract.py → modality_source "text")
against the image pipeline output (rc_multimodal.py → modality_source "image"),
keyed on rc_id. Answers four questions from the multimodal spec §9.5:

  1. Provenance mix — share of assignments by modality per facet (all expositions).
  2. Head-to-head — for expositions processed by BOTH, do the modalities agree?
     (per facet: agree / text-only / image-only term counts)
  3. Coverage / rescue — how many text-thin expositions the image pass rescued,
     i.e. gained facet terms they lacked from text.
  4. Conflicts — expositions where each modality assigned terms the other did not.

Usage
-----
    python3 pipeline/rc_compare.py output/pilot.jsonl output/multimodal.jsonl
    python3 pipeline/rc_compare.py output/pilot.jsonl output/multimodal.jsonl \\
        --thin 50 --out output/compare.csv

Outputs a readable summary to stdout and a per-(rc_id, facet, term) CSV
(default: <image_jsonl stem>_compare.csv) with an in_text / in_image / status
column so agreements and conflicts can be inspected row by row.
"""

import argparse
import csv
import json
import re
from pathlib import Path

FACET_KEYS = ["disc", "med", "mode", "meth", "epist", "out",
              "theo_persons", "theo_concepts", "ctx"]


def norm(text: str) -> str:
    """Normalise a term for matching: lowercase, collapse whitespace/punctuation."""
    return re.sub(r"\s+", " ", (text or "").strip().lower())


def entry_key(entry: dict) -> str:
    """Match on controlled id when present, else the normalised term text."""
    return (entry.get("id") or "").strip() or norm(
        entry.get("term") or entry.get("name") or ""
    )


def entry_label(entry: dict) -> str:
    for k in ("term", "name", "label"):
        if entry.get(k):
            return str(entry[k]).strip()
    return entry.get("id", "") or ""


def load_run(path: Path, default_modality: str = "text") -> dict:
    """rc_id -> {facets: {facet: {key: label}}, mods: {(facet,key): set}, text_words}."""
    runs: dict[str, dict] = {}
    if not path.exists():
        raise SystemExit(f"Not found: {path}")
    with path.open(encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue
            rc_id = str(rec.get("rc_id") or "")
            if not rc_id or rec.get("parse_error"):
                continue
            facets = rec.get("facets") or {}
            # Merge duplicate rc_id records (image run may not, text run won't)
            slot = runs.setdefault(rc_id, {"facets": {}, "mods": {}, "text_words": None})
            for facet in FACET_KEYS:
                for e in facets.get(facet, []) or []:
                    if not isinstance(e, dict):
                        continue
                    k = entry_key(e)
                    if not k:
                        continue
                    slot["facets"].setdefault(facet, {})[k] = entry_label(e)
                    mod = e.get("modality_source", default_modality)
                    slot["mods"].setdefault((facet, k), set()).add(mod)
            if rec.get("_text_words") is not None:
                slot["text_words"] = rec.get("_text_words")
    return runs


def facet_terms(run: dict, rc_id: str, facet: str) -> dict:
    return run.get(rc_id, {}).get("facets", {}).get(facet, {})


def total_terms(run: dict, rc_id: str) -> int:
    return sum(len(t) for t in run.get(rc_id, {}).get("facets", {}).values())


def modalities_for(run: dict, rc_id: str, facet: str, key: str) -> set:
    return run.get(rc_id, {}).get("mods", {}).get((facet, key), set())


_MOD_ABBR = {"image": "img", "image-text": "txt", "text": "text"}


def mod_tag(mods: set) -> str:
    return "+".join(sorted(_MOD_ABBR.get(m, m) for m in mods))


def bar(n: int, width: int = 24, total: int = 0) -> str:
    if not total:
        return ""
    filled = round(width * n / total)
    return "█" * filled + "·" * (width - filled)


def main() -> None:
    ap = argparse.ArgumentParser(description="Compare text vs image extraction runs")
    ap.add_argument("text_jsonl",  help="Text run (rc_extract.py output)")
    ap.add_argument("image_jsonl", help="Image run (rc_multimodal.py output)")
    ap.add_argument("--thin", type=int, default=50,
                    help="text_words below this = 'text-thin' (default 50)")
    ap.add_argument("--out", default=None,
                    help="Detail CSV path (default: <image>_compare.csv)")
    args = ap.parse_args()

    text  = load_run(Path(args.text_jsonl),  default_modality="text")
    image = load_run(Path(args.image_jsonl), default_modality="image")

    both = sorted(set(text) & set(image), key=str)
    out_path = Path(args.out) if args.out else \
        Path(args.image_jsonl).with_name(Path(args.image_jsonl).stem + "_compare.csv")

    print(f"Text run:  {len(text)} expositions")
    print(f"Image run: {len(image)} expositions")
    print(f"In both:   {len(both)} expositions (head-to-head set)\n")

    # ── 1. Provenance mix — distinct exposition-level terms by modality ──────────
    # Counts each (rc_id, facet, term) once per modality that produced it, so one
    # image-heavy exposition can't dominate. image-text = OCR'd designed-in prose.
    print("─" * 62)
    print("1. PROVENANCE MIX — distinct exposition×facet×term by modality")
    print("─" * 62)
    MODS = ["text", "image", "image-text"]
    tally = {f: {m: 0 for m in MODS} for f in FACET_KEYS}
    for run in (text, image):
        for rc_id, data in run.items():
            for (facet, _key), mods in data.get("mods", {}).items():
                for mod in mods:
                    bucket = mod if mod in tally[facet] else "image"
                    tally[facet][bucket] += 1
    print(f"{'facet':<15} {'text':>6} {'image':>6} {'img-text':>9}")
    col_tot = {m: 0 for m in MODS}
    for facet in FACET_KEYS:
        row = tally[facet]
        for m in MODS:
            col_tot[m] += row[m]
        print(f"{facet:<15} {row['text']:>6} {row['image']:>6} {row['image-text']:>9}")
    print(f"{'TOTAL':<15} {col_tot['text']:>6} {col_tot['image']:>6} "
          f"{col_tot['image-text']:>9}")
    if any(col_tot.values()):
        grand = sum(col_tot.values())
        print(f"\n  Share — text {100*col_tot['text']/grand:.0f}%  "
              f"image {100*col_tot['image']/grand:.0f}%  "
              f"image-text {100*col_tot['image-text']/grand:.0f}%")

    # ── 2. Head-to-head agreement (expositions in both runs) ─────────────────────
    print("\n" + "─" * 62)
    print(f"2. HEAD-TO-HEAD — agreement across the {len(both)} shared expositions")
    print("─" * 62)
    print(f"{'facet':<15} {'agree':>6} {'text-only':>10} {'image-only':>11}")
    agg = {f: [0, 0, 0] for f in FACET_KEYS}   # agree, text_only, image_only
    for rc_id in both:
        for facet in FACET_KEYS:
            tk = set(facet_terms(text,  rc_id, facet))
            mk = set(facet_terms(image, rc_id, facet))
            agg[facet][0] += len(tk & mk)
            agg[facet][1] += len(tk - mk)
            agg[facet][2] += len(mk - tk)
    A = T = M = 0
    for facet in FACET_KEYS:
        a, t, m = agg[facet]
        A += a; T += t; M += m
        print(f"{facet:<15} {a:>6} {t:>10} {m:>11}")
    print(f"{'TOTAL':<15} {A:>6} {T:>10} {M:>11}")
    if A + T + M:
        print(f"\n  Agreement rate (agree / all distinct assignments): "
              f"{100*A/(A+T+M):.0f}%")

    # ── 3. Coverage / rescue — text-thin expositions helped by images ────────────
    print("\n" + "─" * 62)
    print(f"3. RESCUE — text-thin expositions (text_words < {args.thin}) in both runs")
    print("─" * 62)
    thin = [r for r in both
            if (text[r].get("text_words") is not None
                and text[r]["text_words"] < args.thin)]
    rescued = []
    for rc_id in thin:
        t_terms = total_terms(text,  rc_id)
        m_terms = total_terms(image, rc_id)
        gained = []
        for f in FACET_KEYS:
            new_keys = set(facet_terms(image, rc_id, f)) - set(facet_terms(text, rc_id, f))
            if not new_keys:
                continue
            mods = set()
            for k in new_keys:
                mods |= modalities_for(image, rc_id, f, k)
            tag = mod_tag(mods)
            gained.append(f"{f}({tag})" if tag else f)
        if m_terms > 0:
            rescued.append((rc_id, text[rc_id].get("text_words"),
                            t_terms, m_terms, gained))

    print(f"Text-thin expositions in both runs: {len(thin)}")
    print(f"…of which the image pass added ≥1 term: {len(rescued)}")
    if rescued:
        print("  (facet tags: img = visual, txt = OCR'd designed-in text)")
        print(f"\n{'rc_id':<12} {'words':>5} {'txt':>4} {'img':>4}  facets gained (by modality)")
        for rc_id, words, t_terms, m_terms, gained in sorted(
                rescued, key=lambda x: (x[1] or 0)):
            print(f"{rc_id:<12} {words:>5} {t_terms:>4} {m_terms:>4}  "
                  f"{', '.join(gained)}")

    # ── 4. Detail CSV (every rc_id × facet × term, with source + status) ─────────
    with out_path.open("w", newline="", encoding="utf-8-sig") as f:
        w = csv.writer(f)
        w.writerow(["rc_id", "text_words", "facet", "term_key", "term_label",
                    "in_text", "in_image", "image_modalities", "status"])
        for rc_id in sorted(set(text) | set(image), key=str):
            words = (text.get(rc_id, {}) or {}).get("text_words", "")
            for facet in FACET_KEYS:
                tt = facet_terms(text,  rc_id, facet)
                mm = facet_terms(image, rc_id, facet)
                for key in sorted(set(tt) | set(mm)):
                    in_t = key in tt
                    in_m = key in mm
                    status = ("agree"     if in_t and in_m else
                              "text_only" if in_t else "image_only")
                    img_mods = mod_tag(modalities_for(image, rc_id, facet, key))
                    w.writerow([rc_id, words, facet, key,
                                tt.get(key) or mm.get(key),
                                "TRUE" if in_t else "", "TRUE" if in_m else "",
                                img_mods, status])
    print(f"\nDetail written → {out_path}")


if __name__ == "__main__":
    main()
