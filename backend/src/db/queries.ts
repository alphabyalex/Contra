/**
 * Centralised CRUD for every table. The pattern: try Supabase first via
 * `getSupabase()`; if it returns null, fall back to the in-memory store
 * defined below. This keeps `npm run dev` working with zero external
 * dependencies — the trade-off is that data resets on process restart.
 *
 * The in-memory store mirrors the relational schema as plain Maps. It is
 * deliberately ungenerous about features (no joins, no transactions) —
 * just enough for the frontend to render and for cron to write.
 */

import { randomUUID } from 'crypto';
import { getSupabase } from './supabase';

// ---------- types -----------------------------------------------------

export type BasketStatus = 'initializing' | 'active' | 'resolving' | 'finalized';
export type LeverageType = 'conservative' | 'aggressive' | 'degen';
export type LegSource = 'kalshi' | 'polymarket';
export type TxType =
  | 'deposit'
  | 'redeem'
  | 'exit'
  | 'leverage_open'
  | 'leverage_close'
  | 'liquidation'
  | 'resolve_leg'
  | 'finalize';

export interface Basket {
  id: string;
  name: string;
  description?: string | null;
  status: BasketStatus;
  leverage_type: LeverageType;
  category?: string | null;
  vault_pda?: string | null;
  contra_mint?: string | null;
  num_legs: number;
  final_payout_ratio?: number | null;
  created_at: string;
  activated_at?: string | null;
  finalized_at?: string | null;
}

export interface Leg {
  id: string;
  basket_id: string;
  leg_index: number;
  source: LegSource;
  market_id: string;
  question: string;
  outcome_label?: string | null;
  p_market_entry: number;
  p_model: number;
  edge: number;
  weight: number;
  outcome?: 0 | 1 | null;
  resolved_at?: string | null;
  created_at: string;
}

export interface Position {
  id: string;
  basket_id: string;
  wallet: string;
  tokens_held: number;
  usdc_deposited: number;
  entry_nav: number;
  entry_tx?: string | null;
  created_at: string;
  updated_at: string;
}

export interface LeveragedPosition {
  id: string;
  basket_id: string;
  wallet: string;
  position_pda?: string | null;
  collateral_usdc: number;
  debt_usdc: number;
  vault_tokens: number;
  leverage: number;
  health_factor: number;
  opened_at: string;
  closed_at?: string | null;
  closed_pnl_usdc?: number | null;
  liquidated: boolean;
}

export interface NavSnapshot {
  id: string;
  basket_id: string;
  nav: number;
  legs_resolved: number;
  snapshotted_at: string;
}

export interface Transaction {
  id: string;
  basket_id?: string | null;
  wallet: string;
  type: TxType;
  usdc_delta?: number | null;
  tokens_delta?: number | null;
  tx_signature: string;
  created_at: string;
}

export interface ScreenedMarket {
  id: string;
  condition_id: string;
  source: LegSource;
  question: string;
  p_market: number | null;
  impossible: boolean;
  already_resolved: boolean;
  ambiguous: boolean;
  excluded: boolean;
  exclusion_reason: string | null;
  screened_at: string;
  screening_model: string | null;
}

export interface ScoredMarket {
  id: string;
  condition_id: string;
  source: string;
  question: string;
  p_market: number;
  p_model: number | null;
  edge: number | null;
  volume: number | null;
  days_to_close: number | null;
  category: string | null;
  include_in_basket: boolean;
  scored_at: string;
  model_version: string | null;
  impossible_edge: boolean;
  // calibration_v2 layered fields
  adjusted_edge: number | null;
  time_factor: number | null;
  category_factor: number | null;
  volume_factor: number | null;
  // momentum prep (populated by daily 8am job once history exists)
  p_market_7d_ago: number | null;
  momentum: number | null;
  momentum_factor: number;
}

