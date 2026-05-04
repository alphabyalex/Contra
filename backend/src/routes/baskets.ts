/**
 * Baskets API.
 *   GET  /api/baskets              — list active baskets + current NAV
 *   GET  /api/baskets/:id          — basket detail + legs + latest NAV
 *   GET  /api/baskets/:id/nav      — NAV history for charting
 *   POST /api/baskets/construct    — admin: scan + propose a basket
 */

import { Router } from 'express';
import {
  getBasket,
  insertLegs,
  listBaskets,
  listLegs,
  listNavHistory,
  createBasket,
} from '../db/queries';
import { computeBasketNav } from '../services/nav';
import { runScanner } from '../services/cron';
import { buildBasket, type LeverageType } from '../services/basket-builder';

export const basketsRouter: Router = Router();

basketsRouter.get('/', async (_req, res) => {
  try {
    const baskets = await listBaskets();
    const enriched = await Promise.all(
      baskets.map(async (b) => {
        const legs = await listLegs(b.id);
        const breakdown = computeBasketNav(legs);
        return {
          ...b,
          nav: breakdown.nav,
          legs_resolved: breakdown.legsResolved,
          legs_total: breakdown.legsTotal,
          avg_edge: legs.length
            ? legs.reduce((s, l) => s + Number(l.edge), 0) / legs.length
            : 0,
        };
      }),
    );
    res.json({ baskets: enriched });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

basketsRouter.get('/:id', async (req, res) => {
  try {
    const basket = await getBasket(req.params.id);
    if (!basket) return res.status(404).json({ error: 'not_found' });
    const legs = await listLegs(basket.id);
    const breakdown = computeBasketNav(legs);
    res.json({ basket, legs, nav: breakdown.nav, breakdown });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

basketsRouter.get('/:id/nav', async (req, res) => {
  try {
    const limit = Math.min(2000, Number(req.query.limit ?? 720));
    const history = await listNavHistory(req.params.id, limit);
    res.json({ history });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

basketsRouter.post('/construct', async (req, res) => {
  try {
    const leverageType = (req.body?.leverageType ?? 'aggressive') as LeverageType;
    const candidates = await runScanner();
    const proposal = buildBasket(candidates, leverageType, {
      name: req.body?.name,
      category: req.body?.category,
    });
    if (!proposal) {
      return res.status(422).json({ error: 'insufficient_candidates' });
    }
    const basket = await createBasket({
      name: proposal.name,
      description: proposal.description,
      leverage_type: proposal.leverageType,
      category: proposal.category,
      num_legs: proposal.legs.length,
    });
    await insertLegs(
      proposal.legs.map((l) => ({
        basket_id: basket.id,
        leg_index: l.legIndex,
        source: l.source,
        market_id: l.marketId,
        question: l.question,
        outcome_label: l.outcomeLabel,
        p_market_entry: l.pMarketEntry,
        p_model: l.pModel,
        edge: l.edge,
        weight: l.weight,
        outcome: null,
      })),
    );
    res.status(201).json({ basket, proposal });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});
