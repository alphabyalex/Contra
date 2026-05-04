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

// ---------- in-memory store ------------------------------------------

const mem = {
  baskets: new Map<string, Basket>(),
  legs: new Map<string, Leg>(),
  positions: new Map<string, Position>(),
  leveraged: new Map<string, LeveragedPosition>(),
  nav: new Map<string, NavSnapshot>(),
  txs: new Map<string, Transaction>(),
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
}
