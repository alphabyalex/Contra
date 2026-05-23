/**
 * Builds the unsigned VersionedTransaction for `vault.deposit`. The
 * frontend never imports Anchor — it calls /api/deposit/prepare, gets the
 * base64 tx returned from here, hands it to Phantom, then posts the
 * signature back to /api/deposit/confirm. This file is the single point
 * where deposit-side compute budget, ATA creation, and PDA wiring live.
 *
 * Notes:
 * - We always include createAssociatedTokenAccountIdempotent for the
 *   user's CTRS account because Phantom users will not have one yet on
 *   their first deposit.
 * - Compute budget is set to 400_000 units; 200k is too tight when the
 *   ATA-create instruction lands in the same tx.
 */

import {
  ComputeBudgetProgram,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import { BN } from '@coral-xyz/anchor';
import {
  getConnection,
  getVaultProgram,
  getLeverageProgram,
  getAuthorityKeypair,
  usdcMint,
} from './client';
import { SystemProgram, SYSVAR_RENT_PUBKEY } from '@solana/web3.js';
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
  uuidToBytes,
} from './pda';

export interface PrepareDepositInput {
  basketUuid: string;
  walletAddress: string;
  amountUsdc: number; // human-readable USDC, e.g. 100.5
}

export interface PrepareDepositResult {
  transactionBase64: string;
  recentBlockhash: string;
  lastValidBlockHeight: number;
  vaultPda: string;
  contraMint: string;
  amountRaw: string;
}

const USDC_DECIMALS = 6;

function toRawUsdc(amount: number): bigint {
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error('amountUsdc must be a positive number');
  }
  // Avoid floating-point drift for typical 6-decimal inputs.
  const fixed = amount.toFixed(USDC_DECIMALS);
  return BigInt(fixed.replace('.', ''));
}

export async function buildDepositTransaction(
  input: PrepareDepositInput,
): Promise<PrepareDepositResult> {
  const conn = getConnection();
  const program = getVaultProgram();
  const user = new PublicKey(input.walletAddress);
  const usdc = usdcMint();

  const [vaultPda] = deriveVaultPda(input.basketUuid);
  const [contraMint] = deriveContraMint(vaultPda);
  const [vaultUsdc] = deriveVaultUsdc(vaultPda);

  const userUsdcAta = getAssociatedTokenAddressSync(usdc, user);
  const userCtrsAta = getAssociatedTokenAddressSync(contraMint, user);

  // Fee treasury = authority's USDC ATA. The vault deposit ix enforces
  // fee_treasury.owner == vault.authority, so this must be the authority.
  const authority = getAuthorityKeypair().publicKey;
  const feeTreasuryAta = getAssociatedTokenAddressSync(usdc, authority);

  const amountRaw = toRawUsdc(input.amountUsdc);

  const instructions: TransactionInstruction[] = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
    // Idempotent — no-op if the user already has a CTRS ATA.
    createAssociatedTokenAccountIdempotentInstruction(
      user,
      userCtrsAta,
      user,
      contraMint,
    ),
    // Idempotent — ensures the fee treasury ATA exists (payer = user).
    createAssociatedTokenAccountIdempotentInstruction(
      user,
      feeTreasuryAta,
      authority,
      usdc,
    ),
  ];

  const depositIx = await program.methods
    .deposit(new BN(amountRaw.toString()))
    .accounts({
      vault: vaultPda,
      contraMint,
      vaultUsdcAccount: vaultUsdc,
      user,
      userUsdcAccount: userUsdcAta,
      userContraAccount: userCtrsAta,
      feeTreasury: feeTreasuryAta,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .instruction();
  instructions.push(depositIx);

  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed');
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
    vaultPda: vaultPda.toBase58(),
    contraMint: contraMint.toBase58(),
    amountRaw: amountRaw.toString(),
  };
}

// =====================================================================
// Leveraged deposit (contra_leverage.open_position)
// =====================================================================

export interface PrepareLeverageInput {
  basketUuid: string;
  walletAddress: string;
  collateralUsdc: number; // human-readable USDC the user puts in
  leverage: 2 | 3;
}

export interface PrepareLeverageResult {
  transactionBase64: string;
  recentBlockhash: string;
  lastValidBlockHeight: number;
  positionPda: string;
  positionNonce: string; // u64 as decimal string — DB stores it, close reads it back
  collateralUsdc: number;
  borrowedUsdc: number;
  totalExposureUsdc: number;
  leverageBps: number;
}

