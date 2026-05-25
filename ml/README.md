# Contra ML Pipeline

## Overview

This pipeline scores prediction market contracts for mispricing by comparing implied probabilities to historically calibrated fair value estimates. The calibration exploits the longshot bias documented in academic literature: low-probability outcomes systematically resolve at lower rates than their market price implies. The output is a per-market `p_model`, `raw_edge`, and signal classification that drives basket construction and scanner ranking.

## Background: Longshot Bias

Prediction markets, like racetrack and sports betting markets, systematically overprice low-probability outcomes and underprice high-probability outcomes. Thaler and Ziemba (1988, *Journal of Economic Perspectives*, "Anomalies: Parimutuel Betting Markets: Racetracks and Lotteries") documented the pattern in horse racing. Snowberg and Wolfers (2010, *Journal of Political Economy*, "Explaining the Favorite-Longshot Bias: Is it Risk-Love or Misperceptions?") provided a structural explanation across multiple market types. This pipeline quantifies the bias empirically on prediction market data and converts it into trading signals.

## Data Sources

### `ml/data/sports_historical.csv`

- 721 rows of historical pre-tournament implied probabilities and outcomes.
- Covers FIFA World Cup (1998-2022), UEFA Euro (2008-2024), Copa America (2015-2024), NBA Finals (2010-2024), NHL Stanley Cup (2010-2024), NFL Super Bowl (2010-2024), Wimbledon and French Open men's and women's (2015-2024).
- Columns: `sport`, `tournament`, `year`, `team_player`, `decimal_odds`, `implied_prob_raw`, `implied_prob`, `outcome` (1 = winner, 0 = did not win).
- Implied probabilities are derived from pre-tournament consensus decimal odds. Vig is removed via per-tournament renormalization so that the field probabilities sum to ~1.0.
- Source: public historical odds records (Wikipedia, contemporaneous press archives, archived bookmaker boards).

### `ml/data/fetch_historical.py`

- Script that constructs `sports_historical.csv` from hardcoded historical odds data embedded in the file.
- Run this to regenerate the dataset.

### Polymarket resolved markets (4,310 markets)

Used to build the base calibration table that maps implied probability buckets to true resolution rates. This raw dataset is not included in the repo. The derived calibration values are encoded in `backend/src/services/ml-scorer.ts` as the `CALIBRATION_TABLE` constant.

## Pipeline Components

### `ml/notebooks/sports_regression.py`

- Loads `sports_historical.csv`.
- Bins implied probabilities into eight buckets: 0-5%, 5-10%, 10-15%, 15-20%, 20-30%, 30-50%, 50-75%, 75%+.
- Computes the actual win rate per bucket per sport (calibration curves).
- Fits a logistic regression per sport with three features: `implied_prob`, `implied_prob^2`, `log(implied_prob)`. Target is the binary outcome.
- Train/test split is 80/20 chronological to avoid data leakage from future tournaments back into earlier model fits.
- Reports out-of-sample Brier score on the held-out test set, with a 200-iteration bootstrap 95% confidence interval, alongside a naive field-base-rate baseline.
- Derives a per-bucket calibration multiplier: `multiplier = actual_win_rate / avg_implied_prob`. Laplace smoothing (alpha = 1) shrinks each cell toward the global per-bucket prior so an under-sampled bucket cannot produce an extreme multiplier from a single observation.
- Applies a minimum sample size gate: only buckets with `n >= 25` observations use the data-derived multiplier. Smaller buckets fall back to the v5_2 hand-tuned sport tiers in `ml-scorer.ts`.
- Writes the artifact to `ml/artifacts/calibration_v6.json`.

### `ml/notebooks/sports_regression.ipynb`

- Jupyter notebook version of the script with captured outputs: calibration curve tables, Brier score comparisons, logistic regression coefficients, derived multiplier matrix, and the 2026 tournament rescore table.
- Open with:
  ```bash
  jupyter notebook ml/notebooks/sports_regression.ipynb
  ```

### `ml/notebooks/rescore_sports_v6.py`

