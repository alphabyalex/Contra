"""
Dry-run test of the FIX-3 parser: fetch markets via Gamma /markets and
push them through `calibrate.parse_one` without writing artifacts.

  * Part A — first 500 markets (per user spec)
  * Part B — broader sweep (offsets up to where Gamma allows) to estimate
    the realistic yield, since lastTradePrice is 0 for almost all of
    Gamma's oldest closed markets.
"""

import requests, time
from calibrate import parse_one, GAMMA_URL


def fetch_page(offset, limit=100):
    r = requests.get(
        GAMMA_URL,
        params={"closed": "true", "archived": "false", "limit": limit, "offset": offset},
        timeout=30,
    )
    data = r.json()
    if not isinstance(data, list):
        return None
    return data


def parse_and_report(markets, label):
    print(f"\n=== {label}: {len(markets)} markets ===")
    rows = []
    counts = {}
    for m in markets:
        status, row = parse_one(m)
        counts[status] = counts.get(status, 0) + 1
        if status == "ok" and isinstance(row, dict):
            rows.append(row)
    print("Status counts:")
    for s, c in sorted(counts.items(), key=lambda kv: -kv[1]):
        print(f"  {s}: {c}")
    print(f"\nUsable rows: {len(rows)}")
    if rows:
        print("\nExample rows (first 3):")
        for r in rows[:3]:
            print(f"  question:        {r['question'][:80]}")
            print(f"  lastTradePrice:  {r['p_market']}")
            print(f"  outcome:         {'YES' if r['resolved_yes'] else 'NO'}  (resolved_yes={r['resolved_yes']})")
            print(f"  volume:          {r['volume']:.0f}")
            print()
    return rows


def part_a_first_500():
    """User-requested: parse first 500 markets and report yield."""
    markets = []
    for off in (0, 100, 200, 300, 400):
        page = fetch_page(off)
        if not page:
            break
        markets.extend(page)
        time.sleep(0.3)
    parse_and_report(markets, "Part A — first 500 markets (offsets 0–400)")


def part_b_broader_sweep():
    """Sample across the full pagination range so we can see where the
    usable rows actually live."""
    all_markets = []
    offsets = [0, 1000, 2000, 3000, 5000, 7000, 9000, 9500, 9700, 9900, 10000]
    for off in offsets:
        page = fetch_page(off)
        if not page:
            print(f"  offset={off}: non-list / empty")
            continue
        all_markets.extend(page)
        time.sleep(0.3)
    parse_and_report(all_markets, f"Part B — broader sweep ({len(all_markets)} markets across {len(offsets)} offsets)")


if __name__ == "__main__":
    part_a_first_500()
    part_b_broader_sweep()