export interface TrackedMarket {
  id: string;
  condition_id: string;
  source: string;
  question: string;
  token_id: string | null;
  category: string | null;
  p_market_initial: number | null;
  p_model_initial: number | null;
  edge_initial: number | null;
  resolution_date: string | null;
  in_basket: boolean;
  outcome: 0 | 1 | null;
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface MarketPricePoint {
  id: string;
  condition_id: string;
  source: string;
  price: number;
  days_to_close: number | null;
  recorded_at: string;
}

export interface PredictionLogEntry {
  id: string;
  condition_id: string;
  source: string;
  question: string;
  p_market_at_entry: number;
  p_model_at_entry: number | null;
  edge_at_entry: number | null;
  basket_id: string | null;
  outcome: 0 | 1 | null;
  days_held: number | null;
  resolved_at: string | null;
  logged_at: string;
  model_version: string | null;
}

export interface PredictionLogStats {
  total: number;
  resolved: number;
  no_count: number;
  yes_count: number;
  hit_rate: number | null;
  avg_edge_winners: number | null;
  avg_edge_losers: number | null;
}

// ---------- in-memory store ------------------------------------------

const mem = {
  baskets: new Map<string, Basket>(),
  legs: new Map<string, Leg>(),
  positions: new Map<string, Position>(),
  leveraged: new Map<string, LeveragedPosition>(),
  nav: new Map<string, NavSnapshot>(),
  txs: new Map<string, Transaction>(),
  screened: new Map<string, ScreenedMarket>(),         // key: condition_id
  scored: new Map<string, ScoredMarket>(),             // key: condition_id
  predictions: new Map<string, PredictionLogEntry>(),  // key: id
  tracked: new Map<string, TrackedMarket>(),           // key: condition_id
  prices: new Map<string, MarketPricePoint[]>(),       // key: condition_id (newest last)
};

const nowIso = () => new Date().toISOString();

// ---------- baskets --------------------------------------------------

export async function createBasket(
  input: Omit<Basket, 'id' | 'created_at' | 'status'> & Partial<Pick<Basket, 'status' | 'id'>>,
): Promise<Basket> {
  const row: Basket = {
    id: input.id ?? randomUUID(),
    name: input.name,
    description: input.description ?? null,
    status: input.status ?? 'initializing',
    leverage_type: input.leverage_type,
    category: input.category ?? null,
    vault_pda: input.vault_pda ?? null,
    contra_mint: input.contra_mint ?? null,
    num_legs: input.num_legs,
    final_payout_ratio: input.final_payout_ratio ?? null,
    created_at: nowIso(),
    activated_at: input.activated_at ?? null,
    finalized_at: input.finalized_at ?? null,
  };

  const sb = getSupabase();
  if (sb) {
    const { data, error } = await sb.from('baskets').insert(row).select().single();
    if (error) throw error;
    return data as Basket;
  }
  mem.baskets.set(row.id, row);
  return row;
}

export async function listBaskets(filter: { status?: BasketStatus } = {}): Promise<Basket[]> {
  const sb = getSupabase();
  if (sb) {
    let q = sb.from('baskets').select('*').order('created_at', { ascending: false });
    if (filter.status) q = q.eq('status', filter.status);
    const { data, error } = await q;
    if (error) throw error;
    return (data ?? []) as Basket[];
  }
  return [...mem.baskets.values()]
    .filter((b) => !filter.status || b.status === filter.status)
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
}

export async function getBasket(id: string): Promise<Basket | null> {
  const sb = getSupabase();
  if (sb) {
    const { data, error } = await sb.from('baskets').select('*').eq('id', id).maybeSingle();
    if (error) throw error;
    return (data ?? null) as Basket | null;
  }
  return mem.baskets.get(id) ?? null;
}

export async function updateBasket(id: string, patch: Partial<Basket>): Promise<Basket | null> {
  const sb = getSupabase();
  if (sb) {
    const { data, error } = await sb.from('baskets').update(patch).eq('id', id).select().maybeSingle();
    if (error) throw error;
    return (data ?? null) as Basket | null;
  }
  const cur = mem.baskets.get(id);
  if (!cur) return null;
  const next = { ...cur, ...patch };
  mem.baskets.set(id, next);
  return next;
}

// ---------- legs -----------------------------------------------------

export async function insertLegs(legs: Omit<Leg, 'id' | 'created_at'>[]): Promise<Leg[]> {
  const rows: Leg[] = legs.map((l) => ({ ...l, id: randomUUID(), created_at: nowIso() }));
  const sb = getSupabase();
  if (sb) {
    const { data, error } = await sb.from('legs').insert(rows).select();
    if (error) throw error;
    return (data ?? []) as Leg[];
  }
  rows.forEach((r) => mem.legs.set(r.id, r));
  return rows;
}

export async function listLegs(basketId: string): Promise<Leg[]> {
  const sb = getSupabase();
  if (sb) {
    const { data, error } = await sb
      .from('legs')
      .select('*')
      .eq('basket_id', basketId)
      .order('leg_index');
    if (error) throw error;
    return (data ?? []) as Leg[];
  }
  return [...mem.legs.values()]
    .filter((l) => l.basket_id === basketId)
    .sort((a, b) => a.leg_index - b.leg_index);
}

export async function resolveLegRow(
  basketId: string,
  legIndex: number,
  outcome: 0 | 1,
): Promise<Leg | null> {
  const sb = getSupabase();
  if (sb) {
    const { data, error } = await sb
      .from('legs')
      .update({ outcome, resolved_at: nowIso() })
      .eq('basket_id', basketId)
      .eq('leg_index', legIndex)
      .select()
      .maybeSingle();
    if (error) throw error;
    return (data ?? null) as Leg | null;
  }
  const leg = [...mem.legs.values()].find(
    (l) => l.basket_id === basketId && l.leg_index === legIndex,
  );
  if (!leg) return null;
  leg.outcome = outcome;
  leg.resolved_at = nowIso();
  return leg;
}

// ---------- positions ------------------------------------------------

export async function upsertPosition(input: {
  basket_id: string;
  wallet: string;
  tokens_delta: number;
  usdc_delta: number;
  entry_nav?: number;
  entry_tx?: string;
}): Promise<Position> {
  const sb = getSupabase();
  if (sb) {
    const existing = await sb
      .from('positions')
      .select('*')
      .eq('basket_id', input.basket_id)
      .eq('wallet', input.wallet)
      .maybeSingle();
    if (existing.data) {
      const next = {
        tokens_held: Number(existing.data.tokens_held) + input.tokens_delta,
        usdc_deposited: Number(existing.data.usdc_deposited) + input.usdc_delta,
      };
      const { data, error } = await sb
        .from('positions')
        .update(next)
        .eq('id', existing.data.id)
        .select()
        .single();
      if (error) throw error;
      return data as Position;
    }
    const row = {
      id: randomUUID(),
      basket_id: input.basket_id,
      wallet: input.wallet,
      tokens_held: input.tokens_delta,
      usdc_deposited: input.usdc_delta,
      entry_nav: input.entry_nav ?? 1,
      entry_tx: input.entry_tx ?? null,
      created_at: nowIso(),
      updated_at: nowIso(),
    };
    const { data, error } = await sb.from('positions').insert(row).select().single();
    if (error) throw error;
    return data as Position;
  }

  const key = `${input.basket_id}:${input.wallet}`;
  const cur = mem.positions.get(key);
  if (cur) {
    cur.tokens_held += input.tokens_delta;
    cur.usdc_deposited += input.usdc_delta;
    cur.updated_at = nowIso();
    return cur;
  }
  const row: Position = {
    id: randomUUID(),
    basket_id: input.basket_id,
    wallet: input.wallet,
    tokens_held: input.tokens_delta,
    usdc_deposited: input.usdc_delta,
    entry_nav: input.entry_nav ?? 1,
    entry_tx: input.entry_tx ?? null,
    created_at: nowIso(),
    updated_at: nowIso(),
  };
  mem.positions.set(key, row);
  return row;
}

export async function listPositionsByWallet(wallet: string): Promise<Position[]> {
  const sb = getSupabase();
  if (sb) {
    const { data, error } = await sb.from('positions').select('*').eq('wallet', wallet);
    if (error) throw error;
    return (data ?? []) as Position[];
  }
  return [...mem.positions.values()].filter((p) => p.wallet === wallet);
}

// ---------- leveraged positions --------------------------------------

export async function insertLeveragedPosition(p: Omit<LeveragedPosition, 'id' | 'opened_at'>): Promise<LeveragedPosition> {
  const row: LeveragedPosition = { ...p, id: randomUUID(), opened_at: nowIso() };
  const sb = getSupabase();
  if (sb) {
    const { data, error } = await sb.from('leveraged_positions').insert(row).select().single();
    if (error) throw error;
    return data as LeveragedPosition;
  }
  mem.leveraged.set(row.id, row);
  return row;
}

export async function listLeveragedByWallet(wallet: string): Promise<LeveragedPosition[]> {
  const sb = getSupabase();
  if (sb) {
    const { data, error } = await sb.from('leveraged_positions').select('*').eq('wallet', wallet);
    if (error) throw error;
    return (data ?? []) as LeveragedPosition[];
  }
  return [...mem.leveraged.values()].filter((l) => l.wallet === wallet);
}

export async function listLiquidatablePositions(threshold = 1.15): Promise<LeveragedPosition[]> {
  const sb = getSupabase();
  if (sb) {
    const { data, error } = await sb
      .from('leveraged_positions')
      .select('*')
      .is('closed_at', null)
      .lt('health_factor', threshold);
    if (error) throw error;
    return (data ?? []) as LeveragedPosition[];
  }
  return [...mem.leveraged.values()].filter((l) => !l.closed_at && l.health_factor < threshold);
}

export async function updateLeveragedPosition(id: string, patch: Partial<LeveragedPosition>): Promise<LeveragedPosition | null> {
  const sb = getSupabase();
  if (sb) {
    const { data, error } = await sb
      .from('leveraged_positions')
      .update(patch)
      .eq('id', id)
      .select()
      .maybeSingle();
    if (error) throw error;
    return (data ?? null) as LeveragedPosition | null;
  }
  const cur = mem.leveraged.get(id);
  if (!cur) return null;
  const next = { ...cur, ...patch };
  mem.leveraged.set(id, next);
  return next;
}

// ---------- nav_snapshots --------------------------------------------

export async function insertNavSnapshot(s: Omit<NavSnapshot, 'id' | 'snapshotted_at'>): Promise<NavSnapshot> {
  const row: NavSnapshot = { ...s, id: randomUUID(), snapshotted_at: nowIso() };
  const sb = getSupabase();
  if (sb) {
    const { data, error } = await sb.from('nav_snapshots').insert(row).select().single();
    if (error) throw error;
    return data as NavSnapshot;
  }
  mem.nav.set(row.id, row);
  return row;
}

export async function listNavHistory(basketId: string, limit = 720): Promise<NavSnapshot[]> {
  const sb = getSupabase();
  if (sb) {
    const { data, error } = await sb
      .from('nav_snapshots')
      .select('*')
      .eq('basket_id', basketId)
      .order('snapshotted_at', { ascending: true })
      .limit(limit);
    if (error) throw error;
    return (data ?? []) as NavSnapshot[];
  }
  return [...mem.nav.values()]
    .filter((n) => n.basket_id === basketId)
    .sort((a, b) => a.snapshotted_at.localeCompare(b.snapshotted_at))
    .slice(-limit);
}

// ---------- transactions ---------------------------------------------

export async function recordTransaction(t: Omit<Transaction, 'id' | 'created_at'>): Promise<Transaction> {
  const row: Transaction = { ...t, id: randomUUID(), created_at: nowIso() };
  const sb = getSupabase();
  if (sb) {
    const { data, error } = await sb.from('transactions').insert(row).select().single();
    if (error) throw error;
    return data as Transaction;
  }
  mem.txs.set(row.id, row);
  return row;
}

export async function listTransactionsByWallet(wallet: string, limit = 100): Promise<Transaction[]> {
  const sb = getSupabase();
  if (sb) {
    const { data, error } = await sb
      .from('transactions')
      .select('*')
      .eq('wallet', wallet)
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) throw error;
    return (data ?? []) as Transaction[];
  }
  return [...mem.txs.values()]
    .filter((t) => t.wallet === wallet)
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .slice(0, limit);
}

