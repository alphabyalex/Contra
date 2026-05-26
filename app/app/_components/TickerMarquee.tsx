'use client';

/**
 * Horizontal infinite ticker. Items repeat seamlessly via duplication +
 * a 50%-width translate animation. Items are separated by a thin blue dot.
 *
 * Stats sources:
 *   /api/scanner/markets -> watched_count for "Markets Scanned" (the
 *     curated tracked universe, currently in the thousands).
 *   /api/baskets -> active basket count, average edge across active legs.
 *   Protocol TVL is intentionally hidden on devnet (the figure is
 *     misleadingly small in a demo context).
 */

import { useEffect, useState } from 'react';
import { api } from '../_lib/api';

interface Stats {
  marketsScanned: number;
  activeBaskets: number;
  avgEdge: number;
}

const ZERO: Stats = {
  marketsScanned: 0,
  activeBaskets: 0,
  avgEdge: 0,
};

export function TickerMarquee() {
  const [s, setS] = useState<Stats>(ZERO);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [scan, bk] = await Promise.all([
          // watched_count is the size of the curated tracked universe
          // (scored_markets minus ephemeral favorites). Falls back to
          // `count` if the server hasn't shipped watched_count yet.
          api.scanner.markets({ min: 0.02, max: 0.20 }).catch(() => null),
          api.baskets.list().catch(() => null),
        ]);
        const baskets = (bk?.baskets ?? []).filter(
          (b: any) => b.status === 'active' || b.status === 'resolving',
        );
        let edgeSum = 0;
        let edgeCount = 0;
        for (const b of baskets) {
          if (Number.isFinite(b.avg_edge)) {
            edgeSum += Number(b.avg_edge);
            edgeCount += 1;
          }
        }
        const marketsScanned = Number(
          (scan as any)?.watched_count ?? (scan as any)?.count ?? 0,
        );
        if (!cancelled) {
          setS({
            marketsScanned,
            activeBaskets: baskets.length,
            avgEdge: edgeCount > 0 ? edgeSum / edgeCount : 0,
          });
        }
      } catch {
        if (!cancelled) setS(ZERO);
      }
    })();
  }, []);

  const items: Array<[string, string]> = [
    ['Markets Scanned', s.marketsScanned.toLocaleString()],
    ['Active Baskets', String(s.activeBaskets)],
    ['Avg Edge', `${(s.avgEdge * 100).toFixed(1)}%`],
    // Protocol TVL intentionally removed on devnet: a sub-$1000 figure
    // misrepresents the protocol's scale in a demo context.
  ];
  // Duplicate so the marquee loops without a visible jump.
  const looped = [...items, ...items];

  return (
    <div
      className="bg-white relative overflow-hidden"
      style={{
        height: 36,
        borderTop: '1px solid #E5E5E3',
        borderBottom: '1px solid #E5E5E3',
      }}
    >
      <div className="ticker-scroll absolute top-0 left-0 h-full flex items-center" style={{ minWidth: '200%' }}>
        {looped.map(([label, value], i) => (
          <div key={`${label}-${i}`} className="flex items-center" style={{ paddingInline: 28, whiteSpace: 'nowrap' }}>
            <span
              style={{
                fontSize: 10,
                color: '#9B9B9B',
                textTransform: 'uppercase',
                letterSpacing: '0.08em',
                marginRight: 10,
              }}
            >
              {label}
            </span>
            <span className="font-num" style={{ fontSize: 12, color: '#0A0A0A' }}>{value}</span>
            {i < looped.length - 1 && (
              <span style={{ color: '#1A56DB', marginLeft: 28, fontSize: 14, lineHeight: 1 }}>·</span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
