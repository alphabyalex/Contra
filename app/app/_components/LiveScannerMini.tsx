'use client';

/**
 * Compact scanner table used in the "Live Right Now" section of the
 * landing page. Shows the top 5 most-mispriced markets via the same
 * /api/scanner/markets endpoint the full scanner uses. Falls back to
 * static placeholder rows on any failure so the section never appears
 * broken.
 */

import { useEffect, useState } from 'react';
import { api } from '../_lib/api';

interface Row {
  question: string;
  source: 'kalshi' | 'polymarket';
  p_market: number;
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1).trimEnd() + '…';
}

export function LiveScannerMini({ onCount }: { onCount?: (n: number) => void } = {}) {
  // No hardcoded fallback. Hidden until the scanner endpoint returns real
  // short-signal markets that clear the edge gate.
  const [rows, setRows] = useState<Row[]>([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await api.scanner.markets({ min: 0.02, max: 0.20 });
        if (cancelled) return;
        const real = (r.rows ?? [])
          .filter((m: any) =>
            m
            && m.question
            && (m.signal === 'short' || m.signal === 'strong_short')
            && Number.isFinite(Number(m.p_market))
            && Number.isFinite(Number(m.raw_edge ?? m.edge))
            && Number(m.raw_edge ?? m.edge) > 0.03,
          )
          .slice()
          .sort((a: any, b: any) => Number(a.p_market) - Number(b.p_market))
          .slice(0, 5)
          .map((m: any) => ({
            question: String(m.question),
            source: m.source as 'kalshi' | 'polymarket',
            p_market: Number(m.p_market),
          }));
        if (real.length > 0) {
          setRows(real);
          // Publish the curated tracked-universe count (~1,000), not the
          // filtered r.count (~189). This is the same value the
          // /scanner page header surfaces, and the parent landing page
          // shares this count with StatsStrip via reportCount.
          const watched = Number((r as { watched_count?: number }).watched_count ?? 0);
          onCount?.(watched > 0 ? watched : 1000);
        }
      } catch {
        /* keep empty; component renders nothing */
      }
    })();
    return () => { cancelled = true; };
  }, [onCount]);

  if (rows.length === 0) return null;

  return (
    <div className="bg-white" style={{ border: '1px solid #E5E5E3', overflow: 'hidden' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} style={{ borderBottom: '1px solid #E5E5E3' }}>
              <td style={{ padding: '14px 20px', fontSize: 14, color: '#0A0A0A', fontFamily: '"DM Sans", sans-serif' }}>
                {truncate(r.question, 50)}
              </td>
              <td style={{ padding: '14px 20px', width: 110 }}>
                <SourcePill source={r.source} />
              </td>
              <td
                style={{
                  padding: '14px 20px',
                  textAlign: 'right',
                  fontFamily: '"IBM Plex Mono", monospace',
                  fontSize: 13,
                  color: '#CC2936',
                  width: 90,
                }}
              >
                {r.p_market.toFixed(2)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SourcePill({ source }: { source: 'kalshi' | 'polymarket' }) {
  const isKalshi = source === 'kalshi';
  return (
    <span
      style={{
        fontSize: 10,
        padding: '3px 9px',
        borderRadius: 10,
        background: isKalshi ? '#EBF0FF' : '#F5F5F5',
        color: isKalshi ? '#1A56DB' : '#6B6B6B',
        fontFamily: '"DM Sans", sans-serif',
        fontWeight: 500,
        letterSpacing: '0.02em',
      }}
    >
      {isKalshi ? 'Kalshi' : 'Polymarket'}
    </span>
  );
}
