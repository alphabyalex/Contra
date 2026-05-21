/**
 * Constructs diversified short baskets from scored mispricings.
 *
 * Steps:
 *   1. Filter to scored markets where `include` is true.
 *   2. Deduplicate textually similar markets (Jaccard similarity > 0.7
 *      on lowercased word sets — same event, different wording).
 *   3. Cap concentration: max 40% of basket weight in any single category.
 *   4. Take the top N by edge for the requested basket type.
 *   5. Assign weights: equal base, edge-adjusted bump, then re-normalise
 *      so weights sum to exactly 1.0 (1_000_000 in 1e6-scaled units, the
 *      contra_vault on-chain representation).
 *
 * The output is a `BasketProposal` ready for the on-chain init flow:
 *   admin → POST /api/admin/init-vault with this proposal.
 */

import type { ScoredMarket } from './mispricing';
import {
  createBasket,
  insertLegs,
  insertPredictionLog,
  listBaskets,
  listScoredMarkets,
  listScreenedMarkets,
  upsertTrackedMarket,
  updateTrackedMarket,
  type LeverageType as DbLeverageType,
} from '../db/queries';

export type LeverageType = 'conservative' | 'aggressive' | 'degen';

export interface BasketProposal {
  name: string;
  description: string;
  leverageType: LeverageType;
  category: string;
  legs: Array<{
    legIndex: number;
    source: 'kalshi' | 'polymarket';
    marketId: string;
    question: string;
    outcomeLabel: string;
    pMarketEntry: number;
    pModel: number;
    edge: number;
    weight: number;             // 0..1
    weightScaled: number;       // 1e6 scale, sums to 1_000_000
    pMarketScaled: number;      // 1e6 scale
  }>;
}

const MAX_CATEGORY_FRACTION = 0.40;
const WEIGHT_TOTAL_SCALED = 1_000_000;
const PRICE_SCALE = 1_000_000;

const SIZE_BY_TYPE: Record<LeverageType, { min: number; target: number; max: number }> = {
  conservative: { min: 100, target: 142, max: 200 },
  aggressive:   { min: 20,  target: 35,  max: 50  },
  degen:        { min: 5,   target: 7,   max: 10  },
};

