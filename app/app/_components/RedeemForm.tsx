'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useWallet } from '@solana/wallet-adapter-react';
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui';
import { api } from '../_lib/api';
import { redeemFromBasket } from '../_lib/redeem-client';

interface Props {
  basketId: string;
  basketName?: string;
  currentNav?: number;
}

interface PositionInfo {
  tokensHeld: number;
  entryNav: number;
  currentNav: number;
  value: number;
  pnl: number;
  pnlPct: number;
}

interface RedeemDone {
  signature: string;
  tokensRedeemed: number;
  netUsdc: number;
  fee: number;
  realizedPnl: number;
}

const PROTOCOL_FEE_RATE = 0.005;
const SANS = '"DM Sans", sans-serif';

export function RedeemForm({ basketId, basketName, currentNav }: Props) {
  const wallet = useWallet();
  const [mounted, setMounted] = useState(false);
  const [pos, setPos] = useState<PositionInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [mode, setMode] = useState<'tokens' | 'amount'>('tokens');
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<RedeemDone | null>(null);

  useEffect(() => setMounted(true), []);

  const walletKey = wallet.publicKey?.toBase58();
  useEffect(() => {
    if (!walletKey) {
      setPos(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    api
      .portfolio(walletKey)
      .then((r) => {
        if (cancelled) return;
        const p = (r.basket_positions ?? []).find((x: any) => x.basket?.id === basketId || x.basket_id === basketId);
        if (p) {
          setPos({
            tokensHeld: Number(p.tokens_held ?? 0),
            entryNav: Number(p.entry_nav ?? 1),
            currentNav: Number(p.current_nav ?? currentNav ?? 1),
            value: Number(p.current_value_usdc ?? 0),
            pnl: Number(p.pnl_usdc ?? 0),
            pnlPct: Number(p.pnl_pct ?? 0),
          });
        } else {
          setPos(null);
        }
      })
      .catch(() => !cancelled && setPos(null))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [walletKey, basketId, currentNav, done]);

  const nav = pos?.currentNav ?? currentNav ?? 1;

  // Derive token amount + payout preview from the input + mode.
  const { tokenAmount, grossUsdc, fee, netUsdc } = useMemo(() => {
    const v = Number(input);
    if (!Number.isFinite(v) || v <= 0) return { tokenAmount: 0, grossUsdc: 0, fee: 0, netUsdc: 0 };
    const tokens = mode === 'tokens' ? v : v / nav;
    const gross = tokens * nav;
    const f = gross * PROTOCOL_FEE_RATE;
    return { tokenAmount: tokens, grossUsdc: gross, fee: f, netUsdc: gross - f };
  }, [input, mode, nav]);

  if (!mounted) {
    return <div suppressHydrationWarning className="bg-white" style={{ border: '1px solid #E5E5E3', padding: 20, minHeight: 200 }} />;
  }

  if (!wallet.publicKey) {
    return (
      <div className="bg-white" style={{ border: '1px solid #E5E5E3', padding: 20 }}>
        <div style={label}>Connect wallet to redeem</div>
        <WalletMultiButton />
      </div>
    );
  }

  if (loading) {
    return (
      <div className="bg-white" style={{ border: '1px solid #E5E5E3', padding: 20, color: '#9B9B9B', fontSize: 13 }}>
        Loading position…
      </div>
    );
  }

  if (!pos || pos.tokensHeld <= 0) {
    return (
      <div className="bg-white" style={{ border: '1px solid #E5E5E3', padding: 20, color: '#6B6B6B', fontSize: 13 }}>
        You don&apos;t hold any {basketName ?? 'CTRA'} tokens
      </div>
    );
  }

  const maxTokens = pos.tokensHeld;
  const maxAmount = pos.value * 0.995;
  const overMax = mode === 'tokens' ? tokenAmount > maxTokens + 1e-9 : Number(input) > maxAmount + 1e-9;

  async function submit() {
    setErr(null);
    if (tokenAmount <= 0) {
      setErr('Enter an amount to redeem');
      return;
    }
    if (overMax) {
      setErr('Amount exceeds your position');
      return;
    }
    setBusy(true);
    try {
      const r = await redeemFromBasket(
        mode === 'tokens'
          ? { wallet, basketId, tokenAmount }
          : { wallet, basketId, usdcAmount: Number(input) },
      );
      setDone({
        signature: r.signature,
        tokensRedeemed: r.preview.tokenAmount,
        netUsdc: r.net_usdc,
        fee: r.preview.fee,
        realizedPnl: r.realized_pnl,
      });
      setInput('');
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="bg-white" style={{ border: '1px solid #E5E5E3', padding: 20 }}>
        <div style={{ fontSize: 16, fontWeight: 500, color: '#0A0A0A', fontFamily: SANS, marginBottom: 16 }}>
          Redeem Position
        </div>

        {/* current position info card */}
        <div style={{ background: '#F7F7F5', borderRadius: 8, padding: 16, marginBottom: 16 }}>
          <InfoRow label={`Tokens held`} value={`${pos.tokensHeld.toFixed(4)} ${basketName ?? 'CTRA'}`} />
          <InfoRow label="Current NAV" value={`$${pos.currentNav.toFixed(4)}`} />
          <InfoRow label="Position value" value={`$${pos.value.toFixed(2)}`} />
          <InfoRow
            label="Unrealized P&L"
            value={`${pos.pnl >= 0 ? '+' : '−'}$${Math.abs(pos.pnl).toFixed(2)} (${pos.pnl >= 0 ? '+' : '−'}${Math.abs(pos.pnlPct * 100).toFixed(1)}%)`}
            valueColor={pos.pnl >= 0 ? '#00875A' : '#CC2936'}
          />
        </div>

        {/* mode toggle */}
        <div className="flex gap-2" style={{ marginBottom: 8 }}>
          {(['tokens', 'amount'] as const).map((m) => {
            const active = mode === m;
            return (
              <button
                key={m}
                type="button"
                onClick={() => { setMode(m); setInput(''); }}
                style={{
                  flex: 1,
                  padding: '6px 0',
                  fontSize: 12,
                  fontFamily: SANS,
                  border: active ? '1px solid #1A56DB' : '1px solid #E5E5E3',
                  color: active ? '#1A56DB' : '#6B6B6B',
                  background: active ? '#EBF0FF' : '#FFFFFF',
                  borderRadius: 3,
                  cursor: 'pointer',
                }}
              >
                {m === 'tokens' ? 'By tokens' : 'By amount'}
              </button>
            );
          })}
        </div>

        <div>
          <div style={label}>{mode === 'tokens' ? 'Tokens to redeem' : 'USDC amount'}</div>
          <input
            value={input}
            inputMode="decimal"
            placeholder={mode === 'tokens' ? maxTokens.toFixed(4) : maxAmount.toFixed(2)}
            onChange={(e) => setInput(e.target.value)}
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
          <button
            type="button"
            onClick={() => setInput(mode === 'tokens' ? String(maxTokens) : String(maxAmount))}
            style={{ marginTop: 6, fontSize: 11, color: '#1A56DB', background: 'none', border: 'none', cursor: 'pointer', padding: 0, fontFamily: SANS }}
          >
            Max
          </button>
          <div style={{ fontSize: 11, color: '#9B9B9B', marginTop: 4, fontFamily: SANS }}>
            {mode === 'tokens'
              ? `≈ $${netUsdc.toFixed(2)} USDC after fees`
              : `≈ ${tokenAmount.toFixed(4)} tokens`}
          </div>
        </div>

        {/* fee breakdown */}
        <div style={{ background: '#F0FDF4', border: '1px solid #BBF7D0', borderRadius: 6, padding: 12, marginTop: 12 }}>
          <FeeRow label="Gross value" value={`$${grossUsdc.toFixed(2)}`} />
          <FeeRow label="Protocol fee (0.5%)" value={`-$${fee.toFixed(2)}`} valueColor="#CC2936" />
          <FeeRow label="You receive" value={`$${netUsdc.toFixed(2)} USDC`} bold />
        </div>

        <button
          type="button"
          onClick={submit}
          disabled={busy}
          style={{
            width: '100%',
            background: '#CC2936',
            color: '#FFFFFF',
            padding: '10px 0',
            fontSize: 13,
            fontWeight: 500,
            borderRadius: 3,
            border: 'none',
            cursor: busy ? 'not-allowed' : 'pointer',
            opacity: busy ? 0.5 : 1,
            marginTop: 12,
            fontFamily: SANS,
          }}
        >
          {busy ? 'Confirming…' : 'Redeem Tokens'}
        </button>

        {err && <div style={{ color: '#CC2936', fontSize: 12, marginTop: 8 }}>{err}</div>}
      </div>

      {done && (
        <RedeemConfirmationModal
          basketName={basketName ?? 'Basket'}
          done={done}
          onClose={() => setDone(null)}
        />
      )}
    </>
  );
}

function InfoRow({ label: l, value, valueColor }: { label: string; value: string; valueColor?: string }) {
  return (
    <div className="flex items-center justify-between" style={{ padding: '4px 0' }}>
      <span style={{ fontSize: 11, color: '#9B9B9B', fontFamily: SANS }}>{l}</span>
      <span className="font-num" style={{ fontSize: 13, color: valueColor ?? '#0A0A0A' }}>{value}</span>
    </div>
  );
}

function FeeRow({ label: l, value, valueColor, bold }: { label: string; value: string; valueColor?: string; bold?: boolean }) {
  return (
    <div className="flex items-center justify-between" style={{ padding: '3px 0' }}>
      <span style={{ fontSize: 11, color: '#6B6B6B', fontFamily: SANS }}>{l}</span>
      <span className="font-num" style={{ fontSize: 13, color: valueColor ?? '#0A0A0A', fontWeight: bold ? 700 : 400 }}>{value}</span>
    </div>
  );
}

function RedeemConfirmationModal({ basketName, done, onClose }: { basketName: string; done: RedeemDone; onClose: () => void }) {
  const explorerUrl = `https://explorer.solana.com/tx/${done.signature}?cluster=devnet`;
  const sigShort = `${done.signature.slice(0, 8)}…${done.signature.slice(-8)}`;
  return (
    <div
      role="dialog"
      aria-modal="true"
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: 16 }}
    >
      <div onClick={(e) => e.stopPropagation()} style={{ background: '#FFFFFF', borderRadius: 12, padding: 32, maxWidth: 480, width: '100%', boxShadow: '0 24px 64px rgba(0,0,0,0.16)' }}>
        <div className="flex items-center gap-3" style={{ marginBottom: 20 }}>
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#00875A" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="10" />
            <polyline points="9 12 11 14 15 10" />
          </svg>
          <h2 style={{ fontSize: 20, fontWeight: 500, color: '#0A0A0A', margin: 0, fontFamily: SANS }}>Position Redeemed</h2>
        </div>
        <div style={{ background: '#F7F7F5', borderRadius: 8, padding: 16, marginBottom: 16 }}>
          <InfoRow label="Basket" value={basketName} />
          <InfoRow label="Tokens redeemed" value={`${done.tokensRedeemed.toFixed(4)} ${basketName}`} />
          <InfoRow label="USDC received" value={`$${done.netUsdc.toFixed(2)}`} />
          <InfoRow label="Fee paid" value={`$${done.fee.toFixed(2)}`} valueColor="#CC2936" />
          <InfoRow
            label="Realized P&L"
            value={`${done.realizedPnl >= 0 ? '+' : '−'}$${Math.abs(done.realizedPnl).toFixed(2)}`}
            valueColor={done.realizedPnl >= 0 ? '#00875A' : '#CC2936'}
          />
        </div>
        <a href={explorerUrl} target="_blank" rel="noopener noreferrer" style={{ display: 'inline-block', fontSize: 13, color: '#1A56DB', marginBottom: 20 }}>
          View on Solana Explorer → ({sigShort})
        </a>
        <div className="flex gap-3">
          <Link href="/portfolio" onClick={onClose} style={{ flex: 1, textAlign: 'center', background: '#1A56DB', color: '#FFFFFF', padding: '12px 0', fontSize: 13, fontWeight: 500, borderRadius: 4, textDecoration: 'none', fontFamily: SANS }}>
            View Portfolio
          </Link>
          <button type="button" onClick={onClose} style={{ flex: 1, background: 'transparent', border: '1px solid #E5E5E3', color: '#6B6B6B', padding: '12px 0', fontSize: 13, fontWeight: 500, borderRadius: 4, cursor: 'pointer', fontFamily: SANS }}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

const label: React.CSSProperties = {
  fontSize: 10,
  color: '#9B9B9B',
  textTransform: 'uppercase',
  letterSpacing: '0.08em',
  marginBottom: 6,
  fontFamily: SANS,
};