// ---------- screened_markets -----------------------------------------

export async function getScreenedMarket(conditionId: string): Promise<ScreenedMarket | null> {
  const sb = getSupabase();
  if (sb) {
    const { data, error } = await sb
      .from('screened_markets')
      .select('*')
      .eq('condition_id', conditionId)
      .maybeSingle();
    if (error) throw error;
    return (data ?? null) as ScreenedMarket | null;
  }
  return mem.screened.get(conditionId) ?? null;
}

export async function getScreenedByConditionIds(ids: string[]): Promise<Map<string, ScreenedMarket>> {
  const out = new Map<string, ScreenedMarket>();
  if (ids.length === 0) return out;
  const sb = getSupabase();
  if (sb) {
    const { data, error } = await sb.from('screened_markets').select('*').in('condition_id', ids);
    if (error) throw error;
    for (const row of (data ?? []) as ScreenedMarket[]) out.set(row.condition_id, row);
    return out;
  }
  for (const id of ids) {
    const r = mem.screened.get(id);
    if (r) out.set(id, r);
  }
  return out;
}

export async function upsertScreenedMarket(
  row: Omit<ScreenedMarket, 'id' | 'screened_at' | 'screening_model'> & {
    id?: string;
    screened_at?: string;
    screening_model?: string | null;
  },
): Promise<ScreenedMarket> {
  const full: ScreenedMarket = {
    id: row.id ?? randomUUID(),
    condition_id: row.condition_id,
    source: row.source,
    question: row.question,
    p_market: row.p_market,
    impossible: row.impossible,
    already_resolved: row.already_resolved,
    ambiguous: row.ambiguous,
    excluded: row.excluded,
    exclusion_reason: row.exclusion_reason,
    screened_at: row.screened_at ?? nowIso(),
    screening_model: row.screening_model ?? 'claude-sonnet-4-20250514',
  };
  const sb = getSupabase();
  if (sb) {
    const { data, error } = await sb
      .from('screened_markets')
      .upsert(full, { onConflict: 'condition_id' })
      .select()
      .single();
    if (error) throw error;
    return data as ScreenedMarket;
  }
  mem.screened.set(full.condition_id, full);
  return full;
}

