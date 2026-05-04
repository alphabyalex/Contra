'use client';

/**
 * Auto-scrolling translucent feed of longshot prediction-market rows.
 * Fetches Polymarket Gamma directly (public, no auth) and falls back to
 * a static set on any error. The list is duplicated so the CSS marquee
 * loops seamlessly.
 */

import { useEffect, useState } from 'react';

const FALLBACK = [
  { question: 'Will Trump be impeached by June?', price: 0.08 },
  { question: 'BTC hits $250k before July?', price: 0.12 },
  { question: 'Apple acquires Netflix in 2026?', price: 0.06 },
  { question: 'Fed cuts rates 5x this year?', price: 0.09 },
  { question: 'Barron Trump becomes Fed Chair?', price: 0.03 },
  { question: 'S&P drops 40% this year?', price: 0.11 },
  { question: 'Elon buys Twitter again?', price: 0.07 },
];

interface FeedItem { question: string; price: number }

function parsePrices(v: unknown): number[] {
  if (Array.isArray(v)) return v.map(Number).filter(Number.isFinite);
  if (typeof v === 'string') {
    try {
      const parsed = JSON.parse(v);
      return Array.isArray(parsed) ? parsed.map(Number).filter(Number.isFinite) : [];
    } catch { return []; }
  }
  return [];
}

function truncate(s: string, n = 38): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1).trimEnd() + '…';
}

export function LiveTradeFeed() {
  const [items, setItems] = useState<FeedItem[]>(FALLBACK);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(
          'https://gamma-api.polymarket.com/markets?active=true&limit=50&order=volume&ascending=false',
        );
        if (!res.ok) throw new Error(`${res.status}`);
        const data = await res.json();
        if (!Array.isArray(data)) throw new Error('shape');
        const out: FeedItem[] = [];
        for (const m of data) {
          const prices = parsePrices(m.outcomePrices);
          const yesPrice = prices[0];
          if (!Number.isFinite(yesPrice)) continue;
          if (yesPrice < 0.02 || yesPrice > 0.15) continue;
          if (!m.question) continue;
          out.push({ question: m.question, price: yesPrice });
          if (out.length >= 24) break;
        }
        if (!cancelled && out.length >= 5) setItems(out);
      } catch {
        // fallback already in state
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Duplicate so the marquee loops without a visible jump.
  const doubled = [...items, ...items];
  const opacity = 0.13;

  return (
    <div className="relative h-full overflow-hidden">
      <div className="feed-scroll">
        {doubled.map((it, i) => (
          <div
            key={i}
            className="flex items-center gap-3 px-4 py-2"
            style={{
              fontFamily: '"IBM Plex Mono", ui-monospace, monospace',
              fontSize: 10,
              color: `rgba(10, 10, 10, ${opacity})`,
              borderBottom: `1px dashed rgba(10, 10, 10, ${opacity * 0.6})`,
            }}
          >
            <span style={{ color: `rgba(204, 41, 54, ${opacity})`, width: 28 }}>NO</span>
            <span style={{ flex: 1 }}>{truncate(it.question, 38)}</span>
            <span style={{ width: 50, textAlign: 'right' }}>{it.price.toFixed(2)}</span>
            <span style={{ color: `rgba(0, 135, 90, ${opacity})`, width: 16, textAlign: 'right' }}>✓</span>
          </div>
        ))}
      </div>
      {/* Top + bottom fade so the loop edges don't pop */}
      <div
        className="pointer-events-none absolute inset-x-0 top-0 h-16"
        style={{ background: 'linear-gradient(to bottom, #F7F7F5, transparent)' }}
      />
      <div
        className="pointer-events-none absolute inset-x-0 bottom-0 h-16"
        style={{ background: 'linear-gradient(to top, #F7F7F5, transparent)' }}
      />
    </div>
  );
}
