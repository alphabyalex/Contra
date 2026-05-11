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
import {
  scanLongshots as scanPoly,
  getAllActiveMarkets as getAllPoly,
  flattenOutcomes as flattenPoly,
  daysToClose,
} from './polymarket';
import { scanLongshots as scanKalshi } from './kalshi';
import { scoreMany, type ScorableMarket } from './mispricing';
import { batchScreenMarkets, type MarketToScreen } from './screener';
import { scoreAllMarkets, getPModel, getEdge, type MarketToScore } from './ml-scorer';
import { collectAllPrices } from './price-collector';
import { checkResolutions } from './resolution-monitor';
import { checkAutoRotation } from './basket-builder';
import { updateMomentum } from './momentum';
import {
  getScreenedByConditionIds,
  getTrackedMarket,
  upsertTrackedMarket,
} from '../db/queries';

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

  // Weekly Anthropic screener + ML scorer pass. Sundays at 02:00 local.
  // Disabled if ANTHROPIC_API_KEY is missing.
  cron.schedule('0 2 * * 0', async () => {
    if (!process.env.ANTHROPIC_API_KEY?.trim()) {
      console.warn('[cron] weekly screener skipped — ANTHROPIC_API_KEY not set');
      return;
    }
    console.info('[cron] weekly screener starting');
    try {
      const summary = await weeklyScreener();
      console.info(
        `[cron] Weekly screen complete: ${summary.screened} new markets screened, ${summary.excluded} excluded, ${summary.scored} scored, ${summary.tracked} tracked`,
      );
    } catch (e) {
      console.error('[cron] weekly screener failed:', (e as Error).message);
    }
  });

  // Price collector — every 15 min. The function itself decides per market
  // whether enough time has passed for the next sample (high/medium/low/
  // minimal tiers based on days-to-close).
  cron.schedule('*/15 * * * *', async () => {
    try {
      await collectAllPrices();
    } catch (e) {
      console.error('[cron] price collector failed:', (e as Error).message);
    }
  });

  // Resolution monitor — every 2 hours. Polls Polymarket for markets
  // resolving within the next 7 days.
  cron.schedule('0 */2 * * *', async () => {
    try {
      const s = await checkResolutions();
      if (s.resolved > 0 || s.errors > 0) {
        console.info(`[cron] resolution check: ${s.resolved} newly resolved, ${s.errors} errors`);
      }
    } catch (e) {
      console.error('[cron] resolution monitor failed:', (e as Error).message);
    }
  });

  // Auto-rotation check — every day at 06:00. Identifies active baskets
  // that will fully resolve within 14 days and proposes the next basket.
  // We log the proposal but do NOT auto-seed — admin reviews + seeds.
  cron.schedule('0 6 * * *', async () => {
    try {
      const results = await checkAutoRotation();
      if (results.length === 0) {
        console.info('[cron] auto-rotation: nothing expiring soon');
      }
    } catch (e) {
      console.error('[cron] auto-rotation failed:', (e as Error).message);
    }
  });

  // Momentum recompute — daily 08:00. Reads market_price_history for every
  // scored market with at least 7 days of samples, derives momentum and
  // updates adjusted_edge.
  cron.schedule('0 8 * * *', async () => {
    try {
      await updateMomentum();
    } catch (e) {
      console.error('[cron] momentum recompute failed:', (e as Error).message);
    }
  });

  console.info('[cron] scheduled jobs started');
}

// ---------------------------------------------------------------------
// Weekly screener pipeline
// ---------------------------------------------------------------------

const SCREEN_MIN_P = 0.02;
const SCREEN_MAX_P = 0.10;
const SCREEN_MIN_VOLUME = 500_000;

export interface WeeklyScreenSummary {
  candidates: number;     // markets in the price/volume band before cache check
  screened: number;       // newly sent to Claude this run
  excluded: number;       // newly screened markets the model excluded
  scored: number;         // markets that passed screening and got scored
  tracked: number;        // newly added to tracked_markets
  errors: number;
}

