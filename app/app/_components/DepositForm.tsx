'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useWallet } from '@solana/wallet-adapter-react';
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui';
import { depositToBasket } from '../_lib/deposit-client';

interface Props {
  basketId: string;
  basketName?: string;
  avgEdge?: number; // 0..1 fractional
  entryNav?: number; // typically 1.0 during active phase
  onConfirmed?: (sig: string) => void;
}

interface ConfirmationDetails {
  signature: string;
  amount: number;
  leverage: 1 | 2 | 3;
  tokens: number;
  entryNav: number;
}

// Rough liquidation NAV per leverage tier, expressed as a multiple of entry
// NAV. These match the spec's display values; on-chain liquidation logic
// lives in contra_leverage::compute_health.
const LIQ_NAV_FACTOR: Record<2 | 3, number> = {
  2: 0.52,
  3: 0.68,
};

export function DepositForm({ basketId, basketName, avgEdge, entryNav, onConfirmed }: Props) {
  const wallet = useWallet();
  const [amount, setAmount] = useState('100');
  const [leverage, setLeverage] = useState<1 | 2 | 3>(1);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<ConfirmationDetails | null>(null);
  // Hold a stable placeholder on the server so the wallet-conditional
  // branch below doesn't trip hydration.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const amt = Number(amount);
  const safeAmt = Number.isFinite(amt) && amt > 0 ? amt : 0;
  const safeEntryNav = Number.isFinite(entryNav) && (entryNav as number) > 0 ? (entryNav as number) : 1;
  const safeEdge = Number.isFinite(avgEdge) ? (avgEdge as number) : 0;

  if (!mounted) {
    return (
      <div suppressHydrationWarning className="bg-white" style={{ border: '1px solid #E5E5E3', padding: 20, minHeight: 200 }} />
    );
  }

  if (!wallet.publicKey) {
    return (
      <div className="bg-white" style={{ border: '1px solid #E5E5E3', padding: 20 }}>
        <div style={labelStyle}>Connect wallet to deposit</div>
        <WalletMultiButton />
      </div>
    );
  }

  async function submit() {
    setErr(null);
    setBusy(true);
    try {
      if (!Number.isFinite(amt) || amt <= 0) throw new Error('Enter a positive USDC amount');
      if (leverage !== 1) throw new Error('Leverage paths land in the next build pass — please use 1x for now.');
      const { signature } = await depositToBasket({ wallet, basketId, amountUsdc: amt });
      // CTRS minted 1:1 against USDC at entry NAV during the active phase.
      const tokens = amt / safeEntryNav;
      setConfirmation({ signature, amount: amt, leverage, tokens, entryNav: safeEntryNav });
      onConfirmed?.(signature);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="bg-white" style={{ border: '1px solid #E5E5E3', padding: 20 }}>
        <div className="space-y-4">
          <div>
            <div style={labelStyle}>USDC amount</div>
            <input
              value={amount}
              inputMode="decimal"
              onChange={(e) => setAmount(e.target.value)}
              style={{
                width: '100%',
                background: '#F0F0EE',
                border: '1px solid #E5E5E3',
                borderRadius: 3,
                padding: '10px 12px',
                fontSize: 14,
                color: '#0A0A0A',
                fontFamily: '"IBM Plex Mono", monospace',
              }}
            />
          </div>

          <div>
            <div style={labelStyle}>Leverage</div>
            <div className="flex gap-2">
              {[1, 2, 3].map((n) => {
                const active = leverage === n;
                return (
                  <button
                    key={n}
                    type="button"
                    onClick={() => setLeverage(n as 1 | 2 | 3)}
                    style={{
                      flex: 1,
                      padding: '8px 0',
                      fontSize: 13,
                      fontFamily: '"IBM Plex Mono", monospace',
                      border: active ? '1px solid #1A56DB' : '1px solid #E5E5E3',
                      color: active ? '#1A56DB' : '#6B6B6B',
                      background: active ? '#EBF0FF' : '#FFFFFF',
                      borderRadius: 3,
                      cursor: 'pointer',
                    }}
                  >
                    {n}x
                  </button>
                );
              })}
            </div>
          </div>

          <LeverageInfo
            leverage={leverage}
            depositUsdc={safeAmt}
            avgEdge={safeEdge}
            entryNav={safeEntryNav}
          />

          <button
            type="button"
            onClick={submit}
            disabled={busy}
            style={{
              width: '100%',
              background: '#1A56DB',
              color: '#FFFFFF',
              padding: '10px 0',
              fontSize: 13,
              fontWeight: 500,
              borderRadius: 3,
              border: 'none',
              cursor: busy ? 'not-allowed' : 'pointer',
              opacity: busy ? 0.5 : 1,
            }}
          >
            {busy ? 'Confirming…' : 'Open short position'}
          </button>

          {err && <div style={{ color: '#CC2936', fontSize: 12 }}>{err}</div>}
        </div>
      </div>

      {confirmation && (
        <ConfirmationModal
          basketName={basketName ?? 'Basket'}
          details={confirmation}
          onClose={() => setConfirmation(null)}
        />
      )}
    </>
  );
}

// =====================================================================
// Leverage info panel
// =====================================================================

function LeverageInfo({
  leverage, depositUsdc, avgEdge, entryNav,
}: {
  leverage: 1 | 2 | 3;
  depositUsdc: number;
  avgEdge: number;
  entryNav: number;
}) {
  // Estimated return = deposit × leverage × avg_edge. For 1x this is just
  // the basket's expected uplift at avg edge; for leveraged positions
  // returns scale with leverage (and so does liquidation risk).
  const ret = useMemo(() => depositUsdc * leverage * avgEdge, [depositUsdc, leverage, avgEdge]);
  const retPct = depositUsdc > 0 ? (ret / depositUsdc) * 100 : 0;
  const retLine = `Estimated return if basket resolves at avg edge: ${ret >= 0 ? '+' : ''}${formatUsd(ret)} (${
    retPct >= 0 ? '+' : ''
  }${retPct.toFixed(1)}%)`;

  if (leverage === 1) {
    return (
      <div
        style={{
          background: '#F0FDF4',
          border: '1px solid #BBF7D0',
          borderRadius: 6,
          padding: 12,
          fontSize: 12,
          color: '#0A0A0A',
          lineHeight: 1.5,
        }}
      >
        <div>{retLine}</div>
        <div className="flex items-center gap-2" style={{ marginTop: 6, color: '#00875A' }}>
          <CheckIcon />
          <span>No liquidation risk at 1x leverage</span>
        </div>
        <LeverageFootnote />
      </div>
    );
  }

  const factor = LIQ_NAV_FACTOR[leverage];
  const liqNav = factor * entryNav;
  const isHigh = leverage === 3;
  const styleBox: React.CSSProperties = isHigh
    ? { background: '#FFF1F2', border: '1px solid #FECDD3' }
    : { background: '#FFF7ED', border: '1px solid #FED7AA' };
  const iconColor = isHigh ? '#CC2936' : '#C2410C';
  // Max loss is the user's deposited collateral — leveraged positions are
  // closed by the liquidator at the liquidation NAV, so the user can never
  // owe more than what they put in.
  const navStr = `$${liqNav.toFixed(4)}`;
  const warning = isHigh
    ? `Higher leverage means liquidation triggers sooner. If NAV drops to ${navStr} your position closes automatically. Maximum loss is your deposited collateral.`
    : `If NAV drops to ${navStr} your position will be liquidated automatically. Maximum loss is your deposited collateral.`;

  return (
    <div
      style={{
        ...styleBox,
        borderRadius: 6,
        padding: 12,
        fontSize: 12,
        color: '#0A0A0A',
        lineHeight: 1.5,
      }}
    >
      <div>{retLine}</div>
      <div className="font-num" style={{ marginTop: 6 }}>
        Liquidation NAV: <span style={{ color: iconColor }}>{navStr}</span>
      </div>
      <div className="flex items-start gap-2" style={{ marginTop: 6, color: iconColor }}>
        <WarningIcon />
        <span>{warning}</span>
      </div>
      <LeverageFootnote />
    </div>
  );
}

function LeverageFootnote() {
  return (
    <div style={{ marginTop: 10, fontSize: 10, color: '#9B9B9B' }}>
      Leverage is provided via the Contra lending pool. Use at your own risk.
    </div>
  );
}

function CheckIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

function WarningIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0, marginTop: 2 }}>
      <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <circle cx="12" cy="17" r="0.7" fill="currentColor" />
    </svg>
  );
}