// ---------- scored_markets -------------------------------------------

export async function getScoredMarket(conditionId: string): Promise<ScoredMarket | null> {
  const sb = getSupabase();
  if (sb) {
    const { data, error } = await sb
      .from('scored_markets')
      .select('*')
      .eq('condition_id', conditionId)
      .maybeSingle();
    if (error) throw error;
    return (data ?? null) as ScoredMarket | null;
  }
  return mem.scored.get(conditionId) ?? null;
}

export async function getScoredByConditionIds(ids: string[]): Promise<Map<string, ScoredMarket>> {
  const out = new Map<string, ScoredMarket>();
  if (ids.length === 0) return out;
  const sb = getSupabase();
  if (sb) {
    const { data, error } = await sb.from('scored_markets').select('*').in('condition_id', ids);
    if (error) throw error;
    for (const row of (data ?? []) as ScoredMarket[]) out.set(row.condition_id, row);
    return out;
  }
  for (const id of ids) {
    const r = mem.scored.get(id);
    if (r) out.set(id, r);
  }
  return out;
}

export async function upsertScoredMarket(
  row: Partial<ScoredMarket> & {
    condition_id: string;
    source: string;
    question: string;
    p_market: number;
    include_in_basket: boolean;
  },
): Promise<ScoredMarket> {
  const full: ScoredMarket = {
    id: row.id ?? randomUUID(),
    condition_id: row.condition_id,
    source: row.source,
    question: row.question,
    p_market: row.p_market,
    p_model: row.p_model ?? null,
    edge: row.edge ?? null,
    volume: row.volume ?? null,
    days_to_close: row.days_to_close ?? null,
    category: row.category ?? null,
    include_in_basket: row.include_in_basket,
    scored_at: row.scored_at ?? nowIso(),
    model_version: row.model_version ?? 'calibration_v2',
    impossible_edge: row.impossible_edge ?? false,
    adjusted_edge: row.adjusted_edge ?? null,
    time_factor: row.time_factor ?? null,
    category_factor: row.category_factor ?? null,
    volume_factor: row.volume_factor ?? null,
    p_market_7d_ago: row.p_market_7d_ago ?? null,
    momentum: row.momentum ?? null,
    momentum_factor: row.momentum_factor ?? 1.0,
  };
  const sb = getSupabase();
  if (sb) {
    // Adaptive payload — keep stripping rejected columns and retry until
    // either the upsert succeeds or we run out of trim candidates. This
    // matters when calibration_v2 ALTER hasn't been run yet on Supabase.
    let payload: Record<string, unknown> = { ...full };
    let attempts = 0;
    while (attempts++ < 12) {
      const { data, error } = await sb
        .from('scored_markets')
        .upsert(payload, { onConflict: 'condition_id' })
        .select()
        .maybeSingle();
      if (!error) {
        return ({ ...full, ...(data ?? {}) }) as ScoredMarket;
      }
      const m = error.message?.match(/Could not find the '(\w+)' column/);
      if (m && m[1] in payload) {
        delete payload[m[1]];
        continue;
      }
      throw error;
    }
    throw new Error('upsertScoredMarket: too many schema mismatches');
  }
  mem.scored.set(full.condition_id, full);
  return full;
}

