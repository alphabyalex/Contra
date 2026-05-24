"""
Phase 7 - rebuild CTRA-03 (short) and CTRA-04 (long) proposals using the
post-v6, post-Phase-4 scored_markets pool. Read-only against Supabase.

Filters per the user spec:
  CTRA-03 short:
    - signal in (short, strong_short)
    - raw_edge > 0.02
    - include_in_basket = true
    - not resolved_likely
    - days_to_close in [7, 230]
    - volume > 0
    - max 2 legs per event
    - target 25-35 legs

  CTRA-04 long:
    - signal in (long, strong_long)
    - include_in_basket = true
    - raw_edge < -0.01
    - not resolved_likely
    - days_to_close in [7, 230]
    - volume > 0
    - target 20-25 legs
    - include tournament favorites from Phase 3D

Rank: abs(adj_edge) * log10(volume + 1) desc.
Dedup by event using Jaccard overlap >= 0.55 on token sets, keep top-2 by volume.
"""

from __future__ import annotations

import collections
import json
import math
import re
import urllib.request
import urllib.parse
from typing import Dict, List, Optional, Tuple

SUPA_URL = "https://ewtwooucdkrqlvynpmwx.supabase.co"
SUPA_KEY = "sb_secret_cRt7hKpdQxRQe8kJoF4hvw_rKWCm4GJ"


def hdrs() -> dict:
    return {"apikey": SUPA_KEY, "Authorization": f"Bearer {SUPA_KEY}"}


def fetch(url: str) -> list:
    req = urllib.request.Request(url, headers=hdrs())
    with urllib.request.urlopen(req, timeout=15) as resp:
        return json.loads(resp.read())


STOPWORDS = set(
    "will the by win wins for that this year end before after than over under "
    "and a an is are with at to of from on or in".split()
)


def tokenize(q: str) -> set:
    s = re.sub(r"(\d),(\d)", r"\1\2", (q or "").lower())
    s = re.sub(r"[^a-z0-9 ]", " ", s)
    return set(t for t in s.split() if len(t) > 2 and t not in STOPWORDS)


def jaccard(a: set, b: set) -> float:
    if not a or not b:
        return 0.0
    return len(a & b) / len(a | b)


def dedupe_max_per_event(rows: list, max_per_event: int = 2, threshold: float = 0.40) -> list:
    """Keep up to max_per_event legs per event cluster. Cluster by Jaccard >= threshold."""
    rows = sorted(rows, key=lambda r: -(r.get("volume") or 0))
    clusters: List[List[Tuple[dict, set]]] = []
    for r in rows:
        toks = tokenize(r.get("question") or "")
        placed = False
        for cluster in clusters:
            if any(jaccard(toks, t) >= threshold for _, t in cluster):
                cluster.append((r, toks))
                placed = True
                break
        if not placed:
            clusters.append([(r, toks)])
    out = []
    for cluster in clusters:
        for r, _ in cluster[:max_per_event]:
            out.append(r)
    return out


def fmt_row(i: int, r: dict) -> str:
    raw = float(r.get("raw_edge") or 0)
    adj = float(r.get("adjusted_edge") or 0)
    vol = float(r.get("volume") or 0)
    d = r.get("days_to_close")
    return (
        f"  #{i+1:02d} [{r['source']:11}] [{(r.get('category') or 'n/a'):8}] "
        f"p_mkt={float(r.get('p_market') or 0):.4f} p_mdl={float(r.get('p_model') or 0):.4f} "
        f"raw_edge={raw:+.4f} adj_edge={adj:+.5f} "
        f"vol=${vol:>12,.0f} d={str(d):>3} sig={r.get('signal') or '-':13} "
        f"mver={r.get('model_version') or '-':16}\n"
        f"      {(r.get('question') or '')[:130]}"
    )


