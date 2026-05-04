'use client';

/**
 * Custom connect button. We don't use WalletMultiButton directly because
 * its connected-state visual is a filled button — we want a clean text-link
 * treatment that reads as a nav element rather than a CTA.
 *
 * Connected:    just the truncated address in #1A56DB, no background.
 *               Click to disconnect (small "x" appears on hover).
 * Disconnected: filled #1A56DB button labeled "Select Wallet".
 *               Click opens the wallet adapter modal.
 */

import { useState } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { useWalletModal } from '@solana/wallet-adapter-react-ui';

function shortAddress(addr: string): string {
  if (addr.length <= 10) return addr;
  return `${addr.slice(0, 4)}..${addr.slice(-4)}`;
}

export function ConnectButton() {
  const { publicKey, disconnect, wallet } = useWallet();
  const { setVisible } = useWalletModal();
  const [hover, setHover] = useState(false);

  if (!publicKey) {
    return (
      <button
        onClick={() => setVisible(true)}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        style={{
          background: hover ? '#1748B8' : '#1A56DB',
          color: '#FFFFFF',
          fontSize: 13,
          fontWeight: 500,
          letterSpacing: '0.04em',
          textTransform: 'uppercase',
          height: 34,
          padding: '0 16px',
          borderRadius: 3,
          border: 'none',
          fontFamily: '"DM Sans", sans-serif',
          cursor: 'pointer',
          transition: 'background 150ms ease-out',
        }}
      >
        Select Wallet
      </button>
    );
  }

  const icon = (wallet?.adapter as any)?.icon as string | undefined;
  const addr = publicKey.toBase58();

  return (
    <button
      onClick={() => disconnect().catch(() => {})}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title={`${addr} — click to disconnect`}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        background: 'transparent',
        color: hover ? '#1748B8' : '#1A56DB',
        fontSize: 13,
        fontWeight: 500,
        height: 32,
        padding: '0 4px',
        border: 'none',
        fontFamily: '"IBM Plex Mono", monospace',
        cursor: 'pointer',
        transition: 'color 150ms ease-out',
      }}
    >
      {icon && (
        <img src={icon} alt="" width={14} height={14} style={{ display: 'inline-block', borderRadius: 2 }} />
      )}
      <span>{shortAddress(addr)}</span>
      {hover && (
        <span style={{ color: '#9B9B9B', fontSize: 11, marginLeft: 2 }}>×</span>
      )}
    </button>
  );
}
