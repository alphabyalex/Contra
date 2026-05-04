'use client';

/**
 * Manually-drawn SVG donut. Big — viewBox 400×400, radius 150, stroke 32.
 *
 * Animation: each segment animates from full-offset (invisible) to its
 * final dasharray over 600ms ease-out on first mount.
 *
 * Hover behaviour: hovering a legend item highlights the corresponding
 * donut segment by bumping its stroke-width from 32 → 40, while the
 * other segments dim to 0.4 opacity. No pop-out.
 */

import { useEffect, useState } from 'react';

interface Segment { label: string; value: number; color: string }

interface Props {
  segments: Segment[];
  total?: number;
  size?: number;       // px width/height; default 320
  centerLabel?: string;
}

const VB = 400;          // viewBox edge
const CENTER = 200;
const RADIUS = 150;
const STROKE_NORMAL = 32;
const STROKE_HOVER = 40;

export function Donut({ segments, total, size = 320, centerLabel }: Props) {
  const c = 2 * Math.PI * RADIUS;
  const sum = total ?? segments.reduce((s, x) => s + x.value, 0);
  const isEmpty = sum <= 0;

  const [drawn, setDrawn] = useState(false);
  const [hoverLabel, setHoverLabel] = useState<string | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setDrawn(true), 60);
    return () => clearTimeout(t);
  }, []);

  let offsetAcc = 0;
  const segs = segments.map((seg) => {
    if (seg.value <= 0 || isEmpty) {
      return { ...seg, dashArray: `0 ${c}`, dashOffset: 0 };
    }
    const portion = seg.value / sum;
    const dash = portion * c;
    const dashArray = `${dash} ${c - dash}`;
    const dashOffset = -offsetAcc;
    offsetAcc += dash;
    return { ...seg, dashArray, dashOffset };
  });

  const center = centerLabel ?? (isEmpty ? '$0' : formatUsd(sum));

  return (
    <div className="inline-flex flex-col items-center" style={{ gap: 28 }}>
      <div style={{ position: 'relative', width: size, height: size }}>
        <svg viewBox={`0 0 ${VB} ${VB}`} width={size} height={size} style={{ overflow: 'visible' }}>
          {/* Base track — slightly larger than max segment so hover bump still fits visually */}
          <circle cx={CENTER} cy={CENTER} r={RADIUS} fill="none" stroke="#F0F0EE" strokeWidth={STROKE_NORMAL} />
          {!isEmpty &&
            segs.map((seg, i) => {
              if (seg.value <= 0) return null;
              const isHover = hoverLabel === seg.label;
              const isOtherHover = hoverLabel != null && !isHover;
              return (
                <circle
                  key={`${seg.label}-${i}`}
                  cx={CENTER}
                  cy={CENTER}
                  r={RADIUS}
                  fill="none"
                  stroke={seg.color}
                  strokeWidth={isHover ? STROKE_HOVER : STROKE_NORMAL}
                  strokeDasharray={drawn ? seg.dashArray : `0 ${c}`}
                  strokeDashoffset={drawn ? seg.dashOffset : 0}
                  transform={`rotate(-90 ${CENTER} ${CENTER})`}
                  strokeLinecap="butt"
                  opacity={isOtherHover ? 0.4 : 1}
                  style={{
                    transition:
                      'stroke-width 180ms ease-out, opacity 180ms ease-out, stroke-dasharray 600ms ease-out, stroke-dashoffset 600ms ease-out',
                  }}
                />
              );
            })}
        </svg>
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            pointerEvents: 'none',
          }}
        >
          <div
            className="font-num"
            style={{ fontSize: 28, color: isEmpty ? '#9B9B9B' : '#0A0A0A', textAlign: 'center' }}
          >
            {center}
          </div>
        </div>
      </div>

      <div
        className="grid grid-cols-2 gap-x-12 gap-y-3"
        style={{ minWidth: 320 }}
      >
        {segments.map((seg) => (
          <button
            key={seg.label}
            type="button"
            onMouseEnter={() => setHoverLabel(seg.label)}
            onMouseLeave={() => setHoverLabel(null)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              fontSize: 14,
              padding: '4px 6px',
              background: 'transparent',
              border: 'none',
              cursor: 'default',
              color: 'inherit',
              fontFamily: '"DM Sans", sans-serif',
            }}
          >
            <span style={{ width: 12, height: 12, background: seg.color, borderRadius: 2, display: 'inline-block', flexShrink: 0 }} />
            <span style={{ color: '#6B6B6B' }}>{seg.label}</span>
            <span className="font-num ml-auto" style={{ color: '#0A0A0A' }}>{formatUsd(seg.value)}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function formatUsd(v: number): string {
  if (!Number.isFinite(v)) return '$0';
  if (Math.abs(v) >= 1000) return `$${v.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
  return `$${v.toFixed(2)}`;
}
