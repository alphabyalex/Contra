'use client';

/**
 * Live Mispricing Scanner — calibration_v2 layered model.
 *
 *   - Default view: top 25 by volume (most liquid markets, most recognizable)
 *   - Search box queries the FULL pool server-side via ?search=
 *   - All probabilities rendered as percentages
 *   - Edge column = adjusted_edge (post time/category/volume layers)
 *   - No internal classification labels (Eligible / Excluded / Impossible)
 *     — the data speaks for itself. Excluded/unscreened rows show "—" for
 *     p_model and adj. edge. Impossible rows show their numeric scores
 *     (p_model 0%, edge = p_market) without any label.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../_lib/api';
import { useInView } from '../_lib/useInView';

interface Row {
  question: string;
  source: 'kalshi' | 'polymarket';
  marketId: string;
  outcomeLabel?: string;
  p_market: number;
  volume?: number;
  daysToClose?: number | null;
  endDateIso?: string;
  category?: string;
  screened?: boolean;
  excluded?: boolean;
  impossible?: boolean;
  exclusion_reason?: string | null;
  p_model?: number | null;
  edge?: number | null;
  adjusted_edge?: number | null;
  include_in_basket?: boolean | null;
}

const MIN = 0.02;
const MAX = 0.15;
const TOP_N = 25;
const REFRESH_MS = 60_000;

type SortField = 'volume' | 'edge' | 'days' | 'p_market';

export default function ScannerPage() {
  const [rows, setRows] = useState<Row[]>([]);
  const [counts, setCounts] = useState<{ polymarket: number; kalshi: number }>({ polymarket: 0, kalshi: 0 });
  const [totalAfterFilter, setTotalAfterFilter] = useState<number>(0);
  const [kalshiError, setKalshiError] = useState<string | null>(null);
  const [kalshiThrottled, setKalshiThrottled] = useState<boolean>(false);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [sortField, setSortField] = useState<SortField>('volume');
  const [retryIn, setRetryIn] = useState<number>(REFRESH_MS / 1000);
  const [query, setQuery] = useState('');

  const refreshTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const tickTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async (opts: { search?: string; sort?: SortField } = {}) => {
    try {
      const r = await api.scanner.markets({
        min: MIN,
        max: MAX,
        sort: opts.sort ?? sortField,
        search: opts.search ?? (query.trim() || undefined),
      });
      const data = (Array.isArray(r.rows) ? r.rows : []) as Row[];
      setRows(data);
      setCounts(r.counts ?? { polymarket: 0, kalshi: 0 });
      setTotalAfterFilter(r.total_after_filter ?? data.length);
      setKalshiError(r.kalshi_error ?? null);
      setKalshiThrottled(Boolean(r.kalshi_throttled));
      setUpdatedAt(r.at ?? Date.now());
      setError(null);
      setRetryIn(REFRESH_MS / 1000);
    } catch (e) {
      setError((e as Error).message);
      setRetryIn(REFRESH_MS / 1000);
    } finally {
      setLoading(false);
    }
  }, [sortField, query]);

  useEffect(() => {
    load();
    refreshTimer.current = setInterval(() => load(), REFRESH_MS);
    tickTimer.current = setInterval(() => {
      setTick((t) => t + 1);
      setRetryIn((r) => Math.max(0, r - 1));
    }, 1000);
    return () => {
      if (refreshTimer.current) clearInterval(refreshTimer.current);
      if (tickTimer.current) clearInterval(tickTimer.current);
    };
  // load is stable enough — explicit deps avoid double-fetch storms.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Debounce search refetches.
  useEffect(() => {
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    debounceTimer.current = setTimeout(() => load({ search: query.trim() || undefined }), 250);
    return () => { if (debounceTimer.current) clearTimeout(debounceTimer.current); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  // Refetch when sort changes.
  useEffect(() => { load({ sort: sortField }); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [sortField]);

  const isSearching = query.trim().length > 0;
  const visible = useMemo(() => rows, [rows]);
  const secondsAgo = updatedAt ? Math.max(0, Math.floor((Date.now() - updatedAt) / 1000)) : null;
  void tick;

  return (
    <div style={{ background: '#F7F7F5', minHeight: 'calc(100vh - 56px)' }}>
      <div className="max-w-[1400px] mx-auto px-6 py-10">
        <div className="bg-white" style={{ border: '1px solid #E5E5E3' }}>
          {/* Header */}
          <div className="flex items-end justify-between" style={{ padding: '32px 36px', borderBottom: '1px solid #E5E5E3' }}>
            <div>
              <h1 style={{ fontSize: 36, fontWeight: 300, color: '#0A0A0A', margin: 0 }}>
                Live Mispricing Scanner
              </h1>
              <div style={{ fontSize: 12, color: '#9B9B9B', marginTop: 10 }}>
                {isSearching
                  ? `${visible.length} result${visible.length === 1 ? '' : 's'} for "${query.trim()}" · across ${totalAfterFilter} total markets`
                  : `Top ${TOP_N} most liquid markets · ${totalAfterFilter} total watched`}
              </div>
              {!loading && !error && (
                <div style={{ fontSize: 11, color: '#9B9B9B', marginTop: 4 }}>
                  {counts.polymarket} from Polymarket
                  <span style={{ color: '#1A56DB', margin: '0 6px' }}>·</span>
                  {counts.kalshi} from Kalshi
                </div>
              )}
              {kalshiError && !kalshiThrottled && (
                <div style={{ fontSize: 10, color: '#CC2936', marginTop: 4, fontFamily: '"IBM Plex Mono", monospace' }}>
                  Kalshi: {kalshiError}
                </div>
              )}
              {kalshiThrottled && !kalshiError && (
                <div style={{ fontSize: 10, color: '#9B9B9B', marginTop: 4 }}>
                  Kalshi data temporarily throttled — retrying shortly.
                </div>
              )}
            </div>
            <div className="flex items-center gap-3">
              <span className="font-num" style={{ fontSize: 12, color: '#9B9B9B' }}>
                {error ? 'last fetch failed' : secondsAgo == null ? 'never' : `Updated ${secondsAgo}s ago`}
              </span>
              <RefreshButton onClick={() => load()} loading={loading} />
            </div>
          </div>

          {/* Search bar */}
          <div style={{ padding: '20px 36px', borderBottom: '1px solid #E5E5E3' }}>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search across all watched markets..."
              style={{
                width: '100%', background: '#FFFFFF', border: '1px solid #E5E5E3', borderRadius: 3,
                padding: '12px 14px', fontSize: 15, color: '#0A0A0A',
                fontFamily: '"DM Sans", sans-serif', outline: 'none',
              }}
              onFocus={(e) => (e.currentTarget.style.borderColor = '#1A56DB')}
              onBlur={(e) => (e.currentTarget.style.borderColor = '#E5E5E3')}
            />
          </div>

          {/* States */}
          {loading && <SkeletonRows count={8} />}
          {!loading && error && (
            <div style={{ padding: 56, textAlign: 'center' }}>
              <div style={{ color: '#CC2936', fontSize: 17 }}>Markets temporarily unavailable.</div>
              <div className="font-num" style={{ color: '#6B6B6B', fontSize: 14, marginTop: 8 }}>
                Retrying in {retryIn}s
              </div>
            </div>
          )}
          {!loading && !error && visible.length === 0 && (
            <div style={{ padding: 56, textAlign: 'center', color: '#9B9B9B', fontSize: 15 }}>
              {isSearching ? `No markets matching "${query.trim()}"` : 'No markets in the longshot range right now.'}
            </div>
          )}

          {/* Table */}
          {!loading && !error && visible.length > 0 && (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: '"DM Sans", sans-serif' }}>
                <thead>
                  <tr>
                    <Th>Market</Th>
                    <Th>Source</Th>
                    <Th align="right" sortable active={sortField === 'p_market'} onClick={() => setSortField('p_market')}>P_market</Th>
                    <Th align="right">P_model</Th>
                    <Th align="right" sortable active={sortField === 'edge'} onClick={() => setSortField('edge')}>
                      Adj. Edge
                    </Th>
                    <Th align="right" sortable active={sortField === 'days'} onClick={() => setSortField('days')}>Days</Th>
                    <Th align="right" sortable active={sortField === 'volume'} onClick={() => setSortField('volume')}>Volume</Th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((r, i) => (
                    <ScannerRow key={`${r.source}-${r.marketId}-${i}`} row={r} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ====== row =========================================================

function ScannerRow({ row }: { row: Row }) {
  const truncated = row.question.length > 64 ? row.question.slice(0, 63).trimEnd() + '…' : row.question;
  const targetW = Math.max(8, Math.min(600, row.p_market * 600));
  const days = row.daysToClose != null ? Math.round(row.daysToClose) : null;
  const [ref, inView] = useInView<HTMLTableRowElement>(0.1);
  const [hover, setHover] = useState(false);

  // Display logic per spec:
  //   impossible    → p_model green "0.0%", edge green = p_market %
  //   excluded (not impossible) → both "—"
  //   not screened  → both "—"
  //   eligible      → real values
  const isImpossible = Boolean(row.impossible);
  const isExcluded = Boolean(row.excluded) && !isImpossible;
  const isUnscreened = !row.screened && !isExcluded && !isImpossible;

  const pModelDisplay = isImpossible
    ? '0.0%'
    : isExcluded || isUnscreened
    ? '—'
    : row.p_model != null
    ? formatPct(row.p_model)
    : '—';

  const adjEdge = row.adjusted_edge ?? row.edge ?? null;
  const edgeDisplay = isImpossible
    ? formatPct(row.p_market)
    : isExcluded || isUnscreened
    ? '—'
    : adjEdge != null
    ? formatPct(adjEdge)
    : '—';

  const pModelColor = isImpossible ? '#00875A' : isExcluded || isUnscreened ? '#9B9B9B' : '#0A0A0A';
  const edgeColor = isImpossible ? '#00875A' : isExcluded || isUnscreened ? '#9B9B9B' : '#1A56DB';

  const daysColor =
    days == null ? '#9B9B9B' :
    days < 30 ? '#00875A' :
    days <= 90 ? '#0A0A0A' :
    days <= 180 ? '#6B6B6B' : '#9B9B9B';

  return (
    <tr
      ref={ref}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{ borderBottom: '1px solid #E5E5E3', background: hover ? '#F7F7F5' : '#FFFFFF', transition: 'background 150ms ease-out' }}
    >
      <td style={{ padding: '16px 18px', verticalAlign: 'top' }}>
        <div style={{ fontSize: 15, color: '#0A0A0A' }} title={row.question}>
          {truncated}
        </div>
        <div style={{ marginTop: 8, height: 4, width: 600, maxWidth: '100%', background: '#F0F0EE', borderRadius: 2 }}>
          <div
            style={{
              height: '100%',
              width: inView ? targetW : 0,
              background: '#1A56DB',
              borderRadius: 2,
              transition: 'width 700ms cubic-bezier(0.2, 0.8, 0.2, 1)',
            }}
          />
        </div>
        <div className="font-num" style={{ fontSize: 11, color: '#9B9B9B', marginTop: 6 }}>
          market: {formatPct(row.p_market)}
        </div>
      </td>
      <td style={{ padding: '16px 18px', verticalAlign: 'top' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'flex-start' }}>
          <SourcePill source={row.source} />
          <CategoryPill category={row.category} />
        </div>
      </td>
      <td className="font-num" style={{ padding: '16px 18px', textAlign: 'right', fontSize: 15, color: '#CC2936', verticalAlign: 'top' }}>
        {formatPct(row.p_market)}
      </td>
      <td className="font-num" style={{ padding: '16px 18px', textAlign: 'right', fontSize: 15, color: pModelColor, verticalAlign: 'top' }}>
        {pModelDisplay}
      </td>
      <td className="font-num" style={{ padding: '16px 18px', textAlign: 'right', fontSize: 15, color: edgeColor, verticalAlign: 'top' }}>
        {edgeDisplay}
      </td>
      <td className="font-num" style={{ padding: '16px 18px', textAlign: 'right', fontSize: 13, color: daysColor, verticalAlign: 'top' }}>
        {days != null ? `${days}d` : '—'}
      </td>
      <td className="font-num" style={{ padding: '16px 18px', textAlign: 'right', fontSize: 13, color: '#6B6B6B', verticalAlign: 'top' }}>
        {row.volume != null ? formatVolume(row.volume) : '—'}
      </td>
    </tr>
  );
}

// ====== shared =====================================================

function formatPct(v: number): string {
  return `${(v * 100).toFixed(1)}%`;
}

function formatVolume(v: number): string {
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `$${(v / 1_000).toFixed(0)}K`;
  return `$${v.toFixed(0)}`;
}

function Th({
  children, align = 'left', sortable, active, onClick,
}: {
  children: React.ReactNode;
  align?: 'left' | 'right';
  sortable?: boolean;
  active?: boolean;
  onClick?: () => void;
}) {
  const [hover, setHover] = useState(false);
  return (
    <th
      onClick={sortable ? onClick : undefined}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        textAlign: align,
        fontSize: 11,
        fontWeight: 500,
        color: sortable && hover ? '#0A0A0A' : active ? '#1A56DB' : '#9B9B9B',
        textTransform: 'uppercase',
        letterSpacing: '0.08em',
        padding: '14px 18px',
        borderBottom: '1px solid #E5E5E3',
        cursor: sortable ? 'pointer' : 'default',
        userSelect: 'none',
        transition: 'color 150ms ease-out',
      }}
    >
      {children}
      {sortable && active && (
        <span className="font-num" style={{ marginLeft: 6, color: '#1A56DB' }}>
          ↓
        </span>
      )}
    </th>
  );
}

