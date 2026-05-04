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
import { getConnection, getVaultProgram, usdcMint } from './client';
import {
  deriveContraMint,
  deriveVaultPda,
  deriveVaultUsdc,
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