def main():
    # Pull tracked_markets for the resolved_at join (proxy for resolved_likely).
    tracked = []
    offset = 0
    while True:
        page = fetch(f"{SUPA_URL}/rest/v1/tracked_markets?select=condition_id,resolved_at&limit=1000&offset={offset}")
        if not page: break
        tracked.extend(page)
        if len(page) < 1000: break
        offset += 1000
    resolved_ids = {t["condition_id"] for t in tracked if t.get("resolved_at")}

    # Paginate so we capture the expanded universe (>2000 rows after Phase 4).
    all_rows = []
    offset = 0
    while True:
        page = fetch(f"{SUPA_URL}/rest/v1/scored_markets?select=*&limit=1000&offset={offset}")
        if not page:
            break
        all_rows.extend(page)
        if len(page) < 1000:
            break
        offset += 1000
    print(f"loaded {len(all_rows)} scored_markets rows, {len(resolved_ids)} have tracked.resolved_at")

    def passes_common(r):
        if r.get("signal") == "resolved_likely":
            return False
        if r["condition_id"] in resolved_ids:
            return False
        d = r.get("days_to_close")
        if d is None or d < 7 or d > 260:
            return False
        v = r.get("volume") or 0
        if not v or float(v) <= 10_000:
            return False
        return True

    # CTRA-03 short pool
    short_rows = [
        r for r in all_rows
        if r.get("signal") in ("short", "strong_short")
        and float(r.get("raw_edge") or 0) > 0.02
        and r.get("include_in_basket")
        and passes_common(r)
    ]

    # CTRA-04 long pool (gate loosened to raw_edge < -0.005 per Task 3C).
    long_rows = [
        r for r in all_rows
        if r.get("signal") in ("long", "strong_long")
        and float(r.get("raw_edge") or 0) < -0.005
        and r.get("include_in_basket")
        and passes_common(r)
    ]

    def rank(r):
        return abs(float(r.get("adjusted_edge") or 0)) * math.log10((r.get("volume") or 0) + 1)

    short_rows.sort(key=lambda r: -rank(r))
    long_rows.sort(key=lambda r: -rank(r))

    # Dedup: max 2 per event
    short_dedup = dedupe_max_per_event(short_rows, max_per_event=2)
    long_dedup = dedupe_max_per_event(long_rows, max_per_event=2)

    short_dedup.sort(key=lambda r: -rank(r))
    long_dedup.sort(key=lambda r: -rank(r))

    target_short = short_dedup[:35]
    target_long = long_dedup[:25]

    print("=" * 100)
    print(f"CTRA-03 (SHORT) -- {len(target_short)} legs (pool before dedup: {len(short_rows)})")
    print("=" * 100)
    for i, r in enumerate(target_short):
        print(fmt_row(i, r))

    print()
    print("=" * 100)
    print(f"CTRA-04 (LONG) -- {len(target_long)} legs (pool before dedup: {len(long_rows)})")
    print("=" * 100)
    for i, r in enumerate(target_long):
        print(fmt_row(i, r))

    def summarize(name, rows):
        src = collections.Counter(r["source"] for r in rows)
        cat = collections.Counter((r.get("category") or "other") for r in rows)
        avg_raw = sum(float(r.get("raw_edge") or 0) for r in rows) / max(1, len(rows))
        avg_adj = sum(float(r.get("adjusted_edge") or 0) for r in rows) / max(1, len(rows))
        avg_vol = sum((r.get("volume") or 0) for r in rows) / max(1, len(rows))
        print(
            f"\n[{name}] legs={len(rows)}  kalshi={src.get('kalshi',0)}  polymarket={src.get('polymarket',0)}  "
            f"avg_raw_edge={avg_raw:+.4f}  avg_adj_edge={avg_adj:+.5f}  avg_volume=${avg_vol:,.0f}"
        )
        print("  by category: " + "  ".join(f"{c}={n}" for c, n in sorted(cat.items(), key=lambda x: -x[1])))

    summarize("CTRA-03", target_short)
    summarize("CTRA-04", target_long)

    s_ids = {r["condition_id"] for r in target_short}
    l_ids = {r["condition_id"] for r in target_long}
    overlap = s_ids & l_ids
    print(f"\nOverlap CTRA-03 vs CTRA-04 by condition_id: {len(overlap)}")
    if overlap:
        print("  FLAG -- markets in both:", overlap)


if __name__ == "__main__":
    main()
