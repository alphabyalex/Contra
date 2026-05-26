'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useWallet } from '@solana/wallet-adapter-react';
import { VersionedTransaction } from '@solana/web3.js';
import { api } from '../../_lib/api';
import { BACKEND_URL } from '../../_lib/tokens';

const SANS = '"DM Sans", sans-serif';
const MONO = '"IBM Plex Mono", monospace';

function fmtUsd(v: number): string {
  if (!Number.isFinite(v)) return '$0.00';
  return v > 0 && v < 0.01 ? `$${v.toFixed(4)}` : `$${v.toFixed(2)}`;
}

/**
 * Translate raw on-chain or simulation error strings into something a
 * user can act on. Currently only specializes the lending pool's
 * InsufficientLiquidity error (Anchor error code 6007, custom program
 * error 0x1777). Every other error falls through untouched so unfamiliar
 * failures still surface their raw message for triage.
 */
function friendlyLeverageError(raw: string | null | undefined): string {
  const msg = String(raw ?? '');
  if (
    /InsufficientLiquidity/i.test(msg)
    || /0x1777/i.test(msg)
    || /\b6007\b/.test(msg)
    || /Insufficient liquidity available in pool/i.test(msg)
  ) {
    return 'The lending pool is currently low on liquidity. Close an existing leveraged position to free up funds, or try a 1x deposit instead.';
  }
  return msg;
}

