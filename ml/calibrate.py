"""
Empirical calibration builder (calibration_v4_empirical).

Pulls resolved Polymarket markets from the Gamma API, parses each for a
clean binary YES/NO resolution + a usable pre-resolution price snapshot
(read directly from `lastTradePrice`), classifies by category +
sport-level subcategory, fits an isotonic regression per subcategory,
and writes calibration artifacts to ml/artifacts/.

Run from the Contra project root:

    python ml/calibrate.py

Data-shape notes from ml/debug.py (kept for next maintainer):
  * Gamma /markets `limit` is hard-capped at 100; we paginate by `offset`.
    Offset works up to ~10k; past that the endpoint returns an error
    string instead of a list.
  * `resolutionOutcome` and `resolvedOutcome` fields DO NOT EXIST.
    Resolution is read from `outcomePrices` (JSON-string of two floats):
    the side that ends up ≈1.0 won.
  * `outcomes` and `outcomePrices` are JSON STRINGS, not arrays.
  * `lastTradePrice` is the only direct price source on /markets. For
    most closed markets it is 0 (or exactly 1 for resolved-YES). Only a
    small fraction of markets have it in the usable (0.01, 0.99) range,
    which is the calibration signal we want.
  * The CLOB /prices-history endpoint returns empty history for these
    resolved markets — it is NOT a viable substitute.
"""

import os
import json
import time
from datetime import datetime, timezone

import requests
import pandas as pd
from sklearn.isotonic import IsotonicRegression

GAMMA_URL = "https://gamma-api.polymarket.com/markets"

# Lowest acceptable raw fetch volume for a market to be considered as a
# calibration data point — below this there is no real price discovery.
MIN_VOLUME = 1_000

# Snapshot price acceptance window. Below 0.01 or above 0.99 means the
# market was already resolved by the time `lastTradePrice` was sampled.
P_MARKET_MIN = 0.01
P_MARKET_MAX = 0.99

# Stop once we have this many usable rows.
TARGET_USABLE = 2500


def fetch_resolved_markets(target_markets=20000):
    """Paginate Gamma /markets via offset (limit is capped at 100 server-side)."""
    markets = []
    offset = 0
    limit = 100
    while offset < target_markets:
        params = {
            "closed": "true",
            "archived": "false",
            "limit": limit,
            "offset": offset,
        }
        try:
            r = requests.get(GAMMA_URL, params=params, timeout=30)
            print(f"  GET {r.url} -> status {r.status_code}")
            data = r.json()
            # Past ~offset 10000 the endpoint can return an error string
            # instead of a list — stop cleanly when that happens.
            if not isinstance(data, list) or len(data) == 0:
                print(f"  non-list/empty response at offset={offset}; stop")
                break
            print(f"  +{len(data)} markets (cumulative: {len(markets) + len(data)})")
            markets.extend(data)
            if len(data) < limit:
                break
            offset += limit
            time.sleep(0.3)
        except Exception as e:
            print(f"  error at offset={offset}: {e}")
            break
    return markets


