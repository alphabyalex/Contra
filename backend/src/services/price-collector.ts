/**
 * Polymarket CLOB price collector.
 *
 * One scheduled call (every 15 minutes) iterates every open tracked
 * market and decides per-market whether enough time has passed since the
 * last sample to take a new one. The cadence depends on time-to-resolve:
 *
 *   < 30 days  →  every 15 minutes
 *   30–90      →  every 60 minutes
 *   90–180     →  every 4 hours
 *   > 180      →  every 12 hours
 *
 * Samples land in two places:
 *   1. market_price_history table (Postgres, queried by NAV / charts)
 *   2. market_data/active/<conditionId>.csv (filesystem, archived to
 *      market_data/resolved/ when the market settles, and used by the
 *      training pipeline)
 *
 * The CLOB endpoint we use is /prices-history?market=<token_id>. We take
 * the last point in the response as "current". If a tracked market has
 * no token_id yet, we skip it (a future weeklyScreener pass will fix).
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  deletePriceHistory,
  getLatestPricePoint,
  getPriceHistory,
  getTrackedMarket,
  listTrackedMarkets,
  recordPricePoint,
  updateTrackedMarket,
  type TrackedMarket,
} from '../db/queries';

const CLOB_BASE = 'https://clob.polymarket.com';

// Cadence by tier (milliseconds between samples for the same market).
const TIER_INTERVAL_MS = {
  high:    15 * 60 * 1000,        //  15 min
  medium:  60 * 60 * 1000,        //  60 min
  low:     4 * 60 * 60 * 1000,    //   4 h
  minimal: 12 * 60 * 60 * 1000,   //  12 h
} as const;

export type FrequencyTier = keyof typeof TIER_INTERVAL_MS;

export function tierForDays(days: number | null): FrequencyTier {
  if (days == null) return 'minimal';
  if (days < 30) return 'high';
  if (days < 90) return 'medium';
  if (days < 180) return 'low';
  return 'minimal';
}

const ACTIVE_DIR = path.resolve(__dirname, '..', '..', '..', 'market_data', 'active');
const RESOLVED_DIR = path.resolve(__dirname, '..', '..', '..', 'market_data', 'resolved');

function ensureDirs(): void {
  for (const d of [ACTIVE_DIR, RESOLVED_DIR]) {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  }
}

function csvPath(conditionId: string, dir: string, suffix = ''): string {
  // Strip leading 0x to keep filenames ASCII-friendly.
  const safe = conditionId.replace(/^0x/i, '').slice(0, 64);
  return path.join(dir, `${safe}${suffix}.csv`);
}

function appendCsvRow(file: string, row: string): void {
  ensureDirs();
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, 'timestamp,price,days_to_close\n', 'utf8');
  }
  fs.appendFileSync(file, row + '\n', 'utf8');
}

function daysToCloseFromIso(iso: string | null): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.round((t - Date.now()) / 86_400_000));
}

interface ClobHistoryResponse {
  history?: { t: number; p: number }[];
}

/**
 * Fetch the most recent CLOB price for a token. Returns null on any
 * error or empty history — caller is expected to skip silently.
 */
async function fetchCurrentPrice(tokenId: string): Promise<number | null> {
  // CLOB requires `interval` (or startTs/endTs); we use 1d so we always
  // get a reasonable window and take the most recent point as "current".
  const params = new URLSearchParams({
    market: tokenId,
    interval: '1d',
    fidelity: '60',
  });
  try {
    const res = await fetch(`${CLOB_BASE}/prices-history?${params.toString()}`);
    if (!res.ok) {
      console.warn(`[price-collector] CLOB ${res.status} for token ${tokenId.slice(0, 12)}…`);
      return null;
    }
    const json = (await res.json()) as ClobHistoryResponse;
    const hist = json.history;
    if (!Array.isArray(hist) || hist.length === 0) return null;
    const last = hist[hist.length - 1];
    return typeof last.p === 'number' ? last.p : null;
  } catch (e) {
    console.warn(`[price-collector] fetch failed for ${tokenId.slice(0, 12)}…: ${(e as Error).message}`);
    return null;
  }
}

export interface CollectResult {
  collected: boolean;
  reason?: 'no_token' | 'too_soon' | 'no_price' | 'error';
}

