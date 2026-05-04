'use client';

import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Logo } from '../_components/Logo';

type TabId = 'what' | 'payoffs' | 'protocol' | 'disclaimer';
const TABS: Array<{ id: TabId; label: string }> = [
  { id: 'what', label: 'What This Is' },
  { id: 'payoffs', label: 'How Payoffs Work' },
  { id: 'protocol', label: 'The Protocol' },
  { id: 'disclaimer', label: 'Disclaimer' },
];

export default function AboutPage() {
  return (
    <Suspense fallback={<AboutShell active="what" />}>
      <AboutInner />
    </Suspense>
  );
}

function AboutInner() {
  const params = useSearchParams();
  const initial = (params?.get('tab') as TabId) || 'what';
  const [active, setActive] = useState<TabId>(
    TABS.find((t) => t.id === initial) ? initial : 'what',
  );

  // If the user navigates between /about?tab=X via in-page links, react.
  useEffect(() => {
    const next = params?.get('tab') as TabId | undefined;
    if (next && TABS.find((t) => t.id === next)) setActive(next);
  }, [params]);

  return <AboutShell active={active} onSelect={setActive} />;
}

function AboutShell({ active, onSelect }: { active: TabId; onSelect?: (id: TabId) => void }) {
  return (
    <div className="bg-white" style={{ minHeight: 'calc(100vh - 56px)' }}>
      <div style={{ maxWidth: 720, margin: '0 auto', padding: '64px 24px 0' }}>
        <div className="flex justify-center" style={{ marginBottom: 64 }}>
          <Logo size={48} tagline={false} />
        </div>

        <div className="flex justify-start" style={{ borderBottom: '1px solid #E5E5E3' }}>
          {TABS.map((t) => (
            <Tab
              key={t.id}
              label={t.label}
              active={active === t.id}
              onClick={() => onSelect?.(t.id)}
            />
          ))}
        </div>

        <div style={{ paddingTop: 48, paddingBottom: 80 }}>
          {active === 'what' && <WhatTab />}
          {active === 'payoffs' && <PayoffsTab />}
          {active === 'protocol' && <ProtocolTab />}
          {active === 'disclaimer' && <DisclaimerTab />}
        </div>

        <div
          style={{
            fontSize: 11,
            color: '#9B9B9B',
            textAlign: 'center',
            paddingTop: 32,
            paddingBottom: 32,
            fontFamily: '"DM Sans", sans-serif',
          }}
        >
          Full disclaimer available at the bottom of every page. This is experimental devnet software.
        </div>
      </div>
    </div>
  );
}

function Tab({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        padding: '14px 20px',
        background: 'transparent',
        border: 'none',
        fontFamily: '"DM Sans", sans-serif',
        fontSize: 13,
        fontWeight: 500,
        textTransform: 'uppercase',
        letterSpacing: '0.08em',
        color: active ? '#1A56DB' : hover ? '#0A0A0A' : '#6B6B6B',
        borderBottom: active ? '2px solid #1A56DB' : '2px solid transparent',
        cursor: 'pointer',
        marginBottom: -1,
        transition: 'color 150ms ease-out',
      }}
    >
      {label}
    </button>
  );
}

const headingStyle: React.CSSProperties = {
  fontFamily: '"DM Sans", sans-serif',
  fontSize: 36,
  fontWeight: 300,
  color: '#0A0A0A',
  lineHeight: 1.25,
  margin: 0,
  marginBottom: 36,
};

const paragraphStyle: React.CSSProperties = {
  fontFamily: '"DM Sans", sans-serif',
  fontSize: 16,
  fontWeight: 300,
  color: '#4A4A4A',
  lineHeight: 1.9,
  margin: 0,
};

const sectionHeadingStyle: React.CSSProperties = {
  fontFamily: '"DM Sans", sans-serif',
  fontSize: 13,
  fontWeight: 500,
  color: '#0A0A0A',
  textTransform: 'uppercase',
  letterSpacing: '0.06em',
  marginBottom: 20,
};

const sectionBodyStyle: React.CSSProperties = {
  fontFamily: '"DM Sans", sans-serif',
  fontSize: 15,
  fontWeight: 300,
  color: '#6B6B6B',
  lineHeight: 1.9,
  margin: 0,
};

function ParagraphStack({ children }: { children: React.ReactNode }) {
  return <div style={{ display: 'flex', flexDirection: 'column', gap: 28 }}>{children}</div>;
}

