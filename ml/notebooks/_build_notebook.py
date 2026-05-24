"""
Build sports_regression.ipynb from sports_regression.py + the latest execution
output. Run after sports_regression.py to keep the notebook in sync.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
PY = os.path.join(HERE, "sports_regression.py")
NB = os.path.join(HERE, "sports_regression.ipynb")


def code(src: str, outputs=None):
    return {
        "cell_type": "code",
        "execution_count": None,
        "metadata": {},
        "outputs": outputs or [],
        "source": src.splitlines(keepends=True),
    }


def markdown(text: str):
    return {
        "cell_type": "markdown",
        "metadata": {},
        "source": text.splitlines(keepends=True),
    }


def text_output(stream_text: str):
    return [{
        "output_type": "stream",
        "name": "stdout",
        "text": stream_text.splitlines(keepends=True),
    }]


def run_script() -> str:
    res = subprocess.run([sys.executable, PY], capture_output=True, text=True)
    return res.stdout + ("\n[stderr]\n" + res.stderr if res.returncode != 0 else "")


def main():
    captured = run_script()

    # Split captured output by section headers.
    parts = {"3A": "", "3B": "", "3C": "", "3D": "", "3E": ""}
    current = None
    for line in captured.splitlines(keepends=True):
        if "3A." in line:
            current = "3A"
        elif "3B." in line:
            current = "3B"
        elif "3C." in line:
            current = "3C"
        elif "3D." in line:
            current = "3D"
        elif "3E." in line:
            current = "3E"
        if current:
            parts[current] += line

    cells = [
        markdown("# Sports Regression - calibration_v6\n\nBuilds per-sport, per-bucket probability multipliers from 599 historical samples (FIFA World Cup 1998-2022, NBA Finals 2010-2024, NHL Stanley Cup 2010-2024, Super Bowl 2010-2024, Wimbledon mens + womens 2015-2024).\n\nLogic mirrors `sports_regression.py` cell-by-cell.\n"),
        markdown("## Imports + setup\n"),
        code(
            "import json, os\n"
            "import numpy as np\n"
            "import pandas as pd\n"
            "from sklearn.linear_model import LogisticRegression\n"
            "from sklearn.metrics import brier_score_loss\n"
            "from sports_regression import (\n"
            "    BUCKET_LABELS, BUCKET_EDGES, label_bucket,\n"
            "    load, calibration_table, brier_per_sport,\n"
            "    logistic_per_sport, multipliers,\n"
            "    apply_to_current, write_calibration,\n"
            ")\n"
            "df = load()\n"
            "print('rows:', len(df), 'sports:', sorted(df.sport.unique()))\n"
        ),
        markdown("## 3A - Calibration curves per sport\n\nFor each (sport, bucket) we count markets, count wins, compute the actual win rate, and compare to the bucket's average implied probability. `multiplier = actual_win_rate / avg_implied_prob` summarises the bias.\n"),
        code("calib = calibration_table(df)\nprint(calib.to_string(index=False, float_format=lambda x: f'{x:.4f}'))\n",
             text_output(parts["3A"])),
        code("brier = brier_per_sport(df)\nprint(brier.to_string(index=False, float_format=lambda x: f'{x:.4f}'))\n"),
        markdown("## 3B - Logistic regression per sport\n\nFeatures: `implied_prob`, `implied_prob^2`, `log(implied_prob)`. 80/20 chronological split. Reports OOS Brier with a 200-iteration bootstrap CI95.\n"),
        code("log_models = logistic_per_sport(df)\nfor s, info in log_models.items():\n    print(s)\n    for k, v in info.items():\n        print(f'  {k}: {v}')\n",
             text_output(parts["3B"])),
        markdown("## 3C - Derived multipliers per probability bucket\n\nLaplace smoothing (alpha=1) shrinks each cell's actual win rate toward the global per-bucket prior. Multipliers clamped to `[0.05, 2.0]` so a 1-of-1 cell does not produce a 10x estimate.\n"),
        code("mults = multipliers(df)\nfor sport in sorted(mults):\n    row = mults[sport]\n    print(sport.ljust(10), ' '.join(f'{row[b]:7.3f}' for b in BUCKET_LABELS))\n",
             text_output(parts["3C"])),
        markdown("## 3D - Apply v6 multipliers to current 2026 tournament markets\n\nPulls live Polymarket prices via the running scanner API (`localhost:3001`). Each team's `p_market` is mapped to its bucket; multiplier produces a v6 `p_model`; `raw_edge = p_market - p_model_v6`. Positive edges are SHORT candidates, negative are LONG.\n"),
        code("current = apply_to_current(mults)\nimport collections\nby_tour = collections.defaultdict(list)\nfor r in current:\n    by_tour[r['tournament']].append(r)\nfor tour in sorted(by_tour):\n    print(tour)\n    rows = sorted(by_tour[tour], key=lambda x: -x['raw_edge_v6'])\n    for r in rows[:15]:\n        side = 'SHORT' if r['raw_edge_v6'] > 0.01 else ('LONG' if r['raw_edge_v6'] < -0.01 else 'FAIR')\n        print(f\"  {side:<5} p={r['p_market']:.3f} mult={r['multiplier_v6']:.3f} p_model={r['p_model_v6']:.3f} edge={r['raw_edge_v6']:+.4f}  {r['question'][:80]}\")\n",
             text_output(parts["3D"])),
        markdown("## 3E - Write calibration_v6.json\n"),
        code("out = write_calibration(mults, {s: int(len(g)) for s, g in df.groupby('sport')}, log_models, calib)\nprint('wrote', out)\n",
             text_output(parts["3E"])),
    ]

    nb = {
        "cells": cells,
        "metadata": {
            "kernelspec": {"display_name": "Python 3", "language": "python", "name": "python3"},
            "language_info": {"name": "python", "version": "3.10"},
        },
        "nbformat": 4,
        "nbformat_minor": 5,
    }
    with open(NB, "w", encoding="utf-8") as f:
        json.dump(nb, f, indent=1)
    print(f"wrote {NB}")


if __name__ == "__main__":
    main()
