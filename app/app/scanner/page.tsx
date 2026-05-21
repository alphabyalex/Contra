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

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
  raw_edge?: number | null;
  adjusted_edge?: number | null;
  signal?: 'strong_short' | 'short' | 'weak_short' | 'fair_value' | 'long' | 'strong_long' | null;
  include_in_basket?: boolean | null;
  // calibration_v5 tournament normalization
  tournament_group?: string | null;
  is_tournament_market?: boolean;
  normalized_p_market?: number | null;
  is_favorite?: boolean;
  is_ephemeral?: boolean;
  score?: number;
}

interface ScannerGroup {
  category: string;
  short_count: number;
  long_count: number;
  long_section_start: number | null;
  markets: Row[];
}

const MIN = 0.02;
const MAX = 0.15;
const TOP_N = 25;
const REFRESH_MS = 60_000;

type SortField = 'volume' | 'edge' | 'days' | 'p_market';

export default function ScannerPage() {
  const [rows, setRows] = useState<Row[]>([]);
  const [groups, setGroups] = useState<ScannerGroup[]>([]);
  const [view, setView] = useState<'category_grouped' | 'search'>('category_grouped');
  const [watchedCount, setWatchedCount] = useState<number>(0);
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
      setGroups(((r as { groups?: ScannerGroup[] }).groups ?? []) as ScannerGroup[]);
      setView(((r as { view?: 'category_grouped' | 'search' }).view ?? 'search'));
      setWatchedCount(Number((r as { watched_count?: number }).watched_count ?? r.count ?? 0));
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
                  ? `${visible.length} result${visible.length === 1 ? '' : 's'} for "${query.trim()}"${
                      totalAfterFilter > watchedCount ? ' · including tournament context' : ''
                    } · ${watchedCount} total watched`
                  : `Top 5 per category · ${watchedCount} total watched`}
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
                    <Th
                      align="right"
                      sortable
                      active={sortField === 'edge'}
                      onClick={() => setSortField('edge')}
                      tooltip="raw_edge = p_market − p_model. Always shown regardless of time-decay or volume filters. adj_edge (raw_edge × time × volume) is used internally for basket inclusion."
                    >
                      Edge
                    </Th>
                    <Th align="right" sortable active={sortField === 'days'} onClick={() => setSortField('days')}>Days</Th>
                    <Th align="right" sortable active={sortField === 'volume'} onClick={() => setSortField('volume')}>Volume</Th>
                  </tr>
                </thead>
                <tbody>
                  {view === 'category_grouped' && !isSearching ? (
                    groups
                      .filter((g) => g.markets.length > 0)
                      .map((g, gIdx) => (
                        <CategorySection key={g.category} group={g} firstSection={gIdx === 0} />
                      ))
                  ) : (
                    visible.map((r, i) => (
                      <ScannerRow key={`${r.source}-${r.marketId}-${i}`} row={r} />
                    ))
                  )}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ====== category section =========================================

function CategorySection({ group, firstSection }: { group: ScannerGroup; firstSection: boolean }) {
  const colSpan = 7;
  const sportsSplit = group.category === 'sports' && group.long_section_start != null && group.long_section_start > 0;
  return (
    <>
      <tr>
        <td colSpan={colSpan} style={{
          background: '#FAFAFA',
          padding: firstSection ? '8px 18px' : '24px 18px 8px',
          borderBottom: '1px solid #F0F0EE',
          fontSize: 11,
          color: '#9B9B9B',
          textTransform: 'uppercase',
          letterSpacing: '0.1em',
          fontFamily: '"DM Sans", sans-serif',
          fontWeight: 500,
        }}>
          {group.category}
        </td>
      </tr>
      {group.markets.map((r, i) => (
        <React.Fragment key={`${r.source}-${r.marketId}`}>
          {sportsSplit && i === group.long_section_start && (
            <tr>
              <td colSpan={colSpan} style={{
                padding: '10px 18px',
                borderBottom: '1px solid #E5E5E3',
                borderTop: '1px solid #E5E5E3',
                fontSize: 9,
                color: '#9B9B9B',
                textAlign: 'center',
                textTransform: 'uppercase',
                letterSpacing: '0.16em',
                fontFamily: '"DM Sans", sans-serif',
                background: '#FCFFFC',
              }}>
                Long Opportunities ↓
              </td>
            </tr>
          )}
          <ScannerRow row={r} />
        </React.Fragment>
      ))}
    </>
  );
}

// ====== row =========================================================