// ---------- prediction_log -------------------------------------------

export async function insertPredictionLog(
  entry: Omit<PredictionLogEntry, 'id' | 'logged_at' | 'model_version'> & {
    id?: string;
    logged_at?: string;
    model_version?: string | null;
  },
): Promise<PredictionLogEntry> {
  const row: PredictionLogEntry = {
    id: entry.id ?? randomUUID(),
    condition_id: entry.condition_id,
    source: entry.source,
    question: entry.question,
    p_market_at_entry: entry.p_market_at_entry,
    p_model_at_entry: entry.p_model_at_entry,
    edge_at_entry: entry.edge_at_entry,
    basket_id: entry.basket_id,
    outcome: entry.outcome,
    days_held: entry.days_held,
    resolved_at: entry.resolved_at,
    logged_at: entry.logged_at ?? nowIso(),
    model_version: entry.model_version ?? 'stub_v1',
  };
  const sb = getSupabase();
  if (sb) {
    const { data, error } = await sb.from('prediction_log').insert(row).select().single();
    if (error) throw error;
    return data as PredictionLogEntry;
  }
  mem.predictions.set(row.id, row);
  return row;
}

export async function getPredictionLogByBasket(basketId: string): Promise<PredictionLogEntry[]> {
  const sb = getSupabase();
  if (sb) {
    const { data, error } = await sb
      .from('prediction_log')
      .select('*')
      .eq('basket_id', basketId)
      .order('logged_at', { ascending: false });
    if (error) throw error;
    return (data ?? []) as PredictionLogEntry[];
  }
  return [...mem.predictions.values()]
    .filter((p) => p.basket_id === basketId)
    .sort((a, b) => b.logged_at.localeCompare(a.logged_at));
}

