/**
 * Two-step redeem (mark-to-market withdraw) flow.
 *
 *   POST /api/redeem/prepare  — backend computes NAV, builds the
 *                               authority-co-signed VersionedTransaction,
 *                               returns base64 + a fee/payout preview.
 *   POST /api/redeem/confirm  — frontend posts the wallet-signed signature;
 *                               backend confirms landing, reduces the
 *                               position, and records the tx.
 *
 * Frontend never imports Anchor.
 */

import { Router } from 'express';
import { z } from 'zod';
import { PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import { buildRedeemTransaction } from '../solana/redeem';
import { confirmSignature } from '../solana/deposit';
import { getConnection } from '../solana/client';
import {
  getBasket,
  getLatestNavSnapshot,
  listLegs,
  listPositionsByWallet,
  recordTransaction,
  upsertPosition,
} from '../db/queries';
import { computeBasketNav, loadCurrentPrices } from '../services/nav';

export const redeemRouter: Router = Router();

const PROTOCOL_FEE_BPS = 50;
const FEE_RATE = PROTOCOL_FEE_BPS / 10_000; // 0.005

/** Latest NAV: prefer the snapshot, fall back to an on-the-fly compute. */
async function currentNav(basketId: string): Promise<number> {
  const snap = await getLatestNavSnapshot(basketId).catch(() => null);
  if (snap && Number.isFinite(Number(snap.nav)) && Number(snap.nav) > 0) {
    return Number(snap.nav);
  }
  const legs = await listLegs(basketId);
  if (legs.length === 0) return 1;
  const lookup = await loadCurrentPrices(legs).catch(() => undefined);
  const nav = computeBasketNav(legs, lookup).nav;
  return Number.isFinite(nav) && nav > 0 ? nav : 1;
}

async function heldTokens(wallet: string, basketId: string): Promise<number> {
  const positions = await listPositionsByWallet(wallet).catch(() => []);
  const pos = positions.find((p) => p.basket_id === basketId);
  return pos ? Number(pos.tokens_held) : 0;
}

/**
 * Read the user's actual on-chain CTRS balance directly from the SPL
 * token account. Used by /prepare as the source of truth so a stale
 * positions.tokens_held row can never cause a redeem to ask for more
 * tokens than the user holds (which would otherwise burn-fail on-chain
 * with "insufficient funds").
 *
 * Returns null when the ATA doesn't exist or the RPC errors; the caller
 * then falls back to the DB-tracked held figure.
 */
async function onChainCtrsBalance(
  contraMintBase58: string,
  walletAddress: string,
): Promise<number | null> {
  try {
    const conn = getConnection();
    const ata = getAssociatedTokenAddressSync(
      new PublicKey(contraMintBase58),
      new PublicKey(walletAddress),
    );
    const resp = await conn.getTokenAccountBalance(ata, 'confirmed');
    const ui = resp?.value?.uiAmount;
    return typeof ui === 'number' && Number.isFinite(ui) ? ui : null;
  } catch (e) {
    console.warn(`[redeem/prepare] on-chain balance fetch failed: ${(e as Error).message}`);
    return null;
  }
}

const prepareSchema = z
  .object({
    basketId: z.string().uuid(),
    walletAddress: z.string().min(32),
    tokenAmount: z.number().positive().optional(),
    usdcAmount: z.number().positive().optional(),
  })
  .refine((d) => d.tokenAmount != null || d.usdcAmount != null, {
    message: 'tokenAmount or usdcAmount required',
  });

redeemRouter.post('/prepare', async (req, res) => {
  const parsed = prepareSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'bad_input', detail: parsed.error.flatten() });
  }
  const { basketId, walletAddress } = parsed.data;
  try {
    const basket = await getBasket(basketId);
    if (!basket) return res.status(404).json({ error: 'basket_not_found' });
    if (basket.status !== 'active' && basket.status !== 'resolving') {
      return res.status(409).json({ error: 'basket_not_redeemable', status: basket.status });
    }
    if (!basket.vault_pda) {
      return res.status(409).json({ error: 'vault_not_initialized' });
    }

    const nav = await currentNav(basketId);
    const requestedTokenAmount =
      parsed.data.tokenAmount != null
        ? parsed.data.tokenAmount
        : (parsed.data.usdcAmount as number) / nav;

    // On-chain balance is the source of truth. The DB position can drift if
    // a confirm handler missed an update or used the wrong mint formula
    // (deposits formerly recorded usdc/nav, on-chain mints usdc*(1-fee)).
    // If the on-chain balance is lower than the requested amount, clamp the
    // burn to the on-chain figure and log a warning instead of erroring; this
    // makes redeem self-healing. Also push the corrected balance back into
    // positions.tokens_held so the next request sees consistent state.
    const dbHeld = await heldTokens(walletAddress, basketId);
    const onChainHeld = basket.contra_mint
      ? await onChainCtrsBalance(basket.contra_mint, walletAddress)
      : null;
    const sourceOfTruth = onChainHeld != null ? onChainHeld : dbHeld;

    if (onChainHeld != null && Math.abs(onChainHeld - dbHeld) > 1e-6) {
      console.warn(
        `[redeem/prepare] DB/on-chain drift detected basket=${basketId.slice(0, 8)} ` +
          `wallet=${walletAddress.slice(0, 8)} db=${dbHeld} onchain=${onChainHeld} ` +
          `(syncing positions.tokens_held to on-chain)`,
      );
      try {
        await upsertPosition({
          basket_id: basketId,
          wallet: walletAddress,
          tokens_delta: onChainHeld - dbHeld,
          usdc_delta: 0,
        });
      } catch (e) {
        console.warn(`[redeem/prepare] position sync write failed: ${(e as Error).message}`);
      }
    }

    if (sourceOfTruth <= 0) {
      return res
        .status(409)
        .json({ error: 'insufficient_balance', held: sourceOfTruth, requested: requestedTokenAmount });
    }

    let tokenAmount = Math.min(requestedTokenAmount, sourceOfTruth);
    let clamped = false;
    if (requestedTokenAmount > sourceOfTruth + 1e-9) {
      console.warn(
        `[redeem/prepare] clamping burn requested=${requestedTokenAmount} sourceOfTruth=${sourceOfTruth} ` +
          `wallet=${walletAddress.slice(0, 8)} basket=${basketId.slice(0, 8)}`,
      );
      clamped = true;
    }

    const grossUsdc = tokenAmount * nav;
    const fee = grossUsdc * FEE_RATE;
    const netUsdc = grossUsdc - fee;

    const built = await buildRedeemTransaction({
      basketUuid: basketId,
      walletAddress,
      tokenAmount,
      navScaled: Math.round(nav * 1_000_000),
    });

    res.json({
      transaction_b64: built.transactionBase64,
      recentBlockhash: built.recentBlockhash,
      lastValidBlockHeight: built.lastValidBlockHeight,
      tokenAmount,
      requested_token_amount: requestedTokenAmount,
      on_chain_held: onChainHeld,
      db_held: dbHeld,
      clamped_to_on_chain: clamped,
      gross_usdc: grossUsdc,
      fee,
      net_usdc: netUsdc,
      current_nav: nav,
      vault_pda: built.vaultPda,
      contra_mint: built.contraMint,
    });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

const confirmSchema = z.object({
  signature: z.string().min(32),
  walletAddress: z.string().min(32),
  basketId: z.string().uuid(),
  tokenAmount: z.number().positive(),
});

redeemRouter.post('/confirm', async (req, res) => {
  const parsed = confirmSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'bad_input', detail: parsed.error.flatten() });
  }
  const { signature, walletAddress, basketId, tokenAmount } = parsed.data;
  try {
    let confirmed = false;
    for (let i = 0; i < 5; i++) {
      const r = await confirmSignature(signature);
      if (r.confirmed) {
        confirmed = true;
        break;
      }
      if (r.err) return res.status(502).json({ error: 'tx_failed', detail: r.err });
      await new Promise((r) => setTimeout(r, 1500));
    }
    if (!confirmed) return res.status(202).json({ status: 'pending' });

    const nav = await currentNav(basketId);
    const grossUsdc = tokenAmount * nav;
    const netUsdc = grossUsdc - grossUsdc * FEE_RATE;

    // Cost basis of the redeemed slice, for realized P&L.
    const positions = await listPositionsByWallet(walletAddress).catch(() => []);
    const pos = positions.find((p) => p.basket_id === basketId);
    const heldBefore = pos ? Number(pos.tokens_held) : 0;
    const costBasisDeposited = pos ? Number(pos.usdc_deposited) : 0;
    const fraction = heldBefore > 0 ? Math.min(1, tokenAmount / heldBefore) : 0;
    const costBasisRedeemed = costBasisDeposited * fraction;
    const realizedPnl = netUsdc - costBasisRedeemed;

    // Reduce the position: tokens out, cost basis out proportionally.
    await upsertPosition({
      basket_id: basketId,
      wallet: walletAddress,
      tokens_delta: -tokenAmount,
      usdc_delta: -costBasisRedeemed,
    });

    await recordTransaction({
      basket_id: basketId,
      wallet: walletAddress,
      // Redeem is an INFLOW to the user (they receive net USDC). usdc_delta is
      // the change to the user's USDC, so it's positive — deposits are negative.
      type: 'redeem',
      usdc_delta: netUsdc,
      tokens_delta: -tokenAmount,
      tx_signature: signature,
    });

    const closed = heldBefore - tokenAmount <= 1e-6;
    res.json({ success: true, net_usdc: netUsdc, realized_pnl: realizedPnl, closed });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});
