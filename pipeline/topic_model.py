#!/usr/bin/env python3
"""
topic_model.py — Discover artistic-research themes from the peer-reviewed corpus.

Runs BERTopic over the peer-reviewed expositions (title + abstract, optionally
+ body) to let the corpus reveal its own thematic structure. The output is a
TOPIC REPORT — each topic's size, top keywords, and a few representative titles
— which we then curate by hand into a controlled vocabulary of ~15-20
artistic-research themes to replace the (too-academic) fields_engaged list.

This does NOT touch the extraction schema or the database. It only reads
expositions and writes two review files.

Workflow:
  1. python3 pipeline/topic_model.py            # title + abstract (fast)
  2. paste output/topics_report.txt back for naming
  3. we agree the named vocabulary; it becomes the new schema dimension
  4. the full Sonnet extraction applies that vocabulary as multi-label tags

Dependencies (heavy — installs torch etc.):
    pip install bertopic sentence-transformers

Environment:
    SUPABASE_URL, SUPABASE_SERVICE_KEY   (ANTHROPIC/OPENAI not needed)

Notes:
  • Uses a MULTILINGUAL embedding model — RUUKKU/VIS abstracts include Finnish,
    Swedish and Norwegian. Keywords in non-English topics will be in-language;
    the representative titles disambiguate them.
  • On a small box, model download + fit on ~900 short docs needs a few minutes
    and ~1-2 GB RAM.
"""

import argparse
import os
import sys
import time
from pathlib import Path

from supabase import create_client
from pipeline import is_peer_reviewed, fetch_expo_json, extract_pages, EXTRACT_TEXT_MAX, NOT_FOUND

EMBED_MODEL = "paraphrase-multilingual-MiniLM-L12-v2"   # handles Nordic-language abstracts

# Domain stop words: near-universal in this corpus, so they drown out real themes.
EXTRA_STOPWORDS = [
    "research", "artistic", "art", "work", "works", "practice", "practices",
    "exposition", "paper", "project", "study", "studies", "author", "article",
    "using", "based", "new", "way", "ways", "different", "within", "also",
    "paper", "essay", "explore", "explores", "question", "questions",
]


def load_texts(sb, with_body: bool):
    """Peer-reviewed expositions with a usable abstract: (id, title, text)."""
    rows, offset, page = [], 0, 1000
    while True:
        batch = (sb.table("expositions")
                   .select("id,title,abstract,published_in")
                   .order("id").range(offset, offset + page - 1).execute().data)
        if not batch:
            break
        for r in batch:
            if not is_peer_reviewed(r.get("published_in")):
                continue
            title = (r.get("title") or "").strip()
            abstract = (r.get("abstract") or "").strip()
            if not title or len(abstract) <= 60:
                continue
            rows.append({"id": r["id"], "title": title, "abstract": abstract})
        if len(batch) < page:
            break
        offset += page

    docs = []
    for i, r in enumerate(rows, 1):
        text = f"{r['title']}. {r['abstract']}"
        if with_body:
            try:
                content = fetch_expo_json(int(r["id"]))
                if content is not NOT_FOUND and content:
                    pages = extract_pages(content)
                    body = "\n\n".join(p["text"] for p in pages)[:EXTRACT_TEXT_MAX]
                    if body:
                        text = f"{text}\n\n{body}"
            except Exception:
                pass
            if i % 50 == 0:
                print(f"  …fetched bodies for {i}/{len(rows)}", file=sys.stderr)
            time.sleep(0.2)
        r["text"] = text
        docs.append(r)
    return docs


def main():
    ap = argparse.ArgumentParser(description="Discover AR themes via BERTopic")
    ap.add_argument("--with-body", action="store_true",
                    help="Enrich each doc with the RC body excerpt (slower; richer topics)")
    ap.add_argument("--min-topic-size", type=int, default=12,
                    help="Minimum docs per topic (smaller = more, finer topics)")
    ap.add_argument("--nr-topics", default="auto",
                    help="Reduce to this many topics after fit ('auto' or an int)")
    ap.add_argument("--outdir", default="output")
    args = ap.parse_args()

    for v in ("SUPABASE_URL", "SUPABASE_SERVICE_KEY"):
        if not os.environ.get(v):
            sys.exit(f"{v} not set")

    try:
        from bertopic import BERTopic
        from sentence_transformers import SentenceTransformer
        from sklearn.feature_extraction.text import CountVectorizer
    except ImportError:
        sys.exit("Missing deps. Run:  pip install bertopic sentence-transformers")

    sb = create_client(os.environ["SUPABASE_URL"], os.environ["SUPABASE_SERVICE_KEY"])
    print("Loading peer-reviewed texts…")
    docs = load_texts(sb, args.with_body)
    if len(docs) < 30:
        sys.exit(f"Only {len(docs)} docs — too few to model.")
    texts  = [d["text"]  for d in docs]
    titles = [d["title"] for d in docs]
    print(f"{len(docs)} documents"
          f"{' (title + abstract + body)' if args.with_body else ' (title + abstract)'}")

    print(f"Embedding with {EMBED_MODEL} …")
    embedder = SentenceTransformer(EMBED_MODEL)
    embeddings = embedder.encode(texts, show_progress_bar=True)

    stop = list(CountVectorizer(stop_words="english").get_stop_words()) + EXTRA_STOPWORDS
    vectorizer = CountVectorizer(stop_words=stop, ngram_range=(1, 2), min_df=3)

    nr = None if args.nr_topics == "auto" else int(args.nr_topics)
    topic_model = BERTopic(
        embedding_model=embedder,
        vectorizer_model=vectorizer,
        min_topic_size=args.min_topic_size,
        nr_topics=nr,
        calculate_probabilities=False,
        verbose=True,
    )
    topics, _ = topic_model.fit_transform(texts, embeddings)

    info = topic_model.get_topic_info()          # includes the -1 outlier topic
    outdir = Path(args.outdir); outdir.mkdir(parents=True, exist_ok=True)

    # ── Topic report (the thing to paste back for naming) ────────────────────
    lines = []
    n_topics = len([t for t in info["Topic"] if t != -1])
    header = (f"BERTopic — {len(docs)} peer-reviewed docs → {n_topics} topics "
              f"(+ outliers)\ninput: {'title+abstract+body' if args.with_body else 'title+abstract'}"
              f"   embed: {EMBED_MODEL}\n")
    lines.append(header)
    for _, row in info.iterrows():
        tid, count = row["Topic"], row["Count"]
        words = [w for w, _ in topic_model.get_topic(tid)][:10] if tid != -1 else []
        label = "OUTLIERS (unassigned)" if tid == -1 else f"Topic {tid}"
        lines.append(f"{'─'*88}\n{label}  —  {count} docs")
        if words:
            lines.append("  keywords: " + ", ".join(words))
        reps = [titles[i] for i, t in enumerate(topics) if t == tid][:4]
        for r in reps:
            lines.append(f"    • {r[:90]}")
    report = "\n".join(lines)
    (outdir / "topics_report.txt").write_text(report, encoding="utf-8")

    # ── Per-doc assignments (kept for later, e.g. seeding / validation) ───────
    import csv
    with open(outdir / "doc_topics.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["id", "topic", "title"])
        for d, t in zip(docs, topics):
            w.writerow([d["id"], t, d["title"]])

    print("\n" + report)
    print(f"\nSaved: {outdir/'topics_report.txt'}  and  {outdir/'doc_topics.csv'}")
    print("Paste topics_report.txt back and we'll name the themes into a vocabulary.")


if __name__ == "__main__":
    main()
