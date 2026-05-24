"""
Sports calibration regression for calibration_v6.

Mirrors ml/notebooks/sports_regression.ipynb cell-by-cell so we can execute
deterministically from the command line. Reads ml/data/sports_historical.csv,
writes ml/artifacts/calibration_v6.json and a handful of PNG plots into
ml/artifacts/. The notebook file imports * from this script so the two stay
in sync.

Sections (matching the user spec):
  3A  calibration curves per sport
  3B  logistic regression per sport
  3C  derive calibration multipliers per probability bucket
  3D  apply to current 2026 tournament markets, rank shorts vs longs
  3E  write calibration_v6.json
"""

from __future__ import annotations

import json
import os
import sys
from datetime import datetime, timezone
from typing import Dict, List, Tuple

import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import brier_score_loss

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
DATA = os.path.join(ROOT, "ml", "data", "sports_historical.csv")
ARTIFACTS = os.path.join(ROOT, "ml", "artifacts")
os.makedirs(ARTIFACTS, exist_ok=True)

# Buckets per spec.
BUCKET_EDGES = [0.0, 0.05, 0.10, 0.15, 0.20, 0.30, 0.50, 0.75, 1.0]
BUCKET_LABELS = ["0-5", "5-10", "10-15", "15-20", "20-30", "30-50", "50-75", "75+"]


def label_bucket(p: float) -> str:
    for i in range(len(BUCKET_EDGES) - 1):
        lo, hi = BUCKET_EDGES[i], BUCKET_EDGES[i + 1]
        # last bucket inclusive of 1.0
        if (p >= lo and p < hi) or (i == len(BUCKET_LABELS) - 1 and p <= 1.0 and p >= lo):
            return BUCKET_LABELS[i]
    return BUCKET_LABELS[-1]


# -----------------------------------------------------------------------------
# Load
# -----------------------------------------------------------------------------

def load() -> pd.DataFrame:
    df = pd.read_csv(DATA)
    df["bucket"] = df["implied_prob"].apply(label_bucket)
    return df


# -----------------------------------------------------------------------------
# 3A  Calibration curves per sport
# -----------------------------------------------------------------------------

def calibration_table(df: pd.DataFrame) -> pd.DataFrame:
    rows = []
    for sport, sub in df.groupby("sport"):
        for label in BUCKET_LABELS:
            members = sub[sub["bucket"] == label]
            n = len(members)
            wins = int(members["outcome"].sum())
            avg_p = float(members["implied_prob"].mean()) if n else float("nan")
            actual = wins / n if n else float("nan")
            mult = actual / avg_p if avg_p and not np.isnan(actual) else float("nan")
            rows.append({
                "sport": sport, "bucket": label, "n": n, "wins": wins,
                "avg_implied_prob": avg_p, "actual_win_rate": actual,
                "multiplier": mult,
            })
    return pd.DataFrame(rows)


def brier_per_sport(df: pd.DataFrame) -> pd.DataFrame:
    rows = []
    for sport, sub in df.groupby("sport"):
        if len(sub) == 0:
            continue
        # model prediction = implied_prob (the "market" baseline)
        b_market = brier_score_loss(sub["outcome"], sub["implied_prob"])
        # naive = field-base-rate baseline (1 / N teams per tournament)
        sizes = sub.groupby(["tournament", "year"])["outcome"].transform("size")
        sub_base = 1.0 / sizes
        b_naive = brier_score_loss(sub["outcome"], sub_base)
        rows.append({"sport": sport, "n": len(sub),
                     "brier_market": b_market, "brier_field_base_rate": b_naive,
                     "skill_vs_baseline": b_naive - b_market})
    return pd.DataFrame(rows)


# -----------------------------------------------------------------------------
# 3B  Logistic regression per sport
# -----------------------------------------------------------------------------

