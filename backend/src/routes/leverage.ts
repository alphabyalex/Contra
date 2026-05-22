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
  getLeveragedPositionById,
  getBasket,
  getLatestNavSnapshot,
  listLegs,
  recordTransaction,
  updateLeveragedPosition,
} from '../db/queries';
import { computeBasketNav } from '../services/nav';

export const leverageRouter: Router = Router();

const LIQ_NAV_FACTOR: Record<number, number> = { 2: 0.52, 3: 0.68 };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Compute the live, derived view of a leveraged position. */
async function describePosition(lp: import('../db/queries').LeveragedPosition) {
  const [basket, legs, snap] = await Promise.all([
    getBasket(lp.basket_id),
    listLegs(lp.basket_id),
    getLatestNavSnapshot(lp.basket_id).catch(() => null),
  ]);
  const currentNav = snap ? Number(snap.nav) : (legs.length ? computeBasketNav(legs).nav : 1);
  const collateral = Number(lp.collateral_usdc);
  const borrowed = Number(lp.debt_usdc);
  const tokens = Number(lp.vault_tokens);
  const total = collateral + borrowed;
  const entryNav = tokens > 0 ? (total * 0.995) / tokens : 1;
  const lev = Number(lp.leverage) || 2;
  const currentValue = total * (currentNav / entryNav);
  const daysOpen = lp.opened_at ? Math.max(0, (Date.now() - Date.parse(lp.opened_at)) / 86_400_000) : 0;
  const interestAccrued = borrowed * 0.05 * (daysOpen / 365);
  const netValue = currentValue - borrowed - interestAccrued;
  const unrealizedPnl = netValue - collateral;
  const health = currentValue > 0 ? (currentValue - borrowed) / currentValue : 0;
  const liquidationNav = (LIQ_NAV_FACTOR[lev] ?? 0.52) * entryNav;
  return {
    id: lp.id,
    basket_id: lp.basket_id,
    basket_name: basket?.name ?? null,
    wallet: lp.wallet,
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
    health_pct: health * 100,
    is_at_risk: currentNav <= liquidationNav * 1.1,
    opened_at: lp.opened_at,
    closed_at: lp.closed_at,
    liquidated: lp.liquidated,
  };
}

/** Close-preview math shared by /close. */
function closePreview(p: Awaited<ReturnType<typeof describePosition>>, tokensToClose: number) {
  const frac = p.token_amount > 0 ? Math.min(1, tokensToClose / p.token_amount) : 0;
  const gross = tokensToClose * p.current_nav;
  const repay = p.borrowed_usdc * frac;
  const interest = p.interest_accrued * frac;
  const fee = Math.max(0, (gross - repay)) * 0.005;
  const net = gross - repay - interest - fee;
  return { tokensClosed: tokensToClose, gross, repay, interest, fee, net };
}

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

// POST /api/leverage/:id/close — preview the close (gross/repay/interest/fee/net).
leverageRouter.post('/:id/close', async (req, res) => {
  const schema = z.object({ tokenAmount: z.number().positive().optional(), usdcAmount: z.number().positive().optional() });
  const parsed = schema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: 'bad_input', detail: parsed.error.flatten() });
  try {
    const lp = await getLeveragedPositionById(req.params.id);
    if (!lp || lp.closed_at) return res.status(404).json({ error: 'not_found' });
    const p = await describePosition(lp);
    let tokensToClose = parsed.data.tokenAmount ?? null;
    if (tokensToClose == null && parsed.data.usdcAmount != null) {
      // Solve net(tokens) for the requested USDC; net ≈ tokens×nav×(1−fee) − proportional repay/interest.
      tokensToClose = p.current_nav > 0 ? parsed.data.usdcAmount / p.current_nav : 0;
    }
    if (tokensToClose == null) tokensToClose = p.token_amount; // default: full close
    tokensToClose = Math.min(tokensToClose, p.token_amount);
    res.json({ position: p, preview: closePreview(p, tokensToClose) });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

// POST /api/leverage/:id/confirm — record the close in the DB.
leverageRouter.post('/:id/confirm', async (req, res) => {
  const schema = z.object({ signature: z.string().min(8), tokenAmount: z.number().positive().optional() });
  const parsed = schema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: 'bad_input', detail: parsed.error.flatten() });
  try {
    const lp = await getLeveragedPositionById(req.params.id);
    if (!lp) return res.status(404).json({ error: 'not_found' });
    const p = await describePosition(lp);
    const tokensToClose = Math.min(parsed.data.tokenAmount ?? p.token_amount, p.token_amount);
    const prev = closePreview(p, tokensToClose);
    const remaining = p.token_amount - tokensToClose;
    const fullClose = remaining <= 1e-6;
    const updated = await updateLeveragedPosition(req.params.id, {
      vault_tokens: fullClose ? 0 : remaining,
      closed_at: fullClose ? new Date().toISOString() : null,
      closed_pnl_usdc: fullClose ? prev.net - p.collateral_usdc : null,
    });
    // No transaction row is recorded for a DB-settled close — there is no
    // real on-chain signature yet, and fake "pending-…" rows pollute history.
    res.json({ success: true, net_usdc: prev.net, closed: fullClose, position: updated });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

// GET /api/leverage/:idOrWallet — UUID → single position detail; else list by wallet.
leverageRouter.get('/:idOrWallet', async (req, res) => {
  try {
    const param = req.params.idOrWallet;
    if (UUID_RE.test(param)) {
      const lp = await getLeveragedPositionById(param);
      if (!lp) return res.status(404).json({ error: 'not_found' });
      return res.json({ position: await describePosition(lp) });
    }
    const list = await listLeveragedByWallet(param);
    res.json({ positions: list });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});
