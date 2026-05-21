'use client';

/**
 * Portfolio page.
 *
 *   Overview tab — donut, holdings rows, performance summary
 *   History tab  — recent on-chain transactions for this wallet
 *
 * Donut + holdings + history all derive from the same data source
 * (state.tsx → /api/portfolio/:wallet) plus an inline USDC balance fetch
 * pulled live from the wallet adapter's RPC connection.
 *
 * Color system:
 *   USDC                          → #9B9B9B
 *   CTRA odd (short term)         → #1A56DB
 *   CTRA even (mid term)          → #0E3A8C
 *   profit / positive P&L         → #00875A
 *   loss   / negative P&L         → #CC2936
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { PublicKey } from '@solana/web3.js';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui';
import { useContraState } from '../_lib/state';

// Devnet circle USDC. Hardcoded — the portfolio donut is a frontend-only
// widget and the backend never needs to know the user's stable balance.
const USDC_MINT_DEVNET = new PublicKey('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU');

const COLOR = {
  usdc: '#9B9B9B',
  ctraOdd: '#1A56DB',
  ctraEven: '#0E3A8C',
  profit: '#00875A',
  loss: '#CC2936',
  text: '#0A0A0A',
  body: '#6B6B6B',
  muted: '#9B9B9B',
  border: '#E5E5E3',
  hairline: '#F0F0F0',
  altRow: '#FAFAFA',
  rowHover: '#F0F4FF',
  surface: '#FFFFFF',
  bg: '#F7F7F5',
} as const;

const SANS = '"DM Sans", system-ui, sans-serif';

function basketTypeFor(name: string | undefined): { label: string; color: string } | null {
  if (!name) return null;
  const m = name.match(/^CTRA-(\d+)/i);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  if (Number.isNaN(n)) return null;
  return n % 2 === 1
    ? { label: 'SHORT TERM', color: COLOR.ctraOdd }
    : { label: 'MID TERM', color: COLOR.ctraEven };
}

interface HoldingRow {
  key: string;
  name: string;
  subtitle: string;
  color: string;
  value: number;
  tokens: number;
  entryNav: number;
  currentNav: number;
  pnl: number;
  pnlPct: number;
}

interface TxRow {
  id: string;
  signature: string;
  type: string;
  basketId: string | null;
  basketName: string | null;
  usdcDelta: number;
  tokensDelta: number;
  createdAt: string;
}

type Tab = 'overview' | 'history';

// =====================================================================
// Page
// =====================================================================

export default function PortfolioPage() {
  const wallet = useWallet();
  const { connection } = useConnection();
  const { walletAddress, basketPositions, leveragedPositions, recentTransactions, refresh, loading, error } = useContraState();
  const [usdcBalance, setUsdcBalance] = useState<number>(0);
  const [tab, setTab] = useState<Tab>('overview');
  // The portfolio surface depends on client-only wallet state. Render a
  // stable shell on the first server pass so React's hydration check
  // doesn't compare wallet-conditional markup against the server output.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (walletAddress) refresh();
  }, [walletAddress, refresh]);

  useEffect(() => {
    if (!wallet.publicKey) {
      setUsdcBalance(0);
      return;
    }
    const pk = wallet.publicKey;
    let cancelled = false;
    (async () => {
      try {
        const accounts = await connection.getParsedTokenAccountsByOwner(pk, { mint: USDC_MINT_DEVNET });
        const total = accounts.value.reduce((s, acc) => {
          const ui = (acc.account.data as any)?.parsed?.info?.tokenAmount?.uiAmount;
          return s + (typeof ui === 'number' ? ui : 0);
        }, 0);
        if (!cancelled) setUsdcBalance(total);
      } catch {
        if (!cancelled) setUsdcBalance(0);
      }
    })();
    return () => { cancelled = true; };
  }, [wallet.publicKey, connection]);

  // ---- stat aggregates ----
  // Total Deployed = sum of USDC originally put in (never moves once
  // deposited). Total P&L = sum of unrealized + resolved pnl_usdc values
  // (moves with NAV). Open Baskets = count of non-finalized positions.
  let unrealizedPnl = 0;
  let resolvedPnl = 0;
  let totalDeployed = 0;
  let openCount = 0;
  for (const p of basketPositions) {
    const status = p.basket?.status ?? 'active';
    const pnl = Number(p.pnl_usdc ?? 0);
    // usdc_deposited is the cumulative USDC the user put in — never moves.
    // The backend also exposes entry_usdc as an alias.
    const entryUsdc = Number(p.usdc_deposited ?? (p as any).entry_usdc ?? 0);
    totalDeployed += entryUsdc;
    if (status === 'finalized') {
      resolvedPnl += pnl;
    } else {
      unrealizedPnl += pnl;
      openCount += 1;
    }
  }
  const totalPnl = unrealizedPnl + resolvedPnl;

  // ---- holdings rows (positions + USDC) ----
  const positionRows: HoldingRow[] = basketPositions.map((p) => {
    const name = p.basket?.name ?? 'Basket';
    const t = basketTypeFor(name);
    return {
      key: p.id,
      name,
      subtitle: t?.label ?? 'BASKET',
      color: t?.color ?? COLOR.ctraOdd,
      value: Number(p.current_value_usdc ?? 0),
      tokens: Number(p.tokens_held ?? 0),
      entryNav: Number(p.entry_nav ?? 1),
      currentNav: Number(p.current_nav ?? 1),
      pnl: Number(p.pnl_usdc ?? 0),
      pnlPct: Number(p.pnl_pct ?? 0),
    };
  });
  const holdings: HoldingRow[] = wallet.publicKey && usdcBalance > 0
    ? [
        ...positionRows,
        {
          key: 'usdc',
          name: 'USDC',
          subtitle: 'STABLECOIN',
          color: COLOR.usdc,
          value: usdcBalance,
          tokens: usdcBalance,
          entryNav: 1,
          currentNav: 1,
          pnl: 0,
          pnlPct: 0,
        },
      ]
    : positionRows;
  const holdingsTotal = holdings.reduce((s, h) => s + h.value, 0);

  // ---- transactions for History tab ----
  const basketNames = new Map<string, string>();
  for (const p of basketPositions) {
    if (p.basket?.id && p.basket?.name) basketNames.set(p.basket.id, p.basket.name);
  }
  const txs: TxRow[] = (recentTransactions ?? []).map((t: any) => ({
    id: String(t.id ?? t.tx_signature),
    signature: String(t.tx_signature ?? ''),
    type: String(t.type ?? ''),
    basketId: t.basket_id ?? null,
    basketName: t.basket_id ? basketNames.get(t.basket_id) ?? null : null,
    usdcDelta: Number(t.usdc_delta ?? 0),
    tokensDelta: Number(t.tokens_delta ?? 0),
    createdAt: String(t.created_at ?? ''),
  }));
  txs.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  const txsView = txs.slice(0, 50);

  const noWallet = !wallet.publicKey;
  const empty = !noWallet && !loading && holdings.length === 0 && leveragedPositions.length === 0;

  if (!mounted) {
    return (
      <div suppressHydrationWarning style={{ background: COLOR.bg, minHeight: 'calc(100vh - 56px)' }}>
        <div className="max-w-[1200px] mx-auto px-6" style={{ paddingTop: 56, color: COLOR.muted, fontSize: 13 }}>
          Loading portfolio…
        </div>
      </div>
    );
  }

  return (
    <div style={{ background: COLOR.bg, minHeight: 'calc(100vh - 56px)' }}>
      <div className="max-w-[1200px] mx-auto px-6">
        <Header walletAddress={walletAddress} />

        {error && <div style={{ color: COLOR.loss, fontSize: 14 }}>{error}</div>}

        <StatsRow totalDeployed={totalDeployed} openCount={openCount} totalPnl={totalPnl} />

        <TabBar active={tab} onChange={setTab} />

        {tab === 'overview' && (
          <div style={{ paddingTop: 24, paddingBottom: 64, display: 'flex', flexDirection: 'column', gap: 24 }}>
            {noWallet && <NoWalletState />}
            {empty && <EmptyState />}
            {!noWallet && !empty && holdings.length > 0 && (
              <>
                <DonutCard holdings={holdings} total={holdingsTotal} />
                <HoldingsSection holdings={holdings} total={holdingsTotal} />
                <PerformanceSection unrealizedPnl={unrealizedPnl} resolvedPnl={resolvedPnl} />
              </>
            )}
          </div>
        )}

        {tab === 'history' && (
          <div style={{ paddingTop: 24, paddingBottom: 64 }}>
            <HistoryCard rows={txsView} noWallet={noWallet} />
          </div>
        )}
      </div>
    </div>
  );
}

// =====================================================================
// Header
// =====================================================================

function Header({ walletAddress }: { walletAddress: string | null }) {
  return (
    <div className="flex items-end justify-between" style={{ paddingTop: 40, paddingBottom: 12 }}>
      <h1 style={{ fontSize: 32, fontWeight: 300, color: COLOR.text, margin: 0, fontFamily: SANS }}>
        Portfolio
      </h1>
      {walletAddress && (
        <div className="font-num" style={{ fontSize: 12, color: COLOR.muted }}>{walletAddress}</div>
      )}
    </div>
  );
}

// =====================================================================
// Stat row (borderless, dividers)
// =====================================================================

function StatsRow({
  totalDeployed, openCount, totalPnl,
}: { totalDeployed: number; openCount: number; totalPnl: number }) {
  const pnlColor = totalPnl > 0 ? COLOR.profit : totalPnl < 0 ? COLOR.loss : COLOR.text;
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '1fr 1px 1fr 1px 1fr',
        gap: 0,
        paddingTop: 40,
        paddingBottom: 40,
      }}
    >
      <StatItem
        label="Total Deployed"
        value={formatUsd(totalDeployed)}
        sub="Amount deposited"
      />
      <Divider />
      <StatItem label="Open Baskets" value={String(openCount)} />
      <Divider />
      <StatItem
        label="Total P&L"
        value={`${totalPnl >= 0 ? '+' : ''}${formatUsd(totalPnl)}`}
        valueColor={pnlColor}
        sub="Unrealized · updates with NAV"
      />
    </div>
  );
}

function StatItem({
  label, value, valueColor = COLOR.text, sub,
}: { label: string; value: string; valueColor?: string; sub?: string }) {
  return (
    <div style={{ paddingLeft: 24, paddingRight: 24 }}>
      <div
        style={{
          fontSize: 11,
          color: COLOR.muted,
          textTransform: 'uppercase',
          letterSpacing: '0.08em',
          fontFamily: SANS,
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontSize: 32,
          fontWeight: 300,
          color: valueColor,
          marginTop: 12,
          fontFamily: SANS,
          letterSpacing: '-0.01em',
        }}
      >
        {value}
      </div>
      {sub && (
        <div style={{ fontSize: 11, color: COLOR.muted, marginTop: 6, fontFamily: SANS }}>
          {sub}
        </div>
      )}
    </div>
  );
}

function Divider() {
  return <div style={{ background: COLOR.border, width: 1 }} />;
}

// =====================================================================
// Tabs
// =====================================================================

function TabBar({ active, onChange }: { active: Tab; onChange: (t: Tab) => void }) {
  return (
    <div style={{ borderBottom: `1px solid ${COLOR.hairline}` }}>
      <div style={{ display: 'flex', gap: 32 }}>
        <TabButton label="Overview" tab="overview" active={active} onClick={() => onChange('overview')} />
        <TabButton label="History" tab="history" active={active} onClick={() => onChange('history')} />
      </div>
    </div>
  );
}

function TabButton({
  label, tab, active, onClick,
}: { label: string; tab: Tab; active: Tab; onClick: () => void }) {
  const isActive = tab === active;
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        background: 'transparent',
        border: 'none',
        padding: '12px 0',
        fontFamily: SANS,
        fontSize: 13,
        fontWeight: 500,
        letterSpacing: '0.04em',
        color: isActive ? COLOR.text : COLOR.muted,
        borderBottom: `2px solid ${isActive ? '#1A56DB' : 'transparent'}`,
        marginBottom: -1,
        cursor: 'pointer',
      }}
    >
      {label}
    </button>
  );
}

// =====================================================================
// Donut card
// =====================================================================

const DONUT_VB = 400;
const DONUT_CENTER = 200;
const DONUT_RADIUS = 150;
const DONUT_STROKE = 32;
const DONUT_STROKE_HOVER = 42;

function DonutCard({ holdings, total }: { holdings: HoldingRow[]; total: number }) {
  return (
    <section
      style={{
        background: COLOR.surface,
        borderRadius: 12,
        boxShadow: '0 1px 3px rgba(0,0,0,0.06)',
        padding: 48,
      }}
    >
      <PortfolioDonut holdings={holdings} total={total} />

      {holdings.length > 0 && (
        <>
          <div style={{ height: 1, background: COLOR.hairline, marginTop: 32 }} />
          <MiniLegend holdings={holdings} />
        </>
      )}
    </section>
  );
}

function MiniLegend({ holdings }: { holdings: HoldingRow[] }) {
  return (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        justifyContent: 'center',
        gap: 32,
        paddingTop: 24,
      }}
    >
      {holdings.map((h) => (
        <div key={h.key} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ width: 8, height: 8, borderRadius: 4, background: h.color, display: 'inline-block' }} />
          <span style={{ fontFamily: SANS, fontSize: 12, color: COLOR.body }}>{h.name}</span>
          <span className="font-num" style={{ fontSize: 12, color: COLOR.text }}>{formatUsd(h.value)}</span>
        </div>
      ))}
    </div>
  );
}

function PortfolioDonut({ holdings, total }: { holdings: HoldingRow[]; total: number }) {
  // Largest segment first so it starts at 12 o'clock and the others
  // fan out clockwise from there.
  const segments = [...holdings].sort((a, b) => b.value - a.value);
  const sum = segments.reduce((s, h) => s + h.value, 0);
  const isEmpty = sum <= 0;
  const c = 2 * Math.PI * DONUT_RADIUS;

  const [hoverKey, setHoverKey] = useState<string | null>(null);
  const [coords, setCoords] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [drawn, setDrawn] = useState(false);

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

  const hovered = segments.find((s) => s.key === hoverKey) ?? null;
  const hoveredPct = hovered && sum > 0 ? (hovered.value / sum) * 100 : 0;

  return (
    <div
      style={{ display: 'flex', justifyContent: 'center', position: 'relative' }}
      onMouseMove={(e) => setCoords({ x: e.clientX, y: e.clientY })}
    >
      <svg
        viewBox={`0 0 ${DONUT_VB} ${DONUT_VB}`}
        width={360}
        height={360}
        style={{ overflow: 'visible' }}
      >
        {/* base track */}
        <circle
          cx={DONUT_CENTER}
          cy={DONUT_CENTER}
          r={DONUT_RADIUS}
          fill="none"
          stroke="#F0F0EE"
          strokeWidth={DONUT_STROKE}
        />
        {!isEmpty &&
          segs.map((seg) => {
            if (seg.value <= 0) return null;
            const isHover = hoverKey === seg.key;
            const isOtherHover = hoverKey != null && !isHover;
            return (
              <circle
                key={seg.key}
                cx={DONUT_CENTER}
                cy={DONUT_CENTER}
                r={DONUT_RADIUS}
                fill="none"
                stroke={seg.color}
                strokeWidth={isHover ? DONUT_STROKE_HOVER : DONUT_STROKE}
                strokeDasharray={drawn ? seg.dashArray : `0 ${c}`}
                strokeDashoffset={drawn ? seg.dashOffset : 0}
                transform={`rotate(-90 ${DONUT_CENTER} ${DONUT_CENTER})`}
                strokeLinecap="butt"
                opacity={isOtherHover ? 0.4 : 1}
                style={{
                  cursor: 'default',
                  transition:
                    'stroke-width 180ms ease-out, opacity 180ms ease-out, stroke-dasharray 600ms ease-out, stroke-dashoffset 600ms ease-out',
                }}
                onMouseEnter={() => setHoverKey(seg.key)}
                onMouseLeave={() => setHoverKey((k) => (k === seg.key ? null : k))}
              />
            );
          })}

        {/* center text rendered inside the SVG so it scales with the
            donut and stays perfectly aligned at every viewport size */}
        <text
          x={DONUT_CENTER}
          y={DONUT_CENTER - 4}
          textAnchor="middle"
          dominantBaseline="middle"
          fontFamily={SANS}
          fontSize={36}
          fontWeight={200}
          fill={isEmpty ? COLOR.muted : COLOR.text}
          letterSpacing="-0.01em"
        >
          {isEmpty ? '$0' : formatUsd(total)}
        </text>
        <text
          x={DONUT_CENTER}
          y={DONUT_CENTER + 30}
          textAnchor="middle"
          dominantBaseline="middle"
          fontFamily={SANS}
          fontSize={11}
          fill={COLOR.muted}
          letterSpacing="2"
          style={{ textTransform: 'uppercase' }}
        >
          TOTAL PORTFOLIO
        </text>
      </svg>

      {hovered && <DonutTooltip name={hovered.name} value={hovered.value} pct={hoveredPct} coords={coords} />}
    </div>
  );
}

