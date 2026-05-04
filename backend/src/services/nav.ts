/**
 * NAV computation for short baskets. The on-chain `payout_ratio` is only
 * set at finalize_vault — between activation and finalize we mark to
 * market here in the backend for chart updates and health-factor checks.
 *
 * Short basket NAV per leg (1.0 = par):
 *   resolved NO  : weight × (1 / p_market_entry)         ← won
 *   resolved YES : 0                                      ← lost
 *   open         : weight × (1 / p_market_current_estimate)
 *                  (mark-to-market — mid-price from data source)
 *
 * If we have no current estimate we hold at weight × 1.0 (par) so the
 * basket NAV doesn't get jerked around by data-source gaps.
 */

import { Leg, listLegs, listBaskets, insertNavSnapshot, updateBasket } from '../db/queries';

export interface NavBreakdown {
  basketId: string;
  nav: number;
  legsResolved: number;
  legsTotal: number;
  contributions: Array<{ legIndex: number; status: 'no' | 'yes' | 'open'; contribution: number }>;
}

export function computeBasketNav(legs: Leg[], currentPriceLookup?: Map<string, number>): NavBreakdown {
  let nav = 0;
  let legsResolved = 0;
  const contributions: NavBreakdown['contributions'] = [];

  for (const leg of legs) {
    const w = Number(leg.weight);
    if (leg.outcome === 0) {
      const c = w * (1 / Math.max(Number(leg.p_market_entry), 1e-6));
      nav += c;
      legsResolved++;
      contributions.push({ legIndex: leg.leg_index, status: 'no', contribution: c });
    } else if (leg.outcome === 1) {
      legsResolved++;
      contributions.push({ legIndex: leg.leg_index, status: 'yes', contribution: 0 });
    } else {
      const cur = currentPriceLookup?.get(`${leg.source}:${leg.market_id}`) ?? Number(leg.p_market_entry);
      // Open-leg mark: as p_market drops below entry (market thinks NO is
      // more likely) the leg is gaining value for us.
      const ratio = Math.max(Number(leg.p_market_entry), 1e-6) / Math.max(cur, 1e-6);
      const c = w * Math.min(ratio, 50); // cap mark-to-market at 50x to silence outliers
      nav += c;
      contributions.push({ legIndex: leg.leg_index, status: 'open', contribution: c });
    }
  }

  return {
    basketId: legs[0]?.basket_id ?? '',
    nav,
    legsResolved,
    legsTotal: legs.length,
    contributions,
  };
}

/** Snapshot NAV for a single basket and persist. */
export async function snapshotBasket(
  basketId: string,
  priceLookup?: Map<string, number>,
): Promise<NavBreakdown> {
  const legs = await listLegs(basketId);
  if (legs.length === 0) {
    return { basketId, nav: 1, legsResolved: 0, legsTotal: 0, contributions: [] };
  }
  const breakdown = computeBasketNav(legs, priceLookup);
  await insertNavSnapshot({
    basket_id: basketId,
    nav: breakdown.nav,
    legs_resolved: breakdown.legsResolved,
  });
  return breakdown;
}

/** Snapshot every active and resolving basket. Called by cron. */
export async function snapshotAllActive(priceLookup?: Map<string, number>): Promise<number> {
  const active = await listBaskets({ status: 'active' });
  const resolving = await listBaskets({ status: 'resolving' });
  const targets = [...active, ...resolving];
  let n = 0;
  for (const b of targets) {
    try {
      await snapshotBasket(b.id, priceLookup);
      n++;
    } catch (e) {
      console.warn(`[nav] snapshot failed for ${b.id}:`, (e as Error).message);
    }
  }
  return n;
}

/** Convenience: write final_payout_ratio onto the basket row at finalize. */
export async function persistFinalRatio(basketId: string, ratio: number): Promise<void> {
  await updateBasket(basketId, {
    final_payout_ratio: ratio,
    status: 'finalized',
    finalized_at: new Date().toISOString(),
  });
}
