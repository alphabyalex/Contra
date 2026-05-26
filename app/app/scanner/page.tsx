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
import { createPortal } from 'react-dom';
import { api } from '../_lib/api';
import { useInView } from '../_lib/useInView';
import { GridBackground } from '../_components/GridBackground';

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
  p_market_screened?: number;
  zone?: 0 | 1 | 2 | 3 | 4;
  badge?: 'overpriced' | 'underpriced' | 'fair value';
  residual?: number | null;
  model_stale?: boolean;
  resolved_likely?: boolean;
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

  // Near-certain markets (p_market ≥ 0.85) are hidden from the default
  // scanner view because the model has no actionable opinion on them —
  // they read as misleading "overpriced" signals. They remain visible
  // when the user searches (explicit intent), and the per-row badge /
  // p_model / edge displays already collapse to '—' for these via the
  // isOutsideRange gate inside ScannerRow.
  const isNearCertain = (r: Row): boolean =>
    typeof r.p_market === 'number' && r.p_market >= 0.85;
  const visible = useMemo(
    () => (isSearching ? rows : rows.filter((r) => !isNearCertain(r))),
    [rows, isSearching],
  );
  const filteredGroups = useMemo<ScannerGroup[]>(
    () =>
      isSearching
        ? groups
        : groups.map((g) => ({
            ...g,
            markets: g.markets.filter((r) => !isNearCertain(r)),
          })),
    [groups, isSearching],
  );
  const hasZone3 = useMemo(() => visible.some((r: Row) => r.zone === 3), [visible]);
  const secondsAgo = updatedAt ? Math.max(0, Math.floor((Date.now() - updatedAt) / 1000)) : null;
  void tick;

  return (
    <div style={{ background: '#F7F7F5', minHeight: 'calc(100vh - 56px)' }}>
      <div className="max-w-[1400px] mx-auto px-6 py-10">
        <div className="bg-white" style={{ position: 'relative', border: '1px solid #E5E5E3', overflow: 'hidden' }}>
          {/* Decorative corner mark. Pinned to the top-right of the scanner
              container, fades in on mount, never interacts with input. */}
          <GridBackground
            opacity={0.07}
            variant="corner"
            corner="top-right"
            markSize={88}
            fadeIn
            duration={1100}
            style={{ margin: 20 }}
          />
          {/* Header */}
          <div className="flex items-end justify-between" style={{ position: 'relative', zIndex: 2, padding: '32px 36px', borderBottom: '1px solid #E5E5E3' }}>
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

          {/* Search bar + sort tabs */}
          <div style={{ padding: '20px 36px', borderBottom: '1px solid #E5E5E3', display: 'flex', alignItems: 'center', gap: 20 }}>
            <div style={{ position: 'relative', flex: 1 }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#9B9B9B" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                style={{ position: 'absolute', left: 14, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none' }}>
                <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
              </svg>
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search markets..."
                style={{
                  width: '100%', height: 44, background: '#FFFFFF', border: '1px solid #E5E5E3', borderRadius: 8,
                  padding: '0 40px', fontSize: 14, color: '#0A0A0A', fontFamily: '"DM Sans", sans-serif', outline: 'none',
                  transition: 'border-color 120ms, box-shadow 120ms', boxSizing: 'border-box',
                }}
                onFocus={(e) => { e.currentTarget.style.borderColor = '#1A56DB'; e.currentTarget.style.boxShadow = '0 0 0 3px rgba(26,86,219,0.1)'; }}
                onBlur={(e) => { e.currentTarget.style.borderColor = '#E5E5E3'; e.currentTarget.style.boxShadow = 'none'; }}
              />
              {query && (
                <button type="button" onClick={() => setQuery('')}
                  style={{ position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', color: '#9B9B9B', fontSize: 18, lineHeight: 1, padding: 4 }}>×</button>
              )}
            </div>
            <div style={{ display: 'flex', gap: 20 }}>
              {([['edge', 'Edge'], ['volume', 'Volume'], ['days', 'Days']] as const).map(([f, label]) => {
                const active = sortField === f;
                return (
                  <button key={f} type="button" onClick={() => setSortField(f as SortField)}
                    style={{ background: 'none', border: 'none', cursor: 'pointer', fontFamily: '"DM Sans", sans-serif', fontSize: 13,
                      fontWeight: active ? 500 : 400, color: active ? '#0A0A0A' : '#9B9B9B',
                      borderBottom: `2px solid ${active ? '#1A56DB' : 'transparent'}`, padding: '4px 0' }}>
                    {label}
                  </button>
                );
              })}
            </div>
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
            <div style={{ padding: 56, textAlign: 'center' }}>
              {isSearching ? (
                <>
                  <div style={{ fontSize: 16, color: '#6B6B6B' }}>No markets found for &ldquo;{query.trim()}&rdquo;</div>
                  <div style={{ fontSize: 13, color: '#9B9B9B', marginTop: 8 }}>Try a broader term, like a country, team, or topic.</div>
                </>
              ) : (
                <div style={{ fontSize: 15, color: '#9B9B9B' }}>No markets in the longshot range right now.</div>
              )}
            </div>
          )}

          {/* Table */}
          {!loading && !error && visible.length > 0 && (
            <div className="contra-table-scroll" style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: '"DM Sans", sans-serif' }}>
                <thead>
                  <tr>
                    <Th>Market</Th>
                    <Th></Th>
                    <Th align="right" sortable active={sortField === 'p_market'} onClick={() => setSortField('p_market')}>P_market</Th>
                    <Th align="right">{hasZone3 ? 'P_model / Residual' : 'P_model'}</Th>
                    <Th
                      align="right"
                      sortable
                      active={sortField === 'edge'}
                      onClick={() => setSortField('edge')}
                      tooltip="Model's estimated probability vs market implied probability. Positive: model sees overpricing. Negative: model sees underpricing. Not financial advice."
                    >
                      Edge
                    </Th>
                    <Th align="right" sortable active={sortField === 'days'} onClick={() => setSortField('days')}>Days</Th>
                    <Th align="right" sortable active={sortField === 'volume'} onClick={() => setSortField('volume')}>Volume</Th>
                  </tr>
                </thead>
                <tbody>
                  {view === 'category_grouped' && !isSearching ? (
                    filteredGroups
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
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            {group.category}
            <span style={{ fontSize: 10, color: '#6B6B6B', background: '#F3F4F6', borderRadius: 8, padding: '1px 7px', letterSpacing: 0, fontWeight: 500 }}>
              {group.markets.length}
            </span>
          </span>
        </td>
      </tr>
      {group.markets.map((r) => (
        <ScannerRow key={`${r.source}-${r.marketId}`} row={r} />
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
  // Only badge real favorites (France/Spain/England level). Teams sitting
  // at 0.1–0.3% normalized are not meaningful favorites — hide the badge
  // below an 8% normalized-probability floor.
  const isFavorite =
    isTournament &&
    Boolean(row.is_favorite) &&
    (row.normalized_p_market ?? 0) > 0.08;
  const hasModelData =
    !isExcluded && !isImpossible && (row.p_model != null || row.signal != null);

  const zone = row.zone ?? 0;
  const modelStale = Boolean(row.model_stale);
  const residual = row.residual ?? (zone === 3 ? 1 - row.p_market : null);

  // Markets where the model has no useful view: zone 4 (fair-value band),
  // near-certain (p_market ≥ 0.85), or backend says signal is missing /
  // outside model range. We collapse both the p_model column and the
  // edge column to '—' for these so the row reads as "no model opinion"
  // rather than offering a misleading numeric estimate.
  const isOutsideRange =
    zone === 4 ||
    (typeof row.p_market === 'number' && row.p_market >= 0.85) ||
    row.signal == null ||
    (row.signal as string) === 'outside_range';

  // p_model display rules:
  //   excluded / outside range → '—'
  //   zone 3 (90%+)  → would show RESIDUAL but isOutsideRange already
  //                    catches this (p ≥ 0.85 → '—').
  //   model stale    → '—' (live price diverged >20pts from screened)
  //   zone 1/2       → p_model (calibration / tournament normalization valid)
  const pModelDisplay = isExcluded
    ? '—'
    : isOutsideRange
    ? '—'
    : modelStale
    ? '—'
    : isImpossible
    ? '0.0%'
    : row.p_model != null
    ? formatPct(row.p_model)
    : isFavorite
    ? 'model: ↑ underpriced'
    : '—';

  // raw_edge = p_market − p_model. The honest model mispricing, never
  // zeroed by time-decay filters — what we want to surface to users.
  // adj_edge is preserved server-side for basket-inclusion checks but
  // intentionally not shown in this column.
  // Near-certain markets (p_market ≥ 0.85, zone 3 and the loose band
  // around it) show '—' here — the residual lives in the p_model column
  // for these rows and the literal raw_edge (often a large negative) is
  // misleading next to the "near-certain" badge.
  const isNearCertain = typeof row.p_market === 'number' && row.p_market >= 0.85;
  const rawEdge = row.raw_edge ?? row.edge ?? null;
  const edgeDisplay = isImpossible
    ? signedPct(row.p_market)
    : isExcluded
    ? '—'
    : isNearCertain
    ? '—'
    : rawEdge != null && hasModelData
    ? signedPct(rawEdge)
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
  const pModelColor = zone === 3
    ? '#D97706' // amber — residual (NO side overpriced)
    : isImpossible
    ? '#00875A'
    : !hasModelData
    ? '#9B9B9B'
    : isLong
    ? '#00875A'
    : '#0A0A0A';
  // Directional context without badges: negative edge (model thinks the
  // market is underpriced) shows green; positive edge (overpriced) blue.
  const rawEdgeVal = Number(row.raw_edge ?? row.edge ?? 0);
  const edgeColor = isImpossible
    ? '#1A56DB'
    : !hasModelData
    ? '#9B9B9B'
    : rawEdgeVal < 0
    ? '#00875A'
    : '#1A56DB';

  // Ineligible markets keep the value but render days in pale grey so the
  // user can see "edge exists but too far out of basket window".
  const daysColor = isIneligible
    ? '#C0C0C0'
    : days == null ? '#9B9B9B'
    : days < 14 ? '#CC2936'
    : '#6B6B6B';

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
      <td style={{ padding: '16px 18px', verticalAlign: 'top' }} colSpan={2}>
        <div style={{ fontSize: 14, fontWeight: 400, color: '#0A0A0A', fontFamily: '"DM Sans", sans-serif', lineHeight: 1.4 }} title={row.question}>
          {truncated}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
          <EdgeBadge
            rawEdge={row.raw_edge ?? row.edge}
            badge={row.badge}
            zone={row.zone}
            pMarket={row.p_market}
            pModel={row.p_model}
            signal={row.signal}
          />
          <SourcePill source={row.source} />
          <CategoryPill category={row.category} />
          {isOutsideRange && <OutsideRangePill />}
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

/** Always-signed percentage: "+6.2%" / "-7.5%". */
function signedPct(v: number): string {
  return `${v >= 0 ? '+' : '−'}${Math.abs(v * 100).toFixed(1)}%`;
}

function formatVolume(v: number): string {
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `$${(v / 1_000).toFixed(0)}K`;
  return `$${v.toFixed(0)}`;
}

function Th({
  children, align = 'left', sortable, active, onClick, tooltip,
}: {
  children?: React.ReactNode;
  align?: 'left' | 'right';
  sortable?: boolean;
  active?: boolean;
  onClick?: () => void;
  tooltip?: string;
}) {
  const [hover, setHover] = useState(false);
  // Fixed-position tooltip coords computed from the ⓘ's bounding rect, so the
  // tooltip escapes the table's overflow:hidden / overflow-x:auto containers.
  const [tipPos, setTipPos] = useState<{ top: number; left: number } | null>(null);
  const iconRef = useRef<HTMLSpanElement>(null);

  const showTip = () => {
    const r = iconRef.current?.getBoundingClientRect();
    if (r) setTipPos({ top: r.bottom + 8, left: r.left - 100 });
  };
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
      {tooltip && (
        <span
          ref={iconRef}
          onMouseEnter={(e) => { e.stopPropagation(); showTip(); }}
          onMouseLeave={() => setTipPos(null)}
          style={{ marginLeft: 5, color: '#9B9B9B', cursor: 'help', fontSize: 11 }}
        >
          ⓘ
        </span>
      )}
      {tooltip && tipPos && typeof document !== 'undefined' && createPortal(
        <div
          style={{
            position: 'fixed', top: tipPos.top, left: tipPos.left,
            background: '#FFFFFF', border: '1px solid #E5E5E3', borderRadius: 8, padding: 12,
            fontSize: 12, fontFamily: '"DM Sans", sans-serif', color: '#0A0A0A', maxWidth: 240,
            whiteSpace: 'normal', textTransform: 'none', letterSpacing: 0, lineHeight: 1.5, fontWeight: 400,
            boxShadow: '0 4px 12px rgba(0,0,0,0.08)', zIndex: 9999, pointerEvents: 'none', textAlign: 'left',
          }}
        >
          {tooltip}
        </div>,
        document.body,
      )}
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

const PILL_BASE: React.CSSProperties = {
  fontFamily: '"IBM Plex Mono", monospace',
  fontSize: 10,
  letterSpacing: '0.06em',
  fontWeight: 500,
  height: 20,
  lineHeight: '18px',
  padding: '0 8px',
  borderRadius: 10,
  display: 'inline-flex',
  alignItems: 'center',
  whiteSpace: 'nowrap',
  boxSizing: 'border-box',
};

// Badge label is purely the SIGN of raw_edge (not the zone):
//   raw_edge > 0  → "overpriced"  (blue)
//   raw_edge < 0  → "underpriced" (green)
//   |raw_edge|<1% → "fair value"  (grey)
// Special cases that override the sign-based label:
//   p_market ≥ 0.85 → "near-certain" (amber). These are zone-3 markets
//                     where calling the YES side "overpriced" is misleading
//                     (the YES is what the model also assigns high prob to).
//   zone 4, no model data, or signal=outside_range → render nothing. The
//                     model intentionally has no view here and showing
//                     "overpriced"/"underpriced" would be a false signal.
function EdgeBadge({
  rawEdge,
  badge,
  zone,
  pMarket,
  pModel,
  signal,
}: {
  rawEdge?: number | null;
  badge?: string;
  zone?: number;
  pMarket?: number;
  pModel?: number | null;
  signal?: string | null;
}) {
  // Hide entirely when the model has no opinion on this market.
  const hasNoModel = pModel == null || pModel === 0;
  const outsideRange = zone === 4 || signal === 'outside_range' || signal == null;
  if (outsideRange || hasNoModel) return null;

  // Near-certain override — applied BEFORE the sign-based label so zone-3
  // (and the looser 0.85 ceiling around it) gets the amber "near-certain"
  // chip regardless of which side of fair the raw edge lands on.
  if (typeof pMarket === 'number' && pMarket >= 0.85) {
    const amber = { bg: '#FFFBEB', fg: '#B45309', bd: '#FDE68A' };
    return (
      <span style={{ ...PILL_BASE, background: amber.bg, color: amber.fg, border: `1px solid ${amber.bd}` }}>
        near-certain
      </span>
    );
  }

  const label = badge ?? (() => {
    const e = Number(rawEdge ?? 0);
    return Math.abs(e) < 0.01 ? 'fair value' : e > 0 ? 'overpriced' : 'underpriced';
  })();
  const map: Record<string, { bg: string; fg: string; bd: string }> = {
    overpriced: { bg: '#EFF6FF', fg: '#1D4ED8', bd: '#BFDBFE' },
    underpriced: { bg: '#F0FDF4', fg: '#15803D', bd: '#BBF7D0' },
    'fair value': { bg: '#F3F4F6', fg: '#6B6B6B', bd: '#E5E7EB' },
  };
  const c = map[label] ?? map['fair value'];
  return <span style={{ ...PILL_BASE, background: c.bg, color: c.fg, border: `1px solid ${c.bd}` }}>{label}</span>;
}

function SourcePill({ source }: { source: 'kalshi' | 'polymarket' }) {
  const isKalshi = source === 'kalshi';
  const style = isKalshi
    ? { background: '#F0FDF4', color: '#15803D', border: '1px solid #BBF7D0' }
    : { background: '#EFF6FF', color: '#1D4ED8', border: '1px solid #BFDBFE' };
  return <span style={{ ...PILL_BASE, ...style }}>{isKalshi ? 'Kalshi' : 'Polymarket'}</span>;
}

// Small grey pill used to mark rows where the model has no actionable
// opinion (zone-4 fair-value band, near-certain p ≥ 0.85, or missing
// signal). Matches the SourcePill / CategoryPill visual so it slots
// cleanly into the same pills row under the market title.
function OutsideRangePill() {
  return (
    <span
      style={{
        ...PILL_BASE,
        background: '#F3F4F6',
        color: '#6B6B6B',
        border: '1px solid #E5E7EB',
      }}
    >
      Outside model range
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