def parse_one(m):
    """
    Apply the FIX-3 parser to a single market dict. Returns either
    a row dict, or None (and logs the skip reason in the caller's
    counter via the returned status string).

    Returns:
      ("ok", row_dict)   on success
      ("skip_<reason>", None | aux) on filter
    """
    # lastTradePrice — Gamma's only direct price field.
    ltp_raw = m.get("lastTradePrice")
    if ltp_raw in (None, "", "0", "0.0"):
        return "skip_no_ltp", None
    try:
        p_market = float(ltp_raw)
    except (TypeError, ValueError):
        return "skip_ltp_parse", None
    if not (P_MARKET_MIN <= p_market <= P_MARKET_MAX):
        # Outside the usable window: this market was already resolved
        # by the time lastTradePrice was sampled (or never traded).
        return "skip_ltp_range", p_market

    # Volume threshold.
    vol_raw = m.get("volumeNum")
    if vol_raw is None:
        vol_raw = m.get("volume")
    try:
        volume = float(vol_raw or 0)
    except (TypeError, ValueError):
        volume = 0.0
    if volume < MIN_VOLUME:
        return "skip_low_volume", volume

    # outcomes / outcomePrices — both are JSON strings.
    outcomes_raw = m.get("outcomes")
    prices_raw = m.get("outcomePrices")
    try:
        outcomes = json.loads(outcomes_raw) if isinstance(outcomes_raw, str) else outcomes_raw
        prices = json.loads(prices_raw) if isinstance(prices_raw, str) else prices_raw
    except Exception:
        return "skip_op_parse", None
    if not isinstance(outcomes, list) or outcomes[:2] != ["Yes", "No"]:
        return "skip_not_yesno", outcomes
    if not isinstance(prices, list) or len(prices) < 2:
        return "skip_op_shape", None
    try:
        p_yes_final = float(prices[0])
        p_no_final = float(prices[1])
    except (TypeError, ValueError):
        return "skip_op_floats", None

    # Clean binary resolution: one side ≈ 1, the other ≈ 0.
    if p_yes_final >= 0.99 and p_no_final <= 0.01:
        resolved_yes = 1
    elif p_yes_final <= 0.01 and p_no_final >= 0.99:
        resolved_yes = 0
    else:
        return "skip_ambiguous", (p_yes_final, p_no_final)

    return "ok", {
        "condition_id": m.get("conditionId", ""),
        "question": m.get("question", "") or "",
        "p_market": p_market,
        "resolved_yes": resolved_yes,
        "volume": volume,
        "end_date": m.get("endDate") or m.get("endDateIso") or "",
    }


def parse_markets(markets):
    """
    FIX-3 parser: lastTradePrice as p_market, no CLOB. Skips markets
    where lastTradePrice is missing / out-of-range / volume too low /
    resolution non-binary. Logs running tallies.
    """
    rows = []
    counts = {}
    for m in markets:
        status, row = parse_one(m)
        counts[status] = counts.get(status, 0) + 1
        if status == "ok" and isinstance(row, dict):
            rows.append(row)
            if len(rows) >= TARGET_USABLE:
                print(f"  hit TARGET_USABLE={TARGET_USABLE}, stopping early")
                break

    print(f"\nparse_markets done: {len(rows)} usable / {len(markets)} seen")
    print("status counts:")
    for s, c in sorted(counts.items(), key=lambda kv: -kv[1]):
        print(f"  {s}: {c}")
    return pd.DataFrame(rows)


def classify(question):
    q = (question or "").lower()

    # Sports subcategories
    if any(x in q for x in ['world cup', 'fifa', 'copa']):
        return 'sports', 'fifa_world_cup'
    if any(x in q for x in ['nba', 'nba finals', 'basketball']):
        return 'sports', 'nba'
    if any(x in q for x in ['stanley cup', 'nhl', 'hockey']):
        return 'sports', 'nhl'
    if any(x in q for x in ['super bowl', 'nfl', 'american football']):
        return 'sports', 'nfl'
    if any(x in q for x in ['world series', 'mlb', 'baseball']):
        return 'sports', 'mlb'
    if any(x in q for x in ['wimbledon', 'french open', 'us open', 'australian open',
                            'grand slam', 'atp', 'wta', 'tennis']):
        return 'sports', 'tennis_slam'
    if any(x in q for x in ['masters', 'pga', 'open championship', 'golf']):
        return 'sports', 'golf'
    if any(x in q for x in ['win', 'championship', 'tournament', 'league',
                            'season', 'playoff', 'finals', 'cup']):
        return 'sports', 'sports_other'

    # Politics subcategories
    if any(x in q for x in ['2028', 'presidential nomination', 'democratic nomination',
                            'republican nomination']):
        return 'politics', 'us_primary'
    if any(x in q for x in ['us presidential', '2024 presidential', '2028 presidential']):
        return 'politics', 'us_general'
    if any(x in q for x in ['governor', 'senate', 'congress', 'house rep']):
        return 'politics', 'us_state'
    if any(x in q for x in ['election', 'president', 'prime minister',
                            'parliament', 'vote', 'minister']):
        return 'politics', 'intl_election'

    # Macro
    if any(x in q for x in ['fed', 'federal reserve', 'rate cut', 'rate hike',
                            'inflation', 'gdp', 'recession', 'unemployment',
                            'interest rate', 'fomc', 'treasury']):
        return 'macro', 'macro'

    # Crypto
    if any(x in q for x in ['bitcoin', 'btc', 'ethereum', 'eth', 'crypto',
                            'blockchain', 'solana', 'token', 'defi', 'nft']):
        return 'crypto', 'crypto'

    return 'other', 'other'