- Loads `calibration_v6.json` and the embedded `bucket_sample_sizes` table.
- Pulls all sports rows from the live `scored_markets` table in Supabase (paginated, no row limit).
- For each row, classifies the sport (`fifa`, `nba`, `nhl`, `nfl`, `tennis`), buckets the price, applies either the v6 multiplier or the v5_2 fallback depending on whether the bucket meets the 25-sample gate.
- For tournament rows, performs the same cross-row renormalization as the production code in `ml-scorer.ts`: sum p_model across the group, divide each member by the sum, recompute `raw_edge = normalized_p_market - p_model_normalized`.
- Recomputes `time_factor`, `volume_factor`, `adjusted_edge`, `signal`, and `include_in_basket` to match the post-Phase-4 inclusion gate (admits long candidates with `raw_edge < -0.005` in addition to the original short gate).
- PATCHes each row back to Supabase via the PostgREST endpoint.
- Requires `SUPABASE_URL` and `SUPABASE_SERVICE_KEY` in environment.

### `ml/notebooks/discovery_pass.py`

- Fetches up to 10,000 active markets from the Polymarket Gamma API in 100-row pages.
- Filters out markets already present in `scored_markets`, non-binary markets, range or bracket markets, and markets outside the 7-260 day resolution window.
- Categorizes each market using the same keyword-bucket classifier as `ml-scorer.ts`.
- Scores each candidate through the partial-v6 layered pipeline (v6 multipliers for buckets >= 25 samples, v5_2 fallback otherwise).
- Inserts qualifying rows into `screened_markets`, `tracked_markets`, and `scored_markets` (in that order to satisfy the foreign key chain).
- Requires `SUPABASE_URL` and `SUPABASE_SERVICE_KEY`.

### `ml/notebooks/rebuild_proposals.py`

- Reads the post-rescore `scored_markets` and `tracked_markets` tables.
- Filters and ranks markets into short basket (CTRA-03) and long basket (CTRA-04) candidate sets according to the inclusion criteria, edge thresholds, and per-event dedup rules.
- Prints the full proposal without writing to the database (read-only).

## Artifacts

### `ml/artifacts/calibration_v6.json`

Structured JSON containing:

- `sports`: per-sport, per-bucket calibration multipliers. Only populated for buckets with sufficient sample size.
- `bucket_sample_sizes`: per-sport, per-bucket observation counts.
- `min_sample_size_for_v6`: the 25-sample threshold below which buckets fall back to v5_2.
- `logistic`: per-sport logistic regression coefficients (`coef_p`, `coef_p_squared`, `coef_log_p`, `intercept`), train and test sizes, out-of-sample Brier score, and bootstrap CI95.
- `calibration_table`: long-form table of (sport, bucket, n, wins, avg_implied_prob, actual_win_rate, multiplier).
- `version`: model version string (`v6`).
- `generated_at`: ISO 8601 generation timestamp.

Consumed by `backend/src/services/ml-scorer.ts` as the `V6_PARTIAL_MULTIPLIERS` constant for live market scoring. Regenerated by running `sports_regression.py`.

## How to Run

### Prerequisites

```bash
pip install pandas numpy scikit-learn matplotlib scipy jupyter
```

### Step 1: regenerate the historical dataset

```bash
python ml/data/fetch_historical.py
```

Writes `ml/data/sports_historical.csv` and prints per-sport row counts and winner counts.

### Step 2: run the sports regression and generate the calibration artifact

```bash
python ml/notebooks/sports_regression.py
```

Writes `ml/artifacts/calibration_v6.json` and prints the calibration tables, per-sport Brier scores, logistic regression results, the derived multiplier matrix, and a per-team breakdown for the 2026 FIFA, NBA, and NHL fields.

Or open the notebook view with captured outputs:

```bash
jupyter notebook ml/notebooks/sports_regression.ipynb
```

### Step 3 (optional): rescore live markets with the new calibration

Requires Supabase credentials in `.env`.

```bash
python ml/notebooks/rescore_sports_v6.py
```

### Step 4 (optional): run a market discovery pass

Requires Supabase credentials in `.env`.

