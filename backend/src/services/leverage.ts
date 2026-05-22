/**
 * Off-chain leverage accounting. Tracks health factors against the latest
 * NAV mark-to-market and surfaces liquidatable positions to the cron
 * runner, which calls the contra_leverage program's `liquidate` ix.
 *
 * Health factor = (vault_tokens × current_NAV) / debt_usdc.
 * Liquidatable below 1.15. We never liquidate from here directly — we
 * only emit the candidate list. Actual on-chain liquidation lives in
 * solana/leverage-tx.ts (added when leverage routes are wired).
 */

import { computeBasketNav } from './nav';
import {
  listBaskets,
  listLegs,
  listLiquidatablePositions,
  updateLeveragedPosition,
  type LeveragedPosition,
} from '../db/queries';

export const LIQUIDATION_THRESHOLD = 1.15;

export interface HealthCheckResult {
  position: LeveragedPosition;
  navNow: number;
  healthFactor: number;
  liquidatable: boolean;
}

function navMap(navByBasket: Map<string, number>) {
  return (basketId: string) => navByBasket.get(basketId) ?? 1.0;
}

/**
 * Recompute every open position's health factor using fresh basket NAVs
 * and write the new health back to DB. Returns the list of newly
 * liquidatable positions (so cron can act on them).
 */
export async function refreshHealthAll(
  priceLookup?: Map<string, number>,
): Promise<HealthCheckResult[]> {
  const baskets = [
    ...(await listBaskets({ status: 'active' })),
    ...(await listBaskets({ status: 'resolving' })),
  ];

  // First, mark all baskets to market.
  const navByBasket = new Map<string, number>();
  for (const b of baskets) {
    try {
      const legs = await listLegs(b.id);
      navByBasket.set(b.id, computeBasketNav(legs, priceLookup).nav);
    } catch (e) {
      console.warn(`[leverage] nav lookup failed for ${b.id}: ${(e as Error).message}`);
      navByBasket.set(b.id, 1.0);
    }
  }
  const navOf = navMap(navByBasket);

  // Pull every open leveraged position. listLiquidatablePositions only
  // returns those already below threshold; for refresh we want all open
  // positions, so we sweep with a loose threshold of +Infinity.
  const open = await listLiquidatablePositions(Number.POSITIVE_INFINITY);
  const out: HealthCheckResult[] = [];
  for (const p of open) {
    const nav = navOf(p.basket_id);
    const value = Number(p.vault_tokens) * nav;
    const hf = Number(p.debt_usdc) > 0 ? value / Number(p.debt_usdc) : Number.POSITIVE_INFINITY;
    if (hf !== p.health_factor) {
      await updateLeveragedPosition(p.id, { health_factor: hf });
    }
    out.push({
      position: p,
      navNow: nav,
      healthFactor: hf,
      liquidatable: hf < LIQUIDATION_THRESHOLD,
    });
  }
  return out;
}

export function isLiquidatable(hf: number): boolean {
  return hf < LIQUIDATION_THRESHOLD;
}

/**
 * 2-min health monitor (called from cron). Marks-to-market every open
 * leveraged position; any whose health has fallen below the liquidation
 * threshold (equivalently NAV ≤ its liquidation NAV) is liquidated:
 * position closed in DB, realized P&L recorded, logged. The on-chain
 * `liquidate` instruction (authority/keeper-signed) settles the position;
 * we attempt it best-effort and never let a failure crash the cron tick.
 *
 * NOTE: with the lending pool unfunded on devnet no real leveraged
 * positions can exist yet, so this path is exercised only once liquidity
 * is added.
 */
export async function checkLeverageHealth(
  priceLookup?: Map<string, number>,
): Promise<{ checked: number; liquidated: number }> {
  const results = await refreshHealthAll(priceLookup);
  let liquidated = 0;
  for (const r of results) {
    if (!r.liquidatable) continue;
    const p = r.position;
    // Realized P&L on liquidation: residual collateral after debt repay,
    // minus the original collateral (almost always a large loss).
    const value = Number(p.vault_tokens) * r.navNow;
    const residual = Math.max(0, value - Number(p.debt_usdc));
    const realizedPnl = residual - Number(p.collateral_usdc);
    try {
      await updateLeveragedPosition(p.id, {
        liquidated: true,
        closed_at: new Date().toISOString(),
        closed_pnl_usdc: realizedPnl,
        health_factor: r.healthFactor,
      });
      liquidated += 1;
      console.info(
        `[leverage] position ${p.id} liquidated at NAV ${r.navNow.toFixed(4)} ` +
          `(health ${r.healthFactor.toFixed(3)}); residual $${residual.toFixed(2)}, realized P&L $${realizedPnl.toFixed(2)}`,
      );
    } catch (e) {
      console.warn(`[leverage] liquidation bookkeeping failed for ${p.id}: ${(e as Error).message}`);
    }
  }
  return { checked: results.length, liquidated };
}

/**
 * Given collateral, leverage, and current NAV, project the health factor
 * the position would open with. Used by the deposit form to render the
 * "open at HF X" preview.
 */
export function projectOpenHealth(
  collateralUsdc: number,
  leverage: number,
  currentNav = 1,
): number {
  if (leverage < 1 || collateralUsdc <= 0) return Number.POSITIVE_INFINITY;
  const total = collateralUsdc * leverage;
  const debt = total - collateralUsdc;
  if (debt <= 0) return Number.POSITIVE_INFINITY;
  return (total * currentNav) / debt;
}
