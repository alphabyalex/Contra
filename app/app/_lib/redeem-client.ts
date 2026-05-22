'use client';

/**
 * Two-step redeem (mark-to-market withdraw) from the browser:
 *   1. POST /api/redeem/prepare → backend builds + AUTHORITY-signs the
 *      VersionedTransaction (it co-signs to attest NAV)
 *   2. wallet.signTransaction(...)  (Phantom adds the user/burn signature;
 *      existing authority signature is preserved)
 *   3. connection.sendRawTransaction(...)
 *   4. POST /api/redeem/confirm  → backend reduces the position
 *
 * The frontend never imports Anchor.
 */

import { Connection, VersionedTransaction } from '@solana/web3.js';
import type { WalletContextState } from '@solana/wallet-adapter-react';
import { api } from './api';
import { RPC_URL } from './tokens';

export interface RedeemPreview {
  tokenAmount: number;
  gross_usdc: number;
  fee: number;
  net_usdc: number;
  current_nav: number;
}

export async function redeemFromBasket(opts: {
  wallet: WalletContextState;
  basketId: string;
  tokenAmount?: number;
  usdcAmount?: number;
}): Promise<{ signature: string; net_usdc: number; realized_pnl: number; closed: boolean; preview: RedeemPreview }> {
  const { wallet, basketId, tokenAmount, usdcAmount } = opts;
  if (!wallet.publicKey || !wallet.signTransaction) {
    throw new Error('Wallet not connected or missing signTransaction');
  }
  const walletAddress = wallet.publicKey.toBase58();

  const prepared = await api.redeem.prepare({ basketId, walletAddress, tokenAmount, usdcAmount });
  const tx = VersionedTransaction.deserialize(
    Uint8Array.from(Buffer.from(prepared.transaction_b64, 'base64')),
  );
  // Phantom fills the user signature; the authority signature already set
  // by the backend is preserved.
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

  const res = await api.redeem.confirm({
    signature,
    walletAddress,
    basketId,
    tokenAmount: prepared.tokenAmount,
  });
  return {
    signature,
    net_usdc: res.net_usdc,
    realized_pnl: res.realized_pnl,
    closed: res.closed,
    preview: {
      tokenAmount: prepared.tokenAmount,
      gross_usdc: prepared.gross_usdc,
      fee: prepared.fee,
      net_usdc: prepared.net_usdc,
      current_nav: prepared.current_nav,
    },
  };
}