/**
 * Builds the single user-signed VersionedTransaction that opens a leveraged
 * position: init_position → init_position_tokens → open_position. The
 * leverage program borrows from the lending pool (its borrower-authority PDA
 * signs that CPI internally) and deposits the total exposure into the vault,
 * minting CTRS to the position's PDA token account. No authority co-sign.
 *
 * NOTE: requires the lending pool to hold ≥ borrowedUsdc of liquidity;
 * otherwise open_position fails with InsufficientLiquidity on-chain.
 */
export async function buildLeveragedTransaction(
  input: PrepareLeverageInput,
): Promise<PrepareLeverageResult> {
  const conn = getConnection();
  const leverage = getLeverageProgram();
  const user = new PublicKey(input.walletAddress);
  const usdc = usdcMint();
  const uuidBytes = uuidToBytes(input.basketUuid);

  const collateralRaw = toRawUsdc(input.collateralUsdc);
  const leverageBps = input.leverage * 10_000;
  const totalRaw = (collateralRaw * BigInt(leverageBps)) / 10_000n;
  const borrowedRaw = totalRaw - collateralRaw;

  // Random nonce per open so the position PDA is unique even for the same
  // (wallet, basket) pair — fixes the deterministic-PDA collision bug.
  const positionNonce = BigInt(Date.now());

  const [vaultPda] = deriveVaultPda(input.basketUuid);
  const [contraMint] = deriveContraMint(vaultPda);
  const [vaultUsdc] = deriveVaultUsdc(vaultPda);
  const [position] = derivePosition(input.basketUuid, user, positionNonce);
  const [positionUsdc] = derivePositionUsdc(position);
  const [positionCtrs] = derivePositionCtrs(position);
  const [pool] = deriveLendingPool();
  const [poolUsdc] = derivePoolUsdc(pool);
  const [borrowerAuth] = deriveBorrowerAuthority();

  const userUsdcAta = getAssociatedTokenAddressSync(usdc, user);
  const feeTreasuryAta = getAssociatedTokenAddressSync(usdc, getAuthorityKeypair().publicKey);

  const initPositionIx = await leverage.methods
    .initPosition([...uuidBytes] as number[], new BN(positionNonce.toString()))
    .accounts({ vault: vaultPda, position, user, systemProgram: SystemProgram.programId })
    .instruction();

  const initTokensIx = await leverage.methods
    .initPositionTokens()
    .accounts({
      position,
      vault: vaultPda,
      usdcMint: usdc,
      contraMint,
      positionUsdc,
      positionCtrs,
      user,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      rent: SYSVAR_RENT_PUBKEY,
    })
    .instruction();

  const openIx = await leverage.methods
    .openPosition(new BN(collateralRaw.toString()), new BN(leverageBps))
    .accounts({
      position,
      vault: vaultPda,
      contraMint,
      vaultUsdcAccount: vaultUsdc,
      feeTreasury: feeTreasuryAta,
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
    // Ensure the fee treasury exists (open_position's vault deposit CPI skims the fee there).
    createAssociatedTokenAccountIdempotentInstruction(user, feeTreasuryAta, getAuthorityKeypair().publicKey, usdc),
    initPositionIx,
    initTokensIx,
    openIx,
  ];

  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed');
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
    positionNonce: positionNonce.toString(),
    collateralUsdc: input.collateralUsdc,
    borrowedUsdc: Number(borrowedRaw) / 1e6,
    totalExposureUsdc: Number(totalRaw) / 1e6,
    leverageBps,
  };
}

/**
 * Confirm landing of a previously prepared deposit. Returns the signature
 * status; the caller (route handler) writes Supabase rows on success.
 */
export async function confirmSignature(signature: string): Promise<{ confirmed: boolean; slot?: number; err?: unknown }> {
  const conn = getConnection();
  const status = await conn.getSignatureStatus(signature, { searchTransactionHistory: true });
  if (!status.value) return { confirmed: false };
  if (status.value.err) return { confirmed: false, err: status.value.err };
  const cs = status.value.confirmationStatus;
  return { confirmed: cs === 'confirmed' || cs === 'finalized', slot: status.value.slot ?? undefined };
}

// Re-export the ATA program ID for use in scripts/tests where convenient.
export { ASSOCIATED_TOKEN_PROGRAM_ID };
