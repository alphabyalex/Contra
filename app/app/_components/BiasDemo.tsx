'use client';

/**
 * Bias demonstration widget. Fetches up to N real longshots from the
 * backend scanner endpoint and renders one card per market, stacked
 * vertically. Bars animate from 0 → final value when the stack scrolls
 * into view; per-card delay staggers the entrances.
 *
 *   <BiasDemo count={3} />  → up to 3 cards
 */

import { useEffect, useState } from 'react';
import { api } from '../_lib/api';
import { useInView } from '../_lib/useInView';

interface Demo { question: string; pMarket: number }
const FALLBACK: Demo[] = [
  { question: 'Will Barron Trump become Fed Chair?', pMarket: 0.08 },
  { question: 'Will BTC hit $250k before July?',     pMarket: 0.12 },
  { question: 'Will Apple acquire Netflix in 2026?', pMarket: 0.06 },
];

export function BiasDemo({ count = 1 }: { count?: number } = {}) {
  const [demos, setDemos] = useState<Demo[]>(() => FALLBACK.slice(0, Math.max(1, count)));
  const [ref, inView] = useInView<HTMLDivElement>(0.2);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await api.scanner.markets(0.02, 0.15);
        const real = (r.rows ?? [])
          .filter((m) => m.question && Number.isFinite(m.p_market))
          .slice(0, count)
          .map((m) => ({ question: m.question, pMarket: m.p_market }));
        if (!cancelled && real.length > 0) setDemos(real);
      } catch {
        /* keep fallback */
      }
    })();
    return () => { cancelled = true; };
  }, [count]);

  return (
    <div
      ref={ref}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 16,
        maxWidth: 680,
        width: '100%',
      }}
    >
      {demos.map((d, i) => (
        <BiasDemoCard key={`${d.question}-${i}`} demo={d} inView={inView} delayMs={i * 220} />
      ))}
    </div>
  );
}

function BiasDemoCard({ demo, inView, delayMs }: { demo: Demo; inView: boolean; delayMs: number }) {
  // Heuristic stub — same factor used by the backend mispricing service.
  const pModel = demo.pMarket * 0.25;
  const edge = demo.pMarket - pModel;

  return (
    <div
      className="bg-white"
      style={{
        border: '1px solid #E5E5E3',
        padding: '28px 32px',
        borderRadius: 4,
      }}
    >
      <div
        style={{
          fontSize: 16,
          color: '#0A0A0A',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          marginBottom: 20,
        }}
        title={demo.question}
      >
        {demo.question}
      </div>

      <div className="space-y-4">
        <BarRow
          label="Market"
          valueText={demo.pMarket.toFixed(2)}
          targetPct={demo.pMarket * 100}
          color="#1A56DB"
          inView={inView}
          delayMs={delayMs}
        />
        <BarRow
          label="Model"
          valueText={pModel.toFixed(2)}
          suffix="(stub)"
          targetPct={pModel * 100}
          color="#00875A"
          inView={inView}
          delayMs={delayMs + 250}
        />
      </div>

      <div
        style={{
          marginTop: 20,
          color: '#1A56DB',
          fontSize: 15,
          fontFamily: '"IBM Plex Mono", monospace',
          display: 'inline-block',
        }}
      >
        +{(edge * 100).toFixed(1)}% in your favor
      </div>
    </div>
  );
}

function BarRow({
  label, valueText, suffix, targetPct, color, inView, delayMs = 0,
}: {
  label: string; valueText: string; suffix?: string;
  targetPct: number; color: string; inView: boolean; delayMs?: number;
}) {
  return (
    <div>
      <div className="flex items-center justify-between mb-1.5">
        <span style={{ fontSize: 11, color: '#9B9B9B', fontFamily: '"IBM Plex Mono", monospace' }}>{label}</span>
        <span style={{ fontSize: 11, color: '#0A0A0A', fontFamily: '"IBM Plex Mono", monospace' }}>
          {valueText} {suffix && <span style={{ color: '#9B9B9B' }}>{suffix}</span>}
        </span>
      </div>
      <div style={{ height: 8, background: '#F0F0EE', borderRadius: 2, overflow: 'hidden' }}>
        <div
          style={{
            height: '100%',
            width: `${inView ? Math.min(100, Math.max(0, targetPct)) : 0}%`,
            background: color,
            borderRadius: 2,
            transition: `width 800ms cubic-bezier(0.2, 0.8, 0.2, 1) ${delayMs}ms`,
          }}
        />
      </div>
    </div>
  );
}
