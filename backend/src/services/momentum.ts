/**
 * Daily momentum recompute.
 *
 * For every scored market that has at least 7 days of price history,
 * compute momentum = p_7d_ago - p_market_now and a momentum_factor
 * multiplier; rewrite scored_markets.adjusted_edge and the three new
 * momentum columns.
 *
 *   momentum >  0.02 → factor = min(1 + momentum * 2, 1.20)   falling, boost
 *   momentum < -0.02 → factor = max(1 + momentum * 3, 0.70)   rising, penalize
 *   else             → factor = 1.0
 *
 * Markets without 7d of history keep momentum_factor = 1.0 untouched.
 */

import {
  getPriceHistory,
  listScoredMarkets,
  upsertScoredMarket,
  type ScoredMarket,
} from '../db/queries';

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

function priceAtOrAfter(history: { recorded_at: string; price: number }[], cutoffMs: number): number | null {
  // history is ascending by recorded_at; find the last sample <= cutoff.
  let candidate: number | null = null;
  for (const p of history) {
    const t = Date.parse(p.recorded_at);
    if (Number.isNaN(t)) continue;
    if (t <= cutoffMs) candidate = Number(p.price);
    else break;
  }
  return candidate;
}

export function computeMomentumFactor(momentum: number): number {
  if (momentum > 0.02) return Math.min(1 + momentum * 2, 1.20);
  if (momentum < -0.02) return Math.max(1 + momentum * 3, 0.70);
  return 1.0;
}

export interface MomentumSummary {
  scanned: number;
  updated: number;
  insufficient_history: number;
  errors: number;
}

export async function updateMomentum(): Promise<MomentumSummary> {
  const scored = await listScoredMarkets().catch(() => [] as ScoredMarket[]);
  const cutoffMs = Date.now() - SEVEN_DAYS_MS;

  let updated = 0;
  let insufficient = 0;
  let errors = 0;

  for (const s of scored) {
    try {
      const history = await getPriceHistory(s.condition_id);
      if (history.length === 0) {
        insufficient += 1;
        continue;
      }
      const oldestMs = Date.parse(history[0].recorded_at);
      if (Number.isNaN(oldestMs) || oldestMs > cutoffMs) {
        // <7 days of history available
        insufficient += 1;
        continue;
      }
      const p7 = priceAtOrAfter(history, cutoffMs);
      if (p7 == null) {
        insufficient += 1;
        continue;
      }
      const pNow = Number(s.p_market);
      const momentum = p7 - pNow;
      const momentum_factor = computeMomentumFactor(momentum);

      const baseEdge = Number(s.edge ?? 0);
      const tf = Number(s.time_factor ?? 1);
      const cf = Number(s.category_factor ?? 1);
      const vf = Number(s.volume_factor ?? 1);
      const adjusted_edge = baseEdge * tf * cf * vf * momentum_factor;

      await upsertScoredMarket({
        condition_id: s.condition_id,
        source: s.source,
        question: s.question,
        p_market: pNow,
        p_model: s.p_model,
        edge: baseEdge,
        volume: s.volume,
        days_to_close: s.days_to_close,
        category: s.category,
        include_in_basket: s.include_in_basket,
        impossible_edge: s.impossible_edge,
        adjusted_edge,
        time_factor: tf,
        category_factor: cf,
        volume_factor: vf,
        p_market_7d_ago: p7,
        momentum,
        momentum_factor,
      });
      updated += 1;
    } catch (e) {
      errors += 1;
      console.warn(`[momentum] ${s.condition_id} failed: ${(e as Error).message}`);
    }
  }

  console.info(`[momentum] updated ${updated} markets with momentum signals (insufficient history: ${insufficient}, errors: ${errors})`);
  return { scanned: scored.length, updated, insufficient_history: insufficient, errors };
}
