'use client';

import { useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import { api } from '../../_lib/api';
import { NavChart, type NavPoint } from '../../_components/NavChart';
import { DepositForm } from '../../_components/DepositForm';
import { RedeemForm } from '../../_components/RedeemForm';

interface Leg {
  leg_index: number;
  source: string;
  market_id: string;
  question: string;
  p_market_entry: number;
  p_model: number;
  edge: number;
}

/**
 * Subtitle term label derived from the basket name + type.
 *   CTRA-NN odd  → "SHORT TERM"
 *   CTRA-NN even → "MID TERM"
 *   CTRA-LXX or type === 'long' → "LONG"
 *
 * Falls back to a stringified leverage_type for legacy mock data.
 */
function basketTermLabel(basket: { name: string; leverage_type?: string; type?: string }): string {
  const name = basket?.name ?? '';
  if (basket?.type === 'long' || /^CTRA-L\d+/i.test(name)) return 'LONG';
  const m = name.match(/^CTRA-(\d+)/i);
  if (m) {
    const n = parseInt(m[1], 10);
    if (!Number.isNaN(n)) return n % 2 === 1 ? 'SHORT TERM' : 'MID TERM';
  }
  return (basket?.leverage_type ?? '').toUpperCase();
}

export default function BasketDetail() {
  const params = useParams<{ id: string }>();
  const searchParams = useSearchParams();
  const id = params?.id ?? '';
  const [tab, setTab] = useState<'buy' | 'sell'>('buy');
  useEffect(() => {
    if (searchParams?.get('tab') === 'sell') setTab('sell');
  }, [searchParams]);
  const [data, setData] = useState<any>(null);
  const [history, setHistory] = useState<NavPoint[]>([]);
  // condition_id → volume, sourced from the live scanner so we can
  // surface a non-model "featured" signal without leaking edge/model.
  const [volumeByMarket, setVolumeByMarket] = useState<Record<string, number>>({});
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    api.baskets.get(id).then(setData).catch((e) => setErr(e.message));
    api.baskets
      .nav(id)
      .then((r) => setHistory(r.history.map((h) => ({ t: h.snapshotted_at, nav: Number(h.nav) }))))
      .catch(() => setHistory([]));
    // Best-effort scanner join. The scanner endpoint returns volume per
    // market — if it 404s or the basket's legs aren't in the snapshot,
    // we fall back to leg_index order for the featured picks.
    api.scanner
      .markets({ min: 0, max: 1, limit: 1000 })
      .then((r) => {
        const map: Record<string, number> = {};
        for (const row of r.rows) {
          if (row.marketId && typeof row.volume === 'number') map[row.marketId] = row.volume;
        }
        setVolumeByMarket(map);
      })
      .catch(() => setVolumeByMarket({}));
  }, [id]);

  if (err) {
    return (
      <div style={{ background: '#F7F7F5', minHeight: 'calc(100vh - 56px)' }} className="p-8">
        <div style={{ color: '#CC2936', fontSize: 13 }}>{err}</div>
      </div>
    );
  }
  if (!data) {
    return (
      <div style={{ background: '#F7F7F5', minHeight: 'calc(100vh - 56px)' }} className="p-8">
        <div style={{ color: '#9B9B9B', fontSize: 13 }}>Loading basket...</div>
      </div>
    );
  }

  const { basket, legs, nav } = data;
  const isUp = nav >= 1;

  // Top-3 by joined volume; fall back to first 3 if no volume data lined up.
  const featured = pickFeatured(legs as Leg[], volumeByMarket);
  const remaining = Math.max(0, legs.length - featured.length);

  // avg_edge for the basket. Backend returns it on the basket row when
  // available; if not, derive from the legs we already have.
  const avgEdge: number =
    typeof basket.avg_edge === 'number'
      ? basket.avg_edge
      : legs.length > 0
      ? legs.reduce((s: number, l: any) => s + Number(l.edge ?? 0), 0) / legs.length
      : 0;

  return (
    <div style={{ background: '#F7F7F5', minHeight: 'calc(100vh - 56px)' }}>
      <div className="max-w-[1400px] mx-auto px-6 py-8 space-y-6">
        <div className="flex justify-between items-start">
          <div>
            <h1 style={{ fontSize: 28, fontWeight: 300, color: '#0A0A0A', margin: 0 }}>{basket.name}</h1>
            <div style={{ fontSize: 10, color: '#9B9B9B', textTransform: 'uppercase', letterSpacing: '0.08em', marginTop: 8 }}>
              {basketTermLabel(basket)} · status {basket.status}
            </div>
            {basket.description && (
              <div style={{ fontSize: 14, color: '#6B6B6B', fontFamily: '"DM Sans", sans-serif', marginTop: 12, maxWidth: 640, lineHeight: 1.5 }}>
                {basket.description}
              </div>
            )}
            <div style={{ fontSize: 11, color: '#9B9B9B', fontFamily: '"DM Sans", sans-serif', marginTop: 8 }}>
              Not financial advice. Prediction markets involve risk of loss.
            </div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: 10, color: '#9B9B9B', textTransform: 'uppercase', letterSpacing: '0.08em' }}>NAV</div>
            <div className="font-num" style={{ fontSize: 32, color: isUp ? '#00875A' : '#CC2936' }}>
              ${nav.toFixed(4)}
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2 space-y-6">
            <div className="bg-white" style={{ border: '1px solid #E5E5E3', padding: 20, paddingLeft: 20, paddingRight: 20 }}>
              <div style={{ fontSize: 10, color: '#9B9B9B', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 12 }}>
                NAV history
              </div>
              <NavChart data={history} />
            </div>

            <FeaturedMarkets featured={featured} remaining={remaining} />
          </div>
          <div className="space-y-4">
            <div className="bg-white" style={{ border: '1px solid #E5E5E3', borderBottom: 'none', display: 'flex', gap: 24, padding: '0 20px' }}>
              {(['buy', 'sell'] as const).map((t) => {
                const active = tab === t;
                return (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setTab(t)}
                    style={{
                      background: 'transparent',
                      border: 'none',
                      padding: '12px 0',
                      fontFamily: '"DM Sans", sans-serif',
                      fontSize: 13,
                      fontWeight: 500,
                      color: active ? '#0A0A0A' : '#9B9B9B',
                      borderBottom: `2px solid ${active ? '#1A56DB' : 'transparent'}`,
                      marginBottom: -1,
                      cursor: 'pointer',
                    }}
                  >
                    {t === 'buy' ? 'Buy' : 'Sell'}
                  </button>
                );
              })}
            </div>
            {tab === 'buy' ? (
              <DepositForm
                basketId={basket.id}
                basketName={basket.name}
                avgEdge={avgEdge}
                entryNav={Number(nav) || 1}
              />
            ) : (
              <RedeemForm basketId={basket.id} basketName={basket.name} currentNav={Number(nav) || 1} />
            )}
            <div style={{ fontSize: 10, color: '#9B9B9B', lineHeight: 1.5 }}>
              Edge is model-estimated. Past performance does not guarantee future results.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function pickFeatured(legs: Leg[], volumeByMarket: Record<string, number>): Leg[] {
  if (!legs || legs.length === 0) return [];
  const withVol = legs
    .map((l) => ({ leg: l, vol: volumeByMarket[l.market_id] ?? 0 }))
    .sort((a, b) => b.vol - a.vol);
  // If no leg matched any scanner row, just take the first three legs in
  // index order so the section still renders something useful.
  const haveVolume = withVol[0]?.vol > 0;
  const picked = haveVolume ? withVol.slice(0, 3).map((x) => x.leg) : legs.slice(0, 3);
  return picked;
}

