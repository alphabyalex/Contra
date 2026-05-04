'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';

// Portfolio is rendered separately on the right side of the nav as a CTA
// (see PortfolioCta). Keep these in display order.
const TABS = [
  { href: '/', label: 'Home' },
  { href: '/baskets', label: 'Baskets' },
  { href: '/scanner', label: 'Scanner' },
  { href: '/about', label: 'About' },
];

export function NavTabs() {
  const pathname = usePathname() ?? '/';
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  return (
    <nav className="flex h-full">
      {TABS.map((t, i) => {
        const active = t.href === '/' ? pathname === '/' : pathname.startsWith(t.href);
        const hovered = hoverIdx === i;
        return (
          <Link
            key={t.href}
            href={t.href}
            onMouseEnter={() => setHoverIdx(i)}
            onMouseLeave={() => setHoverIdx(null)}
            className="flex items-center px-4 h-full"
            style={{
              color: active ? '#1A56DB' : hovered ? '#0A0A0A' : '#6B6B6B',
              fontSize: 13,
              letterSpacing: '0.05em',
              textTransform: 'uppercase',
              borderBottom: active ? '2px solid #1A56DB' : '2px solid transparent',
              transition: 'color 150ms ease-out',
              cursor: 'pointer',
            }}
          >
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