function RefreshButton({ onClick, loading }: { onClick: () => void; loading: boolean }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      disabled={loading}
      title="Refresh"
      style={{
        width: 32, height: 32, borderRadius: 999, border: '1px solid #E5E5E3',
        background: hover ? '#EBF0FF' : '#FFFFFF',
        cursor: loading ? 'not-allowed' : 'pointer',
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        transition: 'background 150ms ease-out',
      }}
    >
      <svg width={14} height={14} viewBox="0 0 24 24" fill="none"
        stroke={hover ? '#1A56DB' : '#6B6B6B'} strokeWidth={2}
        strokeLinecap="round" strokeLinejoin="round"
        style={{ transition: 'stroke 150ms ease-out', transform: loading ? 'rotate(45deg)' : 'none' }}>
        <polyline points="23 4 23 10 17 10" />
        <polyline points="1 20 1 14 7 14" />
        <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
      </svg>
    </button>
  );
}

function SkeletonRows({ count }: { count: number }) {
  return (
    <div>
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} style={{
          display: 'grid',
          gridTemplateColumns: '4fr 1fr 1fr 1fr 1fr 1fr 1fr',
          gap: 16, padding: '16px 18px', borderBottom: '1px solid #E5E5E3', alignItems: 'center',
        }}>
          <div className="skeleton" style={{ height: 14, borderRadius: 2, width: '85%' }} />
          <div className="skeleton" style={{ height: 18, borderRadius: 999, width: 70 }} />
          <div className="skeleton" style={{ height: 14, borderRadius: 2, width: '60%', justifySelf: 'end' }} />
          <div className="skeleton" style={{ height: 14, borderRadius: 2, width: '60%', justifySelf: 'end' }} />
          <div className="skeleton" style={{ height: 14, borderRadius: 2, width: '60%', justifySelf: 'end' }} />
          <div className="skeleton" style={{ height: 14, borderRadius: 2, width: '50%', justifySelf: 'end' }} />
          <div className="skeleton" style={{ height: 14, borderRadius: 2, width: '50%', justifySelf: 'end' }} />
        </div>
      ))}
    </div>
  );
}

