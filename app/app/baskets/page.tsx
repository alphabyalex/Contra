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

const CATEGORIES = ['All', 'Politics', 'Macro', 'Crypto', 'Sports'] as const;

export default function BasketsPage() {
  const [baskets, setBaskets] = useState<BasketRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [usingMock, setUsingMock] = useState(false);
  const [filter, setFilter] = useState<(typeof CATEGORIES)[number]>('All');

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
        leverage: b.leverage_type === 'degen' ? '3x' : b.leverage_type === 'aggressive' ? '2x' : '1x',
        source: 'Both',
      }));

  const filtered = display.filter(
    (b) => filter === 'All' || (b.category ?? '').toLowerCase() === filter.toLowerCase(),
  );

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

        <div className="flex gap-2">
          {CATEGORIES.map((c) => (
            <button
              key={c}
              onClick={() => setFilter(c)}
              style={{
                fontSize: 10,
                textTransform: 'uppercase',
                letterSpacing: '0.08em',
                padding: '6px 12px',
                borderRadius: 3,
                border: filter === c ? '1px solid #1A56DB' : '1px solid #E5E5E3',
                color: filter === c ? '#1A56DB' : '#6B6B6B',
                background: '#FFFFFF',
                cursor: 'pointer',
              }}
            >
              {c}
            </button>
          ))}
        </div>

        {loading ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {Array.from({ length: 8 }).map((_, i) => (
              <BasketCardSkeleton key={i} />
            ))}
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {filtered.map((b) => (
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