function DonutTooltip({
  name, value, pct, coords,
}: { name: string; value: number; pct: number; coords: { x: number; y: number } }) {
  const flipLeft = typeof window !== 'undefined' && coords.x > window.innerWidth - 240;
  return (
    <div
      style={{
        position: 'fixed',
        left: flipLeft ? coords.x - 220 : coords.x + 16,
        top: coords.y + 12,
        background: COLOR.surface,
        border: `1px solid ${COLOR.border}`,
        borderRadius: 8,
        padding: 12,
        minWidth: 200,
        boxShadow: '0 8px 24px rgba(0,0,0,0.06)',
        pointerEvents: 'none',
        animation: 'tooltipFade 150ms ease-out',
        fontFamily: SANS,
        zIndex: 100,
      }}
    >
      <TooltipRow label="Token" value={name} />
      <TooltipRow label="Value" value={formatUsd(value)} mono />
      <TooltipRow label="Share" value={`${pct.toFixed(1)}%`} mono />
    </div>
  );
}

// =====================================================================
// Holdings
// =====================================================================

function HoldingsSection({ holdings, total }: { holdings: HoldingRow[]; total: number }) {
  return (
    <section>
      <SectionLabel>Holdings</SectionLabel>
      <div
        style={{
          borderRadius: 12,
          overflow: 'hidden',
          boxShadow: '0 1px 3px rgba(0,0,0,0.06)',
          background: COLOR.surface,
        }}
      >
        {holdings.map((h, i) => (
          <HoldingRowEl key={h.key} h={h} total={total} rowIndex={i} />
        ))}
      </div>
    </section>
  );
}

