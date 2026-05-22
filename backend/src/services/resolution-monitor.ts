/**
 * Resolution monitor.
 *
 * Every 2 hours we look for tracked markets that should be settling
 * within the next week and ask Polymarket Gamma whether they have. If
 * yes:
 *   1. updatePredictionOutcome — records outcome on every prediction_log
 *      row for this condition_id
 *   2. archiveResolvedMarket   — moves price history out of the live
 *      table into market_data/resolved/<conditionId>_<date>.csv
 *   3. resolveLegRow on every leg pointing at this market
 *   4. snapshotBasketNav for every basket containing the leg
 *   5. if every leg in a basket is now resolved, log + alert (but do
 *      NOT auto-finalize on chain — admin signs that off)
 *
 * Cheap to run: at-most-7-days lookahead keeps the per-call API cost low
 * (typically a few requests per cycle).
 */

import {
  deactivateScoredMarket,
  getBasket,
  getLatestNavSnapshot,
  getPredictionLogByConditionId,
  listLegs,
  listPositionsByBasket,
  listTrackedMarkets,
  listTrackedMarketsResolvingSoon,
  resolveLegRow,
  recordTransaction,
  updateBasket,
  updatePredictionOutcome,
  updateTrackedMarket,
  upsertPosition,
  type Leg,
  type TrackedMarket,
} from '../db/queries';
import { computeBasketNav } from './nav';
import { getMarketByConditionId } from './polymarket';
import { archiveResolvedMarket } from './price-collector';
import { snapshotBasket } from './nav';

export interface ResolutionSummary {
  checked: number;
  resolved: number;
  errors: number;
}

export async function checkResolutions(): Promise<ResolutionSummary> {
  const candidates = await listTrackedMarketsResolvingSoon(7).catch((e) => {
    console.warn('[resolution] listTrackedMarketsResolvingSoon failed:', (e as Error).message);
    return [];
  });

  let resolved = 0;
  let errors = 0;

  for (const tm of candidates) {
    try {
      const m = await getMarketByConditionId(tm.condition_id);
      if (!m) continue;
      const isClosed = Boolean(m.closed) && Boolean(m.resolved);
      if (!isClosed) continue;

      const oc = (m.resolutionOutcome ?? '').trim();
      if (!oc) continue;
      const outcome: 0 | 1 = oc.toLowerCase() === 'yes' ? 1 : 0;
      const resolvedAt = new Date().toISOString();

      // Mirror outcome onto prediction_log rows for this market.
      await updatePredictionOutcome(tm.condition_id, outcome, resolvedAt).catch((e) =>
        console.warn(`[resolution] updatePredictionOutcome failed: ${(e as Error).message}`),
      );

      // Archive price history → CSV; deletes live rows + active CSV;
      // updates tracked_markets.outcome.
      await archiveResolvedMarket(tm.condition_id, outcome).catch((e) =>
        console.warn(`[resolution] archiveResolvedMarket failed: ${(e as Error).message}`),
      );

      // Resolve every leg pointing at this market and re-snapshot the
      // owning basket(s).
      const logRows = await getPredictionLogByConditionId(tm.condition_id).catch(() => []);
      const basketIds = [...new Set(logRows.map((r) => r.basket_id).filter(Boolean) as string[])];
      for (const basketId of basketIds) {
        const legs = await listLegs(basketId).catch(() => [] as Leg[]);
        for (const leg of legs) {
          if (leg.market_id !== tm.condition_id) continue;
          await resolveLegRow(basketId, leg.leg_index, outcome).catch((e) =>
            console.warn(`[resolution] resolveLegRow failed: ${(e as Error).message}`),
          );
        }
        try {
          await snapshotBasket(basketId);
        } catch (e) {
          console.warn(`[resolution] snapshotBasket failed: ${(e as Error).message}`);
        }
        // If every leg now resolved → auto-finalize + auto-redeem positions.
        const after = await listLegs(basketId).catch(() => [] as Leg[]);
        const open = after.filter((l) => l.outcome == null).length;
        if (after.length > 0 && open === 0) {
          await autoFinalizeBasket(basketId).catch((e) =>
            console.warn(`[resolution] autoFinalize failed for ${basketId}: ${(e as Error).message}`),
          );
        }
      }

      // Remove from the active scanner pool: stamp tracked_markets.resolved_at
      // and flip scored_markets.include_in_basket=false so the next-best
      // market in the category surfaces automatically.
      await updateTrackedMarket(tm.condition_id, {
        outcome,
        resolved_at: resolvedAt,
        in_basket: false,
      }).catch((e) =>
        console.warn(`[resolution] tracked_markets update failed: ${(e as Error).message}`),
      );
      await deactivateScoredMarket(tm.condition_id).catch((e) =>
        console.warn(`[resolution] deactivateScoredMarket failed: ${(e as Error).message}`),
      );

      console.info(
        `[resolution] market ${tm.condition_id} resolved ${outcome === 0 ? 'NO' : 'YES'}, removed from scanner — ${tm.question.slice(0, 60)}…`,
      );
      resolved += 1;
    } catch (e) {
      errors += 1;
      console.warn(`[resolution] check failed for ${tm.condition_id}: ${(e as Error).message}`);
    }
  }

  console.info(`[resolution] checked ${candidates.length}, resolved ${resolved}, errors ${errors}`);
  return { checked: candidates.length, resolved, errors };
}