def build_calibration(df_sub, name, min_samples=30):
    if len(df_sub) < min_samples:
        print(f"  {name}: only {len(df_sub)} samples, skipping regression")
        return None

    y = df_sub['resolved_yes'].values

    iso = IsotonicRegression(out_of_bounds='clip')
    iso.fit(df_sub['p_market'].values, y)

    bins = [0, 0.02, 0.05, 0.10, 0.15, 0.20, 0.30, 0.50, 1.01]
    labels = ['0-2', '2-5', '5-10', '10-15', '15-20', '20-30', '30-50', '50-100']
    df_sub = df_sub.copy()
    df_sub['bucket'] = pd.cut(df_sub['p_market'], bins=bins, labels=labels, right=False)

    bucket_stats = df_sub.groupby('bucket', observed=True).agg(
        n=('resolved_yes', 'count'),
        implied=('p_market', 'mean'),
        actual=('resolved_yes', 'mean'),
    ).reset_index()
    bucket_stats['edge'] = bucket_stats['implied'] - bucket_stats['actual']

    control_points = list(zip(
        iso.X_thresholds_.tolist(),
        iso.y_thresholds_.tolist(),
    ))

    result = {
        'name': name,
        'n_total': len(df_sub),
        'control_points': control_points,
        'bucket_stats': bucket_stats[bucket_stats['n'] >= 5].to_dict('records'),
        'min_p_model': float(iso.predict([0.0])[0]),
        'max_p_model': float(iso.predict([1.0])[0]),
    }

    print(f"  {name}: n={len(df_sub)}, buckets:")
    print(bucket_stats[bucket_stats['n'] >= 5][['bucket', 'n', 'implied', 'actual', 'edge']].to_string())
    print()

    return result


def main():
    os.makedirs('ml/artifacts', exist_ok=True)

    print("Fetching resolved markets from Polymarket Gamma...")
    markets = fetch_resolved_markets()
    print(f"Total raw markets pulled: {len(markets)}")

    print("\nParsing markets (lastTradePrice as p_market, no CLOB)...")
    df = parse_markets(markets)
    print(f"Total parsed with valid prices and outcomes: {len(df)}")

    df_longshot = df[df['p_market'] <= 0.50].copy()
    print(f"Markets with p_market <= 50%: {len(df_longshot)}")

    df_longshot[['category', 'subcategory']] = df_longshot['question'].apply(
        lambda q: pd.Series(classify(q))
    )

    print("\nCategory distribution:")
    print(df_longshot.groupby(['category', 'subcategory']).size().reset_index(name='count').to_string())
    print()

    print("=== OVERALL CALIBRATION ===")
    overall = build_calibration(df_longshot, 'overall', min_samples=50)

    calibrations = {'overall': overall}

    subcategories = df_longshot['subcategory'].unique()
    for sub in subcategories:
        df_sub = df_longshot[df_longshot['subcategory'] == sub]
        print(f"=== {sub.upper()} (n={len(df_sub)}) ===")
        result = build_calibration(df_sub, sub, min_samples=30)
        if result:
            calibrations[sub] = result

    output = {
        'version': 'calibration_v4_empirical',
        'generated_at': datetime.now(timezone.utc).isoformat(),
        'total_markets': int(len(df_longshot)),
        'calibrations': calibrations,
    }

    with open('ml/artifacts/calibration_by_category.json', 'w') as f:
        json.dump(output, f, indent=2, default=str)

    print("\nSaved to ml/artifacts/calibration_by_category.json")
    print(f"Categories with calibration: {list(calibrations.keys())}")


if __name__ == '__main__':
    main()