function HoldingRowEl({ h, total, rowIndex }: { h: HoldingRow; total: number; rowIndex: number }) {
  const [hovered, setHovered] = useState(false);
  const [coords, setCoords] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const pct = total > 0 ? (h.value / total) * 100 : 0;
  // First row (rowIndex 0) reads as row 1 = odd = white. Even rows
  // (row 2, 4) get the #FAFAFA tint.
  const baseBg = rowIndex % 2 === 0 ? COLOR.surface : COLOR.altRow;
  // Bar opacity scales with portfolio share so small holdings fade out
  // gracefully — clamped to 15% so a tiny slice is still visible.
  const barOpacity = Math.max(0.15, Math.min(1, pct / 100));

  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onMouseMove={(e) => setCoords({ x: e.clientX, y: e.clientY })}
      style={{
        position: 'relative',
        display: 'grid',
        gridTemplateColumns: '1fr 200px auto',
        gap: 24,
        alignItems: 'center',
        height: 64,
        padding: '0 24px',
        background: hovered ? COLOR.rowHover : baseBg,
        transition: 'background 120ms ease-out',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
        <Dot color={h.color} />
        <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ fontFamily: SANS, fontSize: 15, fontWeight: 500, color: COLOR.text }}>
              {h.name}
            </span>
            <span style={{ fontSize: 10, color: COLOR.muted, textTransform: 'uppercase', letterSpacing: '0.08em', fontFamily: SANS }}>
              {h.subtitle}
            </span>
          </div>
          {/* Token count line — only meaningful for basket positions. The
              USDC pseudo-row has tokens === value, so suppress to avoid
              "100 tokens" reading as redundant noise next to "$100.00". */}
          {h.key !== 'usdc' && (
            <span className="font-num" style={{ fontSize: 11, color: COLOR.muted, marginTop: 2 }}>
              {h.tokens.toFixed(4)} tokens
            </span>
          )}
        </div>
      </div>

      <div
        style={{
          width: 200,
          height: 3,
          borderRadius: 2,
          background: h.color,
          opacity: barOpacity,
        }}
      />

      <div style={{ textAlign: 'right' }}>
        <div className="font-num" style={{ fontSize: 16, fontWeight: 400, color: COLOR.text }}>
          {formatUsd(h.value)}
        </div>
        {h.key !== 'usdc' ? (
          <div
            className="font-num"
            style={{
              fontSize: 12,
              color: h.pnl > 0 ? COLOR.profit : h.pnl < 0 ? COLOR.loss : COLOR.muted,
              marginTop: 2,
            }}
          >
            {h.pnl >= 0 ? '+' : '−'}{formatUsd(Math.abs(h.pnl))}
            {Number.isFinite(h.pnlPct) && (
              <span style={{ marginLeft: 6 }}>
                ({h.pnl >= 0 ? '+' : '−'}{Math.abs(h.pnlPct * 100).toFixed(1)}%)
              </span>
            )}
          </div>
        ) : (
          <div style={{ fontSize: 12, color: COLOR.muted, marginTop: 2 }}>{pct.toFixed(1)}%</div>
        )}
      </div>

      {hovered && <HoldingsTooltip h={h} pct={pct} coords={coords} />}
    </div>
  );
}

