/**
 * Builds the unsigned-by-user (authority-pre-signed) VersionedTransaction
 * for `vault.withdraw` — the mark-to-market redeem path.
 *
 * The withdraw instruction needs the authority to co-sign because it
 * attests the off-chain NAV the program can't read. So the backend
 * partial-signs with the authority keypair here, then hands the tx to the
 * frontend; Phantom adds the user's signature (fee payer + burn authority)
 * and submits. Frontend never imports Anchor.
 *
 * On-chain math (mirrored for the preview in the route):
 *   gross = amount_tokens × nav_scaled / 1e6
 *   fee   = gross × 50 / 10_000      (0.5%)
 *   net   = gross − fee              → to user
 *   fee                              → to fee_treasury (authority USDC ATA)
 */

import {
  ComputeBudgetProgram,
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
import { BN } from '@coral-xyz/anchor';
import {
  getConnection,
  getVaultProgram,
  getAuthorityKeypair,
  usdcMint,
} from './client';
import { deriveContraMint, deriveVaultPda, deriveVaultUsdc } from './pda';

const USDC_DECIMALS = 6;
const TOKEN_DECIMALS = 6; // CTRS_DECIMALS
const RATIO_SCALE = 1_000_000;

export interface PrepareRedeemInput {
  basketUuid: string;
  walletAddress: string;
  tokenAmount: number; // human-readable CTRS tokens, can be fractional
  navScaled: number;   // current NAV × 1e6, integer
}

export interface PrepareRedeemResult {
  transactionBase64: string;
  recentBlockhash: string;
  lastValidBlockHeight: number;
  vaultPda: string;
  contraMint: string;
  amountTokensRaw: string;
  navScaled: number;
}

function toRaw(amount: number, decimals: number): bigint {
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error('amount must be a positive number');
  }
  return BigInt(amount.toFixed(decimals).replace('.', ''));
}

export async function buildRedeemTransaction(
  input: PrepareRedeemInput,
): Promise<PrepareRedeemResult> {
  const conn = getConnection();
  const program = getVaultProgram();
  const authority = getAuthorityKeypair();
  const user = new PublicKey(input.walletAddress);
  const usdc = usdcMint();

  const [vaultPda] = deriveVaultPda(input.basketUuid);
  const [contraMint] = deriveContraMint(vaultPda);
  const [vaultUsdc] = deriveVaultUsdc(vaultPda);

  const userUsdcAta = getAssociatedTokenAddressSync(usdc, user);
  const userCtrsAta = getAssociatedTokenAddressSync(contraMint, user);
  const feeTreasuryAta = getAssociatedTokenAddressSync(usdc, authority.publicKey);

  const amountTokensRaw = toRaw(input.tokenAmount, TOKEN_DECIMALS);
  const navScaled = Math.max(1, Math.round(input.navScaled));

  const instructions: TransactionInstruction[] = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
    // Ensure the user has a USDC ATA to receive the payout.
    createAssociatedTokenAccountIdempotentInstruction(user, userUsdcAta, user, usdc),
    // Ensure the fee treasury exists (payer = user).
    createAssociatedTokenAccountIdempotentInstruction(
      user,
      feeTreasuryAta,
      authority.publicKey,
      usdc,
    ),
  ];

  const withdrawIx = await program.methods
    .withdraw(new BN(amountTokensRaw.toString()), new BN(navScaled))
    .accounts({
      vault: vaultPda,
      contraMint,
      vaultUsdcAccount: vaultUsdc,
      user,
      userContraAccount: userCtrsAta,
      userUsdcAccount: userUsdcAta,
      feeTreasury: feeTreasuryAta,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .instruction();
  instructions.push(withdrawIx);

  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed');
  const message = new TransactionMessage({
    payerKey: user,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message();
  const tx = new VersionedTransaction(message);
  // User-signed only — the program trusts the backend-supplied nav_scaled.
  // (No authority co-sign; that previously triggered a CPI privilege error.)

  return {
    transactionBase64: Buffer.from(tx.serialize()).toString('base64'),
    recentBlockhash: blockhash,
    lastValidBlockHeight,
    vaultPda: vaultPda.toBase58(),
    contraMint: contraMint.toBase58(),
    amountTokensRaw: amountTokensRaw.toString(),
    navScaled,
  };
}

export { USDC_DECIMALS, RATIO_SCALE };
