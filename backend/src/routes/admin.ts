/**
 * Admin API — authority-signed actions. Gate with ADMIN_TOKEN header.
 *
 *   POST /api/admin/init-vault     — runs the 3-step vault init flow,
 *                                    then add_leg ×N and activate_vault
 *   POST /api/admin/resolve-leg    — authority resolves a leg
 *   POST /api/admin/finalize       — authority finalizes a vault
 *
 * Auth: requires `x-admin-token` header to match ADMIN_TOKEN env var. If
 * ADMIN_TOKEN is unset (dev), the gate is open and the route logs a warning.
 */

import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import {
  getBasket,
  listBaskets,
  listLegs,
  listScreenedMarkets,
  resolveLegRow,
  updateBasket,
  recordTransaction,
  getLatestNavSnapshot,
} from '../db/queries';
import { computeBasketNav } from '../services/nav';
import {
  sendAddLeg,
  sendActivateVault,
  sendFinalizeVault,
  sendResolveLeg,
} from '../solana/resolve';
import { persistFinalRatio } from '../services/nav';
import { weeklyScreener } from '../services/cron';
import { scoreAllMarkets, classifyCategory } from '../services/ml-scorer';
import { constructBasket, constructLongBasket, seedBasket, type BasketDefinition } from '../services/basket-builder';
import {
  getAllActiveMarkets as getAllPoly,
  flattenOutcomes as flattenPoly,
  daysToClose,
} from '../services/polymarket';
import { listTrackedMarkets } from '../db/queries';

export const adminRouter: Router = Router();

function requireAdmin(req: Request, res: Response, next: NextFunction) {
  const expected = process.env.ADMIN_TOKEN?.trim();
  if (!expected) {
    if (process.env.NODE_ENV === 'production') {
      return res.status(503).json({ error: 'admin_disabled', detail: 'ADMIN_TOKEN unset in prod' });
    }
    console.warn('[admin] ADMIN_TOKEN unset — admin routes are OPEN in dev');
    return next();
  }
  const got = req.header('x-admin-token');
  if (got !== expected) return res.status(401).json({ error: 'unauthorized' });
  next();
}

adminRouter.use(requireAdmin);