function Dot({ color }: { color: string }) {
  return (
    <span
      style={{
        display: 'inline-block',
        width: 10,
        height: 10,
        borderRadius: 5,
        background: color,
        flexShrink: 0,
      }}
    />
  );
}

function HoldingsTooltip({ h, pct, coords }: { h: HoldingRow; pct: number; coords: { x: number; y: number } }) {
  const flipLeft = typeof window !== 'undefined' && coords.x > window.innerWidth - 320;
  return (
    <div
      style={{
        position: 'fixed',
        left: flipLeft ? coords.x - 280 : coords.x + 16,
        top: coords.y + 12,
        background: COLOR.surface,
        border: `1px solid ${COLOR.border}`,
        borderRadius: 8,
        padding: 12,
        minWidth: 260,
        boxShadow: '0 8px 24px rgba(0,0,0,0.06)',
        pointerEvents: 'none',
        animation: 'tooltipFade 150ms ease-out',
        fontFamily: SANS,
        zIndex: 100,
      }}
    >
      <style>{`
        @keyframes tooltipFade {
          from { opacity: 0; transform: translateY(-2px); }
          to { opacity: 1; transform: translateY(0); }
        }
      `}</style>
      <TooltipRow label="Token" value={h.name} />
      {h.key !== 'usdc' && (
        <TooltipRow label="Tokens held" value={h.tokens.toFixed(4)} mono />
      )}
      <TooltipRow label="Entry NAV" value={`$${h.entryNav.toFixed(4)}`} mono />
      <TooltipRow label="Current NAV" value={`$${h.currentNav.toFixed(4)}`} mono />
      <TooltipRow label="Current Value" value={formatUsd(h.value)} mono />
      <TooltipRow label="Portfolio share" value={`${pct.toFixed(1)}%`} mono />
      <TooltipRow
        label="Unrealized P&L"
        value={
          h.key === 'usdc'
            ? '—'
            : `${h.pnl >= 0 ? '+' : '−'}${formatUsd(Math.abs(h.pnl))} (${h.pnl >= 0 ? '+' : '−'}${Math.abs((h.pnlPct ?? 0) * 100).toFixed(1)}%)`
        }
        mono
        color={h.key === 'usdc' ? undefined : h.pnl >= 0 ? COLOR.profit : COLOR.loss}
      />
    </div>
  );
}

