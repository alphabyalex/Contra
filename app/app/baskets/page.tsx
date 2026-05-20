'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '../_lib/api';
import { MOCK_BASKETS } from '../_lib/tokens';
import { BasketCard } from '../_components/BasketCard';

function BasketCardSkeleton() {
  return (
    <div className="bg-white" style={{ border: '1px solid #E5E5E3', borderRadius: 4, padding: 20 }}>
      <div className="flex justify-between items-start mb-4">
        <div style={{ flex: 1 }}>
          <div className="skeleton" style={{ height: 14, width: '70%', borderRadius: 2 }} />
          <div className="skeleton" style={{ height: 10, width: '35%', borderRadius: 2, marginTop: 8 }} />
        </div>
        <div className="skeleton" style={{ height: 16, width: 36, borderRadius: 10 }} />
      </div>
      <div className="grid grid-cols-2 gap-y-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="contents">
            <div className="skeleton" style={{ height: 10, width: '40%', borderRadius: 2 }} />
            <div className="skeleton" style={{ height: 12, width: '50%', borderRadius: 2, justifySelf: 'end' }} />
          </div>
        ))}
      </div>
    </div>
  );
}

interface BasketRow {
  id: string;
  name: string;
  category?: string | null;
  leverage_type: string;
  num_legs: number;
  nav?: number;
  avg_edge?: number;
}

/**
 * Leverage variants are emitted from the basket builder with a `-2X` / `-3X`
 * suffix on the base CTRA-NN name. Base baskets are always 1x.
 */
function deriveLeverageFromName(name: string): string {
  const m = name.match(/-([23])X$/i);
  return m ? `${m[1]}x` : '1x';
}

export default function BasketsPage() {
  const [baskets, setBaskets] = useState<BasketRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [usingMock, setUsingMock] = useState(false);

  useEffect(() => {
    api.baskets
      .list()
      .then((r) => {
        if (!r.baskets || r.baskets.length === 0) {
          setUsingMock(true);
          setBaskets([]);
        } else {
          setBaskets(r.baskets);
        }
      })
      .catch(() => setUsingMock(true))
      .finally(() => setLoading(false));
  }, []);

  const display = usingMock || baskets.length === 0
    ? MOCK_BASKETS.map((m) => ({
        id: m.id,
        name: m.name,
        category: m.category,
        leverage_type: m.leverage_type,
        num_legs: m.legs,
        nav: m.nav,
        avg_edge: m.avg_edge,
        leverage: m.leverage,
        source: m.source,
      }))
    : baskets.map((b) => ({
        id: b.id,
        name: b.name,
        category: b.category ?? 'mixed',
        leverage_type: b.leverage_type,
        num_legs: b.num_legs,
        nav: b.nav ?? 1,
        avg_edge: b.avg_edge ?? 0,
        // Leverage variants are derived from the basket name suffix
        // (CTRA-01 = 1x base, CTRA-01-2X = 2x, CTRA-01-3X = 3x). The
        // `leverage_type` column tracks short/mid term, not multiplier.
        leverage: deriveLeverageFromName(b.name),
        source: 'Both',
      }));

  return (
    <div style={{ background: '#F7F7F5', minHeight: 'calc(100vh - 56px)' }}>
      {usingMock && (
        <div
          style={{
            background: '#FEF3C7',
            color: '#92400E',
            borderBottom: '1px solid #FDE68A',
            padding: '8px 32px',
            fontSize: 10,
            textTransform: 'uppercase',
            letterSpacing: '0.08em',
          }}
        >
          No baskets live yet. Showing example data.
        </div>
      )}

      <div className="max-w-[1400px] mx-auto px-6 py-8 space-y-6">
        <div className="flex items-end justify-between">
          <div>
            <h1 style={{ fontSize: 28, fontWeight: 300, color: '#0A0A0A', margin: 0 }}>Baskets</h1>
            <div style={{ fontSize: 11, color: '#9B9B9B', marginTop: 6 }}>
              {display.length} short baskets across Kalshi and Polymarket
            </div>
          </div>
          <Link
            href="/scanner"
            style={{
              border: '1px solid #1A56DB',
              color: '#1A56DB',
              padding: '8px 18px',
              borderRadius: 3,
              fontSize: 11,
              fontWeight: 500,
              textTransform: 'uppercase',
              letterSpacing: '0.04em',
            }}
          >
            View Scanner
          </Link>
        </div>

        {loading ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {Array.from({ length: 8 }).map((_, i) => (
              <BasketCardSkeleton key={i} />
            ))}
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {display.map((b) => (
              <BasketCard
                key={b.id}
                id={b.id}
                name={b.name}
                nav={b.nav}
                avgEdge={b.avg_edge}
                legs={b.num_legs}
                leverage={b.leverage}
                source={b.source}
                category={b.category ?? undefined}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
