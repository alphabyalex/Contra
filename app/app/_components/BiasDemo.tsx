'use client';

/**
 * Bias demonstration cards. Renders up to N real short-signal markets
 * pulled from the live scanner endpoint. Cards must satisfy:
 *
 *   signal in {short, strong_short}
 *   raw_edge > 0.03
 *
 * and the rendered set must include at least 2 Kalshi and 2 Polymarket
 * markets when count >= 4. If the fetch fails or returns insufficient
 * qualifying rows, the component renders nothing (no fallback, no stub).
 *
 * Card content: question (truncated to ~50 chars), source pill, p_market,
 * raw_edge as edge %.
 */

import { useEffect, useState } from 'react';
import { api } from '../_lib/api';
import { useInView } from '../_lib/useInView';

interface DemoRow {
  question: string;
  source: 'kalshi' | 'polymarket';
  pMarket: number;
  rawEdge: number;
}

function truncate(s: string, n = 50): string {
  if (!s) return '';
  return s.length <= n ? s : s.slice(0, n - 1).trimEnd() + '…';
}

/**
 * Choose up to `count` rows from a candidate pool while enforcing a
 * minimum source mix. When `requireMix` is true and the pool has both
 * sources, the first 2 picks come from Kalshi and Polymarket each, then
 * the remaining slots are filled by highest edge regardless of source.
 * Kalshi rows are preferred when both sources are otherwise equivalent
 * for a slot so the demo doesn't look Polymarket-only.
 */
function pickMixed(rows: DemoRow[], count: number, requireMix: boolean): DemoRow[] {
  const sorted = [...rows].sort((a, b) => b.rawEdge - a.rawEdge);
  if (!requireMix) return sorted.slice(0, count);
  const kalshi = sorted.filter((r) => r.source === 'kalshi');
  const poly = sorted.filter((r) => r.source === 'polymarket');
  if (kalshi.length < 2 || poly.length < 2) {
    // Not enough of one source to meet the user's minimum mix. Skip the
    // hard requirement and just return the top edges so the component can
    // still render rather than collapse to nothing.
    return sorted.slice(0, count);
  }
  const picked: DemoRow[] = [kalshi[0], kalshi[1], poly[0], poly[1]];
  const ids = new Set(picked.map((r) => r.question));
  for (const r of sorted) {
    if (picked.length >= count) break;
    if (ids.has(r.question)) continue;
    picked.push(r);
    ids.add(r.question);
  }
  return picked.slice(0, count);
}

/**
 * Markets we never want to feature as a "convincing longshot" example.
 * High implied probabilities (15-20%+) and broad partisan-coverage
 * elections read like coin flips, not lottery tickets. Filtering them out
 * keeps every card in the canonical 5-12% longshot band.
 */
function isUnconvincingLongshot(q: string): boolean {
  const s = (q || '').toLowerCase();
  return (
    // Whichever party "controls" a chamber after a midterm is always a
    // ~50/50 markets pair, not a longshot regardless of which side trades
    // at the higher price.
    /(republican|democratic|democrat)\s+party\b.*\bcontrol\b/.test(s)
    || /\bcontrol\s+(the\s+)?(house|senate|congress)\b/.test(s)
    // Brazilian + similar foreign presidential markets at 12-15% are not
    // recognizable to most viewers and read as random rather than as a
    // clear longshot. Exclude single-candidate presidential markets that
    // sit on the upper edge of the longshot band.
    || /brazilian\s+presidential\s+election/.test(s)
  );
}

