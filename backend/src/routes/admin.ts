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
  listLegs,
  resolveLegRow,
  updateBasket,
  recordTransaction,
} from '../db/queries';
import {
  sendAddLeg,
  sendActivateVault,
  sendFinalizeVault,
  sendResolveLeg,
} from '../solana/resolve';
import { persistFinalRatio } from '../services/nav';

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
