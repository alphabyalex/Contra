/**
 * Polymarket price collector — batch Gamma API.
 *
 * One scheduled call (every 15 minutes) makes a SINGLE batch request to
 * the Gamma API:
 *
 *   GET https://gamma-api.polymarket.com/markets?active=true&limit=500
 *
 * which returns `outcomePrices` (a JSON-stringified array, e.g.
 * '["0.082","0.918"]') for every active market in one shot. The YES
 * price is parseFloat(JSON.parse(outcomePrices)[0]).
 *
 * For each tracked market we find the matching Gamma row by conditionId,
 * decide per-market whether enough time has passed since the last sample
 * (cadence by time-to-resolve), and if so write a new sample to:
 *   1. market_price_history (Postgres, queried by NAV / charts)
 *   2. market_data/active/<conditionId>.csv (filesystem, archived to
 *      market_data/resolved/ when the market settles)
 *
 * Cadence by days-to-resolve:
 *   < 30 days  →  every 15 minutes
 *   30–90      →  every 60 minutes
 *   90–180     →  every 4 hours
 *   > 180      →  every 12 hours
 */

import * as fs from 'fs';
import * as path from 'path';
import { getAllActiveMarkets, type RawPolymarketMarket } from './polymarket';
import {
  deletePriceHistory,
  getLatestPricePoint,
  getPriceHistory,
  getTrackedMarket,
  listBaskets,
  listLegs,
  listTrackedMarkets,
  recordPricePoint,
  updateTrackedMarket,
  type Leg,
  type TrackedMarket,
} from '../db/queries';