/**
 * Runs the screen-then-score pipeline once.
 *
 * 1. Pull active Polymarket markets, flatten to outcomes
 * 2. Filter to longshot range (0.02 ≤ p_market ≤ 0.10) and volume ≥ $500k
 * 3. Skip any condition_id already in screened_markets
 * 4. Send the rest to Claude via batchScreenMarkets()
 * 5. Score every non-excluded market via scoreAllMarkets()
 */
export async function weeklyScreener(): Promise<WeeklyScreenSummary> {
  const markets = await safeArray(() => getAllPoly());
  const outcomes = markets.flatMap(flattenPoly);

  const candidates = outcomes.filter(
    (o) => o.pMarket >= SCREEN_MIN_P && o.pMarket <= SCREEN_MAX_P && o.volumeUsd >= SCREEN_MIN_VOLUME,
  );

  // Polymarket gives one row per outcome but condition_id is per-market.
  // Dedupe so we screen each market once even if both YES and NO sit in band.
  const byCondition = new Map<string, (typeof candidates)[number]>();
  for (const o of candidates) {
    if (!byCondition.has(o.conditionId)) byCondition.set(o.conditionId, o);
  }
  const deduped = [...byCondition.values()];

  const cached = await getScreenedByConditionIds(deduped.map((o) => o.conditionId));
  const toScreen: MarketToScreen[] = deduped
    .filter((o) => !cached.has(o.conditionId))
    .map((o) => ({
      condition_id: o.conditionId,
      source: 'polymarket' as const,
      question: o.question,
      p_market: o.pMarket,
    }));

  const screen = await batchScreenMarkets(toScreen);

  // Pool: previously cached + newly screened, restricted to non-excluded.
  const allScreened = [...cached.values(), ...screen.results];
  const screenedById = new Map(allScreened.map((s) => [s.condition_id, s]));

  const toScore: MarketToScore[] = deduped
    .filter((o) => {
      const s = screenedById.get(o.conditionId);
      return s && !s.excluded;
    })
    .map((o) => {
      const s = screenedById.get(o.conditionId)!;
      return {
        screened: s,
        volume: o.volumeUsd,
        days_to_close: daysToClose(o.endDateIso) != null ? Math.round(daysToClose(o.endDateIso)!) : null,
        category: o.category ?? null,
      };
    });

  const score = await scoreAllMarkets(toScore);

  // Auto-populate tracked_markets for every non-excluded market so the
  // price collector starts streaming history immediately, even before
  // any basket is constructed. Impossible-flagged markets are tracked
  // too — they're the highest-priority basket candidates.
  let trackedAdded = 0;
  for (const o of deduped) {
    const s = screenedById.get(o.conditionId);
    if (!s) continue;
    if (s.excluded && !s.impossible) continue;
    try {
      const existing = await getTrackedMarket(o.conditionId);
      if (existing) continue;
      const pMarket = o.pMarket;
      const pModel = s.impossible ? 0 : getPModel(pMarket);
      const edge = s.impossible ? pMarket : getEdge(pMarket, pModel);
      await upsertTrackedMarket({
        condition_id: o.conditionId,
        source: 'polymarket',
        question: o.question,
        token_id: o.tokenId ?? null,
        category: o.category ?? null,
        p_market_initial: pMarket,
        p_model_initial: pModel,
        edge_initial: edge,
        resolution_date: o.endDateIso ?? null,
        in_basket: false,
        outcome: null,
        resolved_at: null,
      });
      trackedAdded += 1;
    } catch (e) {
      console.warn(`[weeklyScreener] tracked insert failed for ${o.conditionId}: ${(e as Error).message}`);
    }
  }

  return {
    candidates: deduped.length,
    screened: screen.newlyScreened,
    excluded: screen.excluded,
    scored: score.scored.length,
    tracked: trackedAdded,
    errors: screen.errors.length,
  };
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
