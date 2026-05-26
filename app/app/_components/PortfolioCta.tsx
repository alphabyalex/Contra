'use client';

/**
 * Portfolio nav button — visually a CTA, not a tab. Sits on the right
 * side of the nav, just left of the wallet connect button. Always blue,
 * mixed-case, with a hover-fill state.
 */

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';

export function PortfolioCta() {
  const pathname = usePathname() ?? '/';
  const active = pathname.startsWith('/portfolio');
  const [hover, setHover] = useState(false);
  const filled = hover || active;
  return (
    <Link
      href="/portfolio"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      className="contra-portfolio-cta"
      aria-label="Portfolio"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        background: filled ? '#1A56DB' : 'transparent',
        color: filled ? '#FFFFFF' : '#1A56DB',
        border: '1px solid #1A56DB',
        borderRadius: 4,
        padding: '7px 16px',
        fontSize: 13,
        fontWeight: 500,
        fontFamily: '"DM Sans", sans-serif',
        transition: 'background 150ms ease-out, color 150ms ease-out',
        cursor: 'pointer',
        lineHeight: 1.2,
      }}
    >
      <span className="contra-portfolio-label">Portfolio</span>
      {/* Compact icon swap when label hides on phones. Keeps the button
       *  reachable so judges can still navigate to their portfolio. */}
      <svg
        className="contra-portfolio-icon"
        aria-hidden
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        style={{ display: 'none' }}
      >
        <rect x="3" y="6" width="18" height="13" rx="2" />
        <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      </svg>
    </Link>
  );
}
