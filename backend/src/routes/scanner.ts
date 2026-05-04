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
    const fresh = snapshotCache && Date.now() - snapshotCache.at < SNAPSHOT_TTL_MS;
    if (!fresh) {
      const rows = await fetchSnapshot(min, max);
      snapshotCache = { at: Date.now(), rows };
    }
    const rows = snapshotCache!.rows;
    const polymarket = rows.filter((r) => r.source === 'polymarket').length;
    const kalshi = rows.filter((r) => r.source === 'kalshi').length;
    res.json({
      at: snapshotCache!.at,
      count: rows.length,
      counts: { polymarket, kalshi },
      kalshi_error: getLastKalshiError(),
      kalshi_throttled: getLastKalshiThrottled(),
      rows: rows.slice(0, 500),
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