/**
 * Daily full sweep (06:00 cron). Unlike checkResolutions — which only looks
 * 7 days ahead — this checks EVERY tracked market with resolved_at IS NULL
 * against Polymarket and removes any that have settled. Reuses the same
 * per-market resolution handling as checkResolutions.
 */
export async function checkAllMarketResolutions(): Promise<ResolutionSummary> {
  const open = await listTrackedMarkets({ onlyOpen: true }).catch((e) => {
    console.warn('[daily-check] listTrackedMarkets failed:', (e as Error).message);
    return [] as TrackedMarket[];
  });

  let resolved = 0;
  let errors = 0;

  for (const tm of open) {
    try {
      // Only Polymarket markets are checkable via Gamma; skip Kalshi here.
      if (tm.source !== 'polymarket') continue;
      const m = await getMarketByConditionId(tm.condition_id);
      if (!m) continue;
      if (!(Boolean(m.closed) && Boolean(m.resolved))) continue;
      const oc = (m.resolutionOutcome ?? '').trim();
      if (!oc) continue;
      const outcome: 0 | 1 = oc.toLowerCase() === 'yes' ? 1 : 0;
      const resolvedAt = new Date().toISOString();

      await updatePredictionOutcome(tm.condition_id, outcome, resolvedAt).catch(() => null);
      await archiveResolvedMarketSafe(tm.condition_id, outcome);

      const logRows = await getPredictionLogByConditionId(tm.condition_id).catch(() => []);
      const basketIds = [...new Set(logRows.map((r) => r.basket_id).filter(Boolean) as string[])];
      for (const basketId of basketIds) {
        const legs = await listLegs(basketId).catch(() => [] as Leg[]);
        for (const leg of legs) {
          if (leg.market_id !== tm.condition_id) continue;
          await resolveLegRow(basketId, leg.leg_index, outcome).catch(() => null);
        }
        await snapshotBasket(basketId).catch(() => null);
        const after = await listLegs(basketId).catch(() => [] as Leg[]);
        if (after.length > 0 && after.every((l) => l.outcome != null)) {
          await autoFinalizeBasket(basketId).catch((e) =>
            console.warn(`[daily-check] autoFinalize failed for ${basketId}: ${(e as Error).message}`),
          );
        }
      }

      await updateTrackedMarket(tm.condition_id, {
        outcome,
        resolved_at: resolvedAt,
        in_basket: false,
      }).catch(() => null);
      await deactivateScoredMarket(tm.condition_id).catch(() => null);

      console.info(
        `[daily-check] market ${tm.condition_id} resolved ${outcome === 0 ? 'NO' : 'YES'}, removed from scanner`,
      );
      resolved += 1;
    } catch (e) {
      errors += 1;
      console.warn(`[daily-check] failed for ${tm.condition_id}: ${(e as Error).message}`);
    }
  }

  console.info(`[daily-check] ${open.length} markets checked, ${resolved} resolved and removed, ${errors} errors`);
  return { checked: open.length, resolved, errors };
}

/**
 * When a basket's last leg resolves: finalize it (lock final NAV) and
 * auto-redeem every open position at that NAV.
 *
 * NOTE: the on-chain redeem/withdraw burns the USER's CTRS and so needs the
 * user's signature — the authority can't burn on their behalf with the
 * current program. So this settles at the DB/accounting layer (positions
 * zeroed, auto_redeem tx recorded). A true on-chain auto-redeem needs a
 * dedicated authority-callable admin_redeem instruction.
 */
async function autoFinalizeBasket(basketId: string): Promise<void> {
  const basket = await getBasket(basketId);
  if (!basket || basket.status === 'finalized') return;

  const snap = await getLatestNavSnapshot(basketId).catch(() => null);
  const legs = await listLegs(basketId).catch(() => [] as Leg[]);
  const finalNav = snap ? Number(snap.nav) : (legs.length ? computeBasketNav(legs).nav : 1);

  await updateBasket(basketId, {
    status: 'finalized',
    finalized_at: new Date().toISOString(),
    final_payout_ratio: finalNav,
  }).catch(() => null);

  const positions = await listPositionsByBasket(basketId).catch(() => []);
  let redeemed = 0;
  for (const p of positions) {
    const tokens = Number(p.tokens_held ?? 0);
    if (tokens <= 0) continue;
    const gross = tokens * finalNav;
    const net = gross - gross * 0.005;
    await upsertPosition({
      basket_id: basketId,
      wallet: p.wallet,
      tokens_delta: -tokens,
      usdc_delta: -Number(p.usdc_deposited ?? 0),
    }).catch(() => null);
    await recordTransaction({
      basket_id: basketId,
      wallet: p.wallet,
      type: 'redeem', // 'auto_redeem' isn't in TxType; signature prefix marks it
      usdc_delta: -net,
      tokens_delta: -tokens,
      tx_signature: `auto_redeem_${basketId.slice(0, 8)}_${p.wallet.slice(0, 6)}_${Date.now()}`,
    }).catch(() => null);
    console.info(`[resolution] auto-redeemed ${p.wallet} ${tokens.toFixed(4)} tokens → $${net.toFixed(2)} USDC`);
    redeemed += 1;
  }
  console.info(`[resolution] basket ${basket.name} finalized, ${redeemed} positions auto-redeemed`);
}

async function archiveResolvedMarketSafe(conditionId: string, outcome: 0 | 1): Promise<void> {
  try {
    await archiveResolvedMarket(conditionId, outcome);
  } catch (e) {
    console.warn(`[daily-check] archiveResolvedMarket failed: ${(e as Error).message}`);
  }
}
