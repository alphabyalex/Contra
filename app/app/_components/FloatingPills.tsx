'use client';

/**
 * Hero ambient layer — pills drift left across the hero, never overlap.
 *
 * Lane system: the hero is divided into 5 fixed horizontal lanes. Each
 * lane runs ONE pill at a time on a recursive setTimeout schedule that
 * adds a 2–4 second random gap between cycles. The animation cycles
 * forever — when a pill finishes its drift, a new one spawns into the
 * same lane after the gap.
 *
 * Because every lane only ever has one pill alive, overlap is
 * structurally impossible. The hero is masked on its left side by a
 * gradient overlay drawn above this layer (in page.tsx), so pills can
 * span the full hero width and still appear to "emerge from behind"
 * the headline.
 */

import { useEffect, useState } from 'react';
import { api } from '../_lib/api';

const FALLBACK = [
  { question: 'Will Trump be impeached by June?', price: 0.08 },
  { question: 'BTC hits $250k before July?', price: 0.12 },
  { question: 'Apple acquires Netflix in 2026?', price: 0.06 },
  { question: 'Fed cuts rates 5x this year?', price: 0.09 },
  { question: 'Barron Trump becomes Fed Chair?', price: 0.03 },
  { question: 'S&P drops 40% this year?', price: 0.11 },
  { question: 'Elon buys Twitter again?', price: 0.07 },
];

interface Pill { question: string; price: number }

// 3 lanes only — slower drift (38–42s) so the field reads as ambient
// texture rather than busy chatter.
const LANES = [
  { topPct: 22, durationSec: 40, startDelaySec: 0  },
  { topPct: 50, durationSec: 38, startDelaySec: 13 },
  { topPct: 78, durationSec: 42, startDelaySec: 26 },
];

function truncate(s: string, n = 32): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1).trimEnd() + '…';
}

export function FloatingPills() {
  const [trades, setTrades] = useState<Pill[]>(FALLBACK);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await api.scanner.markets(0.02, 0.15);
        if (cancelled) return;
        const next = (r.rows ?? [])
          .map((m) => ({ question: m.question, price: m.p_market }))
          .filter((p) => p.question && Number.isFinite(p.price));
        if (next.length >= 4) setTrades(next.slice(0, 50));
      } catch {
        /* fallback already in state */
      }
    })();
    return () => { cancelled = true; };
  }, []);

  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-0 overflow-hidden"
      style={{ zIndex: 0 }}
    >
      {LANES.map((lane, i) => (
        <Lane
          key={i}
          laneIndex={i}
          topPct={lane.topPct}
          durationSec={lane.durationSec}
          startDelaySec={lane.startDelaySec}
          trades={trades}
        />
      ))}
    </div>
  );
}

interface LaneProps {
  laneIndex: number;
  topPct: number;
  durationSec: number;
  startDelaySec: number;
  trades: Pill[];
}

function Lane({ laneIndex, topPct, durationSec, startDelaySec, trades }: LaneProps) {
  const [cycle, setCycle] = useState(-1);

  useEffect(() => {
    if (trades.length === 0) return;
    let alive = true;
    let tid: ReturnType<typeof setTimeout> | null = null;

    // Recursive setTimeout — each cycle waits durationSec + a 2..4s gap
    // before triggering the next pill into this lane. This guarantees a
    // visible "breath" between pills without ever leaving the lane
    // permanently silent.
    const scheduleNext = (afterMs: number) => {
      tid = setTimeout(() => {
        if (!alive) return;
        setCycle((c) => c + 1);
        const gap = 2000 + Math.random() * 2000;
        scheduleNext(durationSec * 1000 + gap);
      }, afterMs);
    };
    scheduleNext(startDelaySec * 1000);

    return () => {
      alive = false;
      if (tid) clearTimeout(tid);
    };
  }, [durationSec, startDelaySec, trades.length]);

  if (trades.length === 0 || cycle < 0) return null;
  const trade = trades[(cycle + laneIndex * 3) % trades.length];

  return (
    <div
      key={cycle}
      style={{
        position: 'absolute',
        top: `${topPct}%`,
        right: '-360px',
        animation: `pill-drift ${durationSec}s linear forwards`,
        willChange: 'transform, opacity',
      }}
    >
      <PillEl trade={trade} />
    </div>
  );
}

function PillEl({ trade }: { trade: Pill }) {
  return (
    <div
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 10,
        background: 'rgba(26, 86, 219, 0.06)',
        border: '1px solid rgba(26, 86, 219, 0.14)',
        borderRadius: 999,
        padding: '7px 16px',
        fontFamily: '"IBM Plex Mono", ui-monospace, monospace',
        fontSize: 12,
        color: '#1A2B5C',
        whiteSpace: 'nowrap',
      }}
    >
      <span style={{ color: '#CC2936', fontWeight: 500 }}>NO</span>
      <span style={{ color: 'rgba(10,10,10,0.35)' }}>·</span>
      <span style={{ color: '#1A2B5C' }}>{truncate(trade.question, 32)}</span>
      <span style={{ color: 'rgba(10,10,10,0.35)' }}>·</span>
      <span style={{ color: '#0A0A0A' }}>{trade.price.toFixed(2)}</span>
    </div>
  );
}