def logistic_per_sport(df: pd.DataFrame) -> Dict[str, dict]:
    out: Dict[str, dict] = {}
    for sport, sub in df.groupby("sport"):
        sub = sub.sort_values(["year"]).reset_index(drop=True)
        if len(sub) < 30:
            out[sport] = {"error": "too few rows"}
            continue
        cut = int(0.8 * len(sub))
        train = sub.iloc[:cut]
        test = sub.iloc[cut:]
        # features
        def featurize(s: pd.DataFrame) -> np.ndarray:
            p = s["implied_prob"].clip(1e-6, 1 - 1e-6).to_numpy()
            return np.stack([p, p ** 2, np.log(p)], axis=1)
        X_train, y_train = featurize(train), train["outcome"].to_numpy()
        X_test, y_test = featurize(test), test["outcome"].to_numpy()
        model = LogisticRegression(max_iter=2000)
        try:
            model.fit(X_train, y_train)
        except Exception as e:
            out[sport] = {"error": str(e)}
            continue
        p_pred = model.predict_proba(X_test)[:, 1]
        brier = float(brier_score_loss(y_test, p_pred))
        # rough 95% CI via bootstrap on test set
        rng = np.random.default_rng(42)
        bs = []
        for _ in range(200):
            idx = rng.integers(0, len(y_test), len(y_test))
            try:
                bs.append(brier_score_loss(y_test[idx], p_pred[idx]))
            except Exception:
                pass
        ci_low, ci_high = (float(np.percentile(bs, 2.5)), float(np.percentile(bs, 97.5))) if bs else (None, None)
        out[sport] = {
            "n_train": int(len(train)),
            "n_test": int(len(test)),
            "coef_p": float(model.coef_[0][0]),
            "coef_p_squared": float(model.coef_[0][1]),
            "coef_log_p": float(model.coef_[0][2]),
            "intercept": float(model.intercept_[0]),
            "brier_oos": brier,
            "brier_oos_ci95": [ci_low, ci_high],
        }
    return out


# -----------------------------------------------------------------------------
# 3C  Derived multipliers per bucket per sport (with Laplace smoothing so
# under-sampled buckets do not collapse to 0).
# -----------------------------------------------------------------------------

def multipliers(df: pd.DataFrame, smoothing: float = 1.0) -> Dict[str, Dict[str, float]]:
    out: Dict[str, Dict[str, float]] = {}
    # Global per-bucket actual win rate as the shrinkage target.
    overall_actual = {}
    for label in BUCKET_LABELS:
        m = df[df["bucket"] == label]
        if len(m):
            overall_actual[label] = float(m["outcome"].mean())
        else:
            overall_actual[label] = float("nan")

    for sport, sub in df.groupby("sport"):
        bucket_map: Dict[str, float] = {}
        for label in BUCKET_LABELS:
            m = sub[sub["bucket"] == label]
            n = len(m)
            wins = int(m["outcome"].sum())
            avg_p = float(m["implied_prob"].mean()) if n else float("nan")
            target = overall_actual.get(label, np.nan)
            if n == 0 or np.isnan(avg_p):
                bucket_map[label] = 1.0
                continue
            # Laplace-smoothed actual win rate with global bucket as prior
            smoothed = (wins + smoothing * target * 10) / (n + smoothing * 10) if not np.isnan(target) else wins / n
            mult = smoothed / avg_p
            # Clamp to a sane range; we never want a multiplier > 2 or < 0.05.
            mult = float(max(0.05, min(2.0, mult)))
            bucket_map[label] = mult
        out[sport] = bucket_map
    return out


# -----------------------------------------------------------------------------
# 3D  Apply derived multipliers to current 2026 tournament markets
# -----------------------------------------------------------------------------

def apply_to_current(mults: Dict[str, Dict[str, float]]) -> List[dict]:
    """Pull live scanner rows for FIFA / NBA / NHL 2026 and rank using v6 multipliers."""
    import urllib.request
    try:
        with urllib.request.urlopen("http://localhost:3001/api/scanner/markets?search=will&limit=2000", timeout=10) as resp:
            data = json.loads(resp.read())
    except Exception as e:
        print(f"[3D] scanner fetch failed: {e}")
        return []
    rows = data.get("rows", [])
    out = []
    for r in rows:
        q = (r.get("question") or "").lower()
        if "fifa world cup" in q or "world cup" in q:
            sport = "fifa"
            tour = "2026 FIFA World Cup"
        elif "nba finals" in q or "western conference" in q or "eastern conference" in q:
            sport = "nba"
            tour = "2026 NBA Finals"
        elif "stanley cup" in q or "nhl" in q:
            sport = "nhl"
            tour = "2026 NHL Stanley Cup"
        else:
            continue
        p = r.get("p_market") or 0
        if not isinstance(p, (int, float)) or p <= 0:
            continue
        label = label_bucket(p)
        mult = mults.get(sport, {}).get(label, 1.0)
        p_model_v6 = float(min(1.0, max(0.0, p * mult)))
        raw_edge_v6 = p - p_model_v6
        out.append({
            "sport": sport, "tournament": tour, "question": r.get("question"),
            "p_market": float(p), "bucket": label, "multiplier_v6": mult,
            "p_model_v6": p_model_v6, "raw_edge_v6": raw_edge_v6,
            "volume": float(r.get("volume") or 0),
            "days_to_close": r.get("days_to_close"),
            "condition_id": r.get("condition_id"),
        })
    return out


