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

    const basketDetails = await Promise.all(
      basketPositions.map(async (p) => {
        const basket = await getBasket(p.basket_id);
        const legs = basket ? await listLegs(p.basket_id) : [];
        const nav = legs.length ? computeBasketNav(legs).nav : 1;
        const currentValueUsdc = Number(p.tokens_held) * nav;
        const pnl = currentValueUsdc - Number(p.usdc_deposited);
        return {
          ...p,
          basket,
          current_nav: nav,
          current_value_usdc: currentValueUsdc,
          pnl_usdc: pnl,
          pnl_pct: Number(p.usdc_deposited) > 0 ? pnl / Number(p.usdc_deposited) : 0,
          redeemable: basket?.status === 'finalized',
        };
      }),
    );

    const leveragedDetails = await Promise.all(
      leveraged.map(async (lp) => {
        const basket = await getBasket(lp.basket_id);
        const legs = basket ? await listLegs(lp.basket_id) : [];
        const nav = legs.length ? computeBasketNav(legs).nav : 1;
        const value = Number(lp.vault_tokens) * nav;
        return {
          ...lp,
          basket,
          current_nav: nav,
          current_value_usdc: value,
          pnl_usdc: value - Number(lp.debt_usdc) - Number(lp.collateral_usdc),
        };
      }),
    );

    res.json({
      wallet,
      basket_positions: basketDetails,
      leveraged_positions: leveragedDetails,
      recent_transactions: txs,
    });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});
