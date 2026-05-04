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

const FALLBACK: Row[] = [
  { question: 'Will Trump be impeached by June?',         source: 'polymarket', p_market: 0.08 },
  { question: 'Will BTC hit $250k before July?',          source: 'polymarket', p_market: 0.12 },
  { question: 'Will Apple acquire Netflix in 2026?',      source: 'polymarket', p_market: 0.06 },
  { question: 'Will Fed cut rates 5x this year?',         source: 'polymarket', p_market: 0.09 },
  { question: 'Will Barron Trump become Fed Chair?',      source: 'polymarket', p_market: 0.03 },
];

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1).trimEnd() + '…';
}

export function LiveScannerMini({ onCount }: { onCount?: (n: number) => void } = {}) {
  const [rows, setRows] = useState<Row[]>(FALLBACK);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await api.scanner.markets(0.02, 0.15);
        if (cancelled) return;
        const real = (r.rows ?? [])
          .slice()
          .sort((a, b) => a.p_market - b.p_market)
          .slice(0, 5)
          .map((m) => ({ question: m.question, source: m.source, p_market: m.p_market }));
        if (real.length > 0) {
          setRows(real);
          if (typeof r.count === 'number') onCount?.(r.count);
        }
      } catch {
        /* fallback already in state */
      }
    })();
    return () => { cancelled = true; };
  }, [onCount]);

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
