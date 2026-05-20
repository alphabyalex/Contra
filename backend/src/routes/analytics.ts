/**
 * Analytics API.
 *
 * GET /api/analytics/performance
 *   - Reads prediction_log, returns the four core model-performance
 *     metrics in one response.
 *   - If fewer than 10 resolved legs exist yet, returns
 *     { insufficient_data: true, resolved_count: N }
 *     so the frontend can render a "not enough data yet" state instead
 *     of charting noise.
 */

import { Router } from 'express';
import {
  computeHitRate,
  computeBrierScore,
  computeCalibration,
  computeEdgeRealization,
} from '../services/analytics';
import { getPredictionLogStats, listScoredMarkets, getScreenerSummary } from '../db/queries';
import { MODEL_VERSION } from '../services/ml-scorer';

const analyticsRouter: Router = Router();

analyticsRouter.get('/performance', async (_req, res) => {
  try {
    const [hit, brier, calibration, edge] = await Promise.all([
      computeHitRate(),
      computeBrierScore(),
      computeCalibration(),
      computeEdgeRealization(),
    ]);

    // All four return null when there aren't 10+ resolved legs yet.
    if (!hit || !brier || !calibration || !edge) {
      const stats = await getPredictionLogStats();
      return res.json({ insufficient_data: true, resolved_count: stats.resolved });
    }

    res.json({
      insufficient_data: false,
      hit_rate: hit,
      brier_score: brier,
      calibration,
      edge_realization: edge,
    });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

/**
 * Lightweight model status for the admin page header.
 * Returns the active model version, the most recent scored_at timestamp,
 * total scored count, and counts by include_in_basket.
 */
analyticsRouter.get('/model-status', async (_req, res) => {
  try {
    const scored = await listScoredMarkets();
    const last = scored
      .map((s) => s.scored_at)
      .filter(Boolean)
      .sort()
      .pop() ?? null;
    const versions: Record<string, number> = {};
    for (const s of scored) {
      const v = s.model_version ?? 'unknown';
      versions[v] = (versions[v] ?? 0) + 1;
    }
    res.json({
      model_version: MODEL_VERSION,
      versions_in_db: versions,
      last_scored_at: last,
      total_scored: scored.length,
      included: scored.filter((s) => s.include_in_basket).length,
      impossible: scored.filter((s) => s.impossible_edge).length,
    });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

/**
 * Screener summary counts for the admin dashboard. Fetched directly from
 * the source tables so the numbers don't depend on (or get truncated by)
 * the scanner display route.
 */
analyticsRouter.get('/screener-summary', async (_req, res) => {
  try {
    const summary = await getScreenerSummary();
    res.json(summary);
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

export default analyticsRouter;