// =====================================================================
// Confirmation modal
// =====================================================================

function ConfirmationModal({
  basketName, details, onClose,
}: {
  basketName: string;
  details: ConfirmationDetails;
  onClose: () => void;
}) {
  const explorerUrl = `https://explorer.solana.com/tx/${details.signature}?cluster=devnet`;
  const sigShort = `${details.signature.slice(0, 8)}…${details.signature.slice(-8)}`;

  return (
    <div
      role="dialog"
      aria-modal="true"
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.5)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
        padding: 16,
        animation: 'modalOverlayIn 200ms ease-out',
      }}
    >
      <style>{`
        @keyframes modalOverlayIn { from { opacity: 0; } to { opacity: 1; } }
        @keyframes modalIn {
          from { opacity: 0; transform: scale(0.95); }
          to   { opacity: 1; transform: scale(1); }
        }
      `}</style>
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: '#FFFFFF',
          borderRadius: 12,
          padding: 32,
          maxWidth: 480,
          width: '100%',
          animation: 'modalIn 200ms ease-out',
          boxShadow: '0 24px 64px rgba(0,0,0,0.16)',
        }}
      >
        <div className="flex items-center gap-3" style={{ marginBottom: 20 }}>
          <CheckCircle />
          <h2 style={{ fontSize: 20, fontWeight: 500, color: '#0A0A0A', margin: 0, fontFamily: '"DM Sans", sans-serif' }}>
            Position Opened
          </h2>
        </div>

        <div style={{ background: '#F7F7F5', borderRadius: 8, padding: 16, marginBottom: 16 }}>
          <ModalRow label="Basket" value={basketName} />
          <ModalRow label="Amount Deposited" value={`${formatUsd(details.amount)} USDC`} mono />
          <ModalRow label="Leverage" value={`${details.leverage}x`} mono />
          <ModalRow label="CTRA Tokens Received" value={`${details.tokens.toFixed(4)} ${basketName}`} mono />
          <ModalRow label="Entry NAV" value={`$${details.entryNav.toFixed(4)}`} mono />
          <ModalRow
            label="Transaction"
            value={(
              <a
                href={explorerUrl}
                target="_blank"
                rel="noopener noreferrer"
                style={{ color: '#1A56DB', textDecoration: 'none' }}
              >
                {sigShort}
              </a>
            )}
            mono
            last
          />
        </div>

        <a
          href={explorerUrl}
          target="_blank"
          rel="noopener noreferrer"
          style={{ display: 'inline-block', fontSize: 13, color: '#1A56DB', marginBottom: 20 }}
        >
          View on Solana Explorer →
        </a>

        <div className="flex gap-3">
          <Link
            href="/portfolio"
            onClick={onClose}
            style={{
              flex: 1,
              textAlign: 'center',
              background: '#1A56DB',
              color: '#FFFFFF',
              padding: '12px 0',
              fontSize: 13,
              fontWeight: 500,
              borderRadius: 4,
              textDecoration: 'none',
            }}
          >
            View Portfolio
          </Link>
          <button
            type="button"
            onClick={onClose}
            style={{
              flex: 1,
              background: 'transparent',
              border: '1px solid #E5E5E3',
              color: '#6B6B6B',
              padding: '12px 0',
              fontSize: 13,
              fontWeight: 500,
              borderRadius: 4,
              cursor: 'pointer',
              fontFamily: '"DM Sans", sans-serif',
            }}
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

