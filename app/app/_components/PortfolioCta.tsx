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
      Portfolio
    </Link>
  );
}
