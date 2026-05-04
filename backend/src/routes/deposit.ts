/**
 * Two-step deposit flow.
 *
 *   POST /api/deposit/prepare  — backend builds VersionedTransaction,
 *                                returns base64 + meta
 *   POST /api/deposit/confirm  — frontend posts back the wallet-signed
 *                                signature; backend confirms landing and
 *                                writes the position + tx audit row
 *
 * Frontend never imports Anchor. This is the only path that mutates
 * basket positions on-chain for end users (admin actions go through /admin).
 */

import { Router } from 'express';
import { z } from 'zod';
import { buildDepositTransaction, confirmSignature } from '../solana/deposit';
import { getBasket, recordTransaction, upsertPosition } from '../db/queries';

export const depositRouter: Router = Router();

const prepareSchema = z.object({
  basketId: z.string().uuid(),
  walletAddress: z.string().min(32),
  amountUsdc: z.number().positive(),
});

depositRouter.post('/prepare', async (req, res) => {
  const parsed = prepareSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'bad_input', detail: parsed.error.flatten() });
  }
  try {
    const basket = await getBasket(parsed.data.basketId);
    if (!basket) return res.status(404).json({ error: 'basket_not_found' });
    if (basket.status !== 'active') {
      return res.status(409).json({ error: 'basket_not_active', status: basket.status });
    }
    if (!basket.vault_pda) {
      return res.status(409).json({ error: 'vault_not_initialized' });
    }
    // basket.id is the basket UUID — same value used as on-chain basket_uuid seed.
    const result = await buildDepositTransaction({
      basketUuid: basket.id,
      walletAddress: parsed.data.walletAddress,
      amountUsdc: parsed.data.amountUsdc,
    });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

const confirmSchema = z.object({
  basketId: z.string().uuid(),
  walletAddress: z.string().min(32),
  amountUsdc: z.number().positive(),
  signature: z.string().min(32),
});

depositRouter.post('/confirm', async (req, res) => {
  const parsed = confirmSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'bad_input', detail: parsed.error.flatten() });
  }
  try {
    // Poll a few times — RPC sometimes hasn't propagated yet.
    let confirmed = false;
    for (let i = 0; i < 5; i++) {
      const r = await confirmSignature(parsed.data.signature);
      if (r.confirmed) {
        confirmed = true;
        break;
      }
      if (r.err) {
        return res.status(502).json({ error: 'tx_failed', detail: r.err });
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
    if (!confirmed) return res.status(202).json({ status: 'pending' });

    // Mint was 1:1 USDC → CTRS during Active phase.
    await upsertPosition({
      basket_id: parsed.data.basketId,
      wallet: parsed.data.walletAddress,
      tokens_delta: parsed.data.amountUsdc,
      usdc_delta: parsed.data.amountUsdc,
      entry_nav: 1,
      entry_tx: parsed.data.signature,
    });
    await recordTransaction({
      basket_id: parsed.data.basketId,
      wallet: parsed.data.walletAddress,
      type: 'deposit',
      usdc_delta: -parsed.data.amountUsdc,
      tokens_delta: parsed.data.amountUsdc,
      tx_signature: parsed.data.signature,
    });
    res.json({ status: 'confirmed', signature: parsed.data.signature });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});
