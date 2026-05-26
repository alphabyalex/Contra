'use client';

/**
 * GridBackground
 *
 * Renders a faint, repeating Contra-mark motif (3x3 grid of squares with a
 * diagonal-fade alpha pattern) as an SVG background. Designed to sit behind
 * content via z-index, never to interact with text or controls.
 *
 * Variants:
 *   tile      repeating tile across the whole bounding box (hero, sections)
 *   centered  a single large instance, centered, used as a page texture
 *   corner    a single instance pinned to the top-right corner
 *   mark      single solid mark, scales with the wrapper width
 *
 * Animation:
 *   When `fadeIn` is true, the wrapper transitions opacity from 0 to the
 *   target value over `duration` ms when `visible` flips true. Defaults to
 *   visible immediately on mount. For scroll-triggered usage, pass the
 *   visible prop driven by an IntersectionObserver in the consumer.
 *
 * No JS animation libraries. Pure CSS transitions.
 *
 * Shape of the motif (the 3x3 grid):
 *   row\col   0     1     2
 *     0     [1.0] [0.32] [0.12]
 *     1     [0.32] [1.0] [0.32]
 *     2     [0.12] [0.32] [1.0]
 *
 * Diagonal cells get full opacity. Adjacent-to-diagonal cells get a
 * mid-fade. Off-diagonal corners get the lightest fade. The whole pattern
 * is then scaled by the outer `opacity` prop so callers can land it
 * anywhere between 2-8% relative to the page background.
 */

import { useEffect, useRef } from 'react';

interface GridBackgroundProps {
  /** Top-level opacity multiplier applied to the SVG. 0.04-0.08 is the safe band. */
  opacity?: number;
  /** Layout mode. */
  variant?: 'tile' | 'centered' | 'corner' | 'mark';
  /** SVG fill color for the squares. Default brand blue. */
  color?: string;
  /** Pixel size of one mark (3x3 of cells). Each cell is size / 3. */
  markSize?: number;
  /** Gap between tiled marks (px). */
  gap?: number;
  /** Animate from 0 -> opacity on mount or when `visible` flips true. */
  fadeIn?: boolean;
  /** External control of the fade. When undefined, fades in on mount. */
  visible?: boolean;
  /** Transition duration in ms. */
  duration?: number;
  /** Custom style overrides on the outer wrapper. */
  style?: React.CSSProperties;
  /** Pin to a specific corner when variant === 'corner'. */
  corner?: 'top-right' | 'top-left' | 'bottom-right' | 'bottom-left';
  /** Aria hidden by default. Decorative only. */
  className?: string;
  /**
   * Optional ambient animation. 'cycle' makes each of the 9 cells in the
   * mark pulse opacity (active <-> 20% of active) on its own slow timer.
   * The 9 timings are deterministic so SSR matches client and the cells
   * never sync up. Default is no animation (the static background-image
   * path is taken). Currently only meaningful for variant === 'tile';
   * other variants render unchanged.
   */
  animate?: 'none' | 'cycle';
}

const ALPHA_MATRIX: number[][] = [
  [1.0, 0.32, 0.12],
  [0.32, 1.0, 0.32],
  [0.12, 0.32, 1.0],
];

/**
 * Deterministic per-cell cycle timings used when animate="cycle". Indices
 * are row*3 + col. Durations sit in 3.9-7.6s, delays in 0-4.2s, no two
 * cells share the same (duration, delay) pair so the pulses drift in and
 * out of phase rather than locking up. Hardcoded (not Math.random) so
 * SSR markup matches the client and the visual stays stable across reloads.
 */
const CYCLE_TIMINGS: Array<{ duration: number; delay: number }> = [
  { duration: 5.3, delay: 0.0 }, // 0,0
  { duration: 6.7, delay: 1.8 }, // 0,1
  { duration: 4.2, delay: 3.1 }, // 0,2
  { duration: 7.1, delay: 2.4 }, // 1,0
  { duration: 5.8, delay: 0.6 }, // 1,1
  { duration: 3.9, delay: 2.9 }, // 1,2
  { duration: 6.4, delay: 4.2 }, // 2,0
  { duration: 7.6, delay: 1.3 }, // 2,1
  { duration: 4.7, delay: 3.5 }, // 2,2
];

/** Cell pulses from its active alpha down to 20% of that and back. */
const CYCLE_LOW_FRACTION = 0.2;

/**
 * Build a <style> string that defines one keyframe per cell (so each cell
 * pulses between its own active alpha and 20% of that alpha) plus one
 * class rule per cell binding the keyframe with the per-cell duration and
 * delay. Scoped with a unique id passed in by the caller so multiple
 * GridBackground instances on the same page never collide.
 */
function cycleKeyframes(scope: string): string {
  const out: string[] = [];
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      const idx = r * 3 + c;
      const alpha = ALPHA_MATRIX[r][c];
      const low = +(alpha * CYCLE_LOW_FRACTION).toFixed(4);
      const { duration, delay } = CYCLE_TIMINGS[idx];
      const kfName = `${scope}-cell-${r}-${c}`;
      out.push(
        `@keyframes ${kfName} {` +
          `  0%, 100% { opacity: ${alpha}; }` +
          `  50% { opacity: ${low}; }` +
          `}`,
      );
      out.push(
        `.${scope} .cell-${r}-${c} {` +
          `  animation: ${kfName} ${duration}s ease-in-out infinite;` +
          `  animation-delay: ${delay}s;` +
          `}`,
      );
    }
  }
  return out.join('\n');
}