function TooltipRow({
  label, value, mono, color,
}: { label: string; value: string; mono?: boolean; color?: string }) {
  return (
    <div className="flex items-baseline justify-between" style={{ padding: '4px 0' }}>
      <span style={{ fontSize: 11, color: COLOR.muted, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
        {label}
      </span>
      <span
        className={mono ? 'font-num' : ''}
        style={{ fontSize: 13, color: color ?? COLOR.text, marginLeft: 12, fontFamily: mono ? undefined : SANS }}
      >
        {value}
      </span>
    </div>
  );
}

// =====================================================================
// Performance
// =====================================================================

function PerformanceSection({ unrealizedPnl, resolvedPnl }: { unrealizedPnl: number; resolvedPnl: number }) {
  return (
    <section>
      <div
        style={{
          borderTop: `1px solid ${COLOR.hairline}`,
          paddingTop: 32,
          paddingBottom: 32,
          paddingLeft: 24,
          paddingRight: 24,
        }}
      >
        <SectionLabel>Performance</SectionLabel>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 48 }}>
          <PerfCell label="Unrealized P&L" value={unrealizedPnl} />
          <PerfCell label="Resolved P&L" value={resolvedPnl} />
        </div>
        <div style={{ marginTop: 16, fontSize: 11, color: COLOR.muted, fontFamily: SANS }}>
          Positions resolve as prediction market legs close
        </div>
      </div>
    </section>
  );
}

