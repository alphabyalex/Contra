/**
 * Mispricing scorer — STUB IMPLEMENTATION.
 *
 * The production design (see Claude_brief.md §6) is:
 *   1. Train a calibrated logistic regression in Python (ml/train.py).
 *   2. Export coefficients + base-rate tables to ml/artifacts/*.json.
 *   3. Reimplement scoring deterministically in TypeScript here.
 *
 * The ML pipeline is intentionally out of scope for this build pass.
 * Until artifacts exist, `scoreMarket` uses a transparent heuristic:
 *
 *    p_model = clamp(p_market × calibration_factor, 0, 1)
 *
 * where calibration_factor encodes the longshot-bias prior (we believe
 * longshots are systematically overpriced, so p_model < p_market).
 *
 * When the artifacts land, replace `heuristicPModel` with the real
 * deterministic scorer that consumes ml/artifacts/model_coefficients.json.
 */

import * as fs from 'fs';
import * as path from 'path';

export interface ScorableMarket {
  source: 'kalshi' | 'polymarket';
  marketId: string;
  question: string;
  outcomeLabel: string;
  pMarket: number;
  volumeUsd: number;
  endDateIso?: string;
  category?: string;
}

export interface ScoredMarket extends ScorableMarket {
  pModel: number;
  edge: number;
  include: boolean;
}

const ARTIFACT_DIR = path.resolve(__dirname, '..', '..', '..', 'ml', 'artifacts');
const REQUIRED_ARTIFACTS = [
  'model_coefficients.json',
  'category_base_rates.json',
  'feature_stats.json',
  'model_metrics.json',
];

let artifactsLoaded = false;
let artifactsAvailable = false;

export function loadArtifacts(): boolean {
  if (artifactsLoaded) return artifactsAvailable;
  artifactsLoaded = true;
  artifactsAvailable = REQUIRED_ARTIFACTS.every((f) =>
    fs.existsSync(path.join(ARTIFACT_DIR, f)),
  );
  if (artifactsAvailable) {
    console.info('[mispricing] ML artifacts present — but real scorer not wired yet (TODO).');
  } else {
    console.info('[mispricing] ML artifacts missing — using heuristic stub p_model.');
  }
  return artifactsAvailable;
}

/** Edge below this is filtered out at basket construction time. */
export const EDGE_THRESHOLD = 0.06;

/**
 * STUB. Calibration factor by category — these numbers are placeholders
 * informed by the longshot-bias literature, not by our own backtest.
 */
const CATEGORY_CALIBRATION: Record<string, number> = {
  politics: 0.45,
  macro: 0.55,
  crypto: 0.40,
  sports: 0.60,
  culture: 0.50,
  other: 0.55,
};

function categoryFactor(cat: string | undefined): number {
  if (!cat) return CATEGORY_CALIBRATION.other;
  const k = cat.toLowerCase();
  return CATEGORY_CALIBRATION[k] ?? CATEGORY_CALIBRATION.other;
}

/**
 * Heuristic p_model: assume the *true* probability of a longshot YES is
 * a fixed fraction of the market price, with longer-tail markets
 * (smaller p_market) discounted more aggressively.
 */
function heuristicPModel(p: number, category?: string): number {
  if (p <= 0) return 0;
  const factor = categoryFactor(category);
  // tail damping: extra discount for very low p_market (deeper longshots)
  const damping = p < 0.05 ? 0.7 : p < 0.10 ? 0.85 : 1.0;
  const out = p * factor * damping;
  return Math.max(0, Math.min(1, out));
}

export function scoreMarket(m: ScorableMarket): ScoredMarket {
  loadArtifacts();
  const pModel = heuristicPModel(m.pMarket, m.category);
  const edge = m.pMarket - pModel;
  const include = edge >= EDGE_THRESHOLD && m.pMarket > 0 && m.pMarket < 0.30 && m.volumeUsd >= 5_000;
  return { ...m, pModel, edge, include };
}

export function scoreMany(ms: ScorableMarket[]): ScoredMarket[] {
  return ms.map(scoreMarket).sort((a, b) => b.edge - a.edge);
}
