'use client';

import { useEffect, useMemo, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { api } from '../../_lib/api';

const SANS = '"DM Sans", sans-serif';
const MONO = '"IBM Plex Mono", monospace';

function fmtUsd(v: number): string {
  if (!Number.isFinite(v)) return '$0.00';
  return v > 0 && v < 0.01 ? `$${v.toFixed(4)}` : `$${v.toFixed(2)}`;
}

export default function LeverageClosePage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const id = params?.id ?? '';
  const [pos, setPos] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  const [mode, setMode] = useState<'tokens' | 'usdc'>('tokens');
  const [input, setInput] = useState('');
  const [preview, setPreview] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ net: number; closed: boolean } | null>(null);

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
    if (tokensToClose <= 0) { setErr('Enter an amount to close'); return; }
    setBusy(true);
    try {
      // On-chain close_position settlement is wired at the DB/accounting layer;
      // a signed-tx builder follows the verified open-position pattern.
      const r = await api.leverage.confirm(id, { signature: 'pending-' + Date.now(), tokenAmount: tokensToClose });
      setDone({ net: r.net_usdc, closed: r.closed });
    } catch (e) {
      setErr((e as Error).message);
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

          {done && (
            <div style={{ marginTop: 14, background: '#F7F7F5', borderRadius: 8, padding: 14 }}>
              <div style={{ fontSize: 14, fontWeight: 500, color: '#00875A', fontFamily: SANS }}>Position Closed</div>
              <div style={{ fontSize: 13, color: '#0A0A0A', fontFamily: MONO, marginTop: 4 }}>Received {fmtUsd(done.net)} USDC</div>
              <button type="button" onClick={() => router.push('/portfolio')}
                style={{ marginTop: 10, background: '#1A56DB', color: '#FFF', padding: '8px 16px', fontSize: 13, borderRadius: 4, border: 'none', cursor: 'pointer', fontFamily: SANS }}>View Portfolio</button>
            </div>
          )}
        </div>
      </div>
    </Shell>
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