function FeaturedMarkets({ featured, remaining }: { featured: Leg[]; remaining: number }) {
  return (
    <div className="bg-white" style={{ border: '1px solid #E5E5E3', padding: 20 }}>
      <div
        style={{
          fontSize: 10,
          color: '#9B9B9B',
          textTransform: 'uppercase',
          letterSpacing: '0.08em',
          marginBottom: 16,
        }}
      >
        Featured markets
      </div>

      {/* column header row */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 90px 80px 80px 80px',
          gap: 12,
          padding: '8px 0',
          borderBottom: '1px solid #F0F0EE',
          fontSize: 10,
          color: '#9B9B9B',
          textTransform: 'uppercase',
          letterSpacing: '0.08em',
        }}
      >
        <span>Market</span>
        <span>Source</span>
        <span style={{ textAlign: 'right' }}>P_Market</span>
        <span style={{ textAlign: 'right' }}>P_Model</span>
        <span style={{ textAlign: 'right' }}>Est. Edge <InfoTip text="Model's estimated probability vs market implied probability. Positive: model sees overpricing. Negative: model sees underpricing. Not financial advice." /></span>
      </div>

      <div>
        {featured.map((l) => (
          <FeaturedRow key={l.leg_index} leg={l} />
        ))}
      </div>

      <div style={{ marginTop: 16, fontSize: 12, color: '#9B9B9B', fontStyle: 'italic' }}>
        + {remaining} more positions · proprietary selection
      </div>
      <div style={{ marginTop: 8, fontSize: 10, color: '#9B9B9B' }}>
        Edge is model-estimated. Past performance does not guarantee future results.
      </div>
    </div>
  );
}

