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
  getPredictionLogByConditionId,
  listLegs,
  listTrackedMarketsResolvingSoon,
  resolveLegRow,
  updateBasket,
  updatePredictionOutcome,
  type Leg,
} from '../db/queries';
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
        // If every leg now resolved → flag for human-signed finalize.
        const after = await listLegs(basketId).catch(() => [] as Leg[]);
        const open = after.filter((l) => l.outcome == null).length;
        if (after.length > 0 && open === 0) {
          await updateBasket(basketId, { status: 'resolving' }).catch(() => null);
          console.info(
            `[resolution] basket ${basketId} all legs resolved — pending admin finalize`,
          );
        }
      }

      console.info(
        `[resolution] ${tm.question.slice(0, 60)}… resolved ${outcome === 0 ? 'NO' : 'YES'}`,
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