function markSvg(size: number, color: string): string {
  const cell = size / 3;
  const padding = cell * 0.18;
  const innerCell = cell - padding * 2;
  const rects = ALPHA_MATRIX.flatMap((row, r) =>
    row.map((alpha, c) => {
      const x = c * cell + padding;
      const y = r * cell + padding;
      return `<rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${innerCell.toFixed(2)}" height="${innerCell.toFixed(2)}" fill="${color}" opacity="${alpha}"/>`;
    }),
  ).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${rects}</svg>`;
}

function dataUrl(svg: string): string {
  return `url("data:image/svg+xml;utf8,${encodeURIComponent(svg)}")`;
}

export function GridBackground({
  opacity = 0.06,
  variant = 'tile',
  color = '#1A56DB',
  markSize = 36,
  gap = 32,
  fadeIn = true,
  visible,
  duration = 800,
  style,
  corner = 'top-right',
  className,
  animate = 'none',
}: GridBackgroundProps) {
  // When `visible` is undefined, mount with opacity 0 then fade to target on
  // the next animation frame. When `visible` is defined, mirror it exactly.
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (visible !== undefined) return;
    if (!fadeIn) return;
    const el = ref.current;
    if (!el) return;
    el.style.opacity = '0';
    const id = requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        el.style.opacity = String(opacity);
      }),
    );
    return () => cancelAnimationFrame(id);
  }, [opacity, fadeIn, visible]);

  const svg = markSvg(markSize, color);

  // Per-variant background style.
  let bgStyle: React.CSSProperties = {};
  if (variant === 'tile') {
    const tile = markSize + gap;
    bgStyle = {
      backgroundImage: dataUrl(svg),
      backgroundRepeat: 'repeat',
      backgroundSize: `${tile}px ${tile}px`,
      backgroundPosition: '0 0',
    };
  } else if (variant === 'centered') {
    bgStyle = {
      backgroundImage: dataUrl(svg),
      backgroundRepeat: 'no-repeat',
      backgroundPosition: 'center center',
      backgroundSize: `${markSize}px ${markSize}px`,
    };
  } else if (variant === 'corner') {
    const yPos = corner.startsWith('top') ? 'top' : 'bottom';
    const xPos = corner.endsWith('right') ? 'right' : 'left';
    bgStyle = {
      backgroundImage: dataUrl(svg),
      backgroundRepeat: 'no-repeat',
      backgroundPosition: `${yPos} ${xPos}`,
      backgroundSize: `${markSize}px ${markSize}px`,
    };
  } else if (variant === 'mark') {
    bgStyle = {
      backgroundImage: dataUrl(svg),
      backgroundRepeat: 'no-repeat',
      backgroundSize: 'contain',
      backgroundPosition: 'center',
    };
  }

  const initialOpacity =
    visible === undefined ? (fadeIn ? 0 : opacity) : (visible ? opacity : 0);

  // Cycle-animation path. Renders an inline SVG with a <pattern> element so
  // every cell can carry its own CSS class and pulse on its own timer. The
  // static path above is unchanged and continues to handle every call site
  // that does not pass animate="cycle". A unique scope id avoids keyframe
  // collisions when multiple animated grids render on the same page.
  if (animate === 'cycle') {
    const tile = markSize + gap;
    const cell = markSize / 3;
    const padding = cell * 0.18;
    const innerCell = cell - padding * 2;
    const scope = `cgrid-${markSize}-${gap}-${color.replace('#', '')}`;
    const css = cycleKeyframes(scope);

    return (
      <div
        ref={ref}
        aria-hidden
        className={`${className ?? ''} ${scope}`.trim()}
        style={{
          position: 'absolute',
          inset: 0,
          pointerEvents: 'none',
          opacity: initialOpacity,
          transition: `opacity ${duration}ms cubic-bezier(0.4, 0, 0.2, 1)`,
          zIndex: 0,
          ...style,
        }}
      >
        <style>{css}</style>
        <svg
          width="100%"
          height="100%"
          xmlns="http://www.w3.org/2000/svg"
          style={{ display: 'block', width: '100%', height: '100%' }}
        >
          <defs>
            <pattern
              id={`${scope}-pattern`}
              width={tile}
              height={tile}
              patternUnits="userSpaceOnUse"
            >
              {ALPHA_MATRIX.flatMap((row, r) =>
                row.map((alpha, c) => (
                  <rect
                    key={`${r}-${c}`}
                    className={`cell-${r}-${c}`}
                    x={c * cell + padding}
                    y={r * cell + padding}
                    width={innerCell}
                    height={innerCell}
                    fill={color}
                    opacity={alpha}
                  />
                )),
              )}
            </pattern>
          </defs>
          <rect width="100%" height="100%" fill={`url(#${scope}-pattern)`} />
        </svg>
      </div>
    );
  }

  return (
    <div
      ref={ref}
      aria-hidden
      className={className}
      style={{
        position: 'absolute',
        inset: 0,
        pointerEvents: 'none',
        opacity: initialOpacity,
        transition: `opacity ${duration}ms cubic-bezier(0.4, 0, 0.2, 1)`,
        zIndex: 0,
        ...bgStyle,
        ...style,
      }}
    />
  );
}