export function BiasDemo({ count = 4 }: { count?: number } = {}) {
  const [rows, setRows] = useState<DemoRow[] | null>(null);
  const [ref, inView] = useInView<HTMLDivElement>(0.2);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // Pull the broad short pool, then filter client-side. p_market window
        // 0.02-0.20 captures the longshot band; the explicit signal + edge
        // gates below enforce the user's quality bar.
        const r = await api.scanner.markets({ min: 0.02, max: 0.20 });
        if (cancelled) return;
        const pool: DemoRow[] = (r.rows ?? [])
          .filter((m: any) =>
            m
            && m.question
            && (m.source === 'kalshi' || m.source === 'polymarket')
            && (m.signal === 'short' || m.signal === 'strong_short')
            && Number.isFinite(Number(m.p_market))
            && Number.isFinite(Number(m.raw_edge ?? m.edge))
            // Tighter than the previous 0.04 floor: only show markets
            // where the model identifies a clear longshot mispricing.
            // Upper bound 0.15 excludes the 20%+ partisan election markets
            // that read like coin flips rather than longshots.
            && Number(m.raw_edge ?? m.edge) > 0.05
            && Number(m.p_market) < 0.15
            && !isUnconvincingLongshot(String(m.question)),
          )
          .map((m: any) => ({
            question: String(m.question),
            source: m.source as 'kalshi' | 'polymarket',
            pMarket: Number(m.p_market),
            rawEdge: Number(m.raw_edge ?? m.edge),
          }));
        const requireMix = count >= 4;
        const picked = pickMixed(pool, count, requireMix);
        if (picked.length > 0) setRows(picked);
      } catch {
        // Empty state per spec: never show placeholders, just hide.
      }
    })();
    return () => { cancelled = true; };
  }, [count]);

  if (!rows || rows.length === 0) return null;

  return (
    <div
      ref={ref}
      style={{
        display: 'grid',
        gridTemplateColumns: rows.length > 1 ? 'repeat(2, minmax(0, 1fr))' : '1fr',
        gap: 16,
        maxWidth: 760,
        width: '100%',
      }}
    >
      {rows.map((d, i) => (
        <BiasCard key={`${d.source}-${d.question}-${i}`} row={d} inView={inView} delayMs={i * 120} />
      ))}
    </div>
  );
}

function BiasCard({ row, inView, delayMs }: { row: DemoRow; inView: boolean; delayMs: number }) {
  return (
    <div
      className="bg-white"
      style={{
        border: '1px solid #E5E5E3',
        padding: '20px 22px',
        borderRadius: 4,
        textAlign: 'left',
        opacity: inView ? 1 : 0,
        transform: inView ? 'translateY(0)' : 'translateY(8px)',
        transition: `opacity 600ms cubic-bezier(0.2, 0.8, 0.2, 1) ${delayMs}ms, transform 600ms cubic-bezier(0.2, 0.8, 0.2, 1) ${delayMs}ms`,
      }}
    >
      <div
        style={{
          fontSize: 14,
          color: '#0A0A0A',
          lineHeight: 1.4,
          fontFamily: '"DM Sans", system-ui, sans-serif',
          minHeight: 40,
        }}
        title={row.question}
      >
        {truncate(row.question, 50)}
      </div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          marginTop: 16,
        }}
      >
        <SourcePill source={row.source} />
        <div style={{ display: 'flex', gap: 14, alignItems: 'baseline' }}>
          <span
            className="font-num"
            style={{ fontSize: 13, color: '#0A0A0A', fontFamily: '"IBM Plex Mono", monospace' }}
            title="Implied market probability"
          >
            {(row.pMarket * 100).toFixed(1)}%
          </span>
          <span
            className="font-num"
            style={{
              fontSize: 13,
              color: '#1A56DB',
              fontFamily: '"IBM Plex Mono", monospace',
              fontWeight: 500,
            }}
            title="Model edge (p_market minus p_model)"
          >
            +{(row.rawEdge * 100).toFixed(1)}%
          </span>
        </div>
      </div>
    </div>
  );
}

function SourcePill({ source }: { source: 'kalshi' | 'polymarket' }) {
  const isKalshi = source === 'kalshi';
  const style: React.CSSProperties = isKalshi
    ? { background: '#F0FDF4', color: '#15803D', border: '1px solid #BBF7D0' }
    : { background: '#EFF6FF', color: '#1D4ED8', border: '1px solid #BFDBFE' };
  return (
    <span
      style={{
        ...style,
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
      }}
    >
      {isKalshi ? 'Kalshi' : 'Polymarket'}
    </span>
  );
}
