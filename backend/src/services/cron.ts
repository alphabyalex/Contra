/**
 * Background jobs.
 *
 *   every 2 min   — snapshot NAVs for every active+resolving basket,
 *                   refresh leveraged-position health factors
 *   every 30 min  — refresh leg mark-to-market prices from data sources
 *   every 6 hours — run mispricing scanner and propose new baskets
 *                   (proposals are surfaced through /api/baskets/construct
 *                   for admin sign-off; we never auto-init on devnet)
 *
 * The scheduler is a no-op outside production unless explicitly enabled
 * via START_CRON=true to keep `npm run dev` fast.
 */

import cron from 'node-cron';
import { snapshotAllActive } from './nav';
import { refreshHealthAll } from './leverage';
import { scanLongshots as scanPoly } from './polymarket';
import { scanLongshots as scanKalshi } from './kalshi';
import { scoreMany, type ScorableMarket } from './mispricing';

let started = false;

export function startCron(): void {
  if (started) return;
  if (process.env.START_CRON !== 'true' && process.env.NODE_ENV !== 'production') {
    console.info('[cron] skipped (set START_CRON=true to enable in dev)');
    return;
  }
  started = true;

  cron.schedule('*/2 * * * *', async () => {
    try {
      const n = await snapshotAllActive();
      const hr = await refreshHealthAll();
      const liq = hr.filter((r) => r.liquidatable);
      if (liq.length > 0) console.info(`[cron] ${liq.length} liquidatable position(s)`);
      console.info(`[cron] snapshot ${n} basket NAV(s)`);
    } catch (e) {
      console.error('[cron] 2min job failed:', (e as Error).message);
    }
  });

  cron.schedule('*/30 * * * *', async () => {
    try {
      const map = await refreshLegPriceMap();
      console.info(`[cron] refreshed prices for ${map.size} markets`);
    } catch (e) {
      console.error('[cron] 30min job failed:', (e as Error).message);
    }
  });

  cron.schedule('0 */6 * * *', async () => {
    try {
      const candidates = await runScanner();
      console.info(`[cron] scanner produced ${candidates.length} candidate(s) — review at /api/baskets/construct`);
    } catch (e) {
      console.error('[cron] 6h job failed:', (e as Error).message);
    }
  });

  console.info('[cron] scheduled jobs started');
}

/**
 * Pull current outcome prices from both data sources, returned as a
 * Map<"source:marketId", pMarket>. Used by NAV mark-to-market and by
 * health-factor refresh to keep leveraged positions accurate.
 */
export async function refreshLegPriceMap(): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const [poly, kalshi] = await Promise.all([
    safeArray(() => scanPoly(1.0, 0)),  // pull *all* prices, not just longshots
    safeArray(() => scanKalshi(1.0, 0)),
  ]);
  for (const o of poly) out.set(`polymarket:${o.conditionId}`, o.pMarket);
  for (const o of kalshi) out.set(`kalshi:${o.ticker}`, o.pMarket);
  return out;
}

export async function runScanner(): Promise<ScorableMarket[]> {
  const [poly, kalshi] = await Promise.all([
    safeArray(() => scanPoly()),
    safeArray(() => scanKalshi()),
  ]);
  const all: ScorableMarket[] = [
    ...poly.map((o) => ({
      source: 'polymarket' as const,
      marketId: o.conditionId,
      question: o.question,
      outcomeLabel: o.outcomeLabel,
      pMarket: o.pMarket,
      volumeUsd: o.volumeUsd,
      endDateIso: o.endDateIso,
      category: o.category,
    })),
    ...kalshi.map((o) => ({
      source: 'kalshi' as const,
      marketId: o.ticker,
      question: o.question,
      outcomeLabel: o.outcomeLabel,
      pMarket: o.pMarket,
      volumeUsd: o.volumeUsd,
      endDateIso: o.endDateIso,
      category: o.category,
    })),
  ];
  return scoreMany(all).filter((s) => s.include);
}

async function safeArray<T>(fn: () => Promise<T[]>): Promise<T[]> {
  try {
    return await fn();
  } catch (e) {
    console.warn('[cron] data source error:', (e as Error).message);
    return [];
  }
}
