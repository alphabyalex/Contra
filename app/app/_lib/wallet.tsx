'use client';

/**
 * Phantom-only wallet provider. Wrap the app once in layout.tsx. The
 * frontend never imports Anchor — wallet here is used solely to sign
 * VersionedTransactions returned by the backend.
 */

import React, { useMemo } from 'react';
import { ConnectionProvider, WalletProvider } from '@solana/wallet-adapter-react';
import { WalletModalProvider } from '@solana/wallet-adapter-react-ui';
import { PhantomWalletAdapter } from '@solana/wallet-adapter-phantom';
import { RPC_URL } from './tokens';

import '@solana/wallet-adapter-react-ui/styles.css';

export function ContraWalletProvider({ children }: { children: React.ReactNode }) {
  const wallets = useMemo(() => [new PhantomWalletAdapter()], []);
  return (
    <ConnectionProvider endpoint={RPC_URL}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>{children}</WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