function FeaturedRow({ leg }: { leg: Leg }) {
  const pMarket = Number(leg.p_market_entry ?? 0);
  const pModel = Number(leg.p_model ?? 0);
  const edge = Number(leg.edge ?? 0);
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '1fr 90px 80px 80px 80px',
        gap: 12,
        alignItems: 'center',
        padding: '14px 0',
        borderBottom: '1px solid #F0F0EE',
      }}
    >
      <div style={{ color: '#0A0A0A', fontSize: 14, lineHeight: 1.4 }}>
        {truncate(leg.question, 60)}
      </div>
      <SourcePill source={leg.source} />
      <span className="font-num" style={{ textAlign: 'right', fontSize: 13, color: '#CC2936' }}>
        {(pMarket * 100).toFixed(1)}%
      </span>
      <span className="font-num" style={{ textAlign: 'right', fontSize: 13, color: '#6B6B6B' }}>
        {(pModel * 100).toFixed(1)}%
      </span>
      <span className="font-num" style={{ textAlign: 'right', fontSize: 13, color: edge >= 0 ? '#1A56DB' : '#00875A' }}>
        {edge >= 0 ? '+' : '−'}{Math.abs(edge * 100).toFixed(1)}%
      </span>
    </div>
  );
}

function truncate(s: string, n: number): string {
  if (!s) return '';
  return s.length <= n ? s : s.slice(0, n - 1).trimEnd() + '…';
}

function InfoTip({ text }: { text: string }) {
  const [show, setShow] = useState(false);
  return (
    <span onMouseEnter={() => setShow(true)} onMouseLeave={() => setShow(false)}
      style={{ position: 'relative', color: '#C0C0C0', cursor: 'help', fontSize: 11 }}>
      ⓘ
      {show && (
        <span style={{
          position: 'absolute', bottom: '150%', right: 0, background: '#FFFFFF', border: '1px solid #E5E5E3',
          borderRadius: 8, padding: 12, fontSize: 12, fontFamily: '"DM Sans", sans-serif', color: '#0A0A0A',
          width: 220, whiteSpace: 'normal', textTransform: 'none', letterSpacing: 0, lineHeight: 1.5, fontWeight: 400,
          boxShadow: '0 8px 24px rgba(0,0,0,0.1)', zIndex: 50, textAlign: 'left',
        }}>{text}</span>
      )}
    </span>
  );
}

function SourcePill({ source }: { source: string }) {
  const isKalshi = (source ?? '').toLowerCase() === 'kalshi';
  const c = isKalshi
    ? { background: '#F0FDF4', color: '#15803D', border: '1px solid #BBF7D0' }
    : { background: '#EFF6FF', color: '#1D4ED8', border: '1px solid #BFDBFE' };
  return (
    <span style={{
      fontFamily: '"IBM Plex Mono", monospace', fontSize: 10, letterSpacing: '0.06em', fontWeight: 500,
      height: 20, lineHeight: '18px', padding: '0 8px', borderRadius: 10, display: 'inline-flex',
      alignItems: 'center', whiteSpace: 'nowrap', width: 'fit-content', boxSizing: 'border-box', ...c,
    }}>
      {isKalshi ? 'Kalshi' : 'Polymarket'}
    </span>
  );
}