function PerfCell({ label, value }: { label: string; value: number }) {
  const color = value > 0 ? COLOR.profit : value < 0 ? COLOR.loss : COLOR.text;
  return (
    <div>
      <div
        style={{
          fontSize: 11,
          color: COLOR.muted,
          textTransform: 'uppercase',
          letterSpacing: '0.08em',
          fontFamily: SANS,
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontFamily: SANS,
          fontWeight: 300,
          fontSize: 24,
          color,
          marginTop: 8,
          letterSpacing: '-0.01em',
        }}
      >
        {`${value >= 0 ? '+' : ''}${formatUsd(value)}`}
      </div>
    </div>
  );
}

// =====================================================================
// Empty / no-wallet states
// =====================================================================

function NoWalletState() {
  return (
    <CenteredCard>
      <EmptyDonut />
      <div style={{ fontSize: 20, fontWeight: 300, color: COLOR.body, fontFamily: SANS }}>
        Connect your wallet
      </div>
      <WalletMultiButton />
    </CenteredCard>
  );
}

function EmptyState() {
  return (
    <CenteredCard>
      <EmptyDonut />
      <div style={{ fontSize: 20, fontWeight: 300, color: COLOR.body, fontFamily: SANS }}>
        No positions yet
      </div>
      <div style={{ fontSize: 13, color: COLOR.muted, fontFamily: SANS }}>
        Deposit USDC into a basket to get started
      </div>
      <Link
        href="/baskets"
        style={{
          marginTop: 12,
          background: COLOR.ctraOdd,
          color: '#FFFFFF',
          padding: '10px 28px',
          fontSize: 13,
          fontWeight: 500,
          borderRadius: 4,
          textTransform: 'uppercase',
          letterSpacing: '0.04em',
          fontFamily: SANS,
        }}
      >
        View Baskets
      </Link>
    </CenteredCard>
  );
}