export async function getPredictionLogByConditionId(conditionId: string): Promise<PredictionLogEntry[]> {
  const sb = getSupabase();
  if (sb) {
    const { data, error } = await sb
      .from('prediction_log')
      .select('*')
      .eq('condition_id', conditionId)
      .order('logged_at', { ascending: false });
    if (error) throw error;
    return (data ?? []) as PredictionLogEntry[];
  }
  return [...mem.predictions.values()]
    .filter((p) => p.condition_id === conditionId)
    .sort((a, b) => b.logged_at.localeCompare(a.logged_at));
}

/**
 * Patch the outcome + resolved_at for every open prediction_log row that
 * shares a condition_id. Multiple rows may exist when the same market sits
 * in several baskets, so this updates all matching rows in one call.
 */
export async function updatePredictionOutcome(
  conditionId: string,
  outcome: 0 | 1,
  resolvedAt?: string,
): Promise<PredictionLogEntry[]> {
  const ts = resolvedAt ?? nowIso();
  const sb = getSupabase();
  if (sb) {
    const { data, error } = await sb
      .from('prediction_log')
      .update({ outcome, resolved_at: ts })
      .eq('condition_id', conditionId)
      .is('outcome', null)
      .select();
    if (error) throw error;
    return (data ?? []) as PredictionLogEntry[];
  }
  const updated: PredictionLogEntry[] = [];
  for (const row of mem.predictions.values()) {
    if (row.condition_id === conditionId && row.outcome == null) {
      row.outcome = outcome;
      row.resolved_at = ts;
      updated.push(row);
    }
  }
  return updated;
}

/**
 * Return every prediction_log row (resolved or open). Used by analytics
 * services that need per-row data — `getPredictionLogStats` aggregates,
 * this is the underlying list.
 */
export async function listPredictionLog(): Promise<PredictionLogEntry[]> {
  const sb = getSupabase();
  if (sb) {
    const { data, error } = await sb.from('prediction_log').select('*');
    if (error) throw error;
    return (data ?? []) as PredictionLogEntry[];
  }
  return [...mem.predictions.values()];
}

export async function getPredictionLogStats(): Promise<PredictionLogStats> {
  const sb = getSupabase();
  let rows: PredictionLogEntry[];
  if (sb) {
    const { data, error } = await sb.from('prediction_log').select('*');
    if (error) throw error;
    rows = (data ?? []) as PredictionLogEntry[];
  } else {
    rows = [...mem.predictions.values()];
  }

  const total = rows.length;
  const resolvedRows = rows.filter((r) => r.outcome === 0 || r.outcome === 1);
  const resolved = resolvedRows.length;
  const winners = resolvedRows.filter((r) => r.outcome === 0);   // NO = we win
  const losers = resolvedRows.filter((r) => r.outcome === 1);    // YES = we lose
  const no_count = winners.length;
  const yes_count = losers.length;
  const hit_rate = resolved > 0 ? no_count / resolved : null;

  const avg = (rs: PredictionLogEntry[]): number | null => {
    const vals = rs.map((r) => r.edge_at_entry).filter((v): v is number => v != null);
    if (vals.length === 0) return null;
    return vals.reduce((s, v) => s + v, 0) / vals.length;
  };

  return {
    total,
    resolved,
    no_count,
    yes_count,
    hit_rate,
    avg_edge_winners: avg(winners),
    avg_edge_losers: avg(losers),
  };
}

// ---------- listing helpers (used by analytics + admin) -------------

export async function listScreenedMarkets(): Promise<ScreenedMarket[]> {
  const sb = getSupabase();
  if (sb) {
    const { data, error } = await sb.from('screened_markets').select('*');
    if (error) throw error;
    return (data ?? []) as ScreenedMarket[];
  }
  return [...mem.screened.values()];
}

export async function listScoredMarkets(): Promise<ScoredMarket[]> {
  const sb = getSupabase();
  if (sb) {
    const { data, error } = await sb.from('scored_markets').select('*');
    if (error) throw error;
    return (data ?? []) as ScoredMarket[];
  }
  return [...mem.scored.values()];
}

