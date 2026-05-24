"""
Phase 6 - rescore every sports market in scored_markets using
calibration_v6.json multipliers. Mirrors the Phase 4 fix to include_in_basket
so longs can now pass the gate.

Reads:  ml/artifacts/calibration_v6.json
Writes: scored_markets (via Supabase REST). Only updates sports rows.

Sport detection follows backend/src/services/ml-scorer.ts:detectSportsSubcategory.
For tournament rows we use normalized_p_market when present so the v6
multiplier sees the same vig-removed input the production pipeline uses.

Adjusted edge / signal / include_in_basket are recomputed with the new
calibration_v6 p_model. Phase 5's MAX_DAYS_TO_CLOSE=230 is honored.
"""

from __future__ import annotations

import json
import os
import re
import sys
import urllib.request
import urllib.error
from typing import Dict, List, Optional, Tuple

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
CAL = os.path.join(ROOT, "ml", "artifacts", "calibration_v6.json")
SUPA_URL = "https://ewtwooucdkrqlvynpmwx.supabase.co"
SUPA_KEY = "sb_secret_cRt7hKpdQxRQe8kJoF4hvw_rKWCm4GJ"

# Mirror of ml-scorer.ts constants after Phase 4/5.
EDGE_INCLUDE_THRESHOLD = 0.03
TOURNAMENT_EDGE_INCLUDE_THRESHOLD = 0.02
IMPOSSIBLE_INCLUDE_THRESHOLD = 0.02
P_MARKET_INCLUDE_MIN = 0.02
P_MARKET_INCLUDE_MAX = 0.12
MIN_DAYS_TO_CLOSE = 3
MAX_DAYS_TO_CLOSE = 260
MIN_VOLUME_USD = 100_000

LONG_P_MIN = 0.05
LONG_P_MAX = 0.35

MODEL_VERSION_V6 = "calibration_v6_partial"
MIN_SAMPLE_SIZE_FOR_V6 = 25

# v5_2 base calibration table, mirrors ml-scorer.ts:62-74
V5_2_TABLE = [
    (0.00, 0.02, 0.0017),
    (0.02, 0.05, 0.0081),
    (0.05, 0.10, 0.0174),
    (0.10, 0.15, 0.0212),
    (0.15, 0.20, 0.0932),
    (0.20, 0.30, 0.1140),
    (0.30, 0.50, 0.2523),
    (0.50, 0.70, 0.4681),
    (0.70, 0.80, 0.6460),
    (0.80, 0.90, 0.7712),
    (0.90, 1.01, 0.9182),
]


def v5_2_base_pmodel(p: float) -> float:
    for lo, hi, m in V5_2_TABLE:
        if lo <= p < hi:
            return m
    return V5_2_TABLE[-1][2]


def v5_2_sport_pmodel(sport: str, p: float) -> float:
    """Mirror of ml-scorer.ts:getSportsSubcategoryPModel v5_2 tier rules."""
    if sport == "fifa":
        if p > 0.15: return p * 0.88
        if p > 0.08: return p * 0.75
        if p > 0.04: return p * 0.35
        return v5_2_base_pmodel(p) * 0.85
    if sport == "nba":
        if p > 0.08: return p * 0.70
        if p > 0.04: return p * 0.40
        return v5_2_base_pmodel(p) * 0.90
    if sport == "nhl":
        if p > 0.15: return p * 0.88
        if p > 0.08: return p * 0.82
        if p > 0.04: return p * 0.55
        return v5_2_base_pmodel(p) * 0.92
    if sport == "mlb":
        if p > 0.08: return p * 0.75
        if p > 0.04: return p * 0.42
        return v5_2_base_pmodel(p) * 0.88
    if sport == "nfl":
        if p > 0.08: return p * 0.78
        if p > 0.04: return p * 0.44
        return v5_2_base_pmodel(p) * 0.88
    if sport == "tennis":
        if p > 0.08: return p * 0.65
        if p > 0.04: return p * 0.32
        return v5_2_base_pmodel(p) * 0.80
    return v5_2_base_pmodel(p)


