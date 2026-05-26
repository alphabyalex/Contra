'use client';

/**
 * The single canonical CONTRA logo treatment.
 *
 * Renders the wordmark lockup PNG (CON light + TRA bold in #1A56DB on the
 * dark variant) plus an optional vertical divider and the BET AGAINST THE
 * OBVIOUS uppercase tagline. The variant prop swaps in the white-on-dark
 * lockup for use over colored or dark backgrounds.
 *
 * `size` is the wordmark IMAGE HEIGHT in pixels. Width is computed via the
 * native PNG aspect ratio set by max-content + height: <size>px. Common
 * sizes:
 *   nav            32
 *   about          28
 *   modal / inline 20-24
 */

interface LogoProps {
  size?: number;                  // image height in px; default 32 (nav)
  tagline?: boolean;              // include divider + tagline text
  taglineSize?: number;           // tagline px size; default 12
  variant?: 'light' | 'dark';     // 'dark' uses the white wordmark for dark bgs
}

export function Logo({
  size = 32,
  tagline = true,
  taglineSize = 12,
  variant = 'light',
}: LogoProps) {
  const src =
    variant === 'dark'
      ? '/contra-logo-lockup-white.png'
      : '/contra-logo-lockup.png';
  return (
    <div className="inline-flex items-center" style={{ gap: tagline ? 14 : 0 }}>
      {/* Plain <img> rather than next/image. The lockup is a small static
          asset, height-controlled with width auto, and intrinsic dimensions
          read by the browser from the PNG. next/image would force a layout
          shift unless we pin width too. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt="Contra"
        style={{ height: size, width: 'auto', display: 'block' }}
        draggable={false}
      />
      {tagline && (
        <>
          <span
            aria-hidden
            style={{
              width: 1,
              height: Math.max(12, Math.round(size * 0.45)),
              background: '#E5E5E3',
              display: 'inline-block',
            }}
          />
          <span
            style={{
              color: '#6B6B6B',
              fontSize: taglineSize,
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
              fontFamily: '"DM Sans", system-ui, sans-serif',
              fontWeight: 400,
            }}
          >
            Bet Against the Obvious
          </span>
        </>
      )}
    </div>
  );
}