function tokenize(s: string): Set<string> {
  return new Set(
    s.toLowerCase()
     .replace(/[^a-z0-9 ]/g, ' ')
     .split(/\s+/)
     .filter((t) => t.length > 2),
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

function dedupe(scored: ScoredMarket[], threshold = 0.7): ScoredMarket[] {
  const kept: { m: ScoredMarket; toks: Set<string> }[] = [];
  for (const m of scored) {
    const toks = tokenize(m.question);
    const dup = kept.find((k) => jaccard(k.toks, toks) >= threshold);
    if (!dup) kept.push({ m, toks });
  }
  return kept.map((k) => k.m);
}

function categoryCap(scored: ScoredMarket[], maxPerCat: number): ScoredMarket[] {
  const counts = new Map<string, number>();
  const out: ScoredMarket[] = [];
  for (const m of scored) {
    const c = (m.category ?? 'other').toLowerCase();
    const seen = counts.get(c) ?? 0;
    if (seen >= maxPerCat) continue;
    counts.set(c, seen + 1);
    out.push(m);
  }
  return out;
}

export function buildBasket(
  scored: ScoredMarket[],
  leverageType: LeverageType,
  opts: { name?: string; category?: string } = {},
): BasketProposal | null {
  const sized = SIZE_BY_TYPE[leverageType];
  const eligible = scored.filter((s) => s.include);
  const deduped = dedupe(eligible);
  const maxPerCat = Math.max(2, Math.floor(sized.target * MAX_CATEGORY_FRACTION));
  const capped = categoryCap(deduped, maxPerCat);
  const chosen = capped.slice(0, sized.target);

  if (chosen.length < sized.min) {
    return null; // not enough quality candidates
  }

  // Weight assignment: equal base + edge bump.
  const baseWeight = 1 / chosen.length;
  const totalEdge = chosen.reduce((s, m) => s + m.edge, 0);
  const raw = chosen.map((m) => baseWeight * 0.6 + (m.edge / Math.max(totalEdge, 1e-9)) * 0.4);
  const sum = raw.reduce((a, b) => a + b, 0);
  const weights = raw.map((w) => w / sum);

  // Scale to integers and force exact sum = WEIGHT_TOTAL_SCALED
  const scaled = weights.map((w) => Math.round(w * WEIGHT_TOTAL_SCALED));
  let drift = WEIGHT_TOTAL_SCALED - scaled.reduce((a, b) => a + b, 0);
  // Distribute drift one unit at a time onto the largest legs.
  const order = scaled.map((_, i) => i).sort((a, b) => scaled[b] - scaled[a]);
  let i = 0;
  while (drift !== 0) {
    const idx = order[i % order.length];
    scaled[idx] += drift > 0 ? 1 : -1;
    drift += drift > 0 ? -1 : 1;
    i++;
  }

  const legs = chosen.map((m, idx) => ({
    legIndex: idx,
    source: m.source,
    marketId: m.marketId,
    question: m.question,
    outcomeLabel: m.outcomeLabel,
    pMarketEntry: m.pMarket,
    pModel: m.pModel,
    edge: m.edge,
    weight: scaled[idx] / WEIGHT_TOTAL_SCALED,
    weightScaled: scaled[idx],
    pMarketScaled: Math.max(1, Math.min(PRICE_SCALE - 1, Math.round(m.pMarket * PRICE_SCALE))),
  }));

  const stamp = new Date().toISOString().slice(0, 10);
  return {
    name: opts.name ?? `${capitalize(leverageType)} Short ${stamp}`,
    description:
      `Auto-constructed ${leverageType} short basket — ${legs.length} legs, ` +
      `avg edge ${(legs.reduce((s, l) => s + l.edge, 0) / legs.length).toFixed(3)}.`,
    leverageType,
    category: opts.category ?? 'mixed',
    legs,
  };
}

function capitalize(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// =====================================================================
// CTRA basket engine (calibration_v1)
// =====================================================================
//
// Two basket types:
//   short term — odd CTRA numbers, legs resolve in 0..90 days
//   mid term   — even CTRA numbers, legs resolve in 91..180 days
//
// Naming: CTRA-01 / CTRA-02 / CTRA-03 ... incremented by 2 to keep parity.
// Leverage variants append -2X / -3X to the same base name; this builder
// only emits the 1X base — the leverage tx flow handles the variants.
// =====================================================================

export type BasketType = 'short' | 'mid' | 'long';

export interface BasketDefinition {
  name: string;                       // e.g. "CTRA-03"
  type: BasketType;
  description: string;
  legs: BasketLeg[];
  weights: Record<string, number>;    // condition_id → weight (sums to ~1.0)
  category_breakdown: Record<string, number>;
  avg_edge: number;
  impossible_count: number;
  resolution_window_days: { min: number; max: number };
}

export interface BasketLeg {
  legIndex: number;
  source: string;
  conditionId: string;
  question: string;
  category: string;
  pMarket: number;
  pModel: number;
  edge: number;
  weight: number;          // 0..1
  weightScaled: number;    // 1e6 scale
  pMarketScaled: number;   // 1e6 scale
  endDateIso: string | null;
  daysToClose: number | null;
  impossible: boolean;
  tokenId: string | null;
}

export const SHORT_WINDOW_DAYS = { min: 0,  max: 90  };
export const MID_WINDOW_DAYS   = { min: 91, max: 180 };
export const MAX_LEGS_PER_CATEGORY = 15;
export const TARGET_LEG_COUNT = 50;
export const MIN_LEG_COUNT = 20;
export const IMPOSSIBLE_WEIGHT_CAP = 0.03;

const POLITICS_KEYWORDS = ['election','president','congress','senate','vote','government','minister','party'];
const MACRO_KEYWORDS    = ['fed','rate','inflation','gdp','recession','economy','unemployment','treasury'];
const CRYPTO_KEYWORDS   = ['bitcoin','btc','ethereum','eth','crypto','blockchain','solana','token','defi'];
const SPORTS_KEYWORDS   = ['win','championship','nba','nfl','mlb','nhl','cup','tournament','league','player'];
const CULTURE_KEYWORDS  = ['oscar','grammy','award','movie','music','actor','album','box office'];

export function classifyCategory(question: string): string {
  const q = question.toLowerCase();
  const hit = (kws: string[]) => kws.some((k) => q.includes(k));
  if (hit(POLITICS_KEYWORDS)) return 'politics';
  if (hit(MACRO_KEYWORDS))    return 'macro';
  if (hit(CRYPTO_KEYWORDS))   return 'crypto';
  if (hit(SPORTS_KEYWORDS))   return 'sports';
  if (hit(CULTURE_KEYWORDS))  return 'culture';
  return 'other';
}

/**
 * Find the next CTRA number for a given basket type. Short term gets odd
 * numbers, mid term gets even. We scan all existing baskets named
 * `CTRA-NN`, take the max number of the matching parity, and add 2.
 *
 * If no baskets exist yet:
 *   short → CTRA-01
 *   mid   → CTRA-02
 */
export async function nextCtraNumber(type: BasketType): Promise<number> {
  const all = await listBaskets();
  const wantOdd = type === 'short';
  let max = 0;
  for (const b of all) {
    const m = b.name.match(/^CTRA-(\d+)/i);
    if (!m) continue;
    const n = parseInt(m[1], 10);
    if (Number.isNaN(n)) continue;
    const isOdd = n % 2 === 1;
    if (isOdd === wantOdd && n > max) max = n;
  }
  return max === 0 ? (wantOdd ? 1 : 2) : max + 2;
}

interface ScoredWithMeta {
  scored: import('../db/queries').ScoredMarket;
  endDateIso: string | null;
  daysToClose: number | null;
  category: string;
  impossible: boolean;
  tokenId: string | null;
}

async function loadBasketCandidates(): Promise<ScoredWithMeta[]> {
  const [scoredAll, screenedAll] = await Promise.all([
    listScoredMarkets(),
    listScreenedMarkets(),
  ]);
  const screenedById = new Map(screenedAll.map((s) => [s.condition_id, s]));

  // tracked_markets has the resolution_date + token_id for everything
  // touched by the screener. Pull lazily so basket construction works
  // even when the table is empty (early in dev).
  let trackedById = new Map<string, import('../db/queries').TrackedMarket>();
  try {
    const { listTrackedMarkets } = await import('../db/queries');
    const t = await listTrackedMarkets();
    trackedById = new Map(t.map((tm) => [tm.condition_id, tm]));
  } catch (e) {
    console.warn('[basket-builder] tracked_markets unavailable:', (e as Error).message);
  }

  const now = Date.now();
  return scoredAll
    .filter((s) => s.include_in_basket || s.impossible_edge)
    .map((s) => {
      const tracked = trackedById.get(s.condition_id);
      const endIso = tracked?.resolution_date ?? null;
      const daysToClose = endIso ? Math.max(0, (Date.parse(endIso) - now) / 86_400_000) : null;
      const screened = screenedById.get(s.condition_id);
      const impossible = Boolean(s.impossible_edge || screened?.impossible);
      return {
        scored: s,
        endDateIso: endIso,
        daysToClose: daysToClose != null ? Math.round(daysToClose) : null,
        category: s.category ?? classifyCategory(s.question),
        impossible,
        tokenId: tracked?.token_id ?? null,
      };
    });
}

function pickEvenSpread<T>(rows: T[], target: number, sortKey: (r: T) => number): T[] {
  if (rows.length <= target) return rows;
  const sorted = [...rows].sort((a, b) => sortKey(a) - sortKey(b));
  const step = sorted.length / target;
  const out: T[] = [];
  for (let i = 0; i < target; i++) {
    const idx = Math.min(sorted.length - 1, Math.floor(i * step));
    out.push(sorted[idx]);
  }
  return out;
}

/**
 * Construct a basket definition WITHOUT persisting. Returns null if too
 * few eligible legs (< MIN_LEG_COUNT) — caller should log + skip.
 */
export async function constructBasket(type: BasketType): Promise<BasketDefinition | null> {
  const window = type === 'short' ? SHORT_WINDOW_DAYS : MID_WINDOW_DAYS;
  const candidates = await loadBasketCandidates();

  // Only keep candidates with a known resolution window that fits.
  const inWindow = candidates.filter((c) => {
    if (c.daysToClose == null) return false;
    return c.daysToClose >= window.min && c.daysToClose <= window.max;
  });

  // Sort: impossibles first (highest conviction), then by edge descending.
  inWindow.sort((a, b) => {
    if (a.impossible !== b.impossible) return a.impossible ? -1 : 1;
    return (b.scored.edge ?? 0) - (a.scored.edge ?? 0);
  });

  // Category cap.
  const counts: Record<string, number> = {};
  const capped: ScoredWithMeta[] = [];
  for (const c of inWindow) {
    const cat = c.category;
    counts[cat] = counts[cat] ?? 0;
    if (counts[cat] >= MAX_LEGS_PER_CATEGORY) continue;
    counts[cat] += 1;
    capped.push(c);
  }

  if (capped.length < MIN_LEG_COUNT) {
    console.warn(
      `[basket-builder] only ${capped.length} eligible legs for ${type} basket (need ${MIN_LEG_COUNT}+). Skipping.`,
    );
    return null;
  }

  // Take target count. For short term, spread across the resolution window
  // (don't pick all legs that resolve in the last week of the window).
  const chosen =
    type === 'short'
      ? pickEvenSpread(capped, Math.min(TARGET_LEG_COUNT, capped.length), (r) => r.daysToClose ?? 0)
      : capped.slice(0, Math.min(TARGET_LEG_COUNT, capped.length));

  // Re-sort the chosen set by edge descending so leg_index is stable
  // (impossibles first when present).
  chosen.sort((a, b) => {
    if (a.impossible !== b.impossible) return a.impossible ? -1 : 1;
    return (b.scored.edge ?? 0) - (a.scored.edge ?? 0);
  });

  // Weights: equal base, impossibles capped at 3%.
  const N = chosen.length;
  const equalWeight = 1 / N;
  const rawWeights = chosen.map((c) =>
    c.impossible ? Math.min(IMPOSSIBLE_WEIGHT_CAP, equalWeight) : equalWeight,
  );
  const sum = rawWeights.reduce((a, b) => a + b, 0);
  const weights = rawWeights.map((w) => w / sum);

  // Scale to integers, force exact sum = 1_000_000 by drift redistribution.
  const scaled = weights.map((w) => Math.round(w * WEIGHT_TOTAL_SCALED));
  let drift = WEIGHT_TOTAL_SCALED - scaled.reduce((a, b) => a + b, 0);
  const order = scaled.map((_, i) => i).sort((a, b) => scaled[b] - scaled[a]);
  let i = 0;
  while (drift !== 0) {
    const idx = order[i % order.length];
    scaled[idx] += drift > 0 ? 1 : -1;
    drift += drift > 0 ? -1 : 1;
    i += 1;
  }

  const legs: BasketLeg[] = chosen.map((c, idx) => ({
    legIndex: idx,
    source: c.scored.source,
    conditionId: c.scored.condition_id,
    question: c.scored.question,
    category: c.category,
    pMarket: c.scored.p_market,
    pModel: c.scored.p_model ?? 0,
    edge: c.scored.edge ?? 0,
    weight: scaled[idx] / WEIGHT_TOTAL_SCALED,
    weightScaled: scaled[idx],
    pMarketScaled: Math.max(1, Math.min(PRICE_SCALE - 1, Math.round(c.scored.p_market * PRICE_SCALE))),
    endDateIso: c.endDateIso,
    daysToClose: c.daysToClose,
    impossible: c.impossible,
    tokenId: c.tokenId,
  }));

  const num = await nextCtraNumber(type);
  const name = `CTRA-${String(num).padStart(2, '0')}`;
  const breakdown: Record<string, number> = {};
  for (const l of legs) breakdown[l.category] = (breakdown[l.category] ?? 0) + 1;
  const avgEdge = legs.reduce((s, l) => s + l.edge, 0) / legs.length;
  const impossibleCount = legs.filter((l) => l.impossible).length;

  return {
    name,
    type,
    description:
      `${type === 'short' ? 'Short' : 'Mid'}-term CTRA basket — ${legs.length} legs, ` +
      `avg edge ${avgEdge.toFixed(3)}, ${impossibleCount} impossibles.`,
    legs,
    weights: Object.fromEntries(legs.map((l) => [l.conditionId, l.weight])),
    category_breakdown: breakdown,
    avg_edge: avgEdge,
    impossible_count: impossibleCount,
    resolution_window_days: window,
  };
}

// =====================================================================
// Long basket — underpriced favorites (tournament + non-tournament)
// =====================================================================

/**
 * Build a YES-position long basket from markets whose model says they're
 * underpriced. Tournament favorites with normalized raw_edge < 0 are the
 * primary source; non-tournament markets with explicit signal='long' or
 * 'strong_long' fill in.
 *
 * Output uses the same BasketLeg structure as the short builder so the
 * on-chain init flow stays uniform, but each leg's pMarketEntry is the
 * normalized (vig-removed) probability when available — we want the long
 * basket to track the model's view of fair price, not the raw market mid.
 */
export async function constructLongBasket(): Promise<BasketDefinition | null> {
  // 1. In-DB long candidates (signal='long' or 'strong_long')
  const scored = await listScoredMarkets();
  const dbCandidates = scored.filter((s) => {
    const sig = (s as any).signal as string | undefined;
    const rawEdge = Number((s as any).raw_edge ?? s.edge ?? 0);
    return sig === 'long' || sig === 'strong_long' || rawEdge < -0.01;
  });

  // 2. Tournament favorites from the ephemeral cache populated by the
  //    most recent applyTournamentNormalization run.
  const { getTournamentFavorites } = await import('./ml-scorer');
  const favorites = getTournamentFavorites();

  interface LongCandidate {
    conditionId: string;
    source: string;
    question: string;
    category: string;
    pMarket: number;
    normalizedPMarket: number | null;
    pModel: number;
    rawEdge: number;
    daysToClose: number | null;
  }

  const candidates: LongCandidate[] = [
    ...dbCandidates.map((s) => ({
      conditionId: s.condition_id,
      source: s.source,
      question: s.question,
      category: s.category ?? classifyCategory(s.question),
      pMarket: Number(s.p_market ?? 0),
      normalizedPMarket: (s as any).normalized_p_market != null ? Number((s as any).normalized_p_market) : null,
      pModel: Number(s.p_model ?? 0),
      rawEdge: Number((s as any).raw_edge ?? s.edge ?? 0),
      daysToClose: s.days_to_close,
    })),
    ...favorites.map((f) => ({
      conditionId: f.condition_id,
      source: f.source,
      question: f.question,
      category: f.category,
      pMarket: f.p_market,
      normalizedPMarket: f.normalized_p_market,
      pModel: f.p_model,
      rawEdge: f.raw_edge,
      daysToClose: f.days_to_close,
    })),
  ];

  if (candidates.length === 0) return null;

  // Sort by most negative raw_edge first (most underpriced) and apply
  // the same category cap as the short builder. Long basket doesn't enforce
  // a resolution window — favorites span tournament dates.
  const sorted = [...candidates].sort((a, b) => a.rawEdge - b.rawEdge);
  const counts: Record<string, number> = {};
  const capped: LongCandidate[] = [];
  for (const c of sorted) {
    const cat = c.category ?? 'other';
    counts[cat] = counts[cat] ?? 0;
    if (counts[cat] >= MAX_LEGS_PER_CATEGORY) continue;
    counts[cat] += 1;
    capped.push(c);
  }

  if (capped.length < Math.min(MIN_LEG_COUNT, 5)) return null;

  const chosen = capped.slice(0, TARGET_LEG_COUNT);
  const N = chosen.length;
  const equalWeight = 1 / N;
  const scaled = chosen.map(() => Math.round(equalWeight * WEIGHT_TOTAL_SCALED));
  let drift = WEIGHT_TOTAL_SCALED - scaled.reduce((a, b) => a + b, 0);
  let i = 0;
  while (drift !== 0) {
    scaled[i % N] += drift > 0 ? 1 : -1;
    drift += drift > 0 ? -1 : 1;
    i += 1;
  }

  const legs: BasketLeg[] = chosen.map((c, idx) => {
    const entryP = c.normalizedPMarket ?? c.pMarket;
    return {
      legIndex: idx,
      source: c.source,
      conditionId: c.conditionId,
      question: c.question,
      category: c.category,
      pMarket: entryP,
      pModel: c.pModel,
      edge: c.rawEdge,
      weight: scaled[idx] / WEIGHT_TOTAL_SCALED,
      weightScaled: scaled[idx],
      pMarketScaled: Math.max(1, Math.min(PRICE_SCALE - 1, Math.round(entryP * PRICE_SCALE))),
      endDateIso: null,
      daysToClose: c.daysToClose,
      impossible: false,
      tokenId: null,
    };
  });

  const num = await nextCtraNumber('mid'); // long baskets reuse the even sequence
  const name = `CTRA-L${String(num).padStart(2, '0')}`;
  const breakdown: Record<string, number> = {};
  for (const l of legs) breakdown[l.category] = (breakdown[l.category] ?? 0) + 1;
  const avgEdge = legs.reduce((s, l) => s + l.edge, 0) / legs.length;

  return {
    name,
    type: 'long',
    description:
      `Long basket — ${legs.length} underpriced markets, avg edge ${avgEdge.toFixed(3)} ` +
      `(negative = underpriced from the model's view).`,
    legs,
    weights: Object.fromEntries(legs.map((l) => [l.conditionId, l.weight])),
    category_breakdown: breakdown,
    avg_edge: avgEdge,
    impossible_count: 0,
    resolution_window_days: { min: 0, max: 730 }, // tournaments can be 6-18 months out
  };
}

/**
 * Persist a basket: writes baskets row + legs rows + prediction_log
 * entries + flips tracked_markets.in_basket. Returns the new basket_id.
 */
export async function seedBasket(definition: BasketDefinition): Promise<string> {
  // Map our 'short'/'mid'/'long' naming to the existing leverage_type column.
  // The on-chain side doesn't know about long; the column is just a tag.
  const leverageType: DbLeverageType =
    definition.type === 'short' ? 'aggressive' :
    definition.type === 'long'  ? 'aggressive' :
    'conservative';

  const basket = await createBasket({
    name: definition.name,
    description: definition.description,
    leverage_type: leverageType,
    category: 'mixed',
    num_legs: definition.legs.length,
  });

  await insertLegs(
    definition.legs.map((l) => ({
      basket_id: basket.id,
      leg_index: l.legIndex,
      source: l.source as 'kalshi' | 'polymarket',
      market_id: l.conditionId,
      question: l.question,
      outcome_label: 'YES',
      p_market_entry: l.pMarket,
      p_model: l.pModel,
      edge: l.edge,
      weight: l.weight,
    })),
  );

  // Mirror legs into prediction_log + flip tracked_markets.in_basket.
  for (const l of definition.legs) {
    try {
      await insertPredictionLog({
        condition_id: l.conditionId,
        source: l.source,
        question: l.question,
        p_market_at_entry: l.pMarket,
        p_model_at_entry: l.pModel,
        edge_at_entry: l.edge,
        basket_id: basket.id,
        outcome: null,
        days_held: null,
        resolved_at: null,
      });
    } catch (e) {
      console.warn(`[basket-builder] prediction_log insert failed for ${l.conditionId}: ${(e as Error).message}`);
    }
    try {
      const existing = await updateTrackedMarket(l.conditionId, { in_basket: true });
      if (!existing) {
        await upsertTrackedMarket({
          condition_id: l.conditionId,
          source: l.source,
          question: l.question,
          token_id: l.tokenId,
          category: l.category,
          p_market_initial: l.pMarket,
          p_model_initial: l.pModel,
          edge_initial: l.edge,
          resolution_date: l.endDateIso,
          in_basket: true,
          outcome: null,
          resolved_at: null,
        });
      }
    } catch (e) {
      console.warn(`[basket-builder] tracked_markets update failed for ${l.conditionId}: ${(e as Error).message}`);
    }
  }

  return basket.id;
}

// ---------------------------------------------------------------------
// Auto-rotation
// ---------------------------------------------------------------------

const ROTATION_LEAD_DAYS = 14;

export interface AutoRotationResult {
  basket: string;
  type: BasketType;
  daysUntilLastLeg: number;
  proposed: BasketDefinition | null;
}

export async function checkAutoRotation(): Promise<AutoRotationResult[]> {
  const baskets = await listBaskets({ status: 'active' });
  const out: AutoRotationResult[] = [];
  const now = Date.now();

  // Group existing baskets by type so we know if a successor already exists.
  const existingByType: Record<BasketType, number[]> = { short: [], mid: [] };
  for (const b of baskets) {
    const m = b.name.match(/^CTRA-(\d+)/i);
    if (!m) continue;
    const n = parseInt(m[1], 10);
    if (Number.isNaN(n)) continue;
    const t: BasketType = n % 2 === 1 ? 'short' : 'mid';
    existingByType[t].push(n);
  }

  // For each basket, find the latest leg endDate via tracked_markets.
  let trackedById = new Map<string, import('../db/queries').TrackedMarket>();
  try {
    const { listTrackedMarkets, listLegs } = await import('../db/queries');
    const t = await listTrackedMarkets();
    trackedById = new Map(t.map((tm) => [tm.condition_id, tm]));

    for (const b of baskets) {
      const m = b.name.match(/^CTRA-(\d+)/i);
      if (!m) continue;
      const n = parseInt(m[1], 10);
      const type: BasketType = n % 2 === 1 ? 'short' : 'mid';
      const legs = await listLegs(b.id);
      let latestMs = 0;
      for (const leg of legs) {
        const tm = trackedById.get(leg.market_id);
        if (!tm?.resolution_date) continue;
        const t = Date.parse(tm.resolution_date);
        if (!Number.isNaN(t) && t > latestMs) latestMs = t;
      }
      if (latestMs === 0) continue;
      const days = Math.round((latestMs - now) / 86_400_000);
      if (days > ROTATION_LEAD_DAYS) continue;

      // Successor already exists?
      const successor = existingByType[type].find((x) => x > n);
      if (successor) continue;

      const proposed = await constructBasket(type);
      out.push({ basket: b.name, type, daysUntilLastLeg: days, proposed });
      console.info(
        `[auto-rotation] ${b.name} nearing expiry (${days}d); next ${type} basket ready: ${
          proposed ? `${proposed.name} (${proposed.legs.length} legs, avg edge ${proposed.avg_edge.toFixed(3)})` : 'INSUFFICIENT_LEGS'
        }`,
      );
    }
  } catch (e) {
    console.warn('[auto-rotation] failed:', (e as Error).message);
  }
  return out;
}
