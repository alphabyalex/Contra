/**
 * Scanner API.
 *   GET /api/scanner/markets   — PRIMARY display endpoint. Reads the
 *                                scored_markets table (full curated pool,
 *                                178+ rows) enriched with screened_markets
 *                                + tracked_markets. Layered factors
 *                                (adjusted_edge / time / category / volume)
 *                                are recomputed on the fly from the ML
 *                                scorer so they stay consistent with the
 *                                active model even though they are not
 *                                persisted as columns.
 *   GET /api/scanner/market/:id — single-market detail (live snapshot join)
 *   GET /api/scanner/snapshot   — raw merged live markets (debug)
 *   GET /api/scanner/live       — SSE stream
 *   GET /api/scanner/history    — most recent scored scan output
 *
 * The live Polymarket / Kalshi APIs are intentionally NOT the source for
 * /markets — they are only used by the weekly screener (new market
 * discovery) and the price collector (price updates).
 */

import { Router, Request, Response } from 'express';
import { runScanner } from '../services/cron';
import {
  getAllActiveMarkets as getAllPoly,
  flattenOutcomes as flattenPoly,
  daysToClose,
} from '../services/polymarket';
import { getLastKalshiError, getLastKalshiThrottled } from '../services/kalshi';
import {
  listScoredMarkets,
  listScreenedMarkets,
  listTrackedMarkets,
  getScreenedMarket,
  getScoredMarket,
  listRecentlyExcluded,
  type ScreenedMarket,
  type TrackedMarket,
} from '../db/queries';
import { computeLayeredScore } from '../services/ml-scorer';

export const scannerRouter: Router = Router();

interface ScannerMarketRow {
  condition_id: string;
  marketId: string; // alias of condition_id for legacy frontend consumers
  question: string;
  source: string;
  p_market: number;
  p_model: number;
  adjusted_edge: number;
  edge: number; // raw base edge (p_market - p_model)
  time_factor: number;
  category_factor: number;
  volume_factor: number;
  category: string;
  days_to_close: number | null;
  daysToClose: number | null; // alias for legacy frontend consumers
  volume: number | null;
  screened: boolean;
  excluded: boolean;
  impossible: boolean;
  exclusion_reason: string | null;
  include_in_basket: boolean;
  model_version: string | null;
}

interface ScoredCacheEntry {
  at: number;
  rows: ScannerMarketRow[];
}

let scoredCache: ScoredCacheEntry | null = null;
const SCORED_TTL_MS = 30_000;

async function buildScoredRows(): Promise<ScannerMarketRow[]> {
  const [scored, screened, tracked] = await Promise.all([
    listScoredMarkets(),
    listScreenedMarkets().catch(() => [] as ScreenedMarket[]),
    listTrackedMarkets().catch(() => [] as TrackedMarket[]),
  ]);

  const screenedById = new Map<string, ScreenedMarket>();
  for (const s of screened) screenedById.set(s.condition_id, s);

  const trackedById = new Map<string, TrackedMarket>();
  for (const t of tracked) trackedById.set(t.condition_id, t);

  const rows: ScannerMarketRow[] = scored.map((sd) => {
    const sc = screenedById.get(sd.condition_id) ?? null;
    const tm = trackedById.get(sd.condition_id) ?? null;

    const impossible = sc?.impossible ?? sd.impossible_edge ?? false;
    const excludedByScreener = sc?.excluded ?? false;

    // Volume / days: scored_markets carries both; fall back to tracked.
    const volume =
      sd.volume ??
      (tm && (tm as unknown as { volume_at_start?: number | null }).volume_at_start) ??
      null;

    let days = sd.days_to_close ?? null;
    if (days == null && tm?.resolution_date) {
      const t = Date.parse(tm.resolution_date);
      if (!Number.isNaN(t)) days = Math.max(0, Math.round((t - Date.now()) / 86_400_000));
    }

    const layered = computeLayeredScore({
      p_market: sd.p_market ?? 0,
      question: sd.question,
      isImpossible: impossible,
      excludedByScreener,
      volume,
      days_to_close: days,
      category: sd.category ?? null,
    });

    return {
      condition_id: sd.condition_id,
      marketId: sd.condition_id,
      question: sd.question,
      source: sd.source,
      p_market: sd.p_market ?? 0,
      p_model: layered.p_model,
      adjusted_edge: layered.adjusted_edge,
      edge: layered.base_edge,
      time_factor: layered.time_factor,
      category_factor: layered.category_factor,
      volume_factor: layered.volume_factor,
      category: layered.category,
      days_to_close: days,
      daysToClose: days,
      volume,
      screened: Boolean(sc),
      excluded: excludedByScreener,
      impossible,
      exclusion_reason: sc?.exclusion_reason ?? null,
      include_in_basket: layered.include_in_basket,
      model_version: sd.model_version ?? null,
    };
  });

  return rows;
}

