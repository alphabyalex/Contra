"""
Phase 4 - broad market discovery pass.

Fetches top ~10k active Polymarket markets, filters out anything already
in tracked_markets, applies binary/range/days filters, scores through the
layered + (partial-v6) sports calibration, and inserts qualifying rows
into tracked_markets and scored_markets. Volume floor for include_in_basket
is MIN_VOLUME_USD (100k). Days window is 7-260 (matches Phase 2 cap).

Prints per-category insertion counts plus a focused list of Dec 31 2026
resolution markets and NFL futures discovered.

Read/write to Supabase via service key. No commits, no seeding.
"""

from __future__ import annotations

import json
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from typing import Dict, List, Optional, Tuple

SUPA = "https://ewtwooucdkrqlvynpmwx.supabase.co"
KEY = "sb_secret_cRt7hKpdQxRQe8kJoF4hvw_rKWCm4GJ"
GAMMA = "https://gamma-api.polymarket.com/markets"
UA = "ContraBot/0.1 (discovery)"

MIN_DAYS = 7
MAX_DAYS = 260
MIN_VOLUME_USD = 100_000
MIN_SAMPLE_SIZE_FOR_V6 = 25
MODEL_VERSION = "auto_discovery"

POL_KEYWORDS = ['election','president','congress','senate','vote','government','minister','party','nomination','primary','nominee','governor','mayoral','parliament','chancellor','prime']
MAC_KEYWORDS = ['fed','rate','inflation','gdp','recession','economy','unemployment','treasury','interest','monetary','fiscal','debt','deficit','tariff']
CRY_KEYWORDS = ['bitcoin','btc','ethereum','eth','crypto','blockchain','solana','token','defi','nft','altcoin','coinbase','binance']
SPT_KEYWORDS = ['win','championship','cup','tournament','league','playoff','football','basketball','baseball','hockey','soccer','tennis','fifa','world cup','nba','nfl','mlb','nhl','stanley','finals','super bowl','wimbledon','french open']
CUL_KEYWORDS = ['oscar','grammy','emmy','award','movie','film','music','actor','album','box office','eurovision']


def hdrs():
    return {"apikey": KEY, "Authorization": f"Bearer {KEY}", "Content-Type": "application/json", "Prefer": "return=representation"}


def classify_category(q: str) -> str:
    q = (q or "").lower()
    if re.search(r"\bnobel\b.*\bprize\b|\bnobel peace prize\b", q): return "other"
    counts = [
        ("politics", sum(1 for k in POL_KEYWORDS if k in q)),
        ("sports", sum(1 for k in SPT_KEYWORDS if k in q)),
        ("macro", sum(1 for k in MAC_KEYWORDS if k in q)),
        ("crypto", sum(1 for k in CRY_KEYWORDS if k in q)),
        ("culture", sum(1 for k in CUL_KEYWORDS if k in q)),
    ]
    counts.sort(key=lambda x: -x[1])
    if counts[0][1] == 0: return "other"
    return counts[0][0]


def detect_sport(q: str) -> Optional[str]:
    q = (q or "").lower()
    if re.search(r"\b(world cup|fifa)\b", q): return "fifa"
    if re.search(r"\b(nba|nba finals|western conference|eastern conference)\b", q): return "nba"
    if re.search(r"\b(stanley cup|nhl)\b", q): return "nhl"
    if re.search(r"\b(super bowl|nfl)\b", q): return "nfl"
    if re.search(r"\b(world series|mlb)\b", q): return "nhl"
    if re.search(r"\b(wimbledon|french open|us open|australian open)\b", q): return "tennis"
    return None


def is_range_market(q: str) -> bool:
    q = (q or "").lower()
    if "between" not in q: return False
    if " and " not in q and "&" not in q: return False
    return bool(re.search(r"[%$]|\d\s*[bt]\b", q))


def bucket_for(p: float) -> str:
    if p < 0.05: return "0-5"
    if p < 0.10: return "5-10"
    if p < 0.15: return "10-15"
    if p < 0.20: return "15-20"
    if p < 0.30: return "20-30"
    if p < 0.50: return "30-50"
    if p < 0.75: return "50-75"
    return "75+"


