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
import { buildDepositTransaction, buildLeveragedTransaction, confirmSignature } from '../solana/deposit';
import {
  getBasket,
  getLatestNavSnapshot,
  recordTransaction,
  upsertPosition,
  insertLeveragedPosition,
} from '../db/queries';

export const depositRouter: Router = Router();

const INTEREST_APY = 0.05; // 5% flat APY on borrowed amount
// Liquidation NAV as a fraction of entry NAV, per leverage tier.
const LIQ_NAV_FACTOR: Record<2 | 3, number> = { 2: 0.52, 3: 0.68 };

async function entryNavFor(basketId: string): Promise<number> {
  const snap = await getLatestNavSnapshot(basketId).catch(() => null);
  return snap && Number.isFinite(Number(snap.nav)) && Number(snap.nav) > 0 ? Number(snap.nav) : 1;
}

const prepareSchema = z.object({
  basketId: z.string().uuid(),
  walletAddress: z.string().min(32),
  amountUsdc: z.number().positive(),
  leverage: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
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

    const leverage = parsed.data.leverage ?? 1;

    // Leveraged path: borrow (leverage−1)× from the lending pool and deposit
    // the total exposure via contra_leverage.open_position.
    if (leverage > 1) {
      const lev = leverage as 2 | 3;
      const built = await buildLeveragedTransaction({
        basketUuid: basket.id,
        walletAddress: parsed.data.walletAddress,
        collateralUsdc: parsed.data.amountUsdc,
        leverage: lev,
      });
      const entryNav = await entryNavFor(basket.id);
      const liquidationNav = LIQ_NAV_FACTOR[lev] * entryNav;
      const dailyInterest = (built.borrowedUsdc * INTEREST_APY) / 365;
      return res.json({
        ...built,
        leverage: lev,
        leveraged: true,
        entry_nav: entryNav,
        collateral: built.collateralUsdc,
        borrowed: built.borrowedUsdc,
        total_exposure: built.totalExposureUsdc,
        liquidation_nav: liquidationNav,
        interest_rate: INTEREST_APY,
        daily_interest: dailyInterest,
      });
    }

    // basket.id is the basket UUID — same value used as on-chain basket_uuid seed.
    const result = await buildDepositTransaction({
      basketUuid: basket.id,
      walletAddress: parsed.data.walletAddress,
      amountUsdc: parsed.data.amountUsdc,
    });
    const fee = parsed.data.amountUsdc * 0.005;
    const net = parsed.data.amountUsdc - fee;
    res.json({
      ...result,
      transaction_b64: result.transactionBase64, // snake_case alias
      leveraged: false,
      leverage: 1,
      deposit_amount: parsed.data.amountUsdc,
      fee,
      net,
    });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

const confirmSchema = z.object({
  basketId: z.string().uuid(),
  walletAddress: z.string().min(32),
  amountUsdc: z.number().positive(),
  signature: z.string().min(32),
  leverage: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
  positionPda: z.string().optional(),
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

    const leverage = parsed.data.leverage ?? 1;

    // Leveraged path: record the leveraged_positions row. The CTRS are held
    // by the position PDA, not the user's wallet ATA.
    if (leverage > 1) {
      const lev = leverage as 2 | 3;
      const entryNav = await entryNavFor(parsed.data.basketId);
      const total = parsed.data.amountUsdc * lev;
      const borrowed = total - parsed.data.amountUsdc;
      // Net (post 0.5% vault fee) exposure mints CTRS at entry NAV.
      const vaultTokens = (total * 0.995) / entryNav;
      const healthFactor = borrowed > 0 ? (total * entryNav) / borrowed : Number.POSITIVE_INFINITY;
      await insertLeveragedPosition({
        basket_id: parsed.data.basketId,
        wallet: parsed.data.walletAddress,
        position_pda: parsed.data.positionPda ?? null,
        collateral_usdc: parsed.data.amountUsdc,
        debt_usdc: borrowed,
        vault_tokens: vaultTokens,
        leverage: lev,
        health_factor: Number.isFinite(healthFactor) ? healthFactor : 999,
        liquidated: false,
      });
      await recordTransaction({
        basket_id: parsed.data.basketId,
        wallet: parsed.data.walletAddress,
        type: 'leverage_open',
        usdc_delta: -parsed.data.amountUsdc,
        tokens_delta: vaultTokens,
        tx_signature: parsed.data.signature,
      });
      return res.json({
        status: 'confirmed',
        signature: parsed.data.signature,
        leveraged: true,
        collateral: parsed.data.amountUsdc,
        borrowed,
        total_exposure: total,
        vault_tokens: vaultTokens,
        liquidation_nav: LIQ_NAV_FACTOR[lev] * entryNav,
        daily_interest: (borrowed * INTEREST_APY) / 365,
      });
    }

    // Tokens minted at the current NAV: tokens = usdc / current_nav.
    // First-deposit / pre-snapshot fallback: NAV = 1.0 (Active phase
    // default). Once nav_snapshots starts ticking, later deposits mint
    // proportionally fewer/more tokens.
    const snap = await getLatestNavSnapshot(parsed.data.basketId).catch(() => null);
    const entryNav = snap && Number.isFinite(Number(snap.nav)) && Number(snap.nav) > 0
      ? Number(snap.nav)
      : 1;
    const tokens = parsed.data.amountUsdc / entryNav;

    await upsertPosition({
      basket_id: parsed.data.basketId,
      wallet: parsed.data.walletAddress,
      tokens_delta: tokens,
      usdc_delta: parsed.data.amountUsdc,
      entry_nav: entryNav,
      entry_tx: parsed.data.signature,
    });
    await recordTransaction({
      basket_id: parsed.data.basketId,
      wallet: parsed.data.walletAddress,
      type: 'deposit',
      usdc_delta: -parsed.data.amountUsdc,
      tokens_delta: tokens,
      tx_signature: parsed.data.signature,
    });
    res.json({ status: 'confirmed', signature: parsed.data.signature });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});
