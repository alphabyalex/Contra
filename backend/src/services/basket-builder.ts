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