export async function listRecentlyExcluded(limit = 10): Promise<ScreenedMarket[]> {
  const sb = getSupabase();
  if (sb) {
    const { data, error } = await sb
      .from('screened_markets')
      .select('*')
      .eq('excluded', true)
      .order('screened_at', { ascending: false })
      .limit(limit);
    if (error) throw error;
    return (data ?? []) as ScreenedMarket[];
  }
  return [...mem.screened.values()]
    .filter((s) => s.excluded)
    .sort((a, b) => b.screened_at.localeCompare(a.screened_at))
    .slice(0, limit);
}

export interface ScreenerSummary {
  total_tracked: number;
  total_screened: number;
  excluded: number;
  eligible: number;
  in_basket: number;
}

/**
 * Counts for the admin Screener Summary panel, fetched directly from the
 * source tables (not derived from the scanner route). Uses Supabase
 * head+count queries when available; falls back to the in-memory store.
 */
export async function getScreenerSummary(): Promise<ScreenerSummary> {
  const sb = getSupabase();
  if (sb) {
    const headCount = async (
      table: string,
      apply?: (q: any) => any,
    ): Promise<number> => {
      let q = sb.from(table).select('*', { count: 'exact', head: true });
      if (apply) q = apply(q);
      const { count, error } = await q;
      if (error) throw error;
      return count ?? 0;
    };
    const [total_tracked, total_screened, excluded, eligible, in_basket] = await Promise.all([
      headCount('tracked_markets'),
      headCount('screened_markets'),
      headCount('screened_markets', (q) => q.eq('excluded', true)),
      headCount('screened_markets', (q) => q.eq('excluded', false)),
      headCount('scored_markets', (q) => q.eq('include_in_basket', true)),
    ]);
    return { total_tracked, total_screened, excluded, eligible, in_basket };
  }

  const screenedArr = [...mem.screened.values()];
  return {
    total_tracked: mem.tracked.size,
    total_screened: screenedArr.length,
    excluded: screenedArr.filter((s) => s.excluded).length,
    eligible: screenedArr.filter((s) => !s.excluded).length,
    in_basket: [...mem.scored.values()].filter((s) => s.include_in_basket).length,
  };
}

// ---------- tracked_markets -----------------------------------------

export async function getTrackedMarket(conditionId: string): Promise<TrackedMarket | null> {
  const sb = getSupabase();
  if (sb) {
    const { data, error } = await sb
      .from('tracked_markets')
      .select('*')
      .eq('condition_id', conditionId)
      .maybeSingle();
    if (error) throw error;
    return (data ?? null) as TrackedMarket | null;
  }
  return mem.tracked.get(conditionId) ?? null;
}

export async function listTrackedMarkets(opts: { onlyOpen?: boolean } = {}): Promise<TrackedMarket[]> {
  const sb = getSupabase();
  if (sb) {
    let q = sb.from('tracked_markets').select('*');
    if (opts.onlyOpen) q = q.is('outcome', null);
    const { data, error } = await q;
    if (error) throw error;
    return (data ?? []) as TrackedMarket[];
  }
  let arr = [...mem.tracked.values()];
  if (opts.onlyOpen) arr = arr.filter((t) => t.outcome == null);
  return arr;
}

export async function listTrackedMarketsResolvingSoon(daysAhead = 7): Promise<TrackedMarket[]> {
  const cutoff = new Date(Date.now() + daysAhead * 24 * 60 * 60 * 1000).toISOString();
  const sb = getSupabase();
  if (sb) {
    const { data, error } = await sb
      .from('tracked_markets')
      .select('*')
      .is('outcome', null)
      .not('resolution_date', 'is', null)
      .lt('resolution_date', cutoff);
    if (error) throw error;
    return (data ?? []) as TrackedMarket[];
  }
  return [...mem.tracked.values()].filter(
    (t) => t.outcome == null && t.resolution_date != null && t.resolution_date < cutoff,
  );
}

