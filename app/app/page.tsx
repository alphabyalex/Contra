'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { FloatingPills } from './_components/FloatingPills';
import { TickerMarquee } from './_components/TickerMarquee';
import { BiasDemo } from './_components/BiasDemo';
import { LiveScannerMini } from './_components/LiveScannerMini';
import { GridBackground } from './_components/GridBackground';
import { useInView } from './_lib/useInView';
import { api } from './_lib/api';

export default function HomePage() {
  const [scanCount, setScanCount] = useState<number | null>(null);
  const reportCount = useCallback((n: number) => setScanCount(n), []);

  return (
    <div>
      <Hero />
      <TickerMarquee />
      <StatsStrip count={scanCount} onCount={reportCount} />
      <ProblemSection />
      <HowItWorksSection />
      <WhyItWorksSection />
      <LiveRightNowSection count={scanCount} onCount={reportCount} />
      <CtaSection />
    </div>
  );
}

// ============== HERO ==============
function Hero() {
  return (
    <section
      className="relative dot-grid-bg overflow-hidden"
      style={{
        background: '#F7F7F5',
        minHeight: 'calc(100vh - 56px)',
      }}
    >
      {/* Static Contra-mark tile that fades in once behind the hero. Sits
          below the gradient mask, the floating pills, and the content layer. */}
      <GridBackground
        opacity={0.06}
        variant="tile"
        markSize={32}
        gap={36}
        fadeIn
        duration={1200}
      />
      <FloatingPills />
      <div
        aria-hidden
        className="absolute inset-0 pointer-events-none"
        style={{
          background:
            'linear-gradient(to right, rgba(247,247,245,0.95) 0%, rgba(247,247,245,0.95) 45%, rgba(247,247,245,0.0) 72%)',
          zIndex: 1,
        }}
      />

      <div
        className="contra-hero-grid"
        style={{
          position: 'relative',
          zIndex: 2,
          minHeight: 'calc(100vh - 56px)',
          display: 'grid',
          gridTemplateColumns: '58% 42%',
        }}
      >
        <div
          className="contra-hero-left"
          style={{
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'center',
            padding: '80px 60px 80px 80px',
          }}
        >
          <div
            className="contra-hero-eyebrow"
            style={{
              fontSize: 11,
              color: '#9B9B9B',
              textTransform: 'uppercase',
              letterSpacing: '0.12em',
              marginBottom: 16,
              fontFamily: '"DM Sans", sans-serif',
            }}
          >
            Prediction Market Protocol · Solana
          </div>
          <div aria-hidden style={{ width: '100%', height: 1, background: '#E5E5E3', marginBottom: 20 }} />
          <h1
            className="contra-hero-headline"
            style={{
              fontFamily: '"DM Sans", system-ui, sans-serif',
              fontWeight: 400,
              fontSize: 56,
              color: '#1A56DB',
              lineHeight: 1.1,
              letterSpacing: '-0.01em',
              margin: 0,
            }}
          >
            Bet against the obvious.
          </h1>
          <p
            className="contra-hero-sub"
            style={{
              fontSize: 16,
              color: '#4A4A4A',
              fontWeight: 400,
              marginTop: 20,
              maxWidth: 480,
              lineHeight: 1.65,
            }}
          >
            Humans are wired to overpay for unlikely outcomes. A 3% chance feels like a lottery ticket,
            so people buy it anyway. Contra packages the other side of that bias into tokenized short
            baskets you can hold to resolution.
          </p>
          <div className="flex flex-wrap contra-hero-cta-row" style={{ gap: 12, marginTop: 32 }}>
            <HoverButton href="/baskets" variant="filled">View Baskets</HoverButton>
            <HoverButton href="#how-it-works" variant="outline">How It Works</HoverButton>
          </div>
        </div>
        <div aria-hidden className="contra-hero-right" />
      </div>
    </section>
  );
}

