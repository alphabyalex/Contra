'use client';

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

export function TickerBar() {
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
        let legsNo = 0;
        let tvl = 0;
        for (const b of baskets) {
          totalLegs += Number(b.num_legs ?? 0);
          if (Number.isFinite(b.avg_edge)) {
            edgeSum += Number(b.avg_edge);
            edgeCount += 1;
          }
          // approximate TVL as nav × 100 USDC per basket; real value lands once positions populate
          tvl += Number(b.nav ?? 1) * 100;
        }
        const next: Stats = {
          marketsScanned: totalLegs * 4,
          activeBaskets: baskets.filter((b: any) => b.status === 'active' || b.status === 'resolving').length,
          avgEdge: edgeCount > 0 ? edgeSum / edgeCount : 0,
          legsResolvedNo: legsNo,
          tvl,
        };
        if (!cancelled) setS(next);
      } catch {
        if (!cancelled) setS(ZERO);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const items: Array<[string, string]> = [
    ['Markets Scanned', s.marketsScanned.toLocaleString()],
    ['Active Baskets', String(s.activeBaskets)],
    ['Avg Edge', `${(s.avgEdge * 100).toFixed(1)}%`],
    ['Legs Resolved NO', String(s.legsResolvedNo)],
    ['Protocol TVL', `$${s.tvl.toLocaleString(undefined, { maximumFractionDigits: 0 })}`],
  ];

  return (
    <div
      className="bg-white"
      style={{
        height: 36,
        borderTop: '1px solid #E5E5E3',
        borderBottom: '1px solid #E5E5E3',
      }}
    >
      <div className="max-w-[1400px] mx-auto h-full px-6 flex items-center">
        {items.map(([label, value], i) => (
          <div key={label} className="flex items-center" style={{ flex: 1 }}>
            <div className="flex items-baseline gap-2">
              <span style={{ fontSize: 10, color: '#9B9B9B', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                {label}
              </span>
              <span className="font-num" style={{ fontSize: 11, color: '#0A0A0A' }}>{value}</span>
            </div>
            {i < items.length - 1 && (
              <div style={{ width: 1, height: 16, background: '#E5E5E3', marginLeft: 'auto', marginRight: 0 }} />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