export async function collectPriceForMarket(market: TrackedMarket): Promise<CollectResult> {
  if (!market.token_id) return { collected: false, reason: 'no_token' };

  const days = daysToCloseFromIso(market.resolution_date);
  const tier = tierForDays(days);
  const interval = TIER_INTERVAL_MS[tier];

  try {
    const last = await getLatestPricePoint(market.condition_id);
    if (last) {
      const sinceMs = Date.now() - Date.parse(last.recorded_at);
      if (sinceMs < interval) return { collected: false, reason: 'too_soon' };
    }

    const price = await fetchCurrentPrice(market.token_id);
    if (price == null) return { collected: false, reason: 'no_price' };

    const point = await recordPricePoint({
      condition_id: market.condition_id,
      price,
      days_to_close: days,
    });

    appendCsvRow(
      csvPath(market.condition_id, ACTIVE_DIR),
      `${point.recorded_at},${price.toFixed(8)},${days ?? ''}`,
    );

    return { collected: true };
  } catch (e) {
    console.warn(`[price-collector] ${market.condition_id} failed: ${(e as Error).message}`);
    return { collected: false, reason: 'error' };
  }
}

export interface CollectAllSummary {
  total: number;
  collected: number;
  skipped_too_soon: number;
  skipped_no_token: number;
  errors: number;
}

export async function collectAllPrices(): Promise<CollectAllSummary> {
  const tracked = await listTrackedMarkets({ onlyOpen: true }).catch((e) => {
    console.warn('[price-collector] listTrackedMarkets failed:', (e as Error).message);
    return [] as TrackedMarket[];
  });

  let collected = 0;
  let tooSoon = 0;
  let noToken = 0;
  let errors = 0;

  for (const m of tracked) {
    const r = await collectPriceForMarket(m);
    if (r.collected) collected += 1;
    else if (r.reason === 'too_soon') tooSoon += 1;
    else if (r.reason === 'no_token') noToken += 1;
    else errors += 1;
  }

  console.info(
    `[price-collector] collected ${collected} prices, skipped ${tooSoon} (too soon), ${noToken} (no token), ${errors} errors`,
  );
  return { total: tracked.length, collected, skipped_too_soon: tooSoon, skipped_no_token: noToken, errors };
}

/**
 * Move a market's full price history out of the live table into a CSV in
 * market_data/resolved/. Called by the resolution monitor when a market
 * settles. Idempotent: if there are no rows to move, the CSV is still
 * written (with just the header block) so we have a record of the
 * resolution.
 */
export async function archiveResolvedMarket(conditionId: string, outcome: 0 | 1): Promise<void> {
  ensureDirs();

  const tracked = await getTrackedMarket(conditionId);
  const points = await getPriceHistory(conditionId).catch(() => []);

  const dateStr = new Date().toISOString().slice(0, 10);
  const outFile = csvPath(conditionId, RESOLVED_DIR, `_${dateStr}`);

  const initP = tracked?.p_market_initial ?? null;
  const initM = tracked?.p_model_initial ?? null;
  const initE = tracked?.edge_initial ?? null;
  const days =
    tracked?.created_at && tracked?.resolved_at
      ? Math.round((Date.parse(tracked.resolved_at) - Date.parse(tracked.created_at)) / 86_400_000)
      : null;

  const headerLines = [
    `# question: ${tracked?.question ?? ''}`,
    `# source: ${tracked?.source ?? ''}`,
    `# p_market_initial: ${initP ?? ''}`,
    `# p_model_initial: ${initM ?? ''}`,
    `# edge_initial: ${initE ?? ''}`,
    `# outcome: ${outcome === 0 ? 'NO' : 'YES'}`,
    `# resolved_at: ${tracked?.resolved_at ?? new Date().toISOString()}`,
    `# days_held: ${days ?? ''}`,
    `# basket_id: ${''}`,
    'timestamp,price,days_to_close',
  ];

  const body = points
    .map((p) => `${p.recorded_at},${Number(p.price).toFixed(8)},${p.days_to_close ?? ''}`)
    .join('\n');

  fs.writeFileSync(outFile, headerLines.join('\n') + '\n' + body + (body ? '\n' : ''), 'utf8');

  // Drop the active CSV (if it exists) and the live history rows.
  const activeFile = csvPath(conditionId, ACTIVE_DIR);
  if (fs.existsSync(activeFile)) {
    try { fs.unlinkSync(activeFile); } catch { /* ignore */ }
  }
  await deletePriceHistory(conditionId).catch((e) =>
    console.warn(`[price-collector] deletePriceHistory failed: ${(e as Error).message}`),
  );

  await updateTrackedMarket(conditionId, {
    outcome,
    resolved_at: new Date().toISOString(),
  }).catch((e) =>
    console.warn(`[price-collector] updateTrackedMarket failed: ${(e as Error).message}`),
  );

  console.info(
    `[price-collector] archived ${conditionId.slice(0, 12)}… → ${path.basename(outFile)} (${points.length} points, outcome=${outcome === 0 ? 'NO' : 'YES'})`,
  );
}
