'use client';

/**
 * Portfolio page. Always renders the donut + 3 stat cards regardless of
 * wallet connection state — the page should look like a dashboard
 * waiting for data, not an empty page.
 *
 * Layered states:
 *   1. No wallet            → grey donut + zeros + connect button
 *   2. Wallet, no positions → grey donut + zeros + "No open positions yet."
 *   3. Wallet + positions   → live donut + real values + tables
 */

import { useEffect } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui';
import { useContraState } from '../_lib/state';
import { Donut } from '../_components/Donut';

export default function PortfolioPage() {
  const wallet = useWallet();
  const { walletAddress, basketPositions, leveragedPositions, recentTransactions, refresh, loading, error } =
    useContraState();

  useEffect(() => {
    if (walletAddress) refresh();
  }, [walletAddress, refresh]);

  // ---- Donut segments ----
  let active = 0;
  let resolvedProfit = 0;
  let loss = 0;
  const usdc = 0; // wallet USDC balance fetch not wired yet
  for (const p of basketPositions) {
    const status = p.basket?.status ?? 'active';
    const value = Number(p.current_value_usdc ?? 0);
    if (status === 'finalized') {
      const pnl = Number(p.pnl_usdc ?? 0);
      if (pnl >= 0) resolvedProfit += value;
      else loss += value;
    } else {
      active += value;
    }
  }
  const totalDeployed = active + resolvedProfit + loss;
  const totalPnl = basketPositions.reduce((s, p) => s + Number(p.pnl_usdc ?? 0), 0);
  const openCount = basketPositions.filter((p) => (p.basket?.status ?? 'active') !== 'finalized').length;

  const segments = [
    { label: 'Active Baskets', value: active, color: '#1A56DB' },
    { label: 'Resolved Profit', value: resolvedProfit, color: '#00875A' },
    { label: 'Loss', value: loss, color: '#CC2936' },
    { label: 'USDC', value: usdc, color: '#E5E5E3' },
  ];

  const noWallet = !wallet.publicKey;
  const empty = !noWallet && !loading && basketPositions.length === 0 && leveragedPositions.length === 0;

  return (
    <div style={{ background: '#F7F7F5', minHeight: 'calc(100vh - 56px)' }}>
      <div className="max-w-[1400px] mx-auto px-6 py-10 space-y-8">
        <div className="flex items-end justify-between">
          <h1 style={{ fontSize: 32, fontWeight: 300, color: '#0A0A0A', margin: 0 }}>Portfolio</h1>
          {walletAddress && (
            <div className="font-num" style={{ fontSize: 12, color: '#9B9B9B' }}>{walletAddress}</div>
          )}
        </div>

        {error && <div style={{ color: '#CC2936', fontSize: 14 }}>{error}</div>}

        {/* Stat cards */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <StatCard label="Total Deployed" value={formatUsd(totalDeployed)} />
          <StatCard label="Open Baskets" value={String(openCount)} />
          <StatCard
            label="Total P&L"
            value={`${totalPnl >= 0 ? '+' : ''}${formatUsd(totalPnl)}`}
            color={totalPnl > 0 ? '#00875A' : totalPnl < 0 ? '#CC2936' : '#0A0A0A'}
          />
        </div>

        {/* Donut + state callout */}
        <div className="bg-white" style={{ border: '1px solid #E5E5E3', padding: 56, minHeight: 560 }}>
          <div style={{ fontSize: 12, color: '#9B9B9B', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 32 }}>
            Allocation
          </div>
          <div className="flex flex-col items-center gap-8">
            <Donut
              segments={segments}
              size={400}
              centerLabel={totalDeployed > 0 ? formatUsd(totalDeployed) : '$0'}
            />

            {noWallet && (
              <>
                <div style={{ fontSize: 16, color: '#6B6B6B', textAlign: 'center' }}>
                  Connect your wallet to see your positions.
                </div>
                <WalletMultiButton />
              </>
            )}
            {empty && (
              <div style={{ fontSize: 16, color: '#6B6B6B' }}>No open positions yet.</div>
            )}
          </div>
        </div>

        {basketPositions.length > 0 && <PositionsTable rows={basketPositions} />}
        {leveragedPositions.length > 0 && <LeveragedTable rows={leveragedPositions} />}
        {recentTransactions.length > 0 && <RecentList rows={recentTransactions} />}
      </div>
    </div>
  );
}

function StatCard({ label, value, color = '#0A0A0A' }: { label: string; value: string; color?: string }) {
  return (
    <div className="bg-white" style={{ border: '1px solid #E5E5E3', padding: 20 }}>
      <div style={{ fontSize: 11, color: '#9B9B9B', textTransform: 'uppercase', letterSpacing: '0.08em' }}>{label}</div>
      <div className="font-num" style={{ fontSize: 24, color, marginTop: 8 }}>{value}</div>
    </div>
  );
}

function PositionsTable({ rows }: { rows: any[] }) {
  return (
    <div className="bg-white" style={{ border: '1px solid #E5E5E3' }}>
      <div style={tableHeaderStyle}>Basket positions</div>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            {['Basket', 'Tokens', 'USDC In', 'Entry NAV', 'Current NAV', 'Value', 'P&L', ''].map((h, i) => (
              <th key={h} style={{ ...thStyle, textAlign: i === 0 ? 'left' : 'right' }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => (
            <tr key={p.id} style={{ borderTop: '1px solid #E5E5E3' }} className="hover:bg-[#F7F7F5]">
              <td style={tdStyle}>{p.basket?.name ?? p.basket_id}</td>
              <td style={tdNumStyle}>{Number(p.tokens_held).toFixed(2)}</td>
              <td style={tdNumStyle}>${Number(p.usdc_deposited).toFixed(2)}</td>
              <td style={tdNumStyle}>${Number(p.entry_nav ?? 1).toFixed(4)}</td>
              <td style={tdNumStyle}>${Number(p.current_nav ?? 1).toFixed(4)}</td>
              <td style={tdNumStyle}>${Number(p.current_value_usdc ?? 0).toFixed(2)}</td>
              <td style={{ ...tdNumStyle, color: Number(p.pnl_usdc) >= 0 ? '#00875A' : '#CC2936' }}>
                {Number(p.pnl_usdc) >= 0 ? '+' : ''}{Number(p.pnl_usdc).toFixed(2)}
              </td>
              <td style={{ ...tdStyle, textAlign: 'right' }}>
                {p.redeemable ? (
                  <button
                    style={{
                      color: '#1A56DB',
                      fontSize: 11,
                      textTransform: 'uppercase',
                      letterSpacing: '0.08em',
                      background: 'transparent',
                      border: 'none',
                      cursor: 'pointer',
                    }}
                  >
                    Redeem
                  </button>
                ) : (
                  <span style={{ color: '#9B9B9B', fontSize: 11 }}>—</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function LeveragedTable({ rows }: { rows: any[] }) {
  return (
    <div className="bg-white" style={{ border: '1px solid #E5E5E3' }}>
      <div style={tableHeaderStyle}>Leveraged positions</div>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            {['Basket', 'Collateral', 'Debt', 'Leverage', 'Health', 'Value'].map((h, i) => (
              <th key={h} style={{ ...thStyle, textAlign: i === 0 ? 'left' : 'right' }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((lp: any) => (
            <tr key={lp.id} style={{ borderTop: '1px solid #E5E5E3' }} className="hover:bg-[#F7F7F5]">
              <td style={tdStyle}>{lp.basket?.name ?? lp.basket_id}</td>
              <td style={tdNumStyle}>${Number(lp.collateral_usdc).toFixed(2)}</td>
              <td style={tdNumStyle}>${Number(lp.debt_usdc).toFixed(2)}</td>
              <td style={tdNumStyle}>{Number(lp.leverage).toFixed(1)}x</td>
              <td style={{ ...tdNumStyle, color: Number(lp.health_factor) < 1.15 ? '#CC2936' : '#0A0A0A' }}>
                {Number(lp.health_factor).toFixed(2)}
              </td>
              <td style={tdNumStyle}>${Number(lp.current_value_usdc ?? 0).toFixed(2)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RecentList({ rows }: { rows: any[] }) {
  return (
    <div className="bg-white" style={{ border: '1px solid #E5E5E3' }}>
      <div style={tableHeaderStyle}>Recent activity</div>
      <ul style={{ margin: 0, padding: '4px 24px 16px', listStyle: 'none' }}>
        {rows.slice(0, 10).map((t) => (
          <li
            key={t.id}
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              padding: '6px 0',
              fontSize: 12,
              color: '#6B6B6B',
              fontFamily: '"IBM Plex Mono", monospace',
            }}
          >
            <span>
              <span style={{ color: '#0A0A0A', textTransform: 'uppercase', marginRight: 8, fontWeight: 500 }}>{t.type}</span>
              {String(t.tx_signature ?? '').slice(0, 16)}…
            </span>
            <span>{new Date(t.created_at).toLocaleString()}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function formatUsd(v: number): string {
  if (!Number.isFinite(v)) return '$0.00';
  if (Math.abs(v) >= 1000) return `$${v.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
  return `$${v.toFixed(2)}`;
}

const tableHeaderStyle: React.CSSProperties = {
  fontSize: 11,
  color: '#9B9B9B',
  textTransform: 'uppercase',
  letterSpacing: '0.08em',
  padding: '20px 24px 12px',
  fontFamily: '"DM Sans", sans-serif',
};

const thStyle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 500,
  color: '#9B9B9B',
  textTransform: 'uppercase',
  letterSpacing: '0.08em',
  padding: '12px 16px',
  borderBottom: '1px solid #E5E5E3',
  background: '#FFFFFF',
};

const tdStyle: React.CSSProperties = {
  padding: '12px 16px',
  fontSize: 14,
  color: '#0A0A0A',
};

const tdNumStyle: React.CSSProperties = {
  ...tdStyle,
  textAlign: 'right',
  fontFamily: '"IBM Plex Mono", monospace',
};