function CenteredCard({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        background: COLOR.surface,
        borderRadius: 12,
        boxShadow: '0 1px 3px rgba(0,0,0,0.06)',
        padding: '64px 24px',
        textAlign: 'center',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 20,
      }}
    >
      {children}
    </div>
  );
}

function EmptyDonut() {
  return (
    <div style={{ position: 'relative', width: 220, height: 220 }}>
      <svg viewBox={`0 0 ${DONUT_VB} ${DONUT_VB}`} width={220} height={220}>
        <circle
          cx={DONUT_CENTER}
          cy={DONUT_CENTER}
          r={DONUT_RADIUS}
          fill="none"
          stroke="#E5E5E3"
          strokeWidth={DONUT_STROKE}
        />
        <text
          x={DONUT_CENTER}
          y={DONUT_CENTER - 4}
          textAnchor="middle"
          dominantBaseline="middle"
          fontFamily={SANS}
          fontSize={36}
          fontWeight={200}
          fill={COLOR.muted}
          letterSpacing="-0.01em"
        >
          $0
        </text>
        <text
          x={DONUT_CENTER}
          y={DONUT_CENTER + 30}
          textAnchor="middle"
          dominantBaseline="middle"
          fontFamily={SANS}
          fontSize={11}
          fill={COLOR.muted}
          letterSpacing="2"
        >
          TOTAL PORTFOLIO
        </text>
      </svg>
    </div>
  );
}

// =====================================================================
// History tab
// =====================================================================

function HistoryCard({ rows, noWallet }: { rows: TxRow[]; noWallet: boolean }) {
  return (
    <section
      style={{
        background: COLOR.surface,
        borderRadius: 12,
        boxShadow: '0 1px 3px rgba(0,0,0,0.06)',
        overflow: 'hidden',
      }}
    >
      <HistoryHeaderRow />
      {noWallet ? (
        <HistoryEmpty title="Connect your wallet" sub="Your transaction history will appear here once you connect." />
      ) : rows.length === 0 ? (
        <HistoryEmpty title="No transactions yet" sub="Your deposit and withdrawal history will appear here" />
      ) : (
        <div>
          {rows.map((r) => (
            <HistoryRow key={r.id} row={r} />
          ))}
        </div>
      )}
      <HistoryFooter />
    </section>
  );
}

function HistoryHeaderRow() {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '180px 110px 1fr 110px 1fr 70px 130px',
        gap: 16,
        padding: '16px 24px',
        borderBottom: `1px solid ${COLOR.hairline}`,
        fontSize: 11,
        textTransform: 'uppercase',
        letterSpacing: '0.06em',
        color: COLOR.muted,
        fontFamily: SANS,
      }}
    >
      <span>Date</span>
      <span>Type</span>
      <span>Basket</span>
      <span style={{ textAlign: 'right' }}>Amount</span>
      <span style={{ textAlign: 'right' }}>Tokens</span>
      <span style={{ textAlign: 'right' }}>Leverage</span>
      <span style={{ textAlign: 'right' }}>Tx</span>
    </div>
  );
}