/**
 * GET /api/scanner/markets
 *
 * Reads from scored_markets (the curated pool), not the live APIs.
 *   ?sort=volume|edge|days|p_market   (volume DESC default)
 *   ?search=term                      filters question across ALL rows,
 *                                     no limit
 *   ?limit=N                          explicit cap (else 25 when no search)
 */
scannerRouter.get('/markets', async (req, res) => {
  try {
    const sortParam = String(req.query.sort ?? 'volume').toLowerCase();
    const search = (req.query.search ?? '').toString().trim().toLowerCase();
    const limitParam =
      req.query.limit != null ? Math.max(1, Math.min(2000, Number(req.query.limit))) : null;

    const fresh = scoredCache && Date.now() - scoredCache.at < SCORED_TTL_MS;
    if (!fresh) {
      scoredCache = { at: Date.now(), rows: await buildScoredRows() };
    }
    const all = scoredCache!.rows;

    const polymarket = all.filter((r) => r.source === 'polymarket').length;
    const kalshi = all.filter((r) => r.source === 'kalshi').length;

    let filtered = all;
    if (search) {
      filtered = all.filter((r) => r.question?.toLowerCase().includes(search));
    }

    const cmp = (a: ScannerMarketRow, b: ScannerMarketRow): number => {
      switch (sortParam) {
        case 'edge':
          return (b.adjusted_edge ?? 0) - (a.adjusted_edge ?? 0);
        case 'days':
          return (
            (a.days_to_close ?? Number.POSITIVE_INFINITY) -
            (b.days_to_close ?? Number.POSITIVE_INFINITY)
          );
        case 'p_market':
          return a.p_market - b.p_market;
        case 'volume':
        default:
          return (b.volume ?? 0) - (a.volume ?? 0);
      }
    };
    const sorted = [...filtered].sort(cmp);

    // Limit semantics:
    //   - search set       → no limit (return all matches)
    //   - explicit ?limit= → that
    //   - default          → 25
    const limit = search ? sorted.length : (limitParam ?? 25);
    const sliced = sorted.slice(0, limit);

    res.json({
      at: scoredCache!.at,
      count: all.length,
      counts: { polymarket, kalshi },
      kalshi_error: getLastKalshiError(),
      kalshi_throttled: getLastKalshiThrottled(),
      sort: sortParam,
      search: search || null,
      total_after_filter: filtered.length,
      rows: sliced,
    });
  } catch (e) {
    res.status(500).json({
      error: (e as Error).message,
      rows: [],
      counts: { polymarket: 0, kalshi: 0 },
      kalshi_error: getLastKalshiError(),
      kalshi_throttled: getLastKalshiThrottled(),
    });
  }
});

/**
 * GET /api/scanner/market/:condition_id
 *
 * Full detail for a single market — joins the scored row with the
 * screened verdict. Falls back to a live snapshot lookup if the market
 * isn't in scored_markets yet.
 */
