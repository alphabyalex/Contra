'use client';

/**
 * Internal admin dashboard. NOT linked from the main nav. Reach by typing
 * /admin in the URL bar. No auth — dev only; admin endpoints accept the
 * page's POSTs because ADMIN_TOKEN matches the header below.
 */

import { useEffect, useState } from 'react';
import { BACKEND_URL } from '../_lib/tokens';

const ADMIN_TOKEN = 'contra-admin';

async function adminPost<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BACKEND_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-admin-token': ADMIN_TOKEN },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((json as any)?.error ?? `${res.status} ${res.statusText}`);
  return json as T;
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BACKEND_URL}${path}`);
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((json as any)?.error ?? `${res.status} ${res.statusText}`);
  return json as T;
}

// ---- shared styles --------------------------------------------------

const colors = {
  bg: '#F7F7F5',
  card: '#FFFFFF',
  border: '#E5E5E3',
  text: '#0A0A0A',
  muted: '#6B6B6B',
  faint: '#9B9B9B',
  accent: '#1A56DB',
  accentSoft: '#EBF0FF',
  positive: '#00875A',
  negative: '#CC2936',
  positiveSoft: '#E6F4EC',
  negativeSoft: '#FCE9EC',
};

const cardStyle: React.CSSProperties = {
  background: colors.card,
  border: `1px solid ${colors.border}`,
  borderRadius: 4,
  padding: 24,
  marginBottom: 20,
};

const sectionLabel: React.CSSProperties = {
  fontSize: 11,
  color: colors.faint,
  textTransform: 'uppercase',
  letterSpacing: '0.12em',
  fontFamily: '"DM Sans", sans-serif',
};

const sectionHeading: React.CSSProperties = {
  fontSize: 22,
  fontWeight: 400,
  color: colors.text,
  margin: '8px 0 20px 0',
};

const numCell: React.CSSProperties = {
  fontFamily: '"IBM Plex Mono", monospace',
  fontSize: 14,
  color: colors.text,
};

// ---- page -----------------------------------------------------------

export default function AdminPage() {
  return (
    <div style={{ background: colors.bg, minHeight: 'calc(100vh - 56px)', padding: '32px 40px' }}>
      <div style={{ maxWidth: 1200, margin: '0 auto' }}>
        <h1 style={{ fontSize: 36, fontWeight: 300, color: colors.text, marginBottom: 4 }}>
          Admin
        </h1>
        <div style={{ ...sectionLabel, marginBottom: 16 }}>Internal · not for production</div>
        <ModelStatusHeader />

        <ModelPerformanceSection />
        <ScreenerSummarySection />
        <BasketControlsSection />
        <ActiveBasketsSection />
        <PredictionLogSection />
        <PriceCollectionSection />
      </div>
    </div>
  );
}

interface ModelStatus {
  model_version: string;
  last_scored_at: string | null;
  total_scored: number;
  included: number;
  impossible: number;
  versions_in_db: Record<string, number>;
}

function ModelStatusHeader() {
  const [s, setS] = useState<ModelStatus | null>(null);
  useEffect(() => { get<ModelStatus>('/api/analytics/model-status').then(setS).catch(() => null); }, []);
  if (!s) return <div style={{ marginBottom: 32 }} />;
  const ts = s.last_scored_at ? new Date(s.last_scored_at).toLocaleString() : '—';
  return (
    <div style={{
      marginBottom: 32, padding: '12px 16px', background: colors.card,
      border: `1px solid ${colors.border}`, borderRadius: 4,
      display: 'flex', gap: 24, alignItems: 'baseline', flexWrap: 'wrap',
    }}>
      <span style={sectionLabel}>Model</span>
      <span style={{ ...numCell, color: colors.accent, fontWeight: 500 }}>{s.model_version}</span>
      <span style={sectionLabel}>Last rescored</span>
      <span style={numCell}>{ts}</span>
      <span style={sectionLabel}>Scored</span>
      <span style={numCell}>{s.total_scored}</span>
      <span style={sectionLabel}>In basket</span>
      <span style={{ ...numCell, color: colors.accent }}>{s.included}</span>
      <span style={sectionLabel}>Impossible</span>
      <span style={{ ...numCell, color: colors.positive }}>{s.impossible}</span>
    </div>
  );
}

// ---- 1. Model Performance --------------------------------------------

interface PerformanceResponse {
  insufficient_data?: boolean;
  resolved_count?: number;
  hit_rate?: { hit_rate: number; resolved: number; no_count: number; yes_count: number };
  brier_score?: { brier: number; resolved: number };
  edge_realization?: { avg_edge_winners: number | null; avg_edge_losers: number | null; spread: number | null };
  calibration?: Array<{ bucket: string; predicted_rate: number; actual_rate: number; count: number }>;
}

function ModelPerformanceSection() {
  const [data, setData] = useState<PerformanceResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    get<PerformanceResponse>('/api/analytics/performance').then(setData).catch((e) => setErr(e.message));
  }, []);

  return (
    <div style={cardStyle}>
      <div style={sectionLabel}>1 · Model Performance</div>
      <h2 style={sectionHeading}>Layered model performance</h2>
      {err && <div style={{ color: colors.negative }}>error: {err}</div>}
      {!data && !err && <Skeleton lines={2} />}
      {data?.insufficient_data && (
        <div style={{ color: colors.muted, fontSize: 14 }}>
          Collecting data — need 10+ resolved legs to compute metrics.
          {' '}<span style={numCell}>(resolved: {data.resolved_count ?? 0})</span>
        </div>
      )}
      {data && !data.insufficient_data && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 16 }}>
          <Metric
            label="Hit Rate"
            value={`${(((data.hit_rate?.hit_rate ?? 0) * 100)).toFixed(1)}%`}
            note={`NO ${data.hit_rate?.no_count ?? 0} / ${data.hit_rate?.resolved ?? 0}`}
          />
          <Metric
            label="Brier Score"
            value={(data.brier_score?.brier ?? 0).toFixed(3)}
            note="lower is better, target <0.15"
          />
          <Metric
            label="Avg Edge Winners"
            value={fmtPct(data.edge_realization?.avg_edge_winners)}
            tone="positive"
          />
          <Metric
            label="Avg Edge Losers"
            value={fmtPct(data.edge_realization?.avg_edge_losers)}
            tone="negative"
          />
        </div>
      )}
    </div>
  );
}

// ---- 2. Screener Summary --------------------------------------------

interface ScannerRow {
  question: string;
  marketId: string;
  source: 'polymarket' | 'kalshi';
  p_market: number;
  daysToClose?: number | null;
  category?: string | null;
  screened?: boolean;
  excluded?: boolean;
  impossible?: boolean;
  exclusion_reason?: string | null;
  edge?: number | null;
  adjusted_edge?: number | null;
  time_factor?: number | null;
  category_factor?: number | null;
  volume_factor?: number | null;
  include_in_basket?: boolean | null;
}
interface RecentExcluded {
  question: string;
  exclusion_reason: string | null;
  p_market: number;
  screened_at: string;
}

interface ScreenerSummary {
  total_tracked: number;
  total_screened: number;
  excluded: number;
  eligible: number;
  in_basket: number;
}

function ScreenerSummarySection() {
  const [rows, setRows] = useState<ScannerRow[] | null>(null);
  const [recent, setRecent] = useState<RecentExcluded[] | null>(null);
  const [summary, setSummary] = useState<ScreenerSummary | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    // Counts come directly from Supabase via the analytics endpoint so
    // they aren't truncated by the scanner display limit. The scanner
    // rows are still used only for the top-10 layered breakdown table.
    Promise.all([
      get<ScreenerSummary>('/api/analytics/screener-summary').then(setSummary),
      get<{ rows: ScannerRow[] }>('/api/scanner/markets?sort=edge&limit=500').then((d) => setRows(d.rows ?? [])),
      get<{ rows: RecentExcluded[] }>('/api/scanner/recent-excluded?limit=10').then((d) => setRecent(d.rows ?? [])),
    ]).catch((e) => setErr(e.message));
  }, []);

  const total = summary?.total_tracked ?? 0;
  const screened = summary?.total_screened ?? 0;
  const excluded = summary?.excluded ?? 0;
  const eligible = summary?.eligible ?? 0;
  const inBasket = summary?.in_basket ?? 0;

  return (
    <div style={cardStyle}>
      <div style={sectionLabel}>2 · Screener Summary</div>
      <h2 style={sectionHeading}>Polymarket scanner state</h2>
      {err && <div style={{ color: colors.negative }}>error: {err}</div>}
      {!rows && !err && <Skeleton lines={3} />}
      {rows && (
        <>
          <div style={{ marginBottom: 16, color: colors.muted, fontSize: 14 }}>
            Total markets watched: <span style={numCell}>{total}</span>
          </div>
          <div style={{ display: 'flex', gap: 12, marginBottom: 24 }}>
            <Pill label="Screened" value={screened} />
            <Pill label="Excluded" value={excluded} tone="negative" />
            <Pill label="Eligible" value={eligible} tone="positive" />
            <Pill label="In basket" value={inBasket} tone="accent" />
          </div>
          {/* Top-scored markets — shows the layered breakdown per market. */}
          <div style={{ marginBottom: 24 }}>
            <div style={{ ...sectionLabel, marginBottom: 8 }}>Top 10 by adjusted edge</div>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ borderBottom: `1px solid ${colors.border}`, color: colors.faint }}>
                  <Th>Market</Th>
                  <Th align="right">p_market</Th>
                  <Th align="right">Adj. Edge</Th>
                  <Th align="right">Time×</Th>
                  <Th>Category</Th>
                  <Th align="right">Days</Th>
                </tr>
              </thead>
              <tbody>
                {(rows ?? [])
                  .filter((r) => r.adjusted_edge != null)
                  .slice(0, 10)
                  .map((r, i) => (
                    <tr key={i} style={{ borderBottom: `1px solid ${colors.border}` }}>
                      <td style={{ padding: '10px 8px', maxWidth: 360 }}>{r.question}</td>
                      <td style={{ padding: '10px 8px', textAlign: 'right', ...numCell }}>{(r.p_market * 100).toFixed(1)}%</td>
                      <td style={{ padding: '10px 8px', textAlign: 'right', ...numCell, color: colors.accent }}>
                        {((r.adjusted_edge ?? 0) * 100).toFixed(1)}%
                      </td>
                      <td style={{ padding: '10px 8px', textAlign: 'right', ...numCell }}>{(r.time_factor ?? 1).toFixed(2)}</td>
                      <td style={{ padding: '10px 8px', color: colors.muted }}>{r.category ?? '—'}</td>
                      <td style={{ padding: '10px 8px', textAlign: 'right', ...numCell }}>{r.daysToClose ?? '—'}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>

          {recent && recent.length > 0 && (
            <div>
              <div style={{ ...sectionLabel, marginBottom: 8 }}>10 most recently excluded</div>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr style={{ borderBottom: `1px solid ${colors.border}`, color: colors.faint }}>
                    <Th>Market</Th>
                    <Th align="right">p_market</Th>
                    <Th>Reason</Th>
                  </tr>
                </thead>
                <tbody>
                  {recent.map((r, i) => (
                    <tr key={i} style={{ borderBottom: `1px solid ${colors.border}` }}>
                      <td style={{ padding: '10px 8px', maxWidth: 360 }}>{r.question}</td>
                      <td style={{ padding: '10px 8px', textAlign: 'right', ...numCell }}>{((r.p_market ?? 0) * 100).toFixed(1)}%</td>
                      <td style={{ padding: '10px 8px', color: colors.muted, fontSize: 12 }}>{r.exclusion_reason ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ---- 3. Basket Controls ---------------------------------------------

interface BasketLegPreview {
  legIndex: number;
  conditionId: string;
  question: string;
  category: string;
  pMarket: number;
  pModel: number;
  edge: number;
  weight: number;
  daysToClose: number | null;
  impossible: boolean;
}

interface BasketDefinition {
  name: string;
  type: 'short' | 'mid';
  description: string;
  legs: BasketLegPreview[];
  category_breakdown: Record<string, number>;
  avg_edge: number;
  impossible_count: number;
}

function BasketControlsSection() {
  const [proposal, setProposal] = useState<BasketDefinition | null>(null);
  const [busy, setBusy] = useState<'short' | 'mid' | 'seed' | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [seeded, setSeeded] = useState<{ name: string; legs_count: number } | null>(null);

  const construct = async (type: 'short' | 'mid') => {
    setBusy(type); setErr(null); setProposal(null); setSeeded(null);
    try {
      const def = await adminPost<BasketDefinition>('/api/admin/construct-basket', { type });
      setProposal(def);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const seed = async () => {
    if (!proposal) return;
    setBusy('seed'); setErr(null);
    try {
      const r = await adminPost<{ basket_id: string; name: string; legs_count: number }>(
        '/api/admin/seed-basket',
        { definition: proposal },
      );
      setSeeded({ name: r.name, legs_count: r.legs_count });
      setProposal(null);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div style={cardStyle}>
      <div style={sectionLabel}>3 · Basket Controls</div>
      <h2 style={sectionHeading}>Construct + seed CTRA baskets</h2>
      <div style={{ display: 'flex', gap: 12, marginBottom: 16 }}>
        <Button label="Construct Short Basket" onClick={() => construct('short')} disabled={!!busy} loading={busy === 'short'} />
        <Button label="Construct Mid Basket" onClick={() => construct('mid')} disabled={!!busy} loading={busy === 'mid'} />
      </div>
      {err && <div style={{ color: colors.negative, marginBottom: 12 }}>error: {err}</div>}
      {seeded && (
        <div style={{ color: colors.positive, marginBottom: 12 }}>
          {seeded.name} seeded successfully — {seeded.legs_count} legs
        </div>
      )}
      {proposal && (
        <div style={{ background: colors.bg, border: `1px solid ${colors.border}`, padding: 16, borderRadius: 4 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
            <div style={{ fontSize: 18, fontWeight: 500 }}>{proposal.name}</div>
            <div style={{ ...sectionLabel }}>{proposal.type} term</div>
          </div>
          <div style={{ marginTop: 8, color: colors.muted, fontSize: 13 }}>
            {proposal.legs.length} legs · avg adj. edge <span style={numCell}>{(proposal.avg_edge * 100).toFixed(1)}%</span> ·
            {' '}<span style={{ color: colors.accent }}>{proposal.impossible_count}</span> impossibles
          </div>
          <div style={{ marginTop: 8, fontSize: 12, color: colors.faint }}>
            Categories: {Object.entries(proposal.category_breakdown).map(([k, v]) => `${k}:${v}`).join(' · ')}
          </div>

          <div style={{ marginTop: 16, maxHeight: 360, overflow: 'auto', background: colors.card, border: `1px solid ${colors.border}` }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr style={{ borderBottom: `1px solid ${colors.border}`, color: colors.faint, position: 'sticky', top: 0, background: colors.card }}>
                  <Th>Question</Th>
                  <Th>Category</Th>
                  <Th align="right">p_market</Th>
                  <Th align="right">Adj. Edge</Th>
                  <Th align="right">Weight</Th>
                  <Th align="right">Days</Th>
                </tr>
              </thead>
              <tbody>
                {proposal.legs.map((l) => (
                  <tr key={l.conditionId} style={{ borderBottom: `1px solid ${colors.border}` }}>
                    <td style={{ padding: '8px', maxWidth: 380 }}>
                      {l.question.length > 50 ? l.question.slice(0, 49) + '…' : l.question}
                      {l.impossible && <span style={{ marginLeft: 8, color: colors.negative, fontSize: 9, fontWeight: 600 }}>IMPOSSIBLE</span>}
                    </td>
                    <td style={{ padding: '8px', color: colors.muted }}>{l.category}</td>
                    <td style={{ padding: '8px', textAlign: 'right', ...numCell, fontSize: 12 }}>{(l.pMarket * 100).toFixed(1)}%</td>
                    <td style={{ padding: '8px', textAlign: 'right', ...numCell, fontSize: 12, color: colors.accent }}>{(l.edge * 100).toFixed(1)}%</td>
                    <td style={{ padding: '8px', textAlign: 'right', ...numCell, fontSize: 12 }}>{(l.weight * 100).toFixed(1)}%</td>
                    <td style={{ padding: '8px', textAlign: 'right', ...numCell, fontSize: 12 }}>{l.daysToClose ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div style={{ marginTop: 16 }}>
            <Button label="Seed this basket" onClick={seed} disabled={busy === 'seed'} loading={busy === 'seed'} accent />
          </div>
        </div>
      )}
    </div>
  );
}

// ---- 4. Active Baskets ----------------------------------------------

interface BasketRow {
  id: string;
  name: string;
  leverage_type: string;
  num_legs: number;
  legs_resolved: number;
  legs_total: number;
  nav: number;
  status: string;
}

interface AdminLeg {
  leg_index: number;
  source: string;
  market_id: string;
  question: string;
  outcome_label?: string | null;
  p_market_entry: number;
  p_model: number;
  edge: number;
  weight: number;
  outcome?: 0 | 1 | null;
}

function ActiveBasketsSection() {
  const [baskets, setBaskets] = useState<BasketRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [legsCache, setLegsCache] = useState<Record<string, AdminLeg[]>>({});
  const [legsLoading, setLegsLoading] = useState<string | null>(null);
  const [legsErr, setLegsErr] = useState<Record<string, string>>({});

  useEffect(() => {
    get<{ baskets: BasketRow[] }>('/api/baskets').then((d) => setBaskets(d.baskets ?? [])).catch((e) => setErr(e.message));
  }, []);

  const toggle = async (b: BasketRow) => {
    if (expanded === b.id) {
      setExpanded(null);
      return;
    }
    setExpanded(b.id);
    if (legsCache[b.id]) return;
    setLegsLoading(b.id);
    try {
      const r = await get<{ legs: AdminLeg[] }>(`/api/baskets/${b.id}`);
      setLegsCache((m) => ({ ...m, [b.id]: r.legs ?? [] }));
    } catch (e) {
      setLegsErr((m) => ({ ...m, [b.id]: (e as Error).message }));
    } finally {
      setLegsLoading(null);
    }
  };

  return (
    <div style={cardStyle}>
      <div style={sectionLabel}>4 · Active Baskets</div>
      <h2 style={sectionHeading}>{baskets?.length ?? 0} baskets in DB</h2>
      {err && <div style={{ color: colors.negative }}>error: {err}</div>}
      {!baskets && !err && <Skeleton lines={3} />}
      {baskets && baskets.length === 0 && (
        <div style={{ color: colors.muted, fontSize: 14 }}>No active baskets — construct one above.</div>
      )}
      {baskets && baskets.length > 0 && (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ borderBottom: `1px solid ${colors.border}`, color: colors.faint }}>
              <Th>Name</Th>
              <Th>Type</Th>
              <Th align="right">Legs</Th>
              <Th align="right">Resolved</Th>
              <Th align="right">NAV</Th>
              <Th>Status</Th>
            </tr>
          </thead>
          <tbody>
            {baskets.map((b) => {
              const open = expanded === b.id;
              return (
                <>
                  <tr
                    key={b.id}
                    style={{ borderBottom: `1px solid ${colors.border}`, cursor: 'pointer' }}
                    onClick={() => toggle(b)}
                  >
                    <td style={{ padding: '10px 8px', color: colors.accent, fontWeight: 500 }}>
                      <span style={{ display: 'inline-block', width: 14, color: colors.faint }}>
                        {open ? '▾' : '▸'}
                      </span>
                      {b.name}
                    </td>
                    <td style={{ padding: '10px 8px', color: colors.muted }}>{b.leverage_type}</td>
                    <td style={{ padding: '10px 8px', textAlign: 'right', ...numCell }}>{b.num_legs}</td>
                    <td style={{ padding: '10px 8px', textAlign: 'right', ...numCell }}>{b.legs_resolved}/{b.legs_total}</td>
                    <td style={{ padding: '10px 8px', textAlign: 'right', ...numCell }}>{(b.nav ?? 1).toFixed(4)}</td>
                    <td style={{ padding: '10px 8px', color: colors.muted }}>{b.status}</td>
                  </tr>
                  {open && (
                    <tr key={`${b.id}-legs`}>
                      <td colSpan={6} style={{ background: colors.bg, padding: 16 }}>
                        {legsLoading === b.id && <Skeleton lines={3} />}
                        {legsErr[b.id] && <div style={{ color: colors.negative }}>error: {legsErr[b.id]}</div>}
                        {legsCache[b.id] && <AdminLegTable legs={legsCache[b.id]} />}
                      </td>
                    </tr>
                  )}
                </>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

function AdminLegTable({ legs }: { legs: AdminLeg[] }) {
  return (
    <div style={{ background: colors.card, border: `1px solid ${colors.border}`, overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
        <thead>
          <tr style={{ borderBottom: `1px solid ${colors.border}`, color: colors.faint }}>
            <Th>#</Th>
            <Th>Question</Th>
            <Th>Source</Th>
            <Th align="right">P market</Th>
            <Th align="right">P model</Th>
            <Th align="right">Edge</Th>
            <Th align="right">Weight</Th>
            <Th>Status</Th>
          </tr>
        </thead>
        <tbody>
          {legs.map((l) => {
            const o = l.outcome;
            const statusBg = o === 0 ? colors.positiveSoft : o === 1 ? colors.negativeSoft : '#F0F0EE';
            const statusFg = o === 0 ? colors.positive : o === 1 ? colors.negative : colors.faint;
            const statusText = o === 0 ? 'NO' : o === 1 ? 'YES' : 'open';
            return (
              <tr key={l.leg_index} style={{ borderBottom: `1px solid ${colors.border}` }}>
                <td style={{ padding: '8px', ...numCell, color: colors.faint, fontSize: 12 }}>{l.leg_index}</td>
                <td style={{ padding: '8px', maxWidth: 380, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {l.question}
                </td>
                <td style={{ padding: '8px', color: colors.muted, textTransform: 'lowercase' }}>{l.source}</td>
                <td style={{ padding: '8px', textAlign: 'right', ...numCell, fontSize: 12, color: colors.negative }}>
                  {(Number(l.p_market_entry) * 100).toFixed(1)}%
                </td>
                <td style={{ padding: '8px', textAlign: 'right', ...numCell, fontSize: 12, color: colors.accent }}>
                  {(Number(l.p_model) * 100).toFixed(1)}%
                </td>
                <td style={{ padding: '8px', textAlign: 'right', ...numCell, fontSize: 12, color: colors.positive }}>
                  +{(Number(l.edge) * 100).toFixed(1)}%
                </td>
                <td style={{ padding: '8px', textAlign: 'right', ...numCell, fontSize: 12 }}>
                  {(Number(l.weight) * 100).toFixed(2)}%
                </td>
                <td style={{ padding: '8px' }}>
                  <span style={{
                    fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.08em',
                    padding: '2px 8px', borderRadius: 10, background: statusBg, color: statusFg,
                    fontFamily: '"DM Sans", sans-serif', fontWeight: 500,
                  }}>
                    {statusText}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ---- 5. Prediction Log Stats ----------------------------------------

function PredictionLogSection() {
  const [data, setData] = useState<PerformanceResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    get<PerformanceResponse>('/api/analytics/performance').then(setData).catch((e) => setErr(e.message));
  }, []);

  return (
    <div style={cardStyle}>
      <div style={sectionLabel}>5 · Prediction Log</div>
      <h2 style={sectionHeading}>Calibration table</h2>
      {err && <div style={{ color: colors.negative }}>error: {err}</div>}
      {!data && !err && <Skeleton lines={2} />}
      {data?.insufficient_data && (
        <div style={{ color: colors.muted, fontSize: 14 }}>
          Insufficient resolved legs ({data.resolved_count ?? 0}) — calibration unavailable.
        </div>
      )}
      {data?.calibration && (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ borderBottom: `1px solid ${colors.border}`, color: colors.faint }}>
              <Th>Bucket</Th>
              <Th align="right">Predicted Rate</Th>
              <Th align="right">Actual Rate</Th>
              <Th align="right">Count</Th>
              <Th align="right">Overpricing</Th>
            </tr>
          </thead>
          <tbody>
            {data.calibration.map((b) => {
              const over = b.predicted_rate - b.actual_rate;
              return (
                <tr key={b.bucket} style={{ borderBottom: `1px solid ${colors.border}` }}>
                  <td style={{ padding: '10px 8px' }}>{b.bucket}</td>
                  <td style={{ padding: '10px 8px', textAlign: 'right', ...numCell }}>{(b.predicted_rate * 100).toFixed(1)}%</td>
                  <td style={{ padding: '10px 8px', textAlign: 'right', ...numCell }}>{(b.actual_rate * 100).toFixed(1)}%</td>
                  <td style={{ padding: '10px 8px', textAlign: 'right', ...numCell }}>{b.count}</td>
                  <td style={{ padding: '10px 8px', textAlign: 'right', ...numCell, color: over > 0 ? colors.positive : colors.negative }}>
                    {over > 0 ? '+' : ''}{(over * 100).toFixed(1)}%
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ---- 6. Price Collection Status -------------------------------------

function PriceCollectionSection() {
  const [rows, setRows] = useState<ScannerRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    get<{ rows: ScannerRow[]; at: number }>('/api/scanner/markets?min=0.0&max=1.0').then((d) => setRows(d.rows ?? [])).catch((e) => setErr(e.message));
  }, []);

  // Tracked count is the total scanner snapshot — a proxy for live tracking
  // until we surface tracked_markets directly. Frequency tier is computed
  // from days_to_close on each row.
  const tier = (d: number | null | undefined): 'high' | 'medium' | 'low' | 'minimal' => {
    if (d == null) return 'minimal';
    if (d < 30) return 'high';
    if (d < 90) return 'medium';
    if (d < 180) return 'low';
    return 'minimal';
  };

  const counts = { high: 0, medium: 0, low: 0, minimal: 0 } as Record<string, number>;
  for (const r of rows ?? []) {
    counts[tier((r as any).daysToClose)]++;
  }

  return (
    <div style={cardStyle}>
      <div style={sectionLabel}>6 · Price Collection</div>
      <h2 style={sectionHeading}>Scanner snapshot · tier breakdown</h2>
      {err && <div style={{ color: colors.negative }}>error: {err}</div>}
      {!rows && !err && <Skeleton lines={2} />}
      {rows && (
        <>
          <div style={{ marginBottom: 16, color: colors.muted, fontSize: 14 }}>
            Markets being tracked: <span style={numCell}>{rows.length}</span>
          </div>
          <div style={{ display: 'flex', gap: 12 }}>
            <Pill label="< 30 days (15 min)" value={counts.high} tone="negative" />
            <Pill label="30–90 (60 min)" value={counts.medium} />
            <Pill label="90–180 (4 h)" value={counts.low} tone="accent" />
            <Pill label="> 180 (12 h)" value={counts.minimal} />
          </div>
          <div style={{ marginTop: 12, color: colors.faint, fontSize: 12 }}>
            Last snapshot: {new Date().toLocaleTimeString()}
          </div>
        </>
      )}
    </div>
  );
}

// ---- shared atoms ----------------------------------------------------

function Th({ children, align = 'left' }: { children: React.ReactNode; align?: 'left' | 'right' }) {
  return (
    <th
      style={{
        textAlign: align,
        padding: '10px 8px',
        fontSize: 11,
        fontWeight: 500,
        textTransform: 'uppercase',
        letterSpacing: '0.08em',
      }}
    >
      {children}
    </th>
  );
}

function Skeleton({ lines = 2 }: { lines?: number }) {
  return (
    <div>
      {Array.from({ length: lines }).map((_, i) => (
        <div
          key={i}
          style={{
            height: 14,
            borderRadius: 2,
            background: '#F0F0EE',
            margin: '6px 0',
            width: i === 0 ? '60%' : '40%',
          }}
        />
      ))}
    </div>
  );
}

function Metric({
  label, value, note, tone = 'default',
}: { label: string; value: string; note?: string; tone?: 'default' | 'positive' | 'negative' }) {
  const color =
    tone === 'positive' ? colors.positive : tone === 'negative' ? colors.negative : colors.text;
  return (
    <div style={{ background: colors.bg, border: `1px solid ${colors.border}`, padding: 16, borderRadius: 4 }}>
      <div style={sectionLabel}>{label}</div>
      <div style={{ fontFamily: '"IBM Plex Mono", monospace', fontSize: 28, color, marginTop: 8 }}>{value}</div>
      {note && <div style={{ color: colors.faint, fontSize: 11, marginTop: 4 }}>{note}</div>}
    </div>
  );
}

function Pill({ label, value, tone = 'default' }: { label: string; value: number; tone?: 'default' | 'positive' | 'negative' | 'accent' }) {
  const bg =
    tone === 'positive' ? colors.positiveSoft :
    tone === 'negative' ? colors.negativeSoft :
    tone === 'accent'   ? colors.accentSoft   : '#F0F0EE';
  const fg =
    tone === 'positive' ? colors.positive :
    tone === 'negative' ? colors.negative :
    tone === 'accent'   ? colors.accent   : colors.muted;
  return (
    <div style={{ background: bg, color: fg, padding: '8px 14px', borderRadius: 4, fontSize: 13, fontFamily: '"DM Sans", sans-serif' }}>
      {label}: <span style={{ fontFamily: '"IBM Plex Mono", monospace', fontWeight: 500 }}>{value}</span>
    </div>
  );
}

function Button({ label, onClick, disabled, loading, accent }: { label: string; onClick: () => void; disabled?: boolean; loading?: boolean; accent?: boolean }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        padding: '10px 18px',
        fontSize: 13,
        fontFamily: '"DM Sans", sans-serif',
        background: accent
          ? (hover && !disabled ? '#0F44B0' : colors.accent)
          : (hover && !disabled ? colors.accentSoft : colors.card),
        color: accent ? '#FFFFFF' : colors.text,
        border: `1px solid ${accent ? colors.accent : colors.border}`,
        borderRadius: 4,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.6 : 1,
        transition: 'background 150ms ease-out',
      }}
    >
      {loading ? '…' : label}
    </button>
  );
}

function fmtPct(v: number | null | undefined): string {
  if (v == null) return '—';
  const sign = v >= 0 ? '+' : '';
  return `${sign}${(v * 100).toFixed(1)}%`;
}