V5_2_TABLE = [
    (0.00, 0.02, 0.0017), (0.02, 0.05, 0.0081), (0.05, 0.10, 0.0174),
    (0.10, 0.15, 0.0212), (0.15, 0.20, 0.0932), (0.20, 0.30, 0.1140),
    (0.30, 0.50, 0.2523), (0.50, 0.70, 0.4681), (0.70, 0.80, 0.6460),
    (0.80, 0.90, 0.7712), (0.90, 1.01, 0.9182),
]


def v5_2_base_pmodel(p: float) -> float:
    for lo, hi, m in V5_2_TABLE:
        if lo <= p < hi: return m
    return V5_2_TABLE[-1][2]


def v5_2_sport_pmodel(sport: str, p: float) -> float:
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
    if sport == "nfl":
        if p > 0.08: return p * 0.78
        if p > 0.04: return p * 0.44
        return v5_2_base_pmodel(p) * 0.88
    if sport == "tennis":
        if p > 0.08: return p * 0.65
        if p > 0.04: return p * 0.32
        return v5_2_base_pmodel(p) * 0.80
    return v5_2_base_pmodel(p)


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


def classify_signal(raw_edge: float) -> str:
    if raw_edge is None: return "fair_value"
    if raw_edge > 0.05: return "strong_short"
    if raw_edge > 0.02: return "short"
    if raw_edge > 0.00: return "weak_short"
    if raw_edge >= -0.01: return "fair_value"
    if raw_edge > -0.05: return "long"
    return "strong_long"


def fetch_scored_ids() -> set:
    """Use scored_markets membership as the dedup key. tracked_markets may
    have entries that never got a scored row (auto-discovery first pass
    inserted there only when the FK constraint blew up)."""
    out = set()
    offset = 0
    while True:
        url = f"{SUPA}/rest/v1/scored_markets?select=condition_id&limit=1000&offset={offset}"
        req = urllib.request.Request(url, headers=hdrs())
        with urllib.request.urlopen(req, timeout=20) as resp:
            rows = json.loads(resp.read())
        if not rows: break
        for r in rows: out.add(r["condition_id"])
        if len(rows) < 1000: break
        offset += 1000
    return out


def fetch_tracked_ids() -> set:
    return fetch_scored_ids()


def fetch_all_active_gamma(max_pages: int = 100) -> List[dict]:
    out: List[dict] = []
    for page in range(max_pages):
        url = f"{GAMMA}?limit=100&offset={page*100}&active=true&closed=false"
        req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=20) as resp:
                batch = json.loads(resp.read())
        except urllib.error.HTTPError as e:
            print(f"  page {page} failed: {e}")
            break
        except Exception as e:
            print(f"  page {page} failed: {e}")
            break
        if not batch:
            break
        out.extend(batch)
        if len(batch) < 100:
            break
        time.sleep(0.15)
    return out


def parse_outcomes(s) -> List[str]:
    if isinstance(s, list): return [str(x) for x in s]
    if not s: return []
    try:
        v = json.loads(s)
        return [str(x) for x in v] if isinstance(v, list) else []
    except Exception:
        return []


def parse_prices(s) -> List[float]:
    items = parse_outcomes(s)
    out = []
    for x in items:
        try:
            out.append(float(x))
        except Exception:
            pass
    return out