function SourcePill({ source }: { source: 'kalshi' | 'polymarket' }) {
  const isKalshi = source === 'kalshi';
  return (
    <span
      style={{
        fontSize: 11, padding: '4px 10px', borderRadius: 10,
        background: isKalshi ? '#EBF0FF' : '#F5F5F5',
        color: isKalshi ? '#1A56DB' : '#6B6B6B',
        fontFamily: '"DM Sans", sans-serif', fontWeight: 500, letterSpacing: '0.02em',
      }}
    >
      {isKalshi ? 'Kalshi' : 'Polymarket'}
    </span>
  );
}

const CATEGORY_PALETTE: Record<string, { bg: string; fg: string }> = {
  sports:   { bg: '#E0EBF7', fg: '#1A4F8C' }, // light blue
  politics: { bg: '#EFE4F4', fg: '#6B3FA0' }, // light purple
  macro:    { bg: '#FAEBD7', fg: '#A35E14' }, // light orange
  crypto:   { bg: '#FAF5DC', fg: '#9C7B14' }, // light yellow
  culture:  { bg: '#FBE6EE', fg: '#A4366E' }, // light pink
  other:    { bg: '#F0F0EE', fg: '#6B6B6B' },
};

function CategoryPill({ category }: { category?: string | null }) {
  const key = (category ?? 'other').toLowerCase();
  const palette = CATEGORY_PALETTE[key] ?? CATEGORY_PALETTE.other;
  return (
    <span
      style={{
        fontSize: 10, padding: '3px 8px', borderRadius: 10,
        background: palette.bg, color: palette.fg,
        fontFamily: '"DM Sans", sans-serif', fontWeight: 500, letterSpacing: '0.04em',
        textTransform: 'lowercase',
      }}
    >
      {key}
    </span>
  );
}

