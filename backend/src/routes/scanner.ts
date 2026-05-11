/**
 * Scanner API.
 *   GET /api/scanner/snapshot — merged Polymarket + Kalshi raw markets
 *                               filtered to longshot range (default 0.02–0.15)
 *   GET /api/scanner/live      — SSE stream, refreshed every 30s
 *   GET /api/scanner/history   — most recent scored scan output
 *
 * snapshot returns rows in the shape the new scanner page expects;
 * live/history keep returning the model-scored output for backwards compat.
 */

import { Router, Request, Response } from 'express';
import { runScanner } from '../services/cron';
import {
  getAllActiveMarkets as getAllPoly,
  flattenOutcomes as flattenPoly,
  daysToClose,
} from '../services/polymarket';
import {
  getAllOpenMarkets as getAllKalshi,
  flattenOutcomes as flattenKalshi,
  getLastKalshiError,
  getLastKalshiThrottled,
} from '../services/kalshi';
import {
  getScreenedByConditionIds,
  getScoredByConditionIds,
  getScreenedMarket,
  getScoredMarket,
  listRecentlyExcluded,
} from '../db/queries';

export const scannerRouter: Router = Router();

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

interface EnrichedRow extends SnapshotRow {
  screened: boolean;
  excluded: boolean;
  impossible: boolean;
  exclusion_reason: string | null;
  p_model: number | null;
  edge: number | null;
  adjusted_edge: number | null;
  time_factor: number | null;
  category_factor: number | null;
  volume_factor: number | null;
  include_in_basket: boolean | null;
}

// Polymarket condition_ids are 66-char hex strings; PostgREST .in() puts
// every id in the URL, so a single 200+ id call easily exceeds the 8KB
// upstream limit and silently 400s. Chunk to keep each request well under.
const ID_CHUNK_SIZE = 50;

async function fetchManyChunked<T>(
  ids: string[],
  fetcher: (chunk: string[]) => Promise<Map<string, T>>,
): Promise<Map<string, T>> {
  const out = new Map<string, T>();
  for (let i = 0; i < ids.length; i += ID_CHUNK_SIZE) {
    const chunk = ids.slice(i, i + ID_CHUNK_SIZE);
    try {
      const m = await fetcher(chunk);
      m.forEach((v, k) => out.set(k, v));
    } catch (e) {
      console.warn('[scanner] enrich chunk failed:', (e as Error).message);
    }
  }
  return out;
}

async function enrichRows(rows: SnapshotRow[]): Promise<EnrichedRow[]> {
  const ids = [...new Set(rows.map((r) => r.marketId))];
  const [screenedMap, scoredMap] = await Promise.all([
    fetchManyChunked(ids, getScreenedByConditionIds),
    fetchManyChunked(ids, getScoredByConditionIds),
  ]);
  return rows.map((r) => {
    const sc = screenedMap.get(r.marketId);
    const sd = scoredMap.get(r.marketId);
    return {
      ...r,
      // Prefer category from scored row (computed via classifyCategory) over snapshot.
      category: sd?.category ?? r.category,
      daysToClose: sd?.days_to_close ?? r.daysToClose,
      screened: Boolean(sc),
      excluded: sc?.excluded ?? false,
      impossible: sc?.impossible ?? false,
      exclusion_reason: sc?.exclusion_reason ?? null,
      p_model: sd?.p_model ?? null,
      edge: sd?.edge ?? null,
      adjusted_edge: sd?.adjusted_edge ?? null,
      time_factor: sd?.time_factor ?? null,
      category_factor: sd?.category_factor ?? null,
      volume_factor: sd?.volume_factor ?? null,
      include_in_basket: sd ? sd.include_in_basket : null,
    };
  });
}

let snapshotCache: { at: number; rows: SnapshotRow[] } | null = null;
const SNAPSHOT_TTL_MS = 30_000;

async function fetchSnapshot(min = 0.02, max = 0.15): Promise<SnapshotRow[]> {
  // Pull both sources in parallel. Kalshi paginates up to 10 pages and
  // early-stops once it has 50+ priced markets in the wider 0.01..0.20
  // band; the snapshot's own min/max filter (default 0.02..0.15) is
  // applied below to the merged set.
  const [poly, kalshi] = await Promise.all([
    safeArr(() => getAllPoly(2)),
    safeArr(() => getAllKalshi(10)),
  ]);
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
  for (const m of kalshi) {
    for (const o of flattenKalshi(m)) {
      if (o.pMarket >= min && o.pMarket <= max) {
        rows.push({
          question: o.question,
          source: 'kalshi',
          marketId: o.ticker,
          outcomeLabel: o.outcomeLabel,
          p_market: o.pMarket,
          volume: o.volumeUsd,
          endDateIso: o.endDateIso,
          daysToClose: o.endDateIso ? daysToCloseLocal(o.endDateIso) : null,
          category: o.category,
        });
      }
    }
  }
  rows.sort((a, b) => a.p_market - b.p_market);
  return rows;
}

function daysToCloseLocal(iso: string): number | null {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return Math.max(0, (t - Date.now()) / 86_400_000);
}

async function safeArr<T>(fn: () => Promise<T[]>): Promise<T[]> {
  try {
    return await fn();
  } catch (e) {
    console.warn('[scanner] data source error:', (e as Error).message);
    return [];
  }
}