def days_to_close(end_iso: Optional[str]) -> Optional[int]:
    if not end_iso: return None
    try:
        dt = datetime.fromisoformat(end_iso.replace("Z", "+00:00"))
    except Exception:
        return None
    delta = dt - datetime.now(timezone.utc)
    return max(0, int(delta.total_seconds() // 86400))


def fetch_v6() -> Tuple[dict, dict]:
    p = "C:/Users/alexs/OneDrive/Desktop/Homework USC/Personal Coding/Contra/ml/artifacts/calibration_v6.json"
    j = json.load(open(p, encoding="utf-8"))
    return j["sports"], j["bucket_sample_sizes"]


def get_p_model(category: str, sport: Optional[str], p: float, v6_mults: dict, v6_sizes: dict) -> float:
    if category == "sports" and sport:
        b = bucket_for(p)
        n = v6_sizes.get(sport, {}).get(b, 0)
        if n >= MIN_SAMPLE_SIZE_FOR_V6:
            return max(0.0, min(1.0, p * v6_mults.get(sport, {}).get(b, 1.0)))
        return max(0.0, min(1.0, v5_2_sport_pmodel(sport, p)))
    return v5_2_base_pmodel(p)


def upsert_screened(rows: List[dict]) -> int:
    if not rows: return 0
    url = f"{SUPA}/rest/v1/screened_markets"
    body = json.dumps(rows).encode()
    h = {**hdrs(), "Prefer": "resolution=merge-duplicates,return=minimal"}
    req = urllib.request.Request(url, data=body, headers=h, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return len(rows)
    except urllib.error.HTTPError as e:
        print(f"  screened upsert error: {e.read().decode('utf-8', 'ignore')[:300]}")
        return 0


def upsert_tracked(rows: List[dict]) -> int:
    if not rows: return 0
    url = f"{SUPA}/rest/v1/tracked_markets"
    body = json.dumps(rows).encode()
    h = {**hdrs(), "Prefer": "resolution=merge-duplicates,return=minimal"}
    req = urllib.request.Request(url, data=body, headers=h, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return len(rows)
    except urllib.error.HTTPError as e:
        print(f"  tracked upsert error: {e.read().decode('utf-8', 'ignore')[:300]}")
        return 0


def upsert_scored(rows: List[dict]) -> int:
    if not rows: return 0
    url = f"{SUPA}/rest/v1/scored_markets"
    body = json.dumps(rows).encode()
    h = {**hdrs(), "Prefer": "resolution=merge-duplicates,return=minimal"}
    req = urllib.request.Request(url, data=body, headers=h, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return len(rows)
    except urllib.error.HTTPError as e:
        print(f"  scored upsert error: {e.read().decode('utf-8', 'ignore')[:300]}")
        return 0


def main():
    v6_mults, v6_sizes = fetch_v6()
    print(f"loaded calibration_v6 partial multipliers")

    tracked_ids = fetch_tracked_ids()
    print(f"already in tracked_markets: {len(tracked_ids)}")

    raw = fetch_all_active_gamma()
    print(f"fetched {len(raw)} raw active Polymarket markets")

    candidates = []
    skipped = {"already_tracked": 0, "non_binary": 0, "range_or_bracket": 0, "days_oob": 0, "no_price": 0, "no_volume": 0}
    for m in raw:
        cid = m.get("conditionId")
        if not cid: continue
        if cid in tracked_ids:
            skipped["already_tracked"] += 1; continue
        outcomes = parse_outcomes(m.get("outcomes"))
        prices = parse_prices(m.get("outcomePrices"))
        if len(outcomes) != 2 or len(prices) != 2:
            skipped["non_binary"] += 1; continue
        question = m.get("question") or ""
        if is_range_market(question):
            skipped["range_or_bracket"] += 1; continue
        # Pick YES side price
        try:
            yes_idx = outcomes.index("Yes") if "Yes" in outcomes else 0
        except Exception:
            yes_idx = 0
        p_yes = prices[yes_idx]
        if not (0 < p_yes < 1):
            skipped["no_price"] += 1; continue
        end_iso = m.get("endDate") or m.get("endDateIso")
        d = days_to_close(end_iso)
        if d is None or d < MIN_DAYS or d > MAX_DAYS:
            skipped["days_oob"] += 1; continue
        vol = m.get("volumeNum") or m.get("volumeClob") or m.get("volume") or m.get("volume24hr") or 0
        try:
            vol_f = float(vol)
        except Exception:
            vol_f = 0.0
        if vol_f <= 0:
            skipped["no_volume"] += 1; continue
        tokens = parse_outcomes(m.get("clobTokenIds"))
        token_id = tokens[yes_idx] if yes_idx < len(tokens) else None
        candidates.append({
            "cid": cid,
            "question": question,
            "p_yes": p_yes,
            "volume": vol_f,
            "days_to_close": d,
            "end_iso": end_iso,
            "token_id": token_id,
        })

    print(f"qualifying candidates: {len(candidates)}")
    print(f"  skipped: {skipped}")

    # Score each candidate.
    tracked_rows = []
    scored_rows = []
    screened_rows = []
    by_cat_added = {"politics": 0, "macro": 0, "crypto": 0, "sports": 0, "culture": 0, "other": 0}
    dec_31_2026 = []
    nfl_futures = []

    for c in candidates:
        q = c["question"]
        cat = classify_category(q)
        sport = detect_sport(q) if cat == "sports" else None
        p = c["p_yes"]
        p_model = get_p_model(cat, sport, p, v6_mults, v6_sizes)
        raw_edge = p - p_model
        tf = time_factor(c["days_to_close"])
        vf = volume_factor(c["volume"])
        adj = raw_edge * tf * vf
        sig = classify_signal(raw_edge)
        hard_excluded = c["days_to_close"] < 3 or c["days_to_close"] > MAX_DAYS or c["volume"] < MIN_VOLUME_USD
        inc_short = (not hard_excluded) and adj >= 0.03 and 0.02 <= p <= 0.12
        inc_long = (not hard_excluded) and sig in ("long", "strong_long") and 0.05 <= p <= 0.35
        include = inc_short or inc_long

        screened_rows.append({
            "condition_id": c["cid"],
            "source": "polymarket",
            "question": q,
            "p_market": round(p, 8),
            "impossible": False,
            "already_resolved": False,
            "ambiguous": False,
            "excluded": False,
            "exclusion_reason": None,
            "screening_model": "auto_discovery",
        })
        tracked_rows.append({
            "condition_id": c["cid"],
            "source": "polymarket",
            "question": q,
            "token_id": c["token_id"],
            "category": cat,
            "p_market_initial": round(p, 8),
            "p_model_initial": round(p_model, 8),
            "edge_initial": round(raw_edge, 8),
            "resolution_date": c["end_iso"],
            "in_basket": False,
            "outcome": None,
            "resolved_at": None,
        })
        scored_rows.append({
            "condition_id": c["cid"],
            "source": "polymarket",
            "question": q,
            "p_market": round(p, 8),
            "p_model": round(p_model, 8),
            "edge": round(raw_edge, 8),
            "raw_edge": round(raw_edge, 8),
            "adjusted_edge": round(adj, 8),
            "signal": sig,
            "volume": round(c["volume"], 2),
            "days_to_close": c["days_to_close"],
            "category": cat,
            "include_in_basket": include,
            "model_version": MODEL_VERSION,
            "impossible_edge": False,
            "time_factor": round(tf, 4),
            "category_factor": 1.0,
            "volume_factor": round(vf, 4),
            "momentum_factor": 1.0,
            "tournament_group": None,
            "is_tournament_market": False,
            "normalized_p_market": None,
            "is_favorite": False,
        })
        by_cat_added[cat] = by_cat_added.get(cat, 0) + 1

        if re.search(r"by\s+(?:dec(?:ember)?\s+31,?\s+)?2026|end\s+of\s+2026", q, re.I):
            dec_31_2026.append((q[:80], p, c["volume"], sig, c["days_to_close"], include))
        if re.search(r"super\s+bowl|nfl\s+(?:nfc|afc|league\s+championship|conference)", q, re.I):
            nfl_futures.append((q[:80], p, c["volume"], sig, c["days_to_close"], include))

    # Insert in batches of 50. screened FIRST (scored_markets has a FK to it).
    print(f"\ninserting {len(screened_rows)} screened + tracked + scored rows in batches...")
    inserted_sc = 0
    inserted_t = 0
    inserted_s = 0
    for i in range(0, len(tracked_rows), 50):
        inserted_sc += upsert_screened(screened_rows[i:i+50])
        inserted_t += upsert_tracked(tracked_rows[i:i+50])
        inserted_s += upsert_scored(scored_rows[i:i+50])
    print(f"upserted screened: {inserted_sc}, tracked: {inserted_t}, scored: {inserted_s}")
    print(f"by category: {by_cat_added}")

    print(f"\nDec 31 2026 resolution markets found: {len(dec_31_2026)}")
    for q, p, v, s, d, inc in sorted(dec_31_2026, key=lambda x: -x[2])[:15]:
        print(f"  {('[INC]' if inc else '     '):5} p={p:.3f} vol=${v:>12,.0f} d={d:>3} sig={s:<13}  {q}")

    print(f"\nNFL futures found: {len(nfl_futures)}")
    for q, p, v, s, d, inc in sorted(nfl_futures, key=lambda x: -x[2])[:15]:
        print(f"  {('[INC]' if inc else '     '):5} p={p:.3f} vol=${v:>12,.0f} d={d:>3} sig={s:<13}  {q}")


if __name__ == "__main__":
    main()
