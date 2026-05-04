/**
 * Leverage API.
 *   POST /api/leverage/prepare     — build open_position tx (base64)
 *   POST /api/leverage/confirm     — record on-chain landing
 *   POST /api/leverage/close       — build close_position tx
 *   GET  /api/leverage/:wallet     — list user's leveraged positions
 *
 * The actual tx-building helpers are stubbed for now — they require the
 * same patterns as solana/deposit.ts but with three additional CPIs and
 * the position USDC + CTRS PDAs initialised first. Wire when the
 * leverage program lands its IDL after `anchor build`.
 */

import { Router } from 'express';
import { z } from 'zod';
import {
  insertLeveragedPosition,
  listLeveragedByWallet,
  recordTransaction,
  updateLeveragedPosition,
} from '../db/queries';

export const leverageRouter: Router = Router();

const prepareSchema = z.object({
  basketId: z.string().uuid(),
  walletAddress: z.string().min(32),
  collateralUsdc: z.number().positive(),
  leverage: z.number().min(1).max(3),
});

leverageRouter.post('/prepare', async (req, res) => {
  const parsed = prepareSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'bad_input', detail: parsed.error.flatten() });
  }
  // TODO: wire buildOpenPositionTx in solana/leverage-tx.ts after IDL lands.
  res.status(501).json({ error: 'not_implemented_yet', hint: 'leverage tx-builder pending IDL sync' });
});

const confirmSchema = z.object({
  basketId: z.string().uuid(),
  walletAddress: z.string().min(32),
  collateralUsdc: z.number().positive(),
  debtUsdc: z.number().nonnegative(),
  vaultTokens: z.number().positive(),
  leverage: z.number().min(1).max(3),
  positionPda: z.string().min(32).optional(),
  signature: z.string().min(32),
});

leverageRouter.post('/confirm', async (req, res) => {
  const parsed = confirmSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'bad_input', detail: parsed.error.flatten() });
  }
  try {
    const pos = await insertLeveragedPosition({
      basket_id: parsed.data.basketId,
      wallet: parsed.data.walletAddress,
      position_pda: parsed.data.positionPda ?? null,
      collateral_usdc: parsed.data.collateralUsdc,
      debt_usdc: parsed.data.debtUsdc,
      vault_tokens: parsed.data.vaultTokens,
      leverage: parsed.data.leverage,
      health_factor: parsed.data.debtUsdc > 0 ? parsed.data.vaultTokens / parsed.data.debtUsdc : 9999,
      closed_at: null,
      closed_pnl_usdc: null,
      liquidated: false,
    });
    await recordTransaction({
      basket_id: parsed.data.basketId,
      wallet: parsed.data.walletAddress,
      type: 'leverage_open',
      usdc_delta: -parsed.data.collateralUsdc,
      tokens_delta: parsed.data.vaultTokens,
      tx_signature: parsed.data.signature,
    });
    res.status(201).json({ position: pos });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

leverageRouter.post('/close', async (req, res) => {
  const closeSchema = z.object({
    positionId: z.string().uuid(),
    signature: z.string().min(32),
    pnlUsdc: z.number().optional(),
  });
  const parsed = closeSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'bad_input', detail: parsed.error.flatten() });
  }
  try {
    const pos = await updateLeveragedPosition(parsed.data.positionId, {
      closed_at: new Date().toISOString(),
      closed_pnl_usdc: parsed.data.pnlUsdc ?? null,
    });
    if (!pos) return res.status(404).json({ error: 'not_found' });
    await recordTransaction({
      basket_id: pos.basket_id,
      wallet: pos.wallet,
      type: 'leverage_close',
      usdc_delta: parsed.data.pnlUsdc ?? null,
      tokens_delta: -pos.vault_tokens,
      tx_signature: parsed.data.signature,
    });
    res.json({ position: pos });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

leverageRouter.get('/:wallet', async (req, res) => {
  try {
    const list = await listLeveragedByWallet(req.params.wallet);
    res.json({ positions: list });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});