export default function LeverageClosePage() {
  const params = useParams<{ id: string }>();
  const id = params?.id ?? '';
  const { publicKey, signTransaction } = useWallet();
  const [pos, setPos] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  const [mode, setMode] = useState<'tokens' | 'usdc'>('tokens');
  const [input, setInput] = useState('');
  const [preview, setPreview] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{
    net: number;
    closed: boolean;
    signature: string;
    tokensClosed: number;
    basketName: string;
  } | null>(null);

  useEffect(() => {
    if (!id) return;
    api.leverage.get(id).then((r) => setPos(r.position)).catch((e) => setErr(e.message));
  }, [id]);

  const nav = Number(pos?.current_nav ?? 1);
  const maxTokens = Number(pos?.token_amount ?? 0);

  const tokensToClose = useMemo(() => {
    const v = Number(input);
    if (!Number.isFinite(v) || v <= 0) return 0;
    return Math.min(mode === 'tokens' ? v : v / nav, maxTokens);
  }, [input, mode, nav, maxTokens]);

  // Live preview as the user types.
  useEffect(() => {
    if (!id || tokensToClose <= 0) { setPreview(null); return; }
    let cancelled = false;
    api.leverage.close(id, { tokenAmount: tokensToClose })
      .then((r) => { if (!cancelled) setPreview(r.preview); })
      .catch(() => { if (!cancelled) setPreview(null); });
    return () => { cancelled = true; };
  }, [id, tokensToClose]);

  if (err) return <Shell><div style={{ color: '#CC2936', fontSize: 13 }}>{err}</div></Shell>;
  if (!pos) return <Shell><div style={{ color: '#9B9B9B', fontSize: 13 }}>Loading position…</div></Shell>;

  const health = Number(pos.health_pct ?? 0);
  const healthColor = health > 60 ? '#00875A' : health >= 40 ? '#C2410C' : '#CC2936';
  const pnl = Number(pos.unrealized_pnl ?? 0);

  async function close() {
    setErr(null);
    // close_position is a full-unwind on-chain instruction — there is no
    // partial close, so the per-tokens input is informational only.
    if (!publicKey || !signTransaction) {
      setErr('Connect your wallet first');
      return;
    }
    setBusy(true);
    try {
      // 1. Ask the backend to build the unsigned close_position tx.
      const prepRes = await fetch(`${BACKEND_URL}/api/leverage/${id}/close/prepare`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ walletAddress: publicKey.toString() }),
      });
      const prep = await prepRes.json().catch(() => null);
      if (!prepRes.ok) throw new Error(prep?.error ?? `prepare failed: ${prepRes.status}`);

      // 2. Deserialize, let Phantom sign.
      const tx = VersionedTransaction.deserialize(Buffer.from(prep.transaction_b64, 'base64'));
      const signed = await signTransaction(tx);
      const signedB64 = Buffer.from(signed.serialize()).toString('base64');

      // 3. Submit + confirm via the backend; only then does the DB settle.
      const confRes = await fetch(`${BACKEND_URL}/api/leverage/${id}/confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ signedTx: signedB64 }),
      });
      const conf = await confRes.json().catch(() => null);
      if (!confRes.ok) {
        console.log('confirm response:', conf);
        throw new Error(JSON.stringify(conf));
      }

      setDone({
        net: Number(conf.net_usdc ?? 0),
        closed: Boolean(conf.closed),
        signature: String(conf.signature ?? ''),
        // close_position is a full unwind on-chain, so the tokens closed
        // equal the full token_amount the position held at open time. The
        // preview is the most accurate live figure when present.
        tokensClosed: Number(preview?.tokensClosed ?? pos?.token_amount ?? 0),
        basketName: String(pos?.basket_name ?? 'Basket'),
      });
    } catch (e) {
      setErr(friendlyLeverageError((e as Error).message));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Shell>
      <div style={{ display: 'grid', gridTemplateColumns: '3fr 2fr', gap: 24 }}>
        {/* Left: details */}
        <div>
          <h1 style={{ fontSize: 24, fontWeight: 300, color: '#0A0A0A', margin: 0, fontFamily: SANS }}>Close Leveraged Position</h1>
          <div style={{ fontSize: 13, color: '#6B6B6B', fontFamily: SANS, marginTop: 4 }}>
            {pos.basket_name} · {pos.leverage}x Leverage
          </div>
          {health < 40 && (
            <div style={{ background: '#FFF7ED', border: '1px solid #FED7AA', color: '#C2410C', borderRadius: 6, padding: 10, fontSize: 12, marginTop: 16 }}>
              ⚠ Position approaching liquidation threshold
            </div>
          )}
          <div style={{ background: '#F7F7F5', borderRadius: 8, padding: 16, marginTop: 16 }}>
            <Row l="Collateral" v={fmtUsd(Number(pos.collateral_usdc))} />
            <Row l="Borrowed" v={fmtUsd(Number(pos.borrowed_usdc))} />
            <Row l="Total Exposure" v={fmtUsd(Number(pos.total_exposure))} />
            <Row l="Current NAV" v={`$${nav.toFixed(4)}`} />
            <Row l="Entry NAV" v={`$${Number(pos.entry_nav).toFixed(4)}`} />
            <Row l="Liquidation NAV" v={`$${Number(pos.liquidation_nav).toFixed(4)}`} color="#CC2936" />
            <Row l="Health" v={`${health.toFixed(0)}%`} color={healthColor} />
            <Row l="Interest Accrued" v={fmtUsd(Number(pos.interest_accrued))} />
            <Row l="Daily Interest" v={`${fmtUsd(Number(pos.daily_interest))}/day`} />
            <Row l="Unrealized P&L" v={`${pnl >= 0 ? '+' : '−'}${fmtUsd(Math.abs(pnl))}`} color={pnl >= 0 ? '#00875A' : '#CC2936'} />
          </div>
        </div>

        {/* Right: close form */}
        <div className="bg-white" style={{ border: '1px solid #E5E5E3', padding: 20, borderRadius: 8, height: 'fit-content' }}>
          <div style={{ fontSize: 16, fontWeight: 500, color: '#0A0A0A', fontFamily: SANS, marginBottom: 14 }}>Close Position</div>
          <div className="flex gap-2" style={{ marginBottom: 10 }}>
            {(['tokens', 'usdc'] as const).map((m) => (
              <button key={m} type="button" onClick={() => { setMode(m); setInput(''); }}
                style={{ flex: 1, padding: '6px 0', fontSize: 12, fontFamily: SANS, borderRadius: 3, cursor: 'pointer',
                  border: mode === m ? '1px solid #1A56DB' : '1px solid #E5E5E3', color: mode === m ? '#1A56DB' : '#6B6B6B', background: mode === m ? '#EBF0FF' : '#FFF' }}>
                {m === 'tokens' ? 'By tokens' : 'By USDC'}
              </button>
            ))}
          </div>
          <div style={{ fontSize: 10, color: '#9B9B9B', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 6, fontFamily: SANS }}>
            {mode === 'tokens' ? 'Tokens to close' : 'USDC to receive'}
          </div>
          <input value={input} inputMode="decimal" placeholder={mode === 'tokens' ? maxTokens.toFixed(4) : (maxTokens * nav).toFixed(2)}
            onChange={(e) => setInput(e.target.value)}
            style={{ width: '100%', background: '#F0F0EE', border: '1px solid #E5E5E3', borderRadius: 3, padding: '10px 12px', fontSize: 14, color: '#0A0A0A', fontFamily: MONO }} />
          <button type="button" onClick={() => setInput(mode === 'tokens' ? String(maxTokens) : String(maxTokens * nav))}
            style={{ marginTop: 6, fontSize: 11, color: '#1A56DB', background: 'none', border: 'none', cursor: 'pointer', padding: 0, fontFamily: SANS }}>Max</button>
          <div style={{ fontSize: 11, color: '#9B9B9B', marginTop: 4, fontFamily: SANS }}>
            {mode === 'tokens' ? `≈ ${fmtUsd(preview?.net ?? 0)} returned after fees` : `≈ ${tokensToClose.toFixed(4)} tokens closed`}
          </div>

          {preview && (
            <div style={{ background: '#F0FDF4', border: '1px solid #BBF7D0', borderRadius: 6, padding: 12, marginTop: 12 }}>
              <Row l="Tokens closed" v={`${preview.tokensClosed.toFixed(4)} ${pos.basket_name}`} small />
              <Row l="Gross value" v={fmtUsd(preview.gross)} small />
              <Row l="Repay borrowed" v={`-${fmtUsd(preview.repay)}`} small color="#CC2936" />
              <Row l="Interest owed" v={`-${fmtUsd(preview.interest)}`} small color="#CC2936" />
              <Row l="Protocol fee (0.5%)" v={`-${fmtUsd(preview.fee)}`} small color="#CC2936" />
              <Row l="You receive" v={`${fmtUsd(preview.net)} USDC`} small bold />
            </div>
          )}

          <button type="button" onClick={close} disabled={busy}
            style={{ width: '100%', background: '#CC2936', color: '#FFF', padding: '10px 0', fontSize: 13, fontWeight: 500, borderRadius: 3, border: 'none', cursor: busy ? 'not-allowed' : 'pointer', opacity: busy ? 0.5 : 1, marginTop: 12, fontFamily: SANS }}>
            {busy ? 'Closing…' : 'Close Position'}
          </button>
          {err && <div style={{ color: '#CC2936', fontSize: 12, marginTop: 8 }}>{err}</div>}
        </div>
      </div>

      {done && (
        <LeverageCloseModal
          done={done}
          onClose={() => setDone(null)}
        />
      )}
    </Shell>
  );
}

// =====================================================================
// Confirmation modal (visual style mirrors DepositForm.ConfirmationModal
// and RedeemForm.RedeemConfirmationModal so the user sees the same shape
// after every settlement action).
// =====================================================================

function LeverageCloseModal({
  done,
  onClose,
}: {
  done: { net: number; closed: boolean; signature: string; tokensClosed: number; basketName: string };
  onClose: () => void;
}) {
  const explorerUrl = `https://explorer.solana.com/tx/${done.signature}?cluster=devnet`;
  const sigShort = done.signature
    ? `${done.signature.slice(0, 8)}…${done.signature.slice(-8)}`
    : '—';
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
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#00875A" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="10" />
            <polyline points="9 12 11 14 15 10" />
          </svg>
          <h2 style={{ fontSize: 20, fontWeight: 500, color: '#0A0A0A', margin: 0, fontFamily: SANS }}>Position Closed</h2>
        </div>
        <div style={{ background: '#F7F7F5', borderRadius: 8, padding: 16, marginBottom: 16 }}>
          <ModalRow label="Basket" value={done.basketName} />
          <ModalRow label="Position size" value={`${done.tokensClosed.toFixed(4)} ${done.basketName}`} />
          <ModalRow label="USDC returned to wallet" value={fmtUsd(done.net)} />
          <ModalRow
            label="Transaction"
            value={
              done.signature ? (
                <a
                  href={explorerUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ color: '#1A56DB', textDecoration: 'none' }}
                >
                  {sigShort}
                </a>
              ) : (
                '—'
              )
            }
          />
        </div>
        {done.signature && (
          <a
            href={explorerUrl}
            target="_blank"
            rel="noopener noreferrer"
            style={{ display: 'inline-block', fontSize: 13, color: '#1A56DB', marginBottom: 20 }}
          >
            View on Solana Explorer →
          </a>
        )}
        <div className="flex gap-3">
          <Link
            href="/portfolio"
            onClick={onClose}
            style={{ flex: 1, textAlign: 'center', background: '#1A56DB', color: '#FFFFFF', padding: '12px 0', fontSize: 13, fontWeight: 500, borderRadius: 4, textDecoration: 'none', fontFamily: SANS }}
          >
            View Portfolio
          </Link>
          <button
            type="button"
            onClick={onClose}
            style={{ flex: 1, background: 'transparent', border: '1px solid #E5E5E3', color: '#6B6B6B', padding: '12px 0', fontSize: 13, fontWeight: 500, borderRadius: 4, cursor: 'pointer', fontFamily: SANS }}
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

function ModalRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between" style={{ padding: '4px 0' }}>
      <span style={{ fontSize: 11, color: '#9B9B9B', fontFamily: SANS }}>{label}</span>
      <span className="font-num" style={{ fontSize: 13, color: '#0A0A0A' }}>{value}</span>
    </div>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ background: '#F7F7F5', minHeight: 'calc(100vh - 56px)' }}>
      <div className="max-w-[1100px] mx-auto px-6 py-8">{children}</div>
    </div>
  );
}

function Row({ l, v, color, bold, small }: { l: string; v: string; color?: string; bold?: boolean; small?: boolean }) {
  return (
    <div className="flex items-center justify-between" style={{ padding: small ? '3px 0' : '5px 0' }}>
      <span style={{ fontSize: small ? 11 : 12, color: '#6B6B6B', fontFamily: SANS }}>{l}</span>
      <span className="font-num" style={{ fontSize: small ? 13 : 14, color: color ?? '#0A0A0A', fontWeight: bold ? 700 : 400, fontFamily: MONO }}>{v}</span>
    </div>
  );
}
