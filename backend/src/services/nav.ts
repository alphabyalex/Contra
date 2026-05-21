/**
 * NAV computation for short baskets — mark-to-market.
 *
 * Each leg contributes a P&L delta to a basket starting at NAV = 1.0:
 *
 *   Open leg:
 *     entry_edge   = 1 - p_market_entry             (NO value at entry)
 *     current_edge = 1 - p_market_current           (NO value now)
 *     leg_pnl      = (current_edge - entry_edge) × weight
 *                  = (p_market_entry - p_market_current) × weight
 *
 *     ↑ When the longshot fades (p drops), the short gains. When the
 *       longshot rallies (p rises), the short loses.
 *
 *   Resolved NO  (outcome = 0, we won):
 *     leg_pnl = +p_market_entry × weight            (kept the full premium)
 *
 *   Resolved YES (outcome = 1, we lost):
 *     leg_pnl = -(1 - p_market_entry) × weight      (lost the NO collateral)
 *
 *   NAV = 1.0 + Σ leg_pnl
 *
 * Current prices are sourced from `market_price_history`, which the price
 * collector cron writes every 15 minutes. Legs whose market_id has no row
 * in market_price_history (e.g. Kalshi legs the collector doesn't cover)
 * are held at entry price → zero contribution → no spurious NAV motion.
 */

import {
  Leg,
  listLegs,
  listBaskets,
  insertNavSnapshot,
  updateBasket,
  getLatestPricePoint,
} from '../db/queries';

export interface LegContribution {
  legIndex: number;
  marketId: string;
  status: 'open' | 'no' | 'yes';
  entryPMarket: number;
  currentPMarket: number | null; // null = no price history → held at entry
  weight: number;
  legPnl: number;
}

export interface NavBreakdown {
  basketId: string;
  nav: number;
  legsResolved: number;
  legsTotal: number;
  contributions: LegContribution[];
}

/**
 * Compute mark-to-market NAV given a set of legs and a lookup of current
 * mid prices. `currentPriceLookup` is keyed by market_id (== condition_id
 * for Polymarket, == ticker for Kalshi). Missing keys → entry price.
 */
export function computeBasketNav(
  legs: Leg[],
  currentPriceLookup?: Map<string, number>,
): NavBreakdown {
  let nav = 1.0;
  let legsResolved = 0;
  const contributions: LegContribution[] = [];

  for (const leg of legs) {
    const w = Number(leg.weight);
    const entryP = Number(leg.p_market_entry);

    if (leg.outcome === 0) {
      // Resolved NO — we won this leg, captured the full p_market_entry
      // as premium scaled by our share.
      const legPnl = entryP * w;
      nav += legPnl;
      legsResolved += 1;
      contributions.push({
        legIndex: leg.leg_index,
        marketId: leg.market_id,
        status: 'no',
        entryPMarket: entryP,
        currentPMarket: 0,
        weight: w,
        legPnl,
      });
    } else if (leg.outcome === 1) {
      // Resolved YES — we lost the collateral on this leg.
      const legPnl = -(1 - entryP) * w;
      nav += legPnl;
      legsResolved += 1;
      contributions.push({
        legIndex: leg.leg_index,
        marketId: leg.market_id,
        status: 'yes',
        entryPMarket: entryP,
        currentPMarket: 1,
        weight: w,
        legPnl,
      });
    } else {
      // Open leg — mark to market against the latest collector price.
      const cur = currentPriceLookup?.get(leg.market_id);
      const haveCur = typeof cur === 'number' && Number.isFinite(cur) && cur >= 0 && cur <= 1;
      const currentP = haveCur ? (cur as number) : null;
      // No price data → assume flat (no change since entry).
      const effectiveCur = currentP ?? entryP;
      const legPnl = (entryP - effectiveCur) * w;
      nav += legPnl;
      contributions.push({
        legIndex: leg.leg_index,
        marketId: leg.market_id,
        status: 'open',
        entryPMarket: entryP,
        currentPMarket: currentP,
        weight: w,
        legPnl,
      });
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

/**
 * Build a market_id → latest price map for every open leg in a set. One
 * query per unique condition_id; Kalshi legs (no collector coverage)
 * simply don't end up in the map.
 */
export async function loadCurrentPrices(legs: Leg[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const openIds = Array.from(
    new Set(legs.filter((l) => l.outcome == null).map((l) => l.market_id)),
  );
  // Concurrent lookups; tiny dataset (basket size ~30).
  await Promise.all(
    openIds.map(async (mid) => {
      try {
        const pt = await getLatestPricePoint(mid);
        if (pt && Number.isFinite(Number(pt.price))) {
          out.set(mid, Number(pt.price));
        }
      } catch {
        /* leave unmapped → falls back to entry price */
      }
    }),
  );
  return out;
}

/** Snapshot NAV for a single basket and persist a row to `nav_snapshots`. */
export async function snapshotBasket(
  basketId: string,
  priceLookup?: Map<string, number>,
  basketName?: string,
): Promise<NavBreakdown> {
  const legs = await listLegs(basketId);
  if (legs.length === 0) {
    return { basketId, nav: 1, legsResolved: 0, legsTotal: 0, contributions: [] };
  }
  const lookup = priceLookup ?? (await loadCurrentPrices(legs));
  const breakdown = computeBasketNav(legs, lookup);
  await insertNavSnapshot({
    basket_id: basketId,
    nav: breakdown.nav,
    legs_resolved: breakdown.legsResolved,
  });
  const openLegs = breakdown.contributions.filter((c) => c.status === 'open').length;
  const livePriced = breakdown.contributions.filter(
    (c) => c.status === 'open' && c.currentPMarket != null,
  ).length;
  const label = basketName ?? basketId.slice(0, 8);
  console.info(
    `[nav] ${label}: computed NAV ${breakdown.nav.toFixed(4)} from ${livePriced}/${openLegs} legs with live prices` +
      (breakdown.legsResolved > 0 ? ` (+${breakdown.legsResolved} resolved)` : ''),
  );
  return breakdown;
}

/** Snapshot every active and resolving basket. Called by the 2-min cron. */
export async function snapshotAllActive(priceLookup?: Map<string, number>): Promise<number> {
  const active = await listBaskets({ status: 'active' });
  const resolving = await listBaskets({ status: 'resolving' });
  const targets = [...active, ...resolving];
  let n = 0;
  for (const b of targets) {
    try {
      await snapshotBasket(b.id, priceLookup, b.name);
      n += 1;
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