scannerRouter.get('/market/:condition_id', async (req, res) => {
  const id = req.params.condition_id;
  try {
    const [screened, scored] = await Promise.all([
      getScreenedMarket(id).catch(() => null),
      getScoredMarket(id).catch(() => null),
    ]);

    let status:
      | 'impossible'
      | 'excluded_resolved'
      | 'excluded_ambiguous'
      | 'excluded'
      | 'eligible'
      | 'unscreened';
    if (!screened) status = 'unscreened';
    else if (screened.impossible) status = 'impossible';
    else if (screened.already_resolved) status = 'excluded_resolved';
    else if (screened.ambiguous) status = 'excluded_ambiguous';
    else if (screened.excluded) status = 'excluded';
    else status = 'eligible';

    let market: unknown = null;
    if (scored) {
      market = {
        question: scored.question,
        source: scored.source,
        marketId: scored.condition_id,
        p_market: scored.p_market,
        volume: scored.volume,
        daysToClose: scored.days_to_close,
        category: scored.category,
      };
    }

    if (!market && !screened && !scored) {
      return res.status(404).json({ error: 'market_not_found', condition_id: id });
    }

    res.json({ condition_id: id, market, screened, scored, status });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

/**
 * Recently excluded screened markets. Used by the admin dashboard to
 * surface what the screener has been kicking out and why.
 */
scannerRouter.get('/recent-excluded', async (req, res) => {
  try {
    const limit = Math.min(50, Math.max(1, Number(req.query.limit ?? 10)));
    const rows = await listRecentlyExcluded(limit);
    res.json({
      rows: rows.map((r) => ({
        condition_id: r.condition_id,
        question: r.question,
        p_market: r.p_market,
        impossible: r.impossible,
        already_resolved: r.already_resolved,
        ambiguous: r.ambiguous,
        exclusion_reason: r.exclusion_reason,
        screened_at: r.screened_at,
      })),
    });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

// ---- live debug endpoints (raw merged sources, not the curated pool) ---

interface SnapshotRow {
  question: string;
  source: 'kalshi' | 'polymarket';
  marketId: string;
  outcomeLabel: string;
  p_market: number;
  volume: number;
  endDateIso?: string;
  daysToClose?: number | null;
  category?: string;
}

async function safeArr<T>(fn: () => Promise<T[]>): Promise<T[]> {
  try {
    return await fn();
  } catch (e) {
    console.warn('[scanner] data source error:', (e as Error).message);
    return [];
  }
}

scannerRouter.get('/snapshot', async (req, res) => {
  try {
    const min = req.query.min ? Number(req.query.min) : 0.02;
    const max = req.query.max ? Number(req.query.max) : 0.15;
    const poly = await safeArr(() => getAllPoly(2));
    const rows: SnapshotRow[] = [];
    for (const m of poly) {
      for (const o of flattenPoly(m)) {
        if (o.pMarket >= min && o.pMarket <= max) {
          rows.push({
            question: o.question,
            source: 'polymarket',
            marketId: o.conditionId,
            outcomeLabel: o.outcomeLabel,
            p_market: o.pMarket,
            volume: o.volumeUsd,
            endDateIso: o.endDateIso,
            daysToClose: daysToClose(o.endDateIso),
            category: o.category,
          });
        }
      }
    }
    rows.sort((a, b) => a.p_market - b.p_market);
    res.json({ at: Date.now(), count: rows.length, rows: rows.slice(0, 200) });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message, rows: [] });
  }
});

scannerRouter.get('/live', async (req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  let closed = false;
  req.on('close', () => {
    closed = true;
  });
  const send = (data: unknown) => {
    if (closed) return;
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };
  const push = async () => {
    try {
      const rows = await runScanner();
      send({ at: Date.now(), rows: rows.slice(0, 50) });
    } catch (e) {
      send({ at: Date.now(), error: (e as Error).message });
    }
  };
  await push();
  const iv = setInterval(push, 30_000);
  req.on('close', () => clearInterval(iv));
});

scannerRouter.get('/history', async (_req, res) => {
  try {
    const rows = await runScanner();
    res.json({ at: Date.now(), rows: rows.slice(0, 100) });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});