# -----------------------------------------------------------------------------
# 3E  Write calibration_v6.json
# -----------------------------------------------------------------------------

def write_calibration(mults: Dict[str, Dict[str, float]], sample_sizes: Dict[str, int],
                      log_models: Dict[str, dict], calib_table: pd.DataFrame) -> str:
    payload = {
        "version": "v6",
        "buckets": BUCKET_LABELS,
        "bucket_edges": BUCKET_EDGES,
        "sports": mults,
        "logistic": log_models,
        "sample_sizes": sample_sizes,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "notes": "Multipliers derived from 599 historical samples (FIFA 1998-2022, NBA/NHL/NFL 2010-2024, Wimbledon mens+womens 2015-2024). Laplace smoothing alpha=1 against global per-bucket prior. Multipliers clamped to [0.05, 2.0].",
        "calibration_table": calib_table.to_dict(orient="records"),
    }
    out = os.path.join(ARTIFACTS, "calibration_v6.json")
    with open(out, "w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2)
    return out


# -----------------------------------------------------------------------------
# Main
# -----------------------------------------------------------------------------

def main() -> None:
    print("=" * 80)
    print("3A. Calibration curves per sport")
    print("=" * 80)
    df = load()
    calib = calibration_table(df)
    print(calib.to_string(index=False, float_format=lambda x: f"{x:.4f}"))
    print()
    print("Brier per sport:")
    print(brier_per_sport(df).to_string(index=False, float_format=lambda x: f"{x:.4f}"))
    print()

    print("=" * 80)
    print("3B. Logistic regression per sport (80/20 chronological split)")
    print("=" * 80)
    log_models = logistic_per_sport(df)
    for sport, info in log_models.items():
        print(f"  {sport}:")
        for k, v in info.items():
            print(f"    {k}: {v}")
    print()

    print("=" * 80)
    print("3C. Derived multipliers per bucket (Laplace alpha=1, clamped [0.05, 2.0])")
    print("=" * 80)
    mults = multipliers(df)
    print(f"{'sport':10}", " ".join(f"{b:>7}" for b in BUCKET_LABELS))
    for sport in sorted(mults):
        row = mults[sport]
        print(f"{sport:10}", " ".join(f"{row[b]:7.3f}" for b in BUCKET_LABELS))
    print()

    print("=" * 80)
    print("3D. Apply v6 multipliers to current 2026 tournament markets")
    print("=" * 80)
    current = apply_to_current(mults)
    by_tour: Dict[str, List[dict]] = {}
    for r in current:
        by_tour.setdefault(r["tournament"], []).append(r)
    for tour in sorted(by_tour):
        rows = sorted(by_tour[tour], key=lambda x: -x["raw_edge_v6"])
        print(f"\n{tour} ({len(rows)} teams)")
        print(f"  {'side':<5} {'p_mkt':>7} {'bucket':>7} {'mult':>6} {'p_mdl':>7} {'edge':>8} {'vol':>13}  question")
        for r in rows:
            side = "SHORT" if r["raw_edge_v6"] > 0.01 else ("LONG" if r["raw_edge_v6"] < -0.01 else "FAIR")
            print(f"  {side:<5} {r['p_market']:>7.3f} {r['bucket']:>7} {r['multiplier_v6']:>6.3f} {r['p_model_v6']:>7.3f} {r['raw_edge_v6']:>+8.4f} {r['volume']:>13,.0f}  {r['question'][:80]}")

    print()
    print("=" * 80)
    print("3E. Write calibration_v6.json")
    print("=" * 80)
    sample_sizes = {sport: int(len(sub)) for sport, sub in df.groupby("sport")}
    out = write_calibration(mults, sample_sizes, log_models, calib)
    print(f"wrote {out}")


if __name__ == "__main__":
    main()
