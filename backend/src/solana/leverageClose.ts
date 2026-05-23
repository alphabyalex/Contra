/**
 * Builds the user-signed VersionedTransaction for contra_leverage's
 * `close_position` — the on-chain unwind that the frontend hands to Phantom.
 *
 * close_position is a FULL unwind (no token-amount arg): it burns all of the
 * position's CTRS via the vault (exit_active while Active, redeem once
 * finalized), repays the lending-pool debt, and refunds the remainder to the
 * user's USDC ATA — all atomically. The backend only needs to wire the
 * accounts and set `vault_finalized`; no authority co-sign.
 *
 * Mirrors buildLeveragedTransaction in solana/deposit.ts.
 */

import {
  ComputeBudgetProgram,
  Connection,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import type { Program } from '@coral-xyz/anchor';
import { getConnection, getLeverageProgram, usdcMint } from './client';
import {
  deriveContraMint,
  deriveVaultPda,
  deriveVaultUsdc,
  derivePosition,
  derivePositionUsdc,
  derivePositionCtrs,
  deriveLendingPool,
  derivePoolUsdc,
  deriveBorrowerAuthority,
  contraVaultProgramId,
  contraLendingProgramId,
} from './pda';
import {
  getLeveragedPositionById,
  getBasket,
  getLatestNavSnapshot,
  listLegs,
} from '../db/queries';
import { computeBasketNav } from '../services/nav';

const FEE_RATE = 0.005; // 0.5% vault redeem fee
const INTEREST_APY = 0.05;

export interface ClosePreview {
  tokensClosed: number;
  gross: number;
  repay: number;
  interest: number;
  fee: number;
  net: number;
}

export interface BuildCloseResult {
  transactionBase64: string;
  recentBlockhash: string;
  lastValidBlockHeight: number;
  positionPda: string;
  vaultFinalized: boolean;
  currentNav: number;
  preview: ClosePreview;
}

/** Latest NAV for a basket: prefer the snapshot, fall back to legs compute. */
async function currentNav(basketId: string): Promise<number> {
  const [snap, legs] = await Promise.all([
    getLatestNavSnapshot(basketId).catch(() => null),
    listLegs(basketId).catch(() => []),
  ]);
  if (snap && Number.isFinite(Number(snap.nav)) && Number(snap.nav) > 0) return Number(snap.nav);
  return legs.length ? computeBasketNav(legs).nav : 1;
}

/**
 * Build the close_position transaction for a leveraged position. Full close
 * only — close_position unwinds the entire position on-chain.
 *
 * @param positionId    leveraged_positions row id
 * @param userPublicKey signer / fee payer (must be the position owner)
 * @param connection    defaults to the shared client connection
 * @param program       defaults to the shared contra_leverage program
 */
export async function buildClosePositionTransaction(
  positionId: string,
  userPublicKey: string,
  connection: Connection = getConnection(),
  program: Program = getLeverageProgram(),
): Promise<BuildCloseResult> {
  const lp = await getLeveragedPositionById(positionId);
  if (!lp) throw new Error('position_not_found');
  if (lp.closed_at || lp.liquidated) throw new Error('position_already_closed');

  const basket = await getBasket(lp.basket_id);
  if (!basket) throw new Error('basket_not_found');

  const user = new PublicKey(userPublicKey);
  const owner = new PublicKey(lp.wallet);
  const usdc = usdcMint();

  // PDAs — position is owned by the original opener (lp.wallet); the on-chain
  // close constraint enforces owner == user, so userPublicKey must match.
  // u64 nonce baked into the position seed at open time — required to
  // re-derive the same PDA at close. Stored as BIGINT in Supabase.
  const positionNonce = BigInt(String(lp.nonce ?? '0'));

  const [vaultPda] = deriveVaultPda(basket.id);
  const [contraMint] = deriveContraMint(vaultPda);
  const [vaultUsdc] = deriveVaultUsdc(vaultPda);
  const [position] = derivePosition(basket.id, owner, positionNonce);
  const [positionUsdc] = derivePositionUsdc(position);
  const [positionCtrs] = derivePositionCtrs(position);
  const [pool] = deriveLendingPool();
  const [poolUsdc] = derivePoolUsdc(pool);
  const [borrowerAuth] = deriveBorrowerAuthority();
  const userUsdcAta = getAssociatedTokenAddressSync(usdc, user);

  const vaultFinalized = basket.status === 'finalized';

  // ---- close preview (display only; the program computes real amounts) ----
  const nav = await currentNav(basket.id);
  const collateral = Number(lp.collateral_usdc);
  const borrowed = Number(lp.debt_usdc);
  const tokens = Number(lp.vault_tokens);
  const gross = tokens * nav;
  const daysOpen = lp.opened_at ? Math.max(0, (Date.now() - Date.parse(lp.opened_at)) / 86_400_000) : 0;
  const interest = borrowed * INTEREST_APY * (daysOpen / 365);
  const repay = borrowed;
  const fee = Math.max(0, gross - repay) * FEE_RATE;
  const net = gross - repay - interest - fee;
  void collateral;

  const closeIx = await program.methods
    .closePosition(vaultFinalized)
    .accounts({
      position,
      vault: vaultPda,
      contraMint,
      vaultUsdcAccount: vaultUsdc,
      lendingPool: pool,
      lendingPoolUsdc: poolUsdc,
      borrowerAuthority: borrowerAuth,
      positionUsdcAccount: positionUsdc,
      positionCtrsAccount: positionCtrs,
      user,
      userUsdcAccount: userUsdcAta,
      contraVaultProgram: contraVaultProgramId(),
      contraLendingProgram: contraLendingProgramId(),
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .instruction();

  const instructions: TransactionInstruction[] = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }),
    // The refund lands in the user's USDC ATA — make sure it exists.
    createAssociatedTokenAccountIdempotentInstruction(user, userUsdcAta, user, usdc),
    closeIx,
  ];

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  const message = new TransactionMessage({
    payerKey: user,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message();
  const tx = new VersionedTransaction(message);

  return {
    transactionBase64: Buffer.from(tx.serialize()).toString('base64'),
    recentBlockhash: blockhash,
    lastValidBlockHeight,
    positionPda: position.toBase58(),
    vaultFinalized,
    currentNav: nav,
    preview: { tokensClosed: tokens, gross, repay, interest, fee, net },
  };
}
