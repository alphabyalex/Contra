'use client';

import Link from 'next/link';

interface Props {
  id: string;
  name: string;
  nav: number;
  avgEdge: number;
  legs: number;
  leverage: string;
  source: string;
  category?: string;
}

/**
 * CTRA-NN — odd = short term (0-90d), even = mid term (90-180d).
 * Falls back to the basket category if the name doesn't match the
 * CTRA-NN convention (mock/legacy data).
 */
function basketSubtitle(name: string, fallback?: string): string {
  const m = name.match(/^CTRA-(\d+)/i);
  if (m) {
    const n = parseInt(m[1], 10);
    if (!Number.isNaN(n)) {
      return n % 2 === 1 ? 'SHORT TERM · 0–90 DAYS' : 'MID TERM · 90–180 DAYS';
    }
  }
  return (fallback ?? '').toUpperCase();
}

/** Returns numeric leverage. "2x" → 2, "1x"/missing → 1. */
function leverageNum(s: string | undefined): number {
  if (!s) return 1;
  const m = s.match(/(\d+)/);
  return m ? parseInt(m[1], 10) : 1;
}

export function BasketCard({ id, name, nav, avgEdge, legs, leverage, source, category }: Props) {
  const isUp = nav >= 1;
  const subtitle = basketSubtitle(name, category);
  const lev = leverageNum(leverage);
  return (
    <Link
      href={`/baskets/${id}`}
      className="block bg-white hover:shadow-sm transition-all"
      style={{ border: '1px solid #E5E5E3', borderRadius: 4, padding: 20 }}
    >
      <div className="flex justify-between items-start mb-4">
        <div>
          <div style={{ color: '#0A0A0A', fontSize: 14, fontWeight: 500, lineHeight: 1.3 }}>{name}</div>
          {subtitle && (
            <div
              style={{
                color: '#9B9B9B',
                fontSize: 10,
                textTransform: 'uppercase',
                letterSpacing: '0.08em',
                marginTop: 6,
              }}
            >
              {subtitle}
            </div>
          )}
        </div>
        {lev > 1 && (
          <span
            className="font-num"
            style={{
              fontSize: 10,
              color: '#1A56DB',
              background: '#EBF0FF',
              padding: '2px 8px',
              borderRadius: 10,
              textTransform: 'uppercase',
            }}
          >
            {lev}x
          </span>
        )}
      </div>

      <div className="grid grid-cols-2 gap-y-2" style={{ fontSize: 12 }}>
        <Label>NAV</Label>
        <Value color={isUp ? '#00875A' : '#CC2936'}>${nav.toFixed(3)}</Value>
        <Label>Est. Edge</Label>
        <Value color="#0A0A0A">+{(avgEdge * 100).toFixed(1)}%</Value>
        <Label>Legs</Label>
        <Value color="#0A0A0A">{legs}</Value>
        <Label>Source</Label>
        <Value color="#0A0A0A">{source}</Value>
      </div>
    </Link>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <span style={{ color: '#9B9B9B', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.08em' }}>
      {children}
    </span>
  );
}

function Value({ children, color }: { children: React.ReactNode; color: string }) {
  return (
    <span className="font-num" style={{ textAlign: 'right', color, fontSize: 13 }}>
      {children}
    </span>
  );
}