function HoverButton({ href, variant, children }: { href: string; variant: 'filled' | 'outline'; children: React.ReactNode }) {
  const [hover, setHover] = useState(false);
  const filled: React.CSSProperties = {
    background: hover ? '#1748B8' : '#1A56DB',
    color: '#FFFFFF',
    border: '1px solid transparent',
  };
  const outline: React.CSSProperties = {
    background: hover ? '#EBF0FF' : 'transparent',
    color: '#1A56DB',
    border: '1px solid #1A56DB',
  };
  const isExternal = href.startsWith('#');
  const inner = (
    <span
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        ...(variant === 'filled' ? filled : outline),
        padding: '14px 28px',
        borderRadius: 3,
        fontSize: 15,
        fontWeight: 500,
        display: 'inline-block',
        transition: 'background 150ms ease-out, color 150ms ease-out',
        cursor: 'pointer',
      }}
    >
      {children}
    </span>
  );
  return isExternal ? <a href={href}>{inner}</a> : <Link href={href}>{inner}</Link>;
}

// ============== STATS STRIP ==============
function StatsStrip({ count, onCount }: { count: number | null; onCount: (n: number) => void }) {
  useEffect(() => {
    if (count != null) return;
    let cancelled = false;
    (async () => {
      try {
        // watched_count is the curated tracked universe (~1,000), not the
        // post-filter row count which is just the rows returned by this
        // particular query window. api.scanner.markets falls back to the
        // snapshot response when the backend is unreachable, and that
        // response also surfaces watched_count from SNAPSHOT_STATS, so the
        // same field works in both modes.
        const r = await api.scanner.markets({ min: 0.02, max: 0.15 });
        const n = Number(
          (r as { watched_count?: number }).watched_count ?? r.count ?? 0,
        );
        if (!cancelled && Number.isFinite(n) && n > 0) onCount(n);
      } catch { /* leave count null */ }
    })();
    return () => { cancelled = true; };
  }, [count, onCount]);

  // Live count is the precise current scanner figure. The "+" appears
  // only on the general watched-universe references elsewhere on the
  // page (e.g. "View all 1000+ watched markets"), not on this specific
  // live count where we have the exact number from the API.
  const liveCount = count != null ? `${count}` : '…';
  const stats = [
    { value: liveCount, label: 'markets tracked live' },
    { value: 'Devnet', label: 'live today on Solana devnet' },
    { value: 'Proprietary', label: 'screening every market' },
  ];

  // Scroll-triggered grid fade. useInView fires once the strip enters the
  // viewport; we drive `stripInView` from that and pass it through to the
  // GridBackground component as its `visible` prop. CSS handles the fade.
  const [stripRef, stripInView] = useInView<HTMLElement>(0.2);

  return (
    <section
      ref={stripRef}
      className="bg-white"
      style={{
        position: 'relative',
        // Thin accent-blue top border defines the strip against the hero
        // above without the heavier hairline color that surrounded it before.
        borderTop: '1px solid #1A56DB',
        borderBottom: '1px solid #E5E5E3',
        overflow: 'hidden',
      }}
    >
      <GridBackground
        opacity={0.04}
        variant="tile"
        markSize={28}
        gap={28}
        fadeIn
        visible={stripInView}
        duration={900}
      />
      <div style={{ position: 'relative', zIndex: 2, maxWidth: 800, margin: '0 auto', padding: '32px 24px' }}>
        <div className="grid grid-cols-1 md:grid-cols-3" style={{ gap: 0 }}>
          {stats.map((s, i) => {
            // Non-numeric values like 'Devnet' and 'Proprietary' get a
            // slightly smaller font so they don't visually crowd or wrap
            // the row alongside the numeric figure in the first cell.
            // Every cell uses an identical fixed 80px height and the same
            // flex centering so the three values share a single vertical
            // center line regardless of font-size, and the three labels
            // sit at exactly the same Y below them.
            const isNumeric = /^[\d.,+\-]+$/.test(s.value.trim());
            const fontSize = isNumeric ? 36 : s.value.length > 8 ? 24 : 28;
            return (
              <div
                key={i}
                style={{
                  height: 80,
                  padding: '12px 24px',
                  borderLeft: i === 0 ? 'none' : '1px solid #E5E5E3',
                  textAlign: 'center',
                  display: 'flex',
                  flexDirection: 'column',
                  justifyContent: 'center',
                  alignItems: 'center',
                  boxSizing: 'border-box',
                }}
              >
                <div
                  className="font-num"
                  style={{
                    fontSize,
                    color: '#1A56DB',
                    fontWeight: 500,
                    lineHeight: 1,
                  }}
                >
                  {s.value}
                </div>
                <div style={{ fontSize: 12, color: '#6B6B6B', marginTop: 8, lineHeight: 1.5, whiteSpace: 'nowrap' }}>
                  {s.label}
                </div>
              </div>
            );
          })}
        </div>
        <div style={{ fontSize: 11, color: '#9B9B9B', textAlign: 'center', marginTop: 20 }}>
          Based on published academic research and live market data.
        </div>
      </div>
    </section>
  );
}