function HistoryRow({ row }: { row: TxRow }) {
  const [hover, setHover] = useState(false);
  const pill = pillFor(row.type);
  const amount = Math.abs(row.usdcDelta);
  const tokens = Math.abs(row.tokensDelta);
  const explorerUrl = `https://explorer.solana.com/tx/${row.signature}?cluster=devnet`;
  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'grid',
        gridTemplateColumns: '180px 110px 1fr 110px 1fr 70px 130px',
        gap: 16,
        padding: '16px 24px',
        borderBottom: `1px solid ${COLOR.hairline}`,
        background: hover ? COLOR.altRow : COLOR.surface,
        transition: 'background 120ms ease-out',
        alignItems: 'center',
        fontFamily: SANS,
      }}
    >
      <span style={{ fontSize: 13, color: COLOR.body }}>{formatDate(row.createdAt)}</span>
      <span><TypePill label={pill.label} fg={pill.fg} bg={pill.bg} /></span>
      <span style={{ fontSize: 13, fontWeight: 500, color: COLOR.text }}>
        {row.basketName ?? (row.basketId ? `${row.basketId.slice(0, 6)}…` : '—')}
      </span>
      <span className="font-num" style={{ textAlign: 'right', fontSize: 13, color: COLOR.text }}>
        {amount > 0 ? formatUsd(amount) : '—'}
      </span>
      <span className="font-num" style={{ textAlign: 'right', fontSize: 13, color: COLOR.body }}>
        {tokens > 0 && row.basketName ? `${tokens.toFixed(4)} ${row.basketName}` : '—'}
      </span>
      <span style={{ textAlign: 'right', fontSize: 13, color: COLOR.body }}>1x</span>
      <span style={{ textAlign: 'right' }}>
        <a
          href={explorerUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="font-num"
          style={{ fontSize: 12, color: '#1A56DB', textDecoration: 'none' }}
        >
          {row.signature ? `${row.signature.slice(0, 8)}…${row.signature.slice(-6)}` : '—'}
        </a>
      </span>
    </div>
  );
}

function TypePill({ label, fg, bg }: { label: string; fg: string; bg: string }) {
  return (
    <span
      style={{
        display: 'inline-block',
        fontSize: 10,
        fontWeight: 500,
        color: fg,
        background: bg,
        padding: '3px 10px',
        borderRadius: 10,
        textTransform: 'uppercase',
        letterSpacing: '0.08em',
        fontFamily: SANS,
      }}
    >
      {label}
    </span>
  );
}

function pillFor(type: string): { label: string; fg: string; bg: string } {
  const t = type.toLowerCase();
  if (t === 'deposit') return { label: 'DEPOSIT', fg: '#00875A', bg: '#F0FDF4' };
  if (t === 'redeem' || t === 'exit') return { label: 'WITHDRAW', fg: '#CC2936', bg: '#FEF2F2' };
  if (t === 'leverage_open' || t === 'leverage_close') return { label: 'LEVERAGE', fg: '#1A56DB', bg: '#EBF0FF' };
  if (t === 'liquidation') return { label: 'LIQUIDATION', fg: '#CC2936', bg: '#FEF2F2' };
  if (t === 'finalize') return { label: 'FINALIZE', fg: '#6B6B6B', bg: '#F2F2F0' };
  if (t === 'resolve_leg') return { label: 'RESOLVE', fg: '#6B6B6B', bg: '#F2F2F0' };
  return { label: type.toUpperCase() || '—', fg: '#6B6B6B', bg: '#F2F2F0' };
}

function HistoryEmpty({ title, sub }: { title: string; sub: string }) {
  return (
    <div
      style={{
        padding: '64px 24px',
        textAlign: 'center',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      }}
    >
      <div style={{ fontSize: 16, color: COLOR.body, fontFamily: SANS }}>{title}</div>
      <div style={{ fontSize: 13, color: COLOR.muted, fontFamily: SANS }}>{sub}</div>
    </div>
  );
}

function HistoryFooter() {
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'flex-end',
        alignItems: 'center',
        gap: 6,
        padding: '12px 24px',
        borderTop: `1px solid ${COLOR.hairline}`,
        fontSize: 10,
        color: COLOR.muted,
        fontFamily: SANS,
      }}
    >
      Powered by Solana
      <SolanaLogo />
    </div>
  );
}

function SolanaLogo() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
      <defs>
        <linearGradient id="contra-sol-grad" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#9945FF" />
          <stop offset="100%" stopColor="#14F195" />
        </linearGradient>
      </defs>
      <circle cx="6" cy="6" r="6" fill="url(#contra-sol-grad)" />
    </svg>
  );
}

// =====================================================================
// Shared
// =====================================================================

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontSize: 11,
        color: COLOR.muted,
        textTransform: 'uppercase',
        letterSpacing: '0.08em',
        marginBottom: 16,
        fontFamily: SANS,
      }}
    >
      {children}
    </div>
  );
}

function formatUsd(v: number): string {
  if (!Number.isFinite(v)) return '$0.00';
  const abs = Math.abs(v);
  if (abs >= 1000) return `$${v.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
  return `$${v.toFixed(2)}`;
}

function formatDate(iso: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.valueOf())) return iso;
  const date = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', hour12: true });
  return `${date} ${time}`;
}