// Frontend-friendly alias for the new home + scanner pages. Same shape as
// /snapshot, also returns per-source counts so the UI can render
// "X from Polymarket · Y from Kalshi".
scannerRouter.get('/markets', async (req, res) => {
  try {
    const min = req.query.min ? Number(req.query.min) : 0.02;
    const max = req.query.max ? Number(req.query.max) : 0.15;
    const sortParam = String(req.query.sort ?? 'volume').toLowerCase();
    const search = (req.query.search ?? '').toString().trim().toLowerCase();
    const limitParam = req.query.limit != null ? Math.max(1, Math.min(500, Number(req.query.limit))) : null;

    const fresh = snapshotCache && Date.now() - snapshotCache.at < SNAPSHOT_TTL_MS;
    if (!fresh) {
      const rows = await fetchSnapshot(min, max);
      snapshotCache = { at: Date.now(), rows };
    }
    const rows = snapshotCache!.rows;
    const polymarket = rows.filter((r) => r.source === 'polymarket').length;
    const kalshi = rows.filter((r) => r.source === 'kalshi').length;

    // Enrich the full set first so search hits ALL markets, not just the
    // top-25 view. enrichRows is bounded by the 500-row cap on the source
    // array — and chunks Supabase calls — so the cost stays reasonable.
    let enriched = await enrichRows(rows.slice(0, 500));

    if (search) {
      enriched = enriched.filter((r) => r.question?.toLowerCase().includes(search));
    }

    // Sort
    const cmp = (a: EnrichedRow, b: EnrichedRow): number => {
      switch (sortParam) {
        case 'edge':
          return (b.adjusted_edge ?? b.edge ?? 0) - (a.adjusted_edge ?? a.edge ?? 0);
        case 'days':
          return (a.daysToClose ?? Number.POSITIVE_INFINITY) - (b.daysToClose ?? Number.POSITIVE_INFINITY);
        case 'p_market':
          return a.p_market - b.p_market;
        case 'volume':
        default:
          return (b.volume ?? 0) - (a.volume ?? 0);
      }
    };
    enriched.sort(cmp);

    // Limit semantics:
    //   - search set → no limit (return all matches)
    //   - explicit limit → that
    //   - default → 25
    const limit = search ? enriched.length : (limitParam ?? 25);
    const sliced = enriched.slice(0, limit);

    res.json({
      at: snapshotCache!.at,
      count: rows.length,
      counts: { polymarket, kalshi },
      kalshi_error: getLastKalshiError(),
      kalshi_throttled: getLastKalshiThrottled(),
      sort: sortParam,
      search: search || null,
      total_after_filter: enriched.length,
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
 * Full detail for a single market. Looks up the most recent live snapshot
 * (so the user gets current p_market / volume / category), then joins on
 * screened_markets and scored_markets for the model verdict.
 *
 * status legend:
 *   "impossible"          — screen verdict marked the outcome impossible
 *   "excluded_resolved"   — already resolved
 *   "excluded_ambiguous"  — vague resolution criteria
 *   "excluded"            — excluded for some other reason
 *   "eligible"            — screened, not excluded
 *   "unscreened"          — never screened yet
 */
scannerRouter.get('/market/:condition_id', async (req, res) => {
  const id = req.params.condition_id;
  try {
    // Refresh snapshot if stale, then look the row up by marketId.
    const fresh = snapshotCache && Date.now() - snapshotCache.at < SNAPSHOT_TTL_MS;
    if (!fresh) {
      const rows = await fetchSnapshot(0.0, 1.0);
      snapshotCache = { at: Date.now(), rows };
    }
    const market = snapshotCache!.rows.find((r) => r.marketId === id) ?? null;

    const [screened, scored] = await Promise.all([
      getScreenedMarket(id).catch(() => null),
      getScoredMarket(id).catch(() => null),
    ]);

    let status: 'impossible' | 'excluded_resolved' | 'excluded_ambiguous' | 'excluded' | 'eligible' | 'unscreened';
    if (!screened) status = 'unscreened';
    else if (screened.impossible) status = 'impossible';
    else if (screened.already_resolved) status = 'excluded_resolved';
    else if (screened.ambiguous) status = 'excluded_ambiguous';
    else if (screened.excluded) status = 'excluded';
    else status = 'eligible';

    if (!market && !screened && !scored) {
      return res.status(404).json({ error: 'market_not_found', condition_id: id });
    }

    res.json({
      condition_id: id,
      market,
      screened,
      scored,
      status,
    });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

/**
 * Recently excluded screened markets. Used by the admin dashboard to
 * surface what Claude has been kicking out and why.
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

scannerRouter.get('/snapshot', async (req, res) => {
  try {
    const min = req.query.min ? Number(req.query.min) : 0.02;
    const max = req.query.max ? Number(req.query.max) : 0.15;
    const fresh = snapshotCache && Date.now() - snapshotCache.at < SNAPSHOT_TTL_MS;
    if (!fresh) {
      const rows = await fetchSnapshot(min, max);
      snapshotCache = { at: Date.now(), rows };
    }
    res.json({
      at: snapshotCache!.at,
      count: snapshotCache!.rows.length,
      rows: snapshotCache!.rows.slice(0, 200),
    });
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