// ============== PROBLEM ==============
function ProblemSection() {
  const FACTS = [
    'Documented across decades of behavioral economics research',
    'Persists in elections, sports, crypto, and macro markets',
    'Now shortable, systematically, on-chain',
  ];
  return (
    <section className="bg-white contra-section-pad" style={{ padding: '48px 80px' }}>
      <div style={{ maxWidth: 800, margin: '0 auto', textAlign: 'center' }}>
        <div className="contra-section-eyebrow" style={sectionLabel}>The Problem</div>
        <h2 className="contra-section-title" style={{ ...sectionHeading, fontSize: 36, fontWeight: 400, marginTop: 16 }}>
          Longshots lose. We built the short side.
        </h2>
        <p className="contra-section-body" style={{ ...bodyParagraph, maxWidth: 780, margin: '24px auto 0' }}>
          Retail traders treat low-probability contracts like lottery tickets. A 7% implied chance feels
          plausible enough to buy, even when the true probability is closer to 1%. The gap between
          perception and reality is persistent, measurable, and shows up in every category of
          prediction market.
        </p>

        {/* Pill row — wider container so all three sit on one line. */}
        <div
          style={{
            maxWidth: 900,
            margin: '32px auto 0',
            display: 'flex',
            flexWrap: 'wrap',
            gap: 8,
            justifyContent: 'center',
          }}
        >
          {FACTS.map((f) => (
            <span
              key={f}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                background: '#FFFFFF',
                border: '1px solid #E5E5E3',
                color: '#6B6B6B',
                fontSize: 13,
                padding: '8px 20px',
                borderRadius: 20,
                whiteSpace: 'nowrap',
                fontFamily: '"DM Sans", sans-serif',
              }}
            >
              {f}
            </span>
          ))}
        </div>

        <div style={{ marginTop: 32, display: 'flex', justifyContent: 'center' }}>
          <BiasDemo count={4} />
        </div>
      </div>
    </section>
  );
}

// ============== HOW IT WORKS ==============
function HowItWorksSection() {
  const steps = [
    { n: '01', title: 'We scan the markets', body: 'Thousands of prediction markets across Kalshi and Polymarket, scored in real time.' },
    { n: '02', title: 'Model finds the edge', body: 'Our proprietary ML model identifies where the crowd is most wrong. Every market is scored, ranked, and filtered by edge before it enters a basket.' },
    { n: '03', title: 'You get one token',    body: 'The best opportunities bundle into a single tokenized basket. One deposit, dozens of positions.' },
  ];
  return (
    <section id="how-it-works" style={{ background: '#F7F7F5', padding: '48px 0' }}>
      <div className="contra-section-pad" style={{ maxWidth: 800, margin: '0 auto 24px', padding: '0 80px', textAlign: 'center' }}>
        <div className="contra-section-eyebrow" style={sectionLabel}>How It Works</div>
      </div>

      {/* Cards: flex row, gap 24px, 48px page padding so they don't touch
          the edges. Each card is its own bordered square on white. */}
      <div
        className="contra-section-pad"
        style={{
          display: 'flex',
          justifyContent: 'center',
          gap: 24,
          padding: '0 48px',
          flexWrap: 'wrap',
        }}
      >
        {steps.map((s, i) => (
          <Step key={s.n} index={i} {...s} />
        ))}
      </div>
    </section>
  );
}