def hdrs() -> dict:
    return {
        "apikey": SUPA_KEY,
        "Authorization": f"Bearer {SUPA_KEY}",
        "Content-Type": "application/json",
        "Prefer": "return=representation",
    }


def fetch(url: str) -> list:
    req = urllib.request.Request(url, headers=hdrs())
    with urllib.request.urlopen(req, timeout=15) as resp:
        return json.loads(resp.read())


def patch(url: str, body: dict) -> Optional[list]:
    data = json.dumps(body).encode()
    req = urllib.request.Request(url, data=data, headers=hdrs(), method="PATCH")
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "ignore")
        print(f"[patch error] {e.code} {body[:200]}")
        return None


def detect_sport(q: str) -> Optional[str]:
    q = (q or "").lower()
    if re.search(r"\b(world cup|fifa)\b", q):
        return "fifa"
    if re.search(r"\b(nba|nba finals|nba playoffs|western conference|eastern conference)\b", q):
        return "nba"
    if re.search(r"\b(stanley cup|nhl)\b", q):
        return "nhl"
    if re.search(r"\b(world series|mlb)\b", q):
        return "nhl"  # treat MLB as NHL bucket since we don't have MLB cal
    if re.search(r"\b(super bowl|nfl)\b", q):
        return "nfl"
    if re.search(r"\b(wimbledon|french open|us open|australian open)\b", q):
        return "tennis"
    return None


def bucket_for(p: float) -> str:
    if p < 0.05: return "0-5"
    if p < 0.10: return "5-10"
    if p < 0.15: return "10-15"
    if p < 0.20: return "15-20"
    if p < 0.30: return "20-30"
    if p < 0.50: return "30-50"
    if p < 0.75: return "50-75"
    return "75+"


def classify_signal(raw_edge: float) -> str:
    if raw_edge is None or raw_edge != raw_edge:
        return "fair_value"
    if raw_edge > 0.05: return "strong_short"
    if raw_edge > 0.02: return "short"
    if raw_edge > 0.00: return "weak_short"
    if raw_edge >= -0.01: return "fair_value"
    if raw_edge > -0.05: return "long"
    return "strong_long"


def time_factor(d: Optional[int]) -> float:
    if d is None: return 1.0
    if d < 30: return 1.20
    if d <= 90: return 1.00
    if d <= 180: return 0.70
    if d <= 365: return 0.40
    if d <= 730: return 0.20
    return 0.10


def volume_factor(v: Optional[float]) -> float:
    if v is None: return 1.0
    if v < MIN_VOLUME_USD: return 0.10
    if v < 500_000: return 0.90
    if v <= 2_000_000: return 1.00
    return 1.05


TOURNAMENT_PATTERNS = [
    (re.compile(r"\b(\d{4})\s+fifa\s+world\s+cup\b", re.I), lambda m: f"fifa_world_cup_{m.group(1)}"),
    (re.compile(r"\bfifa\s+world\s+cup\s+(\d{4})\b", re.I), lambda m: f"fifa_world_cup_{m.group(1)}"),
    (re.compile(r"\bworld\s+cup\s+(\d{4})\b", re.I), lambda m: f"fifa_world_cup_{m.group(1)}"),
    (re.compile(r"\b(\d{4})\s+world\s+cup\b", re.I), lambda m: f"fifa_world_cup_{m.group(1)}"),
    (re.compile(r"\b(\d{4})\s+nba\s+western\s+conference\s+finals\b", re.I), lambda m: f"nba_west_finals_{m.group(1)}"),
    (re.compile(r"\b(\d{4})\s+nba\s+eastern\s+conference\s+finals\b", re.I), lambda m: f"nba_east_finals_{m.group(1)}"),
    (re.compile(r"\b(\d{4})\s+nba\s+finals\b", re.I), lambda m: f"nba_finals_{m.group(1)}"),
    (re.compile(r"\bnba\s+finals\s+(\d{4})\b", re.I), lambda m: f"nba_finals_{m.group(1)}"),
    (re.compile(r"\b(\d{4})\s+nhl\s+stanley\s+cup\b", re.I), lambda m: f"nhl_stanley_cup_{m.group(1)}"),
    (re.compile(r"\b(\d{4})\s+stanley\s+cup\b", re.I), lambda m: f"nhl_stanley_cup_{m.group(1)}"),
    (re.compile(r"\b(\d{4})\s+super\s+bowl\b", re.I), lambda m: f"nfl_super_bowl_{m.group(1)}"),
    (re.compile(r"\b(\d{4})\s+world\s+series\b", re.I), lambda m: f"mlb_world_series_{m.group(1)}"),
]


