'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { AreaChart, Area, ResponsiveContainer } from 'recharts';
import { api } from '../_lib/api';
import { MOCK_BASKETS } from '../_lib/tokens';
import { GridBackground } from '../_components/GridBackground';

function BasketCardSkeleton() {
  return (
    <div className="bg-white" style={{ border: '1px solid #E5E5E3', borderRadius: 4, padding: 20 }}>
      <div className="flex justify-between items-start mb-4">
        <div style={{ flex: 1 }}>
          <div className="skeleton" style={{ height: 14, width: '70%', borderRadius: 2 }} />
          <div className="skeleton" style={{ height: 10, width: '35%', borderRadius: 2, marginTop: 8 }} />
        </div>
        <div className="skeleton" style={{ height: 16, width: 36, borderRadius: 10 }} />
      </div>
      <div className="grid grid-cols-2 gap-y-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="contents">
            <div className="skeleton" style={{ height: 10, width: '40%', borderRadius: 2 }} />
            <div className="skeleton" style={{ height: 12, width: '50%', borderRadius: 2, justifySelf: 'end' }} />
          </div>
        ))}
      </div>
    </div>
  );
}

interface BasketRow {
  id: string;
  name: string;
  category?: string | null;
  leverage_type: string;
  num_legs: number;
  nav?: number;
  avg_edge?: number;
  description?: string | null;
}

/**
 * Leverage variants are emitted from the basket builder with a `-2X` / `-3X`
 * suffix on the base CTRA-NN name. Base baskets are always 1x.
 */
function deriveLeverageFromName(name: string): string {
  const m = name.match(/-([23])X$/i);
  return m ? `${m[1]}x` : '1x';
}