function ScannerRow({ row }: { row: Row }) {
  const truncated = row.question.length > 64 ? row.question.slice(0, 63).trimEnd() + '…' : row.question;
  // Tournament markets display the vig-removed normalized probability;
  // everything else displays the raw market mid.
  const displayPMarket = row.is_tournament_market && row.normalized_p_market != null
    ? row.normalized_p_market
    : row.p_market;
  const targetW = Math.max(8, Math.min(600, displayPMarket * 600));
  const days = row.daysToClose != null ? Math.round(row.daysToClose) : null;
  const [ref, inView] = useInView<HTMLTableRowElement>(0.1);
  const [hover, setHover] = useState(false);

  // Display logic:
  //   impossible    → p_model green "0.0%", edge green = p_market %
  //   excluded      → both "—"
  //   has model data (p_model or signal computed) → real values
  //   missing model → "—" / fallback hint
  //
  // Ephemeral tournament favorites have `screened: false` but DO have a
  // p_model computed during the group renormalization, so they render
  // real numbers even though they never went through the Anthropic
  // screener pipeline.
  const isImpossible = Boolean(row.impossible);
  const isExcluded = Boolean(row.excluded) && !isImpossible;
  const isTournament = Boolean(row.is_tournament_market);
  const isFavorite = isTournament && Boolean(row.is_favorite);
  const hasModelData =
    !isExcluded && !isImpossible && (row.p_model != null || row.signal != null);

  const pModelDisplay = isImpossible
    ? '0.0%'
    : isExcluded
    ? '—'
    : row.p_model != null
    ? formatPct(row.p_model)
    : isFavorite
    ? 'model: ↑ underpriced'
    : '—';

  // raw_edge = p_market − p_model. The honest model mispricing, never
  // zeroed by time-decay filters — what we want to surface to users.
  // adj_edge is preserved server-side for basket-inclusion checks but
  // intentionally not shown in this column.
  const rawEdge = row.raw_edge ?? row.edge ?? null;
  const edgeDisplay = isImpossible
    ? formatPct(row.p_market)
    : isExcluded
    ? '—'
    : rawEdge != null && hasModelData
    ? formatPct(rawEdge)
    : '—';

  const isLong = row.signal === 'long' || row.signal === 'strong_long';
  const isIneligible = days != null && days > 365;

  // Color story:
  //   shorts        → p_market red, p_model black, edge blue (positive)
  //   longs         → p_market black, p_model green (model > market),
  //                   edge green negative
  //   excluded/etc  → muted greys
  const pMarketColor = isLong
    ? '#0A0A0A'
    : '#CC2936';
  const pModelColor = isImpossible
    ? '#00875A'
    : !hasModelData
    ? '#9B9B9B'
    : isLong
    ? '#00875A'
    : '#0A0A0A';
  const edgeColor = isImpossible
    ? '#00875A'
    : !hasModelData
    ? '#9B9B9B'
    : isLong
    ? '#00875A'
    : '#1A56DB';

  // Ineligible markets keep the value but render days in pale grey so the
  // user can see "edge exists but too far out of basket window".
  const daysColor = isIneligible
    ? '#C0C0C0'
    : days == null ? '#9B9B9B'
    : days < 30 ? '#00875A'
    : days <= 90 ? '#0A0A0A'
    : days <= 180 ? '#6B6B6B'
    : '#9B9B9B';

  // Hover tint: green for longs, light blue/grey for everything else.
  const hoverBg = isLong ? '#F0FDF4' : '#F7F8FF';
  const barColor = isLong ? '#00875A' : '#1A56DB';

  return (
    <tr
      ref={ref}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{ borderBottom: '1px solid #E5E5E3', background: hover ? hoverBg : '#FFFFFF', transition: 'background 150ms ease-out' }}
    >
      <td style={{ padding: '16px 18px', verticalAlign: 'top' }}>
        <div style={{ fontSize: 15, color: '#0A0A0A', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }} title={row.question}>
          <span>{truncated}</span>
          {row.signal && <SignalBadge signal={row.signal} />}
          {isFavorite && <TournamentBadge tone="favorite" />}
          {isTournament && !isFavorite && <TournamentBadge tone="longshot" />}
        </div>
        <div style={{ marginTop: 8, height: 4, width: 600, maxWidth: '100%', background: '#F0F0EE', borderRadius: 2 }}>
          <div
            style={{
              height: '100%',
              width: inView ? targetW : 0,
              background: barColor,
              borderRadius: 2,
              transition: 'width 700ms cubic-bezier(0.2, 0.8, 0.2, 1)',
            }}
          />
        </div>
        <div className="font-num" style={{ fontSize: 11, color: '#9B9B9B', marginTop: 6 }}>
          {isTournament ? 'normalized: ' : 'market: '}{formatPct(displayPMarket)}
        </div>
      </td>
      <td style={{ padding: '16px 18px', verticalAlign: 'top' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'flex-start' }}>
          <SourcePill source={row.source} />
          <CategoryPill category={row.category} />
        </div>
      </td>
      <td className="font-num" style={{ padding: '16px 18px', textAlign: 'right', fontSize: 15, color: pMarketColor, verticalAlign: 'top' }}>
        {formatPct(displayPMarket)}
      </td>
      <td className="font-num" style={{ padding: '16px 18px', textAlign: 'right', fontSize: 15, color: pModelColor, verticalAlign: 'top' }}>
        {pModelDisplay}
      </td>
      <td className="font-num" style={{ padding: '16px 18px', textAlign: 'right', fontSize: 15, color: edgeColor, verticalAlign: 'top' }}>
        {/* Negative sign for longs (edge displayed positive in formatPct
            because rawEdge is signed — we just prepend a minus if it's
            actually negative). */}
        {edgeDisplay}
      </td>
      <td
        className="font-num"
        style={{ padding: '16px 18px', textAlign: 'right', fontSize: 13, color: daysColor, verticalAlign: 'top' }}
        title={isIneligible ? 'Outside basket window · edge exists but too far out' : undefined}
      >
        {days != null ? `${days}d${isIneligible ? ' ⚠' : ''}` : '—'}
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
  children, align = 'left', sortable, active, onClick, tooltip,
}: {
  children: React.ReactNode;
  align?: 'left' | 'right';
  sortable?: boolean;
  active?: boolean;
  onClick?: () => void;
  tooltip?: string;
}) {
  const [hover, setHover] = useState(false);
  return (
    <th
      onClick={sortable ? onClick : undefined}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title={tooltip}
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

function SignalBadge({ signal }: { signal: NonNullable<Row['signal']> }) {
  // strong_short / short / weak_short are red shades.
  // long / strong_long are green shades.
  // fair_value is grey.
  const palette: Record<string, { fg: string; bg: string; label: string }> = {
    strong_short: { fg: '#9F1239', bg: '#FECDD3', label: 'SHORT ↑↑' },
    short:        { fg: '#CC2936', bg: '#FCE9EC', label: 'SHORT ↑' },
    weak_short:   { fg: '#CC2936', bg: '#FEF2F2', label: 'SHORT' },
    fair_value:   { fg: '#6B6B6B', bg: '#F0F0EE', label: 'FAIR' },
    long:         { fg: '#00875A', bg: '#F0FDF4', label: 'LONG ↓' },
    strong_long:  { fg: '#005C3D', bg: '#D1FAE5', label: 'LONG ↓↓' },
  };
  const p = palette[signal] ?? palette.fair_value;
  return (
    <span
      style={{
        fontSize: 9,
        fontWeight: 600,
        color: p.fg,
        background: p.bg,
        padding: '2px 6px',
        borderRadius: 3,
        textTransform: 'uppercase',
        letterSpacing: '0.06em',
        fontFamily: '"DM Sans", sans-serif',
        whiteSpace: 'nowrap',
      }}
    >
      {p.label}
    </span>
  );
}

function TournamentBadge({ tone }: { tone: 'favorite' | 'longshot' }) {
  // Favorite: the market UNDERPRICES this team (edge ≤ 0 after group
  // renorm) — interesting for the long basket product. Gold/amber.
  // Longshot: market OVERPRICES this team — short candidate. Red.
  const isFav = tone === 'favorite';
  return (
    <span
      style={{
        fontSize: 9,
        fontWeight: 600,
        letterSpacing: '0.08em',
        textTransform: 'uppercase',
        padding: '2px 6px',
        borderRadius: 3,
        background: isFav ? '#FEF3C7' : '#FCE9EC',
        color: isFav ? '#D97706' : '#CC2936',
        fontFamily: '"DM Sans", sans-serif',
      }}
      title={isFav
        ? 'Underpriced — tournament normalization marks this side as a favorite (potential long candidate).'
        : 'Overpriced — tournament normalization marks this side as a longshot (short candidate).'}
    >
      {isFav ? 'FAVORITE' : 'LONGSHOT'}
    </span>
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