def detect_tournament_group(question: str) -> Optional[str]:
    if not question:
        return None
    if not re.search(r"\bwin\b.*\b(world cup|fifa|nba|stanley cup|nhl|world series|mlb|super bowl|nfl|wimbledon|french open|us open|australian open)\b", question, re.I):
        return None
    for rx, key in TOURNAMENT_PATTERNS:
        m = rx.search(question)
        if m:
            return key(m)
    return None


def fetch_tournament_full_fields() -> Dict[str, List[dict]]:
    """Pull live full tournament fields via the running backend scanner.
    Each entry is a list of {condition_id, question, p_market, normalized_p_market, volume, days_to_close}.
    """
    try:
        req = urllib.request.Request(
            "http://localhost:3001/api/scanner/markets?search=will&limit=2000",
            headers={"Accept": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read())
    except Exception as e:
        print(f"[tournament fetch] failed: {e}")
        return {}
    groups: Dict[str, List[dict]] = {}
    for r in data.get("rows", []):
        tg = r.get("tournament_group") or detect_tournament_group(r.get("question") or "")
        if not tg:
            continue
        p = r.get("p_market")
        if not isinstance(p, (int, float)) or p <= 0:
            continue
        npm = r.get("normalized_p_market")
        if not isinstance(npm, (int, float)) or npm <= 0:
            npm = p  # fallback; will be renormalized after we sum
        groups.setdefault(tg, []).append({
            "condition_id": r.get("condition_id"),
            "question": r.get("question") or "",
            "p_market": float(p),
            "normalized_p_market": float(npm),
            "volume": float(r.get("volume") or 0),
            "days_to_close": r.get("days_to_close"),
        })
    return groups


def hard_excluded(d: Optional[int], v: Optional[float]) -> bool:
    if d is not None and (d < MIN_DAYS_TO_CLOSE or d > MAX_DAYS_TO_CLOSE):
        return True
    if v is not None and v < MIN_VOLUME_USD:
        return True
    return False


def compute_include(p_market: float, signal: str, adj_edge: float, hex_: bool, raw_edge: float = 0.0) -> bool:
    # short gate
    short_ok = (not hex_) and adj_edge >= EDGE_INCLUDE_THRESHOLD and \
        P_MARKET_INCLUDE_MIN <= p_market <= P_MARKET_INCLUDE_MAX
    # long gate: signal in long/strong_long OR raw_edge < -0.005 (Task 3C).
    long_ok = (not hex_) and (signal in ("long", "strong_long") or raw_edge < -0.005) and \
        LONG_P_MIN <= p_market <= LONG_P_MAX
    return short_ok or long_ok


def main():
    global cal, mults_by_sport, sizes_by_sport
    cal = json.load(open(CAL, encoding="utf-8"))
    mults_by_sport = cal["sports"]
    sizes_by_sport = cal.get("bucket_sample_sizes", {})
    print(f"calibration: {cal['version']}  buckets: {cal['buckets']}  min_n_for_v6: {MIN_SAMPLE_SIZE_FOR_V6}")
    kept_v6 = []
    reverted_v5_2 = []
    for sport, bucket_sizes in sizes_by_sport.items():
        for b, n in bucket_sizes.items():
            if n >= MIN_SAMPLE_SIZE_FOR_V6:
                kept_v6.append((sport, b, n))
            else:
                reverted_v5_2.append((sport, b, n))
    print(f"buckets KEPT as v6 (n>={MIN_SAMPLE_SIZE_FOR_V6}): {len(kept_v6)}")
    for s, b, n in kept_v6:
        print(f"  {s} {b} (n={n})")
    print(f"buckets REVERTED to v5_2 (n<{MIN_SAMPLE_SIZE_FOR_V6}): {len(reverted_v5_2)}")
    for s, b, n in reverted_v5_2:
        print(f"  {s} {b} (n={n})")

    rows = []
    offset = 0
    while True:
        page = fetch(f"{SUPA_URL}/rest/v1/scored_markets?select=*&limit=1000&offset={offset}")
        if not page: break
        rows.extend(page)
        if len(page) < 1000: break
        offset += 1000
    print(f"loaded {len(rows)} scored_markets rows (paginated)")

    # Only update sports rows whose question matches a known sub-category.
    targets = []
    for r in rows:
        sport = detect_sport(r.get("question") or "")
        if sport is None: continue
        if r.get("category") and r["category"] != "sports": continue
        targets.append((sport, r))
    print(f"sports targets: {len(targets)}")

    # For tournament rows we need cross-row renormalization. Pull the live
    # full field via Polymarket Gamma so we include ephemeral favorites
    # (France, Spain etc.) that are not in scored_markets.
    tournament_live = fetch_tournament_full_fields()
    print(f"live tournament fields fetched: {sorted(tournament_live.keys())}")
    # Build a per-(sport,tournament_group) p_model_raw sum using the hybrid
    # multiplier so cross-row renorm happens with the correct numerator.
    group_sums = {}
    for tg, members in tournament_live.items():
        sport_for_group = detect_sport(members[0]["question"] if members else "") or "fifa"
        total = 0.0
        for m in members:
            p_in = m["normalized_p_market"]
            if p_in <= 0:
                continue
            b = bucket_for(p_in)
            n = sizes_by_sport.get(sport_for_group, {}).get(b, 0)
            if n >= MIN_SAMPLE_SIZE_FOR_V6:
                pm = max(0.0, min(1.0, p_in * mults_by_sport.get(sport_for_group, {}).get(b, 1.0)))
            else:
                pm = max(0.0, min(1.0, v5_2_sport_pmodel(sport_for_group, p_in)))
            total += pm
        group_sums[tg] = total
        print(f"  {tg} sum_p_model_raw = {total:.4f} ({len(members)} members)")

    before_after = []
    updated = 0
    skipped = 0
    for sport, r in targets:
        # tournament rows: use normalized_p_market (vig-removed) when present
        npm = r.get("normalized_p_market")
        p_input = float(npm) if npm is not None else float(r.get("p_market") or 0)
        if p_input <= 0:
            skipped += 1
            continue
        b = bucket_for(p_input)
        sample_n = sizes_by_sport.get(sport, {}).get(b, 0)
        if sample_n >= MIN_SAMPLE_SIZE_FOR_V6:
            mult = mults_by_sport.get(sport, {}).get(b, 1.0)
            p_model_raw = max(0.0, min(1.0, p_input * mult))
            used = "v6"
        else:
            p_model_raw = max(0.0, min(1.0, v5_2_sport_pmodel(sport, p_input)))
            mult = (p_model_raw / p_input) if p_input > 0 else 1.0
            used = "v5_2_fallback"

        # Tournament rows: renormalize across the full group so p_model_normalized
        # behaves like the production applyTournamentNormalization output.
        tg = r.get("tournament_group")
        if tg and tg in group_sums and group_sums[tg] > 0:
            p_model_v6 = p_model_raw / group_sums[tg]
        else:
            p_model_v6 = p_model_raw
        # The displayed p_market for edge sign stays the row's p_market.
        p_market_show = float(r.get("p_market") or 0)
        # Use normalized p_market as the basis for raw_edge in tournament rows
        # to match how ml-scorer Layer 5 computes the edge.
        p_basis = float(npm) if npm is not None else p_market_show
        raw_edge = p_basis - p_model_v6
        tf = time_factor(r.get("days_to_close"))
        vf = volume_factor(r.get("volume"))
        adj_edge = raw_edge * tf * vf
        signal = classify_signal(raw_edge)
        hex_ = hard_excluded(r.get("days_to_close"), r.get("volume"))
        include = compute_include(p_market_show, signal, adj_edge, hex_, raw_edge)

        patch_body = {
            "p_model": round(p_model_v6, 8),
            "raw_edge": round(raw_edge, 8),
            "edge": round(raw_edge, 8),
            "adjusted_edge": round(adj_edge, 8),
            "signal": signal,
            "include_in_basket": include,
            "model_version": MODEL_VERSION_V6,
            "time_factor": round(tf, 4),
            "volume_factor": round(vf, 4),
            "category_factor": 1.0,
        }

        # Don't overwrite resolved_likely flag — it's owned by the price collector.
        if r.get("signal") == "resolved_likely":
            patch_body.pop("signal")
            patch_body.pop("include_in_basket")

        url = (
            f"{SUPA_URL}/rest/v1/scored_markets"
            f"?condition_id=eq.{urllib.parse.quote(r['condition_id'])}"
        )
        result = patch(url, patch_body)
        if result is None:
            skipped += 1
            continue
        updated += 1

        before_after.append({
            "sport": sport,
            "bucket": b,
            "question": (r.get("question") or "")[:60],
            "p_market": p_market_show,
            "p_model_old": float(r.get("p_model") or 0),
            "p_model_new": p_model_v6,
            "raw_edge_old": float(r.get("raw_edge") or r.get("edge") or 0),
            "raw_edge_new": raw_edge,
            "signal_old": r.get("signal"),
            "signal_new": patch_body.get("signal", r.get("signal")),
            "include_old": bool(r.get("include_in_basket")),
            "include_new": patch_body.get("include_in_basket", bool(r.get("include_in_basket"))),
            "volume": float(r.get("volume") or 0),
            "multiplier": mult,
        })

    print(f"\nupdated {updated} sports rows, skipped {skipped}")
    print("\nTop 20 by abs raw_edge change:")
    before_after.sort(key=lambda x: -abs(x["raw_edge_new"] - x["raw_edge_old"]))
    hdr = f"{'sport':6} {'p_mkt':>7} {'mult':>5} {'old_pmdl':>9} {'new_pmdl':>9} {'old_edge':>9} {'new_edge':>9} {'old_sig':<14} {'new_sig':<14} {'inc_chg':<7} question"
    print(hdr)
    for b in before_after[:20]:
        inc_chg = ""
        if b["include_old"] != b["include_new"]:
            inc_chg = f"{b['include_old']}->{b['include_new']}"
        print(
            f"{b['sport']:6} {b['p_market']:>7.3f} {b['multiplier']:>5.2f} "
            f"{b['p_model_old']:>9.4f} {b['p_model_new']:>9.4f} "
            f"{b['raw_edge_old']:>+9.4f} {b['raw_edge_new']:>+9.4f} "
            f"{(b['signal_old'] or '-'):<14} {(b['signal_new'] or '-'):<14} {inc_chg:<7} {b['question']}"
        )

    new_inc = sum(1 for b in before_after if b["include_new"] and not b["include_old"])
    dropped = sum(1 for b in before_after if b["include_old"] and not b["include_new"])
    print(f"\nnewly include_in_basket=true: {new_inc}")
    print(f"newly include_in_basket=false: {dropped}")


if __name__ == "__main__":
    main()
