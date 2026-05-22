'use client';

/**
 * Two-step deposit from the browser:
 *   1. POST /api/deposit/prepare → backend builds VersionedTransaction
 *   2. wallet.signTransaction(...)  (Phantom)
 *   3. connection.sendRawTransaction(...)
 *   4. POST /api/deposit/confirm  → backend persists position
 *
 * The frontend never imports Anchor. We deserialize the base64 the
 * backend returns into a VersionedTransaction (web3.js only) and hand
 * it to Phantom for signing.
 */

import { Connection, VersionedTransaction } from '@solana/web3.js';
import type { WalletContextState } from '@solana/wallet-adapter-react';
import { api } from './api';
import { RPC_URL } from './tokens';

export interface DepositResult {
  signature: string;
  leveraged: boolean;
  collateral?: number;
  borrowed?: number;
  totalExposure?: number;
  vaultTokens?: number;
  liquidationNav?: number;
  dailyInterest?: number;
}

export async function depositToBasket(opts: {
  wallet: WalletContextState;
  basketId: string;
  amountUsdc: number;
  leverage?: 1 | 2 | 3;
}): Promise<DepositResult> {
  const { wallet, basketId, amountUsdc } = opts;
  const leverage = opts.leverage ?? 1;
  if (!wallet.publicKey || !wallet.signTransaction) {
    throw new Error('Wallet not connected or missing signTransaction');
  }
  const walletAddress = wallet.publicKey.toBase58();

  const prepared = await api.deposit.prepare({ basketId, walletAddress, amountUsdc, leverage });
  const tx = VersionedTransaction.deserialize(
    Uint8Array.from(Buffer.from(prepared.transactionBase64, 'base64')),
  );
  const signed = await wallet.signTransaction(tx);

  const conn = new Connection(RPC_URL, 'confirmed');
  const signature = await conn.sendRawTransaction(signed.serialize(), {
    skipPreflight: false,
    maxRetries: 3,
  });
  await conn.confirmTransaction(
    {
      signature,
      blockhash: prepared.recentBlockhash,
      lastValidBlockHeight: prepared.lastValidBlockHeight,
    },
    'confirmed',
  );

  const confirmed = await api.deposit.confirm({
    basketId,
    walletAddress,
    amountUsdc,
    signature,
    leverage,
    positionPda: prepared.positionPda,
  });
  return {
    signature,
    leveraged: Boolean(confirmed.leveraged),
    collateral: confirmed.collateral,
    borrowed: confirmed.borrowed,
    totalExposure: confirmed.total_exposure,
    vaultTokens: confirmed.vault_tokens,
    liquidationNav: confirmed.liquidation_nav,
    dailyInterest: confirmed.daily_interest,
  };
}
