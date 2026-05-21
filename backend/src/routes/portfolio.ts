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
      basketPositions.map(async (p) => {
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
        const currentValueUsdc = tokens * currentNav;
        const pnl = currentValueUsdc - entryUsdc;
        return {
          ...p,
          basket_id: p.basket_id,
          basket_name: basket?.name ?? null,
          basket,
          token_amount: tokens,
          entry_nav: entryNav,
          entry_usdc: entryUsdc,
          current_nav: currentNav,
          current_value_usdc: currentValueUsdc,
          pnl_usdc: pnl,
          pnl_pct: entryUsdc > 0 ? pnl / entryUsdc : 0,
          redeemable: basket?.status === 'finalized',
        };
      }),
    );

    const leveragedDetails = await Promise.all(
      leveraged.map(async (lp) => {
        const [basket, legs, snap] = await Promise.all([
          getBasket(lp.basket_id),
          listLegs(lp.basket_id),
          getLatestNavSnapshot(lp.basket_id).catch(() => null),
        ]);
        const fallbackNav = legs.length ? computeBasketNav(legs).nav : 1;
        const currentNav = snap ? Number(snap.nav) : fallbackNav;
        const value = Number(lp.vault_tokens) * currentNav;
        return {
          ...lp,
          basket,
          current_nav: currentNav,
          current_value_usdc: value,
          pnl_usdc: value - Number(lp.debt_usdc) - Number(lp.collateral_usdc),
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
    const transactions = txs.map((t) => ({
      ...t,
      basket_name: t.basket_id ? basketNameMap.get(t.basket_id) ?? null : null,
      token_amount: Math.abs(Number(t.tokens_delta ?? 0)),
      usdc_amount: Math.abs(Number(t.usdc_delta ?? 0)),
    }));

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