// Cadence by tier (milliseconds between samples for the same market).
const TIER_INTERVAL_MS = {
  high: 15 * 60 * 1000, //  15 min  (< 30 days)
  medium: 60 * 60 * 1000, //  60 min  (30–90)
  low: 4 * 60 * 60 * 1000, //   4 h    (90–180)
  minimal: 12 * 60 * 60 * 1000, //  12 h    (> 180)
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

/**
 * Parse the YES price out of a Gamma market row. `outcomePrices` is
 * usually a JSON-stringified array ('["0.082","0.918"]') but can also
 * already be an array. Returns null when unparseable.
 */
function yesPriceFromGamma(m: RawPolymarketMarket): number | null {
  const raw = m.outcomePrices;
  if (!raw) return null;
  let arr: unknown;
  if (Array.isArray(raw)) {
    arr = raw;
  } else {
    try {
      arr = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(arr) || arr.length === 0) return null;
  const yes = parseFloat(String(arr[0]));
  return Number.isFinite(yes) ? yes : null;
}

export interface CollectAllSummary {
  total: number; // tracked markets considered
  fetched: number; // markets returned by the Gamma batch call
  collected: number; // new price rows written
  skipped_too_soon: number; // matched but cadence interval not elapsed
  skipped_no_match: number; // tracked market not in the Gamma batch
  errors: number;
}

/**
 * Paginated Gamma fetch → per-tracked-market cadence check → write.
 */
export async function collectAllPrices(): Promise<CollectAllSummary> {
  // All tracked markets that have not yet resolved. The DB filter is
  // `resolved_at IS NULL`; `listTrackedMarkets({ onlyOpen: true })` does
  // the equivalent via `outcome IS NULL`. Either way: no row cap, fetch
  // every unresolved market.
  const tracked = await listTrackedMarkets({ onlyOpen: true }).catch((e) => {
    console.warn('[price-collector] listTrackedMarkets failed:', (e as Error).message);
    return [] as TrackedMarket[];
  });
  console.info(`[price-collector] loaded ${tracked.length} tracked markets from DB`);

  // Pull every leg from every active basket and make sure they're in the
  // collection list — even if some are missing from tracked_markets
  // (e.g. seeded before tracking was wired). This guarantees NAV
  // mark-to-market has fresh prices for every basket leg.
  const trackedIds = new Set(tracked.map((t) => t.condition_id));
  let basketLegsAdded = 0;
  try {
    const baskets = await listBaskets({ status: 'active' });
    const resolving = await listBaskets({ status: 'resolving' });
    const allBaskets = [...baskets, ...resolving];
    const legArrays = await Promise.all(allBaskets.map((b) => listLegs(b.id)));
    const allLegs: Leg[] = legArrays.flat().filter((l) => l.outcome == null);
    for (const leg of allLegs) {
      if (trackedIds.has(leg.market_id)) continue;
      // Synthesize a minimal TrackedMarket so the rest of the loop treats
      // this leg the same as any tracked entry. Cadence falls back to
      // "minimal" since we have no resolution_date here.
      tracked.push({
        id: leg.id,
        condition_id: leg.market_id,
        source: leg.source,
        question: leg.question,
        token_id: null,
        category: null,
        p_market_initial: leg.p_market_entry,
        p_model_initial: null,
        edge_initial: null,
        resolution_date: null,
        in_basket: true,
        outcome: null,
        resolved_at: null,
        created_at: leg.created_at,
        updated_at: leg.created_at,
      });
      trackedIds.add(leg.market_id);
      basketLegsAdded += 1;
    }
  } catch (e) {
    console.warn('[price-collector] basket-leg priority enrichment failed:', (e as Error).message);
  }
  if (basketLegsAdded > 0) {
    console.info(`[price-collector] ${basketLegsAdded} basket legs added as priority tracking`);
  }

  let gamma: RawPolymarketMarket[] = [];
  try {
    gamma = await getAllActiveMarkets(20);
  } catch (e) {
    console.warn('[price-collector] Gamma paginated fetch failed:', (e as Error).message);
  }
  const pagesFetched = (gamma as any).__pagesFetched ?? 0;
  console.info(
    `[price-collector] Gamma API: fetched ${gamma.length} total active markets across ${pagesFetched} pages`,
  );

  // conditionId → YES price, from the merged paginated response.
  const priceById = new Map<string, number>();
  for (const m of gamma) {
    if (!m.conditionId) continue;
    const yes = yesPriceFromGamma(m);
    if (yes != null) priceById.set(m.conditionId, yes);
  }

  let collected = 0;
  let tooSoon = 0;
  let noMatch = 0;
  let errors = 0;

  for (const m of tracked) {
    const price = priceById.get(m.condition_id);
    if (price == null) {
      noMatch += 1;
      continue;
    }

    const days = daysToCloseFromIso(m.resolution_date);
    const interval = TIER_INTERVAL_MS[tierForDays(days)];

    try {
      const last = await getLatestPricePoint(m.condition_id);
      if (last) {
        const sinceMs = Date.now() - Date.parse(last.recorded_at);
        if (sinceMs < interval) {
          tooSoon += 1;
          continue;
        }
      }

      const point = await recordPricePoint({
        condition_id: m.condition_id,
        source: m.source ?? 'polymarket',
        price,
        days_to_close: days,
      });

      appendCsvRow(
        csvPath(m.condition_id, ACTIVE_DIR),
        `${point.recorded_at},${price.toFixed(8)},${days ?? ''}`,
      );

      collected += 1;
    } catch (e) {
      console.warn(`[price-collector] ${m.condition_id} failed: ${(e as Error).message}`);
      errors += 1;
    }
  }

  console.info(
    `[price-collector] recorded ${collected} new prices, skipped ${tooSoon} (too soon)`,
  );
  if (noMatch > 0 || errors > 0) {
    console.info(
      `[price-collector] (${noMatch} tracked markets not in batch, ${errors} write errors)`,
    );
  }

  return {
    total: tracked.length,
    fetched: gamma.length,
    collected,
    skipped_too_soon: tooSoon,
    skipped_no_match: noMatch,
    errors,
  };
}

/**
 * Move a market's full price history out of the live table into a CSV in
 * market_data/resolved/. Called by the resolution monitor when a market
 * settles. Idempotent.
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

  const activeFile = csvPath(conditionId, ACTIVE_DIR);
  if (fs.existsSync(activeFile)) {
    try {
      fs.unlinkSync(activeFile);
    } catch {
      /* ignore */
    }
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