function ModalRow({
  label, value, mono, last,
}: { label: string; value: React.ReactNode; mono?: boolean; last?: boolean }) {
  return (
    <div
      className="flex items-center justify-between"
      style={{
        padding: '10px 0',
        borderBottom: last ? 'none' : '1px solid #E5E5E3',
      }}
    >
      <span style={{ fontSize: 11, color: '#9B9B9B', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
        {label}
      </span>
      <span
        className={mono ? 'font-num' : ''}
        style={{ fontSize: 14, color: '#0A0A0A', textAlign: 'right' }}
      >
        {value}
      </span>
    </div>
  );
}

function CheckCircle() {
  return (
    <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#00875A" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="10" />
      <polyline points="9 12 11 14 15 10" />
    </svg>
  );
}

// =====================================================================
// Shared atoms
// =====================================================================

function formatUsd(v: number): string {
  if (!Number.isFinite(v)) return '$0.00';
  const abs = Math.abs(v);
  if (abs >= 1000) return `$${v.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
  return `$${v.toFixed(2)}`;
}

const labelStyle: React.CSSProperties = {
  fontSize: 10,
  color: '#9B9B9B',
  textTransform: 'uppercase',
  letterSpacing: '0.08em',
  marginBottom: 6,
  fontFamily: '"DM Sans", sans-serif',
};