function Step({ n, title, body, index }: { n: string; title: string; body: string; index: number }) {
  const [ref, inView] = useInView<HTMLDivElement>(0.2);
  const [hover, setHover] = useState(false);
  return (
    <div
      ref={ref}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      className="contra-step-card"
      style={{
        width: 'calc(33% - 16px)',
        minHeight: 280,
        padding: 32,
        background: '#FFFFFF',
        border: hover ? '1px solid #1A56DB' : '1px solid #E5E5E3',
        borderRadius: 4,
        opacity: inView ? 1 : 0,
        transform: inView ? 'translateY(0)' : 'translateY(20px)',
        transitionProperty: 'border-color, opacity, transform',
        transitionDuration: '150ms, 500ms, 500ms',
        transitionDelay: `0ms, ${index * 100}ms, ${index * 100}ms`,
        transitionTimingFunction: 'ease-out',
        cursor: 'default',
      }}
    >
      <div
        className="font-num"
        style={{
          fontSize: 11,
          color: '#C0C0C0',
          marginBottom: 14,
          display: 'block',
          letterSpacing: '0.04em',
        }}
      >
        {n}
      </div>
      <div style={{ fontSize: 16, fontWeight: 500, color: '#0A0A0A', marginBottom: 10 }}>{title}</div>
      <div style={{ fontSize: 14, color: '#6B6B6B', lineHeight: 1.65, fontWeight: 300 }}>{body}</div>
    </div>
  );
}

// ============== WHY IT WORKS ==============
function WhyItWorksSection() {
  const points = [
    { label: 'Documented in academic literature', body: 'The longshot bias has been studied across horse racing, sports betting, and financial prediction markets for over 40 years.' },
    { label: 'Holds across every category', body: 'Politics, sports, crypto, macro, culture. The bias is not specific to one market type. It is structural.' },
    { label: 'Retail-driven mispricing', body: 'Sophisticated traders arbitrage most inefficiencies away. Longshot bias persists because it requires scale and infrastructure most traders do not have.' },
    { label: 'The edge compounds', body: 'A basket of dozens of independently mispriced markets has a more consistent return profile than any single position.' },
  ];
  return (
    <section
      className="bg-white relative overflow-hidden"
      style={{ padding: '48px 0' }}
    >
      <SubtleSectionPills />

      <div className="contra-section-pad" style={{ maxWidth: 980, margin: '0 auto', position: 'relative', zIndex: 1, textAlign: 'center', padding: '0 80px' }}>
        <div className="contra-section-eyebrow" style={sectionLabel}>Why It Works</div>
        <h2 className="contra-section-title" style={{ ...sectionHeading, marginTop: 16, marginLeft: 'auto', marginRight: 'auto' }}>
          This is not a hunch.
        </h2>
        <p className="contra-section-body" style={{ ...bodyParagraph, maxWidth: 820, margin: '24px auto 0' }}>
          Longshot bias is one of the most replicated findings in behavioral economics. Favorites are
          underpriced. Longshots are overpriced. The pattern holds across elections, sports, crypto,
          and macro events. We built the short side of that trade. Packaged it. Put it on Solana.
          Every position is on-chain. Every basket is verifiable.
        </p>
      </div>

      {/* 4 boxes in a single horizontal row, centered, no left-border style. */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'center',
          gap: 20,
          padding: '0 40px',
          marginTop: 40,
          position: 'relative',
          zIndex: 1,
          flexWrap: 'wrap',
        }}
      >
        {points.map((p) => (
          <SupportPoint key={p.label} label={p.label} body={p.body} />
        ))}
      </div>
    </section>
  );
}

