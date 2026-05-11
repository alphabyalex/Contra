/**
 * Model performance analytics.
 *
 * Every function pulls the full prediction_log and computes one metric.
 * Each returns null when fewer than MIN_RESOLVED legs have been resolved —
 * any earlier read is too noisy to be useful, especially with a STUB
 * scorer that has known calibration issues.
 *
 *   computeHitRate         — share of resolved legs that paid us (outcome=0/NO)
 *   computeBrierScore      — mean squared error of p_model vs realised outcome
 *   computeCalibration     — predicted vs actual YES rate per p_model decile
 *   computeEdgeRealization — avg edge_at_entry split by win/loss
 */

import {
  getPredictionLogStats,
  listPredictionLog,
  type PredictionLogEntry,
} from '../db/queries';

const MIN_RESOLVED = 10;

async function loadResolved(): Promise<PredictionLogEntry[]> {
  const all = await listPredictionLog();
  return all.filter((r) => r.outcome === 0 || r.outcome === 1);
}

export interface HitRateResult {
  resolved: number;
  hit_rate: number;          // 0..1
  no_count: number;
  yes_count: number;
}

export async function computeHitRate(): Promise<HitRateResult | null> {
  const stats = await getPredictionLogStats();
  if (stats.resolved < MIN_RESOLVED) return null;
  return {
    resolved: stats.resolved,
    hit_rate: stats.hit_rate ?? 0,
    no_count: stats.no_count,
    yes_count: stats.yes_count,
  };
}

export interface BrierResult {
  brier: number;             // 0..1, lower better. Random=0.25, good model <0.15.
  resolved: number;
}

export async function computeBrierScore(): Promise<BrierResult | null> {
  const rows = await loadResolved();
  const valid = rows.filter((r) => r.p_model_at_entry != null);
  if (valid.length < MIN_RESOLVED) return null;
  let sum = 0;
  for (const r of valid) {
    const p = r.p_model_at_entry as number;
    const y = r.outcome as 0 | 1;        // YES (longshot hits) = 1
    sum += (p - y) ** 2;
  }
  return { brier: sum / valid.length, resolved: valid.length };
}

export interface CalibrationBucket {
  bucket: string;            // "0-10%" .. "90-100%"
  predicted_rate: number;    // midpoint of the bucket, 0..1
  actual_rate: number;       // share of legs in bucket that resolved YES
  count: number;
}

export async function computeCalibration(): Promise<CalibrationBucket[] | null> {
  const rows = await loadResolved();
  const valid = rows.filter((r) => r.p_model_at_entry != null);
  if (valid.length < MIN_RESOLVED) return null;

  const buckets: CalibrationBucket[] = [];
  for (let i = 0; i < 10; i++) {
    const lo = i / 10;
    const hi = (i + 1) / 10;
    const inBucket = valid.filter((r) => {
      const p = r.p_model_at_entry as number;
      return p >= lo && (i === 9 ? p <= hi : p < hi);
    });
    if (inBucket.length === 0) {
      buckets.push({
        bucket: `${i * 10}-${(i + 1) * 10}%`,
        predicted_rate: (lo + hi) / 2,
        actual_rate: 0,
        count: 0,
      });
      continue;
    }
    const yes = inBucket.filter((r) => r.outcome === 1).length;
    buckets.push({
      bucket: `${i * 10}-${(i + 1) * 10}%`,
      predicted_rate: (lo + hi) / 2,
      actual_rate: yes / inBucket.length,
      count: inBucket.length,
    });
  }
  return buckets;
}

export interface EdgeRealization {
  avg_edge_winners: number | null;   // resolved NO
  avg_edge_losers: number | null;    // resolved YES
  winners: number;
  losers: number;
  spread: number | null;             // winners - losers; positive → model edge is real
}

export async function computeEdgeRealization(): Promise<EdgeRealization | null> {
  const stats = await getPredictionLogStats();
  if (stats.resolved < MIN_RESOLVED) return null;
  const w = stats.avg_edge_winners;
  const l = stats.avg_edge_losers;
  return {
    avg_edge_winners: w,
    avg_edge_losers: l,
    winners: stats.no_count,
    losers: stats.yes_count,
    spread: w != null && l != null ? w - l : null,
  };
}
