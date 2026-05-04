'use client';

/**
 * Horizontal infinite ticker. Items repeat seamlessly via duplication +
 * a 50%-width translate animation. Items are separated by a thin blue dot.
 *
 * Stats source: /api/baskets — TVL approximated as nav × 100 USDC per
 * basket; replace with real on-chain TVL once vault USDC accounts are
 * being polled.
 */

import { useEffect, useState } from 'react';
import { api } from '../_lib/api';

interface Stats {
  marketsScanned: number;
  activeBaskets: number;
  avgEdge: number;
  legsResolvedNo: number;
  tvl: number;
}

const ZERO: Stats = {
  marketsScanned: 0,
  activeBaskets: 0,
  avgEdge: 0,
  legsResolvedNo: 0,
  tvl: 0,
};

export function TickerMarquee() {
  const [s, setS] = useState<Stats>(ZERO);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await api.baskets.list();
        const baskets = r.baskets ?? [];
        let totalLegs = 0;
        let edgeSum = 0;
        let edgeCount = 0;
        let tvl = 0;
        for (const b of baskets) {
          totalLegs += Number(b.num_legs ?? 0);
          if (Number.isFinite(b.avg_edge)) {
            edgeSum += Number(b.avg_edge);
            edgeCount += 1;
          }
          tvl += Number(b.nav ?? 1) * 100;
        }
        if (!cancelled) {
          setS({
            marketsScanned: totalLegs * 4,
            activeBaskets: baskets.filter((b: any) => b.status === 'active' || b.status === 'resolving').length,
            avgEdge: edgeCount > 0 ? edgeSum / edgeCount : 0,
            legsResolvedNo: 0,
            tvl,
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
    ['Legs Resolved NO', String(s.legsResolvedNo)],
    ['Protocol TVL', `$${s.tvl.toLocaleString(undefined, { maximumFractionDigits: 0 })}`],
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