export async function upsertTrackedMarket(
  row: Omit<TrackedMarket, 'id' | 'created_at' | 'updated_at'> & {
    id?: string;
    created_at?: string;
    updated_at?: string;
  },
): Promise<TrackedMarket> {
  const full: TrackedMarket = {
    id: row.id ?? randomUUID(),
    condition_id: row.condition_id,
    source: row.source,
    question: row.question,
    token_id: row.token_id,
    category: row.category,
    p_market_initial: row.p_market_initial,
    p_model_initial: row.p_model_initial,
    edge_initial: row.edge_initial,
    resolution_date: row.resolution_date,
    in_basket: row.in_basket,
    outcome: row.outcome,
    resolved_at: row.resolved_at,
    created_at: row.created_at ?? nowIso(),
    updated_at: row.updated_at ?? nowIso(),
  };
  const sb = getSupabase();
  if (sb) {
    // Build payload incrementally and retry on "column not found" by
    // stripping the offending field. The user's Supabase tracked_markets
    // schema has been observed to differ slightly from schema.sql
    // (e.g. missing `category` / `created_at` columns) so we trim what
    // PostgREST rejects rather than fail the whole insert.
    let payload: Record<string, unknown> = { ...full };
    let attempts = 0;
    while (attempts++ < 6) {
      const { data, error } = await sb
        .from('tracked_markets')
        .upsert(payload, { onConflict: 'condition_id' })
        .select()
        .maybeSingle();
      if (!error) {
        return ({ ...full, ...(data ?? {}) }) as TrackedMarket;
      }
      const m = error.message?.match(/Could not find the '(\w+)' column/);
      if (m && m[1] in payload) {
        delete payload[m[1]];
        continue;
      }
      throw error;
    }
    throw new Error('upsertTrackedMarket: too many schema mismatches');
  }
  mem.tracked.set(full.condition_id, full);
  return full;
}

export async function updateTrackedMarket(
  conditionId: string,
  patch: Partial<TrackedMarket>,
): Promise<TrackedMarket | null> {
  const sb = getSupabase();
  if (sb) {
    const { data, error } = await sb
      .from('tracked_markets')
      .update({ ...patch, updated_at: nowIso() })
      .eq('condition_id', conditionId)
      .select()
      .maybeSingle();
    if (error) throw error;
    return (data ?? null) as TrackedMarket | null;
  }
  const cur = mem.tracked.get(conditionId);
  if (!cur) return null;
  Object.assign(cur, patch, { updated_at: nowIso() });
  return cur;
}

// ---------- market_price_history ------------------------------------

export async function recordPricePoint(
  point: Omit<MarketPricePoint, 'id' | 'recorded_at' | 'source'> & {
    id?: string;
    recorded_at?: string;
    source?: string;
  },
): Promise<MarketPricePoint> {
  const row: MarketPricePoint = {
    id: point.id ?? randomUUID(),
    condition_id: point.condition_id,
    // market_price_history.source is NOT NULL in Supabase.
    source: point.source ?? 'polymarket',
    price: point.price,
    days_to_close: point.days_to_close,
    recorded_at: point.recorded_at ?? nowIso(),
  };
  const sb = getSupabase();
  if (sb) {
    const { data, error } = await sb.from('market_price_history').insert(row).select().single();
    if (error) throw error;
    return data as MarketPricePoint;
  }
  const arr = mem.prices.get(row.condition_id) ?? [];
  arr.push(row);
  mem.prices.set(row.condition_id, arr);
  return row;
}

export async function getLatestPricePoint(conditionId: string): Promise<MarketPricePoint | null> {
  const sb = getSupabase();
  if (sb) {
    const { data, error } = await sb
      .from('market_price_history')
      .select('*')
      .eq('condition_id', conditionId)
      .order('recorded_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    return (data ?? null) as MarketPricePoint | null;
  }
  const arr = mem.prices.get(conditionId);
  if (!arr || arr.length === 0) return null;
  return arr[arr.length - 1];
}

export async function getPriceHistory(conditionId: string): Promise<MarketPricePoint[]> {
  const sb = getSupabase();
  if (sb) {
    const { data, error } = await sb
      .from('market_price_history')
      .select('*')
      .eq('condition_id', conditionId)
      .order('recorded_at', { ascending: true });
    if (error) throw error;
    return (data ?? []) as MarketPricePoint[];
  }
  return (mem.prices.get(conditionId) ?? []).slice().sort((a, b) =>
    a.recorded_at.localeCompare(b.recorded_at),
  );
}

export async function deletePriceHistory(conditionId: string): Promise<number> {
  const sb = getSupabase();
  if (sb) {
    const { data, error } = await sb
      .from('market_price_history')
      .delete()
      .eq('condition_id', conditionId)
      .select('id');
    if (error) throw error;
    return (data ?? []).length;
  }
  const arr = mem.prices.get(conditionId);
  const n = arr?.length ?? 0;
  mem.prices.delete(conditionId);
  return n;
}

// ---------- helpers --------------------------------------------------

/**
 * Wipe the in-memory store. No-op when Supabase is configured. Used by
 * tests and seed scripts.
 */
export function __resetInMemory(): void {
  mem.baskets.clear();
  mem.legs.clear();
  mem.positions.clear();
  mem.leveraged.clear();
  mem.nav.clear();
  mem.txs.clear();
  mem.screened.clear();
  mem.scored.clear();
  mem.predictions.clear();
  mem.tracked.clear();
  mem.prices.clear();
}