function SupportPoint({ label, body }: { label: string; body: string }) {
  const [hover, setHover] = useState(false);
  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      className="contra-support-card"
      style={{
        width: 'calc(25% - 15px)',
        minWidth: 200,
        padding: '24px 20px',
        background: hover ? '#EEF2FF' : '#FFFFFF',
        border: hover ? '1px solid #1A56DB' : '1px solid #E5E5E3',
        borderRadius: 4,
        textAlign: 'center',
        transition: 'background 150ms ease-out, border-color 150ms ease-out',
        cursor: 'default',
      }}
    >
      <div style={{ fontSize: 12, fontWeight: 500, color: '#0A0A0A', marginBottom: 8 }}>{label}</div>
      <div style={{ fontSize: 13, fontWeight: 300, color: '#6B6B6B', lineHeight: 1.6 }}>{body}</div>
    </div>
  );
}

/**
 * Ambient drifting pills behind Why It Works. Pulls real short-signal
 * markets from the scanner endpoint. Renders nothing if the fetch fails
 * or returns no qualifying rows. No hardcoded placeholders.
 */
function SubtleSectionPills() {
  const [trades, setTrades] = useState<Array<{ question: string; price: number }>>([]);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await api.scanner.markets({ min: 0.02, max: 0.20 });
        if (cancelled) return;
        const real = (r.rows ?? [])
          .filter((m: any) =>
            m
            && m.question
            && (m.signal === 'short' || m.signal === 'strong_short')
            && Number.isFinite(Number(m.p_market))
            && Number.isFinite(Number(m.raw_edge ?? m.edge))
            && Number(m.raw_edge ?? m.edge) > 0.03,
          )
          .slice(0, 6)
          .map((m: any) => ({ question: String(m.question), price: Number(m.p_market) }));
        if (real.length > 0) setTrades(real);
      } catch { /* leave empty; component renders null */ }
    })();
    return () => { cancelled = true; };
  }, []);

  if (trades.length === 0) return null;

  const lanes = [
    { topPct: 22, durationSec: 35, startDelaySec: 0,  index: 0 },
    { topPct: 70, durationSec: 35, startDelaySec: 17, index: Math.min(2, trades.length - 1) },
  ];
  return (
    <div
      aria-hidden
      className="absolute inset-0 pointer-events-none overflow-hidden"
      style={{ zIndex: 0 }}
    >
      {lanes.map((l, i) => (
        <div
          key={i}
          style={{
            position: 'absolute',
            top: `${l.topPct}%`,
            right: '-360px',
            animation: `subtle-pill-drift ${l.durationSec}s linear ${l.startDelaySec}s infinite`,
          }}
        >
          <div
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 10,
              background: 'rgba(26, 86, 219, 0.06)',
              border: '1px solid rgba(26, 86, 219, 0.10)',
              borderRadius: 999,
              padding: '7px 16px',
              fontFamily: '"IBM Plex Mono", monospace',
              fontSize: 12,
              color: '#1A2B5C',
              whiteSpace: 'nowrap',
            }}
          >
            <span style={{ color: '#CC2936', fontWeight: 500 }}>NO</span>
            <span style={{ color: 'rgba(10,10,10,0.35)' }}>·</span>
            <span>{trades[l.index].question}</span>
            <span style={{ color: 'rgba(10,10,10,0.35)' }}>·</span>
            <span style={{ color: '#0A0A0A' }}>{trades[l.index].price.toFixed(2)}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

// ============== LIVE RIGHT NOW ==============
function LiveRightNowSection({ count, onCount }: { count: number | null; onCount: (n: number) => void }) {
  const linkLabel = count != null
    ? `View all ${count}+ watched markets →`
    : 'View all watched markets →';
  return (
    <section className="bg-white contra-section-pad" style={{ padding: '48px 80px' }}>
      {/* Outer container is wider (900) to accommodate the table. The
          heading + body still center inside narrower max-widths. */}
      <div style={{ maxWidth: 900, margin: '0 auto' }}>
        <div style={{ textAlign: 'center' }}>
          <div className="contra-section-eyebrow" style={sectionLabel}>Live Right Now</div>
          <h2 className="contra-section-title" style={{ ...sectionHeading, marginTop: 16 }}>The scanner never stops.</h2>
          <p className="contra-section-body" style={{ ...bodyParagraph, margin: '20px auto 0', maxWidth: 720 }}>
            Every prediction market on Kalshi and Polymarket is monitored continuously. When our model
            finds a mispricing worth acting on, it gets added to the next basket construction cycle.
          </p>
        </div>

        {/* LiveCounter removed: the 'NO outcomes confirmed 1,210' pill was
            opaque to first-time visitors and the figure was a heuristic
            estimate rather than a real on-chain count. The live scanner
            table below now sits directly under the section body. */}

        <div style={{ marginTop: 28 }}>
          <LiveScannerMini onCount={onCount} />
          <div style={{ marginTop: 16, textAlign: 'left' }}>
            <Link
              href="/scanner"
              style={{
                fontSize: 13,
                color: '#1A56DB',
                fontWeight: 500,
                fontFamily: '"DM Sans", sans-serif',
              }}
            >
              {linkLabel}
            </Link>
          </div>
        </div>
      </div>
    </section>
  );
}

// ============== CTA ==============
function CtaSection() {
  return (
    <section className="contra-section-pad" style={{ background: '#1A56DB', padding: '48px 80px' }}>
      <div
        className="max-w-[1400px] mx-auto"
        style={{
          display: 'flex',
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 32,
          flexWrap: 'wrap',
        }}
      >
        <div
          style={{
            fontSize: 24,
            fontWeight: 300,
            color: '#FFFFFF',
            maxWidth: 400,
            lineHeight: 1.45,
            textAlign: 'left',
          }}
        >
          Pick a basket. Deposit USDC. Let the crowd be wrong for you.
        </div>
        <CtaButton />
      </div>
    </section>
  );
}

function CtaButton() {
  const [hover, setHover] = useState(false);
  return (
    <Link href="/baskets">
      <span
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        style={{
          background: '#FFFFFF',
          color: '#1A56DB',
          padding: '16px 32px',
          borderRadius: 3,
          fontSize: 15,
          fontWeight: 500,
          display: 'inline-flex',
          alignItems: 'center',
          gap: 10,
          border: hover ? '1px solid #FFFFFF' : '1px solid transparent',
          transition: 'background 150ms ease-out, color 150ms ease-out',
          cursor: 'pointer',
        }}
      >
        View Baskets
        {hover && <span className="slide-in-left" style={{ display: 'inline-block' }}>→</span>}
      </span>
    </Link>
  );
}

// ============== shared style atoms ==============
const sectionLabel: React.CSSProperties = {
  fontSize: 11,
  color: '#9B9B9B',
  textTransform: 'uppercase',
  letterSpacing: '0.12em',
};

const sectionHeading: React.CSSProperties = {
  fontFamily: '"DM Sans", sans-serif',
  fontWeight: 300,
  fontSize: 34,
  color: '#0A0A0A',
  lineHeight: 1.2,
  margin: 0,
  maxWidth: 800,
};

const bodyParagraph: React.CSSProperties = {
  fontSize: 16,
  color: '#6B6B6B',
  fontWeight: 400,
  lineHeight: 1.7,
  maxWidth: 680,
  margin: 0,
};