```bash
python ml/notebooks/discovery_pass.py
```

Live scoring of individual markets in production is handled by `backend/src/services/ml-scorer.ts`. The TypeScript path mirrors the Python math exactly (same constants, same per-bucket multipliers, same tournament renormalization, same inclusion gates) so the offline Python pipeline and the live backend produce identical outputs for any given market.

## Calibration Table: Base Layer

The base calibration table maps implied probability buckets to empirically observed resolution rates across 4,310 resolved Polymarket markets. The figures below are approximations from the live `CALIBRATION_TABLE` constant in `backend/src/services/ml-scorer.ts`:

| Implied Probability | Observed Resolution Rate | Multiplier |
|---------------------|--------------------------|------------|
| 2-5%                | ~0.8%                    | ~0.40      |
| 5-10%               | ~1.7%                    | ~0.25      |
| 10-15%              | ~4.2%                    | ~0.35      |
| 15-20%              | ~7.5%                    | ~0.45      |
| 20-25%              | ~12.1%                   | ~0.55      |
| 90-95%              | ~97.2%                   | ~1.02      |
| 95-100%             | ~99.1%                   | ~1.01      |

Markets priced at 5-10% resolve YES only about 1.7% of the time on average. That gap is the core edge the pipeline trades against.

## Model Versioning

- `calibration_v5_2`: base calibration table plus hand-tuned per-sport tier multipliers. Used as the production default before the regression was run, and as the fallback for any sport bucket below the 25-sample gate.
- `calibration_v6_partial`: base table plus data-driven sport multipliers for buckets with `n >= 25` historical observations. Buckets below the gate keep their `v5_2` values. This is the model version that writes out to `scored_markets.model_version` after the rescore.

## Limitations

- Sports buckets with fewer than 25 historical observations fall back to v5_2 multipliers. The 15-20% FIFA bucket sits at n=15 after the Euros and Copa America expansion. Confidence intervals on per-bucket actual win rates are wide at these sample sizes.
- The base calibration table is derived from Polymarket data, not Kalshi. Cross-market calibration assumes the longshot bias structure is similar across the two venues, which is plausible but not separately validated here.
- Live performance history is short. Days of NAV data, not months. Sharpe ratios computed over this window are not statistically meaningful.
- The historical sports dataset captures pre-tournament opening odds and final outcomes only. It does not include in-tournament price evolution, so the model cannot calibrate intra-tournament momentum or in-flight price dynamics.

## Setup and Credentials

Copy `.env.example` to `.env` and fill in the following values before running any live scripts.

| Variable | Required By | Where to Get It |
|----------|-------------|-----------------|
| `SUPABASE_URL` | `rescore_sports_v6.py`, `discovery_pass.py` | Supabase project settings |
| `SUPABASE_SERVICE_KEY` | `rescore_sports_v6.py`, `discovery_pass.py` | Supabase project settings |
| `KALSHI_API_KEY` | Kalshi market fetching | kalshi.com API settings |
| `KALSHI_KEY_ID` | Kalshi JWT authentication | kalshi.com API settings |
| `ANTHROPIC_API_KEY` | Weekly impossibility screener | console.anthropic.com |

Kalshi uses RSA-PSS JWT authentication. A private key file (`kalshi_private_key.pem`) is required alongside the API key. Generate an RSA key pair and register the public key on Kalshi's developer portal. The PEM file is gitignored and must never be committed.

The sports regression pipeline (Steps 1 and 2) runs fully offline with no credentials required. Only the live rescoring and discovery scripts (Steps 3 and 4) require Supabase access.

### Data sources used in this project

- **Kalshi Trade API v2** (RSA-PSS JWT auth). Live market prices, volumes, order books.
- **Polymarket Gamma API** (public, no auth). Live and historical market data; reference set for cross-market calibration.
- **Anthropic API** (Claude Sonnet). Weekly impossibility screener for catching markets the model should never quote (constitutional impossibilities, already-resolved markets, ambiguous wording).
- **Supabase** (PostgreSQL). Market storage, NAV snapshots, scored market history, basket and position tracking.