function WhatTab() {
  return (
    <div>
      <h2 style={headingStyle}>A short book on human overconfidence.</h2>
      <ParagraphStack>
        <p style={paragraphStyle}>
          Prediction markets have a well-documented problem rooted in what behavioral economists call
          the longshot bias. Retail traders systematically overpay for low-probability outcomes because
          they perceive them as lottery tickets. The gap between actual probability and market price is
          persistent, measurable, and has been studied extensively in academic literature. Contra is
          built to sit on the other side of that trade, powered by a proprietary ML model that scores
          every market in real time.
        </p>
        <p style={paragraphStyle}>
          Contra is a protocol that finds those gaps, bundles the best opportunities into diversified
          short baskets, and lets anyone deposit into them with a single transaction. When longshots
          fail to materialize (which they do, most of the time), the basket pays out above the deposit
          amount.
        </p>
        <p style={paragraphStyle}>
          The protocol runs on Solana. Every basket is a tokenized vault. Every position is on-chain.
        </p>
      </ParagraphStack>
    </div>
  );
}

function PayoffsTab() {
  const sections = [
    {
      h: 'When you deposit',
      b: 'You send USDC into a basket vault. You receive basket tokens representing your share of the vault at current NAV. NAV starts at 1.00.',
    },
    {
      h: 'As legs resolve',
      b: 'Each prediction market outcome in the basket is a leg. When a leg resolves NO (the longshot fails), that leg contributes a positive return to NAV. The return is proportional to how overpriced the market was. A leg priced at 8% that resolves NO contributes roughly 1/0.08 = 12.5x that leg\'s weight.',
    },
    {
      h: 'When you redeem',
      b: 'You burn your basket tokens and receive USDC at the current NAV. If NAV is 1.14, you receive 14% more than you deposited. If a rare cluster of longshots hit, NAV can go below 1.00.',
    },
    {
      h: 'Leverage',
      b: 'Leverage between 1x and 3x is available on basket positions. Leverage multiplies both gains and losses. A leveraged position on a basket that returns 10% earns proportionally more, but the same leverage applies to losses. Health factor is monitored continuously.',
    },
  ];
  return (
    <div>
      <h2 style={headingStyle}>The math is straightforward.</h2>
      <div className="grid grid-cols-1 md:grid-cols-2" style={{ columnGap: 56, rowGap: 48 }}>
        {sections.map((s) => (
          <div key={s.h}>
            <div style={sectionHeadingStyle}>{s.h}</div>
            <p style={sectionBodyStyle}>{s.b}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

function ProtocolTab() {
  return (
    <div>
      <h2 style={headingStyle}>Built on Solana. Fully on-chain.</h2>
      <ParagraphStack>
        <p style={paragraphStyle}>Three programs govern the protocol:</p>
        <p style={paragraphStyle}>
          The vault program manages basket creation, deposits, leg resolution, and redemptions. Each basket
          is an independent vault with its own SPL token.
        </p>
        <p style={paragraphStyle}>
          The lending program provides the USDC pool that powers leveraged positions. Liquidity providers
          deposit USDC and earn yield from borrowers.
        </p>
        <p style={paragraphStyle}>
          The leverage program chains the two together — borrowing from the lending pool and depositing
          into vault positions on behalf of users.
        </p>
        <p style={paragraphStyle}>
          All positions, all NAVs, all resolutions are verifiable on-chain. This is a devnet deployment.
          Mainnet is the next milestone.
        </p>
      </ParagraphStack>
    </div>
  );
}

function DisclaimerTab() {
  const headingDisclaim: React.CSSProperties = {
    fontFamily: '"DM Sans", sans-serif',
    fontSize: 28,
    fontWeight: 300,
    color: '#0A0A0A',
    lineHeight: 1.25,
    margin: 0,
    marginBottom: 32,
  };
  const para: React.CSSProperties = {
    fontFamily: '"DM Sans", sans-serif',
    fontSize: 15,
    fontWeight: 300,
    color: '#4A4A4A',
    lineHeight: 1.8,
    margin: 0,
  };
  const paragraphs = [
    'This platform is experimental software deployed on Solana devnet. It is not a registered investment product and does not constitute financial advice.',
    'Prediction market positions involve real financial risk. You may lose some or all of your deposited funds.',
    'Leveraged positions can result in losses exceeding your initial deposit. Leverage amplifies both gains and losses. Using leverage is entirely at your own risk.',
    'Past basket performance does not guarantee future results. Historical edge calculations are based on market data and model estimates, not guaranteed outcomes.',
    'Always conduct your own research before depositing funds. Contra Protocol is provided as-is with no warranty of any kind.',
  ];
  return (
    <div>
      <h2 style={headingDisclaim}>Risk Disclosure</h2>
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        {paragraphs.map((p, i) => (
          <div key={i}>
            <p style={para}>{p}</p>
            {i < paragraphs.length - 1 && (
              <hr style={{ border: 'none', borderTop: '1px solid #E5E5E3', margin: '16px 0' }} />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
