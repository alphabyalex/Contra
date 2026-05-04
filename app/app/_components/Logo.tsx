'use client';

/**
 * The single canonical CONTRA logo treatment.
 *
 *   CON  (DM Sans 300)  TRA  (DM Sans 700)
 *   no letter-gap between CON and TRA
 *   letter-spacing 0.18em
 *   color #0A0A0A
 *   then a 1px #E5E5E3 vertical divider
 *   then "Bet Against the Obvious" in DM Sans uppercase #6B6B6B
 *
 * `size` controls the wordmark font-size. `tagline={false}` hides the
 * divider + tagline text for centered/small contexts (about page,
 * portfolio empty state).
 */

interface LogoProps {
  size?: number;        // wordmark px size; default 17 (nav)
  tagline?: boolean;    // include the divider + tagline text
  taglineSize?: number; // tagline px size; default 11
  color?: string;       // override wordmark color
}

export function Logo({
  size = 17,
  tagline = true,
  taglineSize = 12,
  color = '#0A0A0A',
}: LogoProps) {
  return (
    <div className="inline-flex items-center" style={{ gap: tagline ? 14 : 0 }}>
      <span
        style={{
          color,
          fontSize: size,
          letterSpacing: '0.18em',
          fontFamily: '"DM Sans", system-ui, sans-serif',
          lineHeight: 1,
          display: 'inline-flex',
        }}
      >
        <span style={{ fontWeight: 300 }}>CON</span>
        <span style={{ fontWeight: 700 }}>TRA</span>
      </span>
      {tagline && (
        <>
          <span
            aria-hidden
            style={{
              width: 1,
              height: 14,
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