export default function BasketsPage() {
  const [baskets, setBaskets] = useState<BasketRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [usingMock, setUsingMock] = useState(false);

  useEffect(() => {
    api.baskets
      .list()
      .then((r) => {
        // Archived baskets (legacy CTRA-01 etc.) live in the DB as a
        // historical record but should never render on the Baskets page.
        const live = (r.baskets ?? []).filter((b: any) => String(b.status ?? '').toLowerCase() !== 'archived');
        if (live.length === 0) {
          setUsingMock(true);
          setBaskets([]);
        } else {
          setBaskets(live);
        }
      })
      .catch(() => setUsingMock(true))
      .finally(() => setLoading(false));
  }, []);

  const display = usingMock || baskets.length === 0
    ? MOCK_BASKETS.map((m) => ({
        id: m.id,
        name: m.name,
        category: m.category,
        leverage_type: m.leverage_type,
        num_legs: m.legs,
        nav: m.nav,
        avg_edge: m.avg_edge,
        leverage: m.leverage,
        source: m.source,
      }))
    : baskets.map((b) => ({
        id: b.id,
        name: b.name,
        category: b.category ?? 'mixed',
        leverage_type: b.leverage_type,
        num_legs: b.num_legs,
        nav: b.nav ?? 1,
        avg_edge: b.avg_edge ?? 0,
        // Leverage variants are derived from the basket name suffix
        // (CTRA-01 = 1x base, CTRA-01-2X = 2x, CTRA-01-3X = 3x). The
        // `leverage_type` column tracks short/mid term, not multiplier.
        leverage: deriveLeverageFromName(b.name),
        source: 'Both',
        description: b.description ?? null,
        status: (b as any).status ?? 'active',
      }));

  return (
    <div style={{ position: 'relative', background: 'linear-gradient(135deg, #F7F7F5 0%, #F0F4FF 50%, #F7F7F5 100%)', backgroundSize: '400% 400%', animation: 'gradientShift 8s ease infinite', minHeight: 'calc(100vh - 56px)', overflow: 'hidden' }}>
      <style>{`@keyframes gradientShift { 0% { background-position: 0% 50% } 50% { background-position: 100% 50% } 100% { background-position: 0% 50% } }`}</style>
      {/* Page-texture watermark. Small repeating tile so it reads as
          paper grain rather than a floating mark, and the basket cards
          always overlap it. Pointer-events:none + low z-index keep this
          layer below every interactive element. */}
      <GridBackground
        opacity={0.035}
        variant="tile"
        markSize={44}
        gap={48}
        fadeIn
        duration={1400}
        style={{ position: 'fixed', zIndex: 0 }}
      />
      {usingMock && (
        <div
          style={{
            background: '#FEF3C7',
            color: '#92400E',
            borderBottom: '1px solid #FDE68A',
            padding: '8px 32px',
            fontSize: 10,
            textTransform: 'uppercase',
            letterSpacing: '0.08em',
          }}
        >
          No baskets live yet. Showing example data.
        </div>
      )}

      <div style={{ position: 'relative', zIndex: 1, maxWidth: 1200, margin: '0 auto', padding: '0 24px' }}>
        <div style={{ padding: '48px 0 32px', display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between' }}>
          <div>
            <h1 style={{ fontSize: 40, fontWeight: 200, color: '#0A0A0A', margin: 0, fontFamily: '"DM Sans", sans-serif' }}>Baskets</h1>
            <div style={{ fontSize: 15, color: '#6B6B6B', marginTop: 8, fontFamily: '"DM Sans", sans-serif' }}>
              {(() => {
                const longN = display.filter(isLongBasket).length;
                const shortN = display.length - longN;
                return `${shortN} short · ${longN} long · across Kalshi and Polymarket`;
              })()}
            </div>
          </div>
          <Link href="/scanner" style={{ border: '1px solid #1A56DB', color: '#1A56DB', padding: '8px 18px', borderRadius: 6, fontSize: 12, fontWeight: 500, fontFamily: '"DM Sans", sans-serif' }}>
            View Scanner
          </Link>
        </div>

        {/* Strict 2-column grid: odd-numbered baskets (CTRA-01, CTRA-03, ...)
            sorted ascending in the left column; even-numbered (CTRA-02,
            CTRA-04, ...) sorted ascending in the right column. Unequal
            column heights leave empty space at the bottom of the shorter
            side rather than spilling across. Colors are unchanged; column
            assignment is purely a sort/layout step. */}
        <div className="contra-baskets-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24, paddingBottom: 48 }}>
          {loading ? (
            Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="skeleton" style={{ height: 280, borderRadius: 16 }} />
            ))
          ) : (
            <>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
                {sortByCtraNumber(display.filter((b) => isOddBasket(b))).map((b) => (
                  <BasketCardPremium key={b.id} b={b} />
                ))}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
                {sortByCtraNumber(display.filter((b) => !isOddBasket(b))).map((b) => (
                  <BasketCardPremium key={b.id} b={b} />
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function isLongBasket(b: any): boolean {
  return /^CTRA-L/i.test(b.name ?? '') || /long exposure/i.test(b.description ?? '') || b.type === 'long';
}

/**
 * Parse the integer number out of a CTRA-NN basket name. Leverage variants
 * like CTRA-01-2X reuse the base number. CTRA-L prefixed names (legacy long
 * basket naming, e.g. CTRA-L02) parse from the digits after the L. Returns
 * Number.MAX_SAFE_INTEGER for anything unparseable so it sorts to the end.
 */
function parseCtraNumber(name: string | undefined): number {
  const m = (name ?? '').match(/^CTRA-L?(\d+)/i);
  if (!m) return Number.MAX_SAFE_INTEGER;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) ? n : Number.MAX_SAFE_INTEGER;
}

/** Odd-numbered baskets (CTRA-01, CTRA-03, ...) are short and render blue. */
function isOddBasket(b: any): boolean {
  const n = parseCtraNumber(b.name);
  if (n === Number.MAX_SAFE_INTEGER) return true; // unparseable: default to left column
  return n % 2 === 1;
}

/** Ascending sort by CTRA number; non-CTRA names fall to the bottom. */
function sortByCtraNumber<T extends { name?: string }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => parseCtraNumber(a.name) - parseCtraNumber(b.name));
}

const PILL: React.CSSProperties = {
  fontFamily: '"IBM Plex Mono", monospace', fontSize: 10, letterSpacing: '0.06em', fontWeight: 500,
  height: 20, lineHeight: '18px', padding: '0 8px', borderRadius: 10, display: 'inline-flex', alignItems: 'center', whiteSpace: 'nowrap',
};
const STAT_LABEL: React.CSSProperties = {
  fontSize: 10, color: '#9B9B9B', textTransform: 'uppercase', letterSpacing: '0.08em', fontFamily: '"DM Sans", sans-serif',
};

function timeAgo(iso?: string | null): string {
  if (!iso) return 'never';
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return 'just now';
  const m = Math.floor(ms / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function BasketCardPremium({ b }: { b: any }) {
  const router = useRouter();
  const [hover, setHover] = useState(false);
  const [navHistory, setNavHistory] = useState<{ nav: number }[]>([]);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.baskets.nav(b.id)
      .then((r: any) => {
        if (cancelled) return;
        const all = r.history ?? [];
        setNavHistory(all.slice(-50).map((h: any) => ({ nav: Number(h.nav ?? 1) })));
        const last = all[all.length - 1];
        setUpdatedAt(last?.snapshotted_at ?? last?.created_at ?? null);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [b.id]);

  const long = isLongBasket(b);
  const edge = Number(b.avg_edge ?? 0);
  const nav = Number(b.nav ?? 1);
  const navChange = (nav - 1) * 100;
  const status = String(b.status ?? 'active').toLowerCase();
  const desc = b.description ?? '';
  const accent = long ? '#00875A' : '#1A56DB';
  const fillId = `nav-fill-${b.id}`;
  const statusPill =
    status === 'finalized' ? { t: 'Finalized', bg: '#F3F4F6', fg: '#6B6B6B', bd: '#E5E7EB' }
    : status === 'resolving' ? { t: 'Resolving', bg: '#FFFBEB', fg: '#B45309', bd: '#FDE68A' }
    : { t: 'Active', bg: '#F0FDF4', fg: '#15803D', bd: '#BBF7D0' };
  const spark = navHistory.length >= 2 ? navHistory : [{ nav }, { nav }];

  return (
    <div
      onClick={() => router.push(`/baskets/${b.id}`)}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      className="contra-basket-card"
      style={{
        background: '#FFF', borderRadius: 20, padding: 32, cursor: 'pointer', borderTop: `3px solid ${accent}`,
        boxShadow: hover ? '0 12px 32px rgba(0,0,0,0.14)' : '0 4px 16px rgba(0,0,0,0.08)',
        transform: hover ? 'translateY(-4px)' : 'none',
        transition: 'all 250ms cubic-bezier(0.34, 1.56, 0.64, 1)',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <div className="contra-basket-card-title" style={{ fontSize: 24, fontWeight: 600, color: '#0A0A0A', fontFamily: '"IBM Plex Mono", monospace' }}>{b.name}</div>
          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            {/* Outlined type pill — more refined than a filled chip. */}
            <span style={{ height: 24, padding: '0 10px', borderRadius: 12, display: 'inline-flex', alignItems: 'center', background: '#FFF', border: `1.5px solid ${accent}`, color: accent, fontSize: 12, fontWeight: 500, fontFamily: '"DM Sans", sans-serif' }}>
              {long ? 'Long' : 'Short'}
            </span>
            <span style={{ height: 24, padding: '0 10px', borderRadius: 12, display: 'inline-flex', alignItems: 'center', background: statusPill.bg, color: statusPill.fg, fontSize: 12, fontWeight: 500, fontFamily: '"DM Sans", sans-serif' }}>
              {statusPill.t}
            </span>
          </div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div className="font-num contra-basket-card-nav" style={{ fontSize: 32, fontWeight: 200, color: '#0A0A0A', lineHeight: 1.1 }}>${nav.toFixed(4)}</div>
          <div className="font-num" style={{ fontSize: 14, color: navChange >= 0 ? '#00875A' : '#CC2936', marginTop: 4 }}>
            {navChange >= 0 ? '+' : '−'}{Math.abs(navChange).toFixed(1)}%
          </div>
        </div>
      </div>

      <div style={{ height: 1, background: '#F0F0F0', margin: '20px 0' }} />

      {/* stats grid with a centered vertical divider */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1px 1fr', gap: 20, alignItems: 'start' }}>
        <div>
          <div style={STAT_LABEL}>Avg Edge</div>
          <div className="font-num" style={{ fontSize: 18, color: edge >= 0 ? '#1A56DB' : '#00875A', marginTop: 2 }}>
            {edge >= 0 ? '+' : '−'}{Math.abs(edge * 100).toFixed(1)}%
          </div>
          <div style={{ ...STAT_LABEL, marginTop: 16 }}>Sources</div>
          <div style={{ fontSize: 13, color: '#6B6B6B', marginTop: 2, fontFamily: '"DM Sans", sans-serif' }}>Polymarket · Kalshi</div>
        </div>
        <div style={{ width: 1, height: 40, background: '#F0F0F0', alignSelf: 'center' }} />
        <div>
          <div style={STAT_LABEL}>Status</div>
          <div style={{ fontSize: 13, color: '#0A0A0A', marginTop: 2, fontFamily: '"DM Sans", sans-serif' }}>{statusPill.t}</div>
          <div style={{ ...STAT_LABEL, marginTop: 16 }}>Updated</div>
          <div style={{ fontSize: 13, color: '#6B6B6B', marginTop: 2, fontFamily: '"DM Sans", sans-serif' }}>{timeAgo(updatedAt)}</div>
        </div>
      </div>

      <div style={{ marginTop: 16, height: 56, width: '100%' }}>
        <ResponsiveContainer width="100%" height={56}>
          <AreaChart data={spark} margin={{ top: 4, bottom: 4, left: 0, right: 0 }}>
            <defs>
              <linearGradient id={fillId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={accent} stopOpacity={0.18} />
                <stop offset="100%" stopColor={accent} stopOpacity={0} />
              </linearGradient>
            </defs>
            <Area type="monotone" dataKey="nav" stroke={accent} strokeWidth={2} fill={`url(#${fillId})`} dot={false} isAnimationActive={false} />
          </AreaChart>
        </ResponsiveContainer>
      </div>

      {desc && (
        <div style={{ fontSize: 13, color: '#6B6B6B', marginTop: 16, fontFamily: '"DM Sans", sans-serif', lineHeight: 1.5, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
          {desc}
        </div>
      )}
      <div style={{ fontSize: 10, color: '#C0C0C0', marginTop: 8, fontFamily: '"DM Sans", sans-serif' }}>Model-driven · Solana devnet</div>
    </div>
  );
}
