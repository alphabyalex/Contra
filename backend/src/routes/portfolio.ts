/**
 * Portfolio API.
 *   GET /api/portfolio/:wallet — every position (basket + leveraged) for a wallet,
 *                                joined with current basket NAV for P&L computation.
 */

import { Router } from 'express';
import {
  listPositionsByWallet,
  listLeveragedByWallet,
  getBasket,
  getLatestNavSnapshot,
  listLegs,
  listTransactionsByWallet,
} from '../db/queries';
import { computeBasketNav } from '../services/nav';

export const portfolioRouter: Router = Router();

portfolioRouter.get('/:wallet', async (req, res) => {
  try {
    const wallet = req.params.wallet;
    const [basketPositions, leveraged, txs] = await Promise.all([
      listPositionsByWallet(wallet),
      listLeveragedByWallet(wallet),
      listTransactionsByWallet(wallet, 50),
    ]);

    // Current NAV per position is read from the latest nav_snapshots row
    // (written every 2 min by the NAV cron, mark-to-market against the
    // live Polymarket price feed). The legs-based recompute is a fallback
    // for the seconds-window after a basket activates but before the
    // first snapshot has been persisted.
    const basketDetails = await Promise.all(
      basketPositions
        // Phase 3: never return fully-redeemed / zero-balance positions.
        .filter((p) => Number(p.tokens_held ?? 0) > 0)
        .map(async (p) => {
        const [basket, legs, snap] = await Promise.all([
          getBasket(p.basket_id),
          listLegs(p.basket_id),
          getLatestNavSnapshot(p.basket_id).catch(() => null),
        ]);
        const fallbackNav = legs.length ? computeBasketNav(legs).nav : 1;
        const currentNav = snap ? Number(snap.nav) : fallbackNav;
        const tokens = Number(p.tokens_held);
        const entryNav = Number(p.entry_nav ?? 1);
        const entryUsdc = Number(p.usdc_deposited);
        // Cost basis = entry NAV × tokens STILL held (survives partial redeems
        // correctly — `usdc_deposited` is the original deposit and would
        // overstate the basis after a partial sell).
        const costBasis = entryNav * tokens;
        const currentValueUsdc = tokens * currentNav;
        const pnl = currentValueUsdc - costBasis;
        return {
          ...p,
          basket_id: p.basket_id,
          basket_name: basket?.name ?? null,
          basket,
          token_amount: tokens,
          entry_nav: entryNav,
          entry_usdc: entryUsdc,
          cost_basis: costBasis,
          current_nav: currentNav,
          current_value_usdc: currentValueUsdc,
          unrealized_pnl: pnl,
          pnl_usdc: pnl,
          // P&L % tracks NAV movement from entry.
          pnl_pct: entryNav > 0 ? (currentNav - entryNav) / entryNav : 0,
          redeemable: basket?.status === 'finalized',
        };
      }),
    );

    const LIQ_NAV_FACTOR: Record<number, number> = { 2: 0.52, 3: 0.68 };
    const leveragedDetails = await Promise.all(
      leveraged
        .filter((lp) => !lp.liquidated && !lp.closed_at)
        .map(async (lp) => {
          const [basket, legs, snap] = await Promise.all([
            getBasket(lp.basket_id),
            listLegs(lp.basket_id),
            getLatestNavSnapshot(lp.basket_id).catch(() => null),
          ]);
          const fallbackNav = legs.length ? computeBasketNav(legs).nav : 1;
          const currentNav = snap ? Number(snap.nav) : fallbackNav;

          const collateral = Number(lp.collateral_usdc);
          const borrowed = Number(lp.debt_usdc);
          const tokens = Number(lp.vault_tokens);
          const total = collateral + borrowed;
          // entry_nav recovered from the tokens minted at open (net of 0.5% fee).
          const entryNav = tokens > 0 ? (total * 0.995) / tokens : 1;
          const lev = Number(lp.leverage) || 2;

          const currentValue = total * (currentNav / entryNav);
          const daysOpen = lp.opened_at
            ? Math.max(0, (Date.now() - Date.parse(lp.opened_at)) / 86_400_000)
            : 0;
          const interestAccrued = borrowed * 0.05 * (daysOpen / 365);
          const netValue = currentValue - borrowed - interestAccrued;
          const unrealizedPnl = netValue - collateral;
          const health = currentValue > 0 ? (currentValue - borrowed) / currentValue : 0;
          const liquidationNav = (LIQ_NAV_FACTOR[lev] ?? 0.52) * entryNav;
          const isAtRisk = currentNav <= liquidationNav * 1.1;

          return {
            ...lp,
            basket,
            basket_name: basket?.name ?? null,
            leverage: lev,
            collateral_usdc: collateral,
            borrowed_usdc: borrowed,
            total_exposure: total,
            token_amount: tokens,
            entry_nav: entryNav,
            current_nav: currentNav,
            liquidation_nav: liquidationNav,
            interest_accrued: interestAccrued,
            daily_interest: (borrowed * 0.05) / 365,
            current_value_usdc: currentValue,
            net_value: netValue,
            unrealized_pnl: unrealizedPnl,
            pnl_usdc: unrealizedPnl,
            health_pct: health * 100,
            is_at_risk: isAtRisk,
            opened_at: lp.opened_at,
          };
        }),
    );

    // Build a basket_id → name map so the transactions array can render
    // human-readable basket names + token denominations without extra
    // round-trips from the frontend.
    const basketNameMap = new Map<string, string>();
    for (const bd of basketDetails) {
      if (bd.basket?.id && bd.basket?.name) basketNameMap.set(bd.basket.id, bd.basket.name);
    }
    // basket_id → leverage multiple, so leverage_open txs can show 2x/3x
    // (the transaction row itself doesn't store leverage_bps).
    const leverageByBasket = new Map<string, number>();
    for (const lp of leveragedDetails) {
      if (lp.basket_id) leverageByBasket.set(lp.basket_id, Number(lp.leverage) || 1);
    }
    const transactions = txs
      // Only real on-chain signatures — drop DB-settled synthetic rows
      // ("pending-…" closes, "auto_redeem_…" finalizes).
      .filter((t) => {
        const sig = t.tx_signature ?? '';
        return sig !== '' && !sig.startsWith('pending-') && !sig.startsWith('auto_redeem');
      })
      .map((t) => {
      const isLev = t.type === 'leverage_open' || t.type === 'leverage_close';
      const lev = isLev && t.basket_id ? leverageByBasket.get(t.basket_id) ?? 2 : 1;
      return {
        ...t,
        basket_name: t.basket_id ? basketNameMap.get(t.basket_id) ?? null : null,
        token_amount: Math.abs(Number(t.tokens_delta ?? 0)),
        usdc_amount: Math.abs(Number(t.usdc_delta ?? 0)),
        leverage: lev,
        leverage_bps: lev * 10_000,
      };
    });

    res.json({
      wallet,
      basket_positions: basketDetails,
      leveraged_positions: leveragedDetails,
      recent_transactions: transactions,
    });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});