/** GET /api/admin/baskets — all baskets with leg count + current NAV. */
adminRouter.get('/baskets', async (_req, res) => {
  try {
    const baskets = await listBaskets();
    const out = await Promise.all(
      baskets.map(async (b) => {
        const [legs, snap] = await Promise.all([
          listLegs(b.id).catch(() => []),
          getLatestNavSnapshot(b.id).catch(() => null),
        ]);
        const nav = snap ? Number(snap.nav) : (legs.length ? computeBasketNav(legs).nav : 1);
        return {
          id: b.id,
          name: b.name,
          status: b.status,
          num_legs: b.num_legs,
          legs_count: legs.length,
          current_nav: nav,
          vault_pda: b.vault_pda ?? null,
          contra_mint: b.contra_mint ?? null,
        };
      }),
    );
    res.json({ baskets: out });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

/**
 * Multi-tx orchestration. Caller is expected to have already deposited
 * the rent on-chain via the vault init scripts; this route assumes the
 * three init ixs (initialize_vault, initialize_contra_mint,
 * initialize_vault_tokens) have been run by `scripts/init-vaults.ts`.
 *
 * Here we only call add_leg for every leg in DB and then activate_vault.
 * Splitting init from leg loading lets us retry leg loading without
 * paying re-init rent.
 */
adminRouter.post('/init-vault', async (req, res) => {
  const schema = z.object({ basketId: z.string().uuid() });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'bad_input', detail: parsed.error.flatten() });
  try {
    const basket = await getBasket(parsed.data.basketId);
    if (!basket) return res.status(404).json({ error: 'not_found' });
    const legs = await listLegs(basket.id);
    if (legs.length === 0) return res.status(409).json({ error: 'no_legs' });
    if (basket.status !== 'initializing') {
      return res.status(409).json({ error: 'wrong_status', status: basket.status });
    }

    const sigs: string[] = [];
    for (const leg of legs) {
      const sig = await sendAddLeg(
        basket.id,
        leg.leg_index,
        Math.round(Number(leg.weight) * 1_000_000),
        Math.max(1, Math.min(999_999, Math.round(Number(leg.p_market_entry) * 1_000_000))),
      );
      sigs.push(sig);
    }
    const activate = await sendActivateVault(basket.id);
    sigs.push(activate);
    await updateBasket(basket.id, { status: 'active', activated_at: new Date().toISOString() });
    res.json({ status: 'active', signatures: sigs });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

adminRouter.post('/resolve-leg', async (req, res) => {
  const schema = z.object({
    basketId: z.string().uuid(),
    legIndex: z.number().int().nonnegative(),
    outcome: z.union([z.literal(0), z.literal(1)]),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'bad_input', detail: parsed.error.flatten() });
  try {
    const sig = await sendResolveLeg(parsed.data.basketId, parsed.data.legIndex, parsed.data.outcome);
    await resolveLegRow(parsed.data.basketId, parsed.data.legIndex, parsed.data.outcome);
    const basket = await getBasket(parsed.data.basketId);
    if (basket && basket.status === 'active') {
      await updateBasket(basket.id, { status: 'resolving' });
    }
    await recordTransaction({
      basket_id: parsed.data.basketId,
      wallet: 'authority',
      type: 'resolve_leg',
      tx_signature: sig,
    });
    res.json({ signature: sig });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

/**
 * Manual trigger for the weekly screener. Same pipeline as the Sunday 02:00
 * cron job — useful for kicking off a screen on demand after deploy.
 *
 * Auth (dev-friendly): if ADMIN_TOKEN is set, require x-admin-token to
 * match. If ADMIN_TOKEN is unset, allow the call through — devnet only,
 * security not a concern here. Note this also bypasses the route-level
 * requireAdmin gate, so this endpoint is reachable as soon as the backend
 * boots, with or without ADMIN_TOKEN.
 */
adminRouter.post('/run-screener', (req, res, next) => {
  const expected = process.env.ADMIN_TOKEN?.trim();
  if (expected && req.header('x-admin-token') !== expected) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  return next();
}, async (_req, res) => {
  if (!process.env.ANTHROPIC_API_KEY?.trim()) {
    return res.status(503).json({ error: 'anthropic_api_key_missing' });
  }
  try {
    const summary = await weeklyScreener();
    res.json({
      candidates: summary.candidates,
      screened: summary.screened,
      excluded: summary.excluded,
      scored: summary.scored,
      errors: summary.errors,
    });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

/**
 * Rescore every screened market against the current calibration model.
 * Pulls live Polymarket metadata so the layered model has volume +
 * days_to_close + category for each candidate. Idempotent — uses
 * upsertScoredMarket on condition_id.
 */
adminRouter.post('/rescore', async (_req, res) => {
  try {
    const [screened, polyMarkets, tracked] = await Promise.all([
      listScreenedMarkets(),
      getAllPoly().catch(() => []),
      listTrackedMarkets().catch(() => []),
    ]);

    // Build a metadata lookup keyed by condition_id from live Polymarket data.
    interface Meta { volume: number | null; days_to_close: number | null; category: string | null }
    const metaById = new Map<string, Meta>();
    for (const m of polyMarkets) {
      const flat = flattenPoly(m);
      const o = flat[0]; // YES side suffices for volume + endDate (same per market)
      if (!o) continue;
      const days = daysToClose(o.endDateIso);
      metaById.set(o.conditionId, {
        volume: o.volumeUsd ?? null,
        days_to_close: days != null ? Math.round(days) : null,
        category: classifyCategory(o.question),
      });
    }
    // Fallback to tracked_markets resolution_date for anything not in the live snapshot.
    const trackedById = new Map(tracked.map((t) => [t.condition_id, t]));

    const eligible = screened.filter((s) => !s.excluded || s.impossible);
    const inputs = eligible.map((s) => {
      const meta = metaById.get(s.condition_id);
      const tm = trackedById.get(s.condition_id);
      let days = meta?.days_to_close ?? null;
      if (days == null && tm?.resolution_date) {
        days = Math.max(0, Math.round((Date.parse(tm.resolution_date) - Date.now()) / 86_400_000));
      }
      return {
        screened: s,
        volume: meta?.volume ?? null,
        days_to_close: days,
        category: meta?.category ?? classifyCategory(s.question),
      };
    });

    const result = await scoreAllMarkets(inputs);
    res.json({
      total_screened: screened.length,
      candidates: eligible.length,
      scored: result.scored.length,
      included: result.included,
      impossible_included: result.impossible_included,
      hard_excluded: result.hard_excluded,
      live_metadata_hits: inputs.filter((i) => i.volume != null).length,
    });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

/**
 * Construct a basket definition without writing anything to the DB.
 * Returns the proposed leg list + weights for human review.
 */
adminRouter.post('/construct-basket', async (req, res) => {
  const schema = z.object({ type: z.enum(['short', 'mid', 'long']) });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'bad_input', detail: parsed.error.flatten() });
  try {
    const def =
      parsed.data.type === 'long'
        ? await constructLongBasket()
        : await constructBasket(parsed.data.type);
    if (!def) return res.status(422).json({ error: 'insufficient_legs' });
    res.json(def);
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

/**
 * Persist a previously-constructed basket. Body is the full
 * BasketDefinition returned by /construct-basket. Returns the new
 * basket_id + leg count.
 */
adminRouter.post('/seed-basket', async (req, res) => {
  // Light shape check — full structural validation is on the builder side.
  const def = req.body?.definition ?? req.body;
  if (!def || !Array.isArray(def.legs) || typeof def.name !== 'string') {
    return res.status(400).json({ error: 'bad_input', detail: 'missing definition or legs[]' });
  }
  try {
    const basketId = await seedBasket(def as BasketDefinition);
    res.json({ basket_id: basketId, name: def.name, legs_count: def.legs.length });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

adminRouter.post('/finalize', async (req, res) => {
  const schema = z.object({ basketId: z.string().uuid() });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'bad_input', detail: parsed.error.flatten() });
  try {
    const sig = await sendFinalizeVault(parsed.data.basketId);
    const legs = await listLegs(parsed.data.basketId);
    let ratioScaled = 0;
    for (const leg of legs) {
      if (leg.outcome === 0) {
        const w = Math.round(Number(leg.weight) * 1_000_000);
        const p = Math.max(1, Math.round(Number(leg.p_market_entry) * 1_000_000));
        ratioScaled += Math.floor((w * 1_000_000) / p);
      }
    }
    const ratio = ratioScaled / 1_000_000 / 1_000_000;
    await persistFinalRatio(parsed.data.basketId, ratio);
    await recordTransaction({
      basket_id: parsed.data.basketId,
      wallet: 'authority',
      type: 'finalize',
      tx_signature: sig,
    });
    res.json({ signature: sig, payout_ratio: ratio });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});
