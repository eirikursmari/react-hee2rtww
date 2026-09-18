#!/usr/bin/env python3
"""
peer_reviewed_ids.py — Write the ~889 peer-reviewed exposition ids as a
JSONL id-list, in the {"rc_id": ...} format rc_inventory.py expects as its
input_jsonl argument.

Uses the same venue-phrase rule as pipeline.is_peer_reviewed(), so the set
matches exactly what the analytics "Peer-reviewed journals" scope covers.

Usage
-----
    python3 pipeline/peer_reviewed_ids.py output/peer_reviewed_ids.jsonl

Environment
-----------
    SUPABASE_URL, SUPABASE_SERVICE_KEY   (no API keys needed)
"""

import json
import os
import sys
from pathlib import Path

from supabase import create_client

from pipeline import fetch_all_expositions_from_db, is_peer_reviewed


def main() -> None:
    if len(sys.argv) != 2:
        sys.exit("Usage: python3 pipeline/peer_reviewed_ids.py OUTPUT.jsonl")
    out_path = Path(sys.argv[1])

    for var in ("SUPABASE_URL", "SUPABASE_SERVICE_KEY"):
        if not os.environ.get(var):
            sys.exit(f"{var} not set")
    sb = create_client(os.environ["SUPABASE_URL"], os.environ["SUPABASE_SERVICE_KEY"])

    rows = fetch_all_expositions_from_db(sb, "id,published_in")
    ids = sorted(r["id"] for r in rows if is_peer_reviewed(r.get("published_in")))

    out_path.parent.mkdir(parents=True, exist_ok=True)
    with out_path.open("w", encoding="utf-8") as f:
        for rc_id in ids:
            f.write(json.dumps({"rc_id": str(rc_id)}) + "\n")

    print(f"Wrote {len(ids)} peer-reviewed exposition ids → {out_path}")


if __name__ == "__main__":
    main()
