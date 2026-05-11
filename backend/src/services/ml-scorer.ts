/**
 * ML scorer — calibration_v2 (layered).
 *
 * Pipeline (per market):
 *   Layer 1  base calibration  → p_model from 11-bucket lookup
 *                                 base_edge = p_market - p_model
 *   Layer 2  hard exclusion    → days < 3 / days > 365 / volume < 100k
 *                                 → edge = 0, include = false, stop
 *   Layer 3  time factor       → 1.20 / 1.00 / 0.80 / 0.50
 *   Layer 4  category factor   → 1.20 sports, 1.10 politics+culture,
 *                                0.90 macro, 0.95 crypto, 1.00 other
 *   Layer 5  volume factor     → 0.90 / 1.00 / 1.05
 *   Layer 6  impossible override
 *                                 p_model = 0, base_edge = p_market,
 *                                 skip category factor, include if
 *                                 adjusted_edge >= 0.02
 *
 *   adjusted_edge = base_edge × time_factor × category_factor × volume_factor
 *                   × momentum_factor (default 1.0; updated by daily job)
 *
 * Inclusion gate (after layers):
 *   adjusted_edge >= 0.03 AND p_market in [0.02, 0.12] AND not excluded.
 */

import {
  upsertScoredMarket,
  type ScreenedMarket,
  type ScoredMarket,
} from '../db/queries';

interface CalibrationBucket {
  min: number;
  max: number;          // half-open: [min, max)
  p_model: number;
  n: number;
}

export const CALIBRATION_TABLE: CalibrationBucket[] = [
  { min: 0.00, max: 0.02, p_model: 0.0017, n: 1150 },
  { min: 0.02, max: 0.05, p_model: 0.0081, n: 371 },
  { min: 0.05, max: 0.10, p_model: 0.0174, n: 287 },
  { min: 0.10, max: 0.15, p_model: 0.0212, n: 189 },
  { min: 0.15, max: 0.20, p_model: 0.0932, n: 161 },
  { min: 0.20, max: 0.30, p_model: 0.1140, n: 193 },
  { min: 0.30, max: 0.50, p_model: 0.2523, n: 321 },
  { min: 0.50, max: 0.70, p_model: 0.4681, n: 722 },
  { min: 0.70, max: 0.80, p_model: 0.6460, n: 113 },
  { min: 0.80, max: 0.90, p_model: 0.7712, n: 118 },
  { min: 0.90, max: 1.01, p_model: 0.9182, n: 685 },
];

export const MODEL_VERSION = 'calibration_v2';

// Inclusion gate (post-layered).
export const EDGE_INCLUDE_THRESHOLD = 0.03;
export const IMPOSSIBLE_INCLUDE_THRESHOLD = 0.02;
export const P_MARKET_INCLUDE_MIN = 0.02;
export const P_MARKET_INCLUDE_MAX = 0.12;

// Hard exclusion thresholds (Layer 2).
export const MIN_DAYS_TO_CLOSE = 3;
export const MAX_DAYS_TO_CLOSE = 365;
export const MIN_VOLUME_USD = 100_000;

// ---------------------------------------------------------------------
// Pure layer functions
// ---------------------------------------------------------------------

export function getPModel(p_market: number): number {
  if (!Number.isFinite(p_market)) return 0;
  if (p_market >= 1.0) return 1.0;
  if (p_market <= 0.0) return 0.0;
  for (const b of CALIBRATION_TABLE) {
    if (p_market >= b.min && p_market < b.max) return b.p_model;
  }
  return CALIBRATION_TABLE[CALIBRATION_TABLE.length - 1].p_model;
}

export function getEdge(p_market: number, p_model: number): number {
  return p_market - p_model;
}

export function getTimeFactor(days: number | null): number {
  if (days == null) return 1.0;
  if (days < 7) return 1.20;       // technically excluded by Layer 2 below 3
  if (days <= 30) return 1.20;
  if (days <= 90) return 1.00;
  if (days <= 180) return 0.80;
  return 0.50;                     // 180-365; >365 excluded by Layer 2
}

const POLITICS_KEYWORDS = [
  'election','president','congress','senate','vote','government','minister','party',
  'democrat','republican','primary','nominee','nomination','governor','mayor',
  'parliament','chancellor','prime',
];
const MACRO_KEYWORDS = [
  'fed','rate','inflation','gdp','recession','economy','unemployment','treasury',
  'interest','monetary','fiscal','debt','deficit','tariff','trade','market cap',
  'stock','index',
];
const CRYPTO_KEYWORDS = [
  'bitcoin','btc','ethereum','eth','crypto','blockchain','solana','token','defi',
  'nft','altcoin','coinbase','binance','web3',
];
const SPORTS_KEYWORDS = [
  'win','championship','nba','nfl','mlb','nhl','cup','tournament','league','player',
  'coach','season','playoff','score','match','game','football','basketball','baseball',
  'hockey','soccer','tennis','golf','olympic','fifa','world cup',
];
const CULTURE_KEYWORDS = [
  'oscar','grammy','emmy','award','movie','film','music','actor','album','box office',
  'celebrity','artist','singer','director','netflix','disney','streaming',
];

export type Category = 'sports' | 'politics' | 'macro' | 'crypto' | 'culture' | 'other';

export function classifyCategory(question: string): Category {
  const q = (question || '').toLowerCase();
  // Vote count: pick the category with the most distinct keyword hits.
  // Single-word keywords like "win" appear in many sports questions but
  // also in political races; matching "election"/"president"/"governor"
  // should outrank a lone "win" → politics wins.
  const count = (kws: string[]) => {
    let n = 0;
    for (const k of kws) if (q.includes(k)) n += 1;
    return n;
  };
  const scores: Array<[Category, number]> = [
    ['politics', count(POLITICS_KEYWORDS)],
    ['sports',   count(SPORTS_KEYWORDS)],
    ['macro',    count(MACRO_KEYWORDS)],
    ['crypto',   count(CRYPTO_KEYWORDS)],
    ['culture',  count(CULTURE_KEYWORDS)],
  ];
  scores.sort((a, b) => b[1] - a[1]);
  if (scores[0][1] === 0) return 'other';
  return scores[0][0];
}

export function getCategoryFactor(category: string | null): number {
  switch ((category ?? 'other').toLowerCase()) {
    case 'sports':   return 1.20;
    case 'politics': return 1.10;
    case 'culture':  return 1.10;
    case 'macro':    return 0.90;
    case 'crypto':   return 0.95;
    default:         return 1.00;
  }
}

export function getVolumeFactor(volume: number | null): number {
  if (volume == null) return 1.0;
  if (volume < MIN_VOLUME_USD) return 0.0; // hard-excluded but defensive default
  if (volume < 500_000) return 0.90;
  if (volume <= 2_000_000) return 1.00;
  return 1.05;
}

export function isHardExcluded(days: number | null, volume: number | null): boolean {
  if (days != null && (days < MIN_DAYS_TO_CLOSE || days > MAX_DAYS_TO_CLOSE)) return true;
  if (volume != null && volume < MIN_VOLUME_USD) return true;
  return false;
}

// ---------------------------------------------------------------------
// scoreMarket
// ---------------------------------------------------------------------

export interface MarketToScore {
  /** Output of the screener for this market. */
  screened: ScreenedMarket;
  /** Live volume — rescore endpoint pulls from Polymarket. */
  volume?: number | null;
  /** Days-to-close at scoring time. */
  days_to_close?: number | null;
  /** Optional pre-classified category; otherwise derived from question text. */
  category?: string | null;
}

export interface LayeredScoreFields {
  p_model: number;
  base_edge: number;
  time_factor: number;
  category_factor: number;
  volume_factor: number;
  adjusted_edge: number;
  category: string;
  include_in_basket: boolean;
  impossible_edge: boolean;
  hard_excluded: boolean;
}

/**
 * Pure layered computation — exposed for unit tests + the basket builder.
 * Persistence-free version of scoreMarket.
 */
export function computeLayeredScore(opts: {
  p_market: number;
  question: string;
  isImpossible?: boolean;
  excludedByScreener?: boolean;
  volume?: number | null;
  days_to_close?: number | null;
  category?: string | null;
  momentum_factor?: number;
}): LayeredScoreFields {
  const {
    p_market,
    question,
    volume = null,
    days_to_close = null,
    isImpossible = false,
    excludedByScreener = false,
    momentum_factor = 1.0,
  } = opts;

  const category = (opts.category ?? classifyCategory(question)) as string;
  const time_factor = getTimeFactor(days_to_close);
  const volume_factor = getVolumeFactor(volume);
  const category_factor = isImpossible ? 1.0 : getCategoryFactor(category);

  // Layer 6 — impossible override sidesteps Anthropic excluded gating.
  if (isImpossible) {
    const base_edge = p_market;
    const adjusted_edge = base_edge * time_factor * volume_factor * momentum_factor;
    const hard_excluded = isHardExcluded(days_to_close, volume);
    return {
      p_model: 0.0,
      base_edge,
      time_factor,
      category_factor,
      volume_factor,
      adjusted_edge: hard_excluded ? 0 : adjusted_edge,
      category,
      include_in_basket: !hard_excluded && adjusted_edge >= IMPOSSIBLE_INCLUDE_THRESHOLD,
      impossible_edge: true,
      hard_excluded,
    };
  }

  // Layer 1 — base calibration.
  const p_model = getPModel(p_market);
  const base_edge = getEdge(p_market, p_model);

  // Layer 2 — hard exclusion. Stops further scoring.
  if (isHardExcluded(days_to_close, volume)) {
    return {
      p_model,
      base_edge,
      time_factor: 1,
      category_factor: 1,
      volume_factor: 1,
      adjusted_edge: 0,
      category,
      include_in_basket: false,
      impossible_edge: false,
      hard_excluded: true,
    };
  }

  // Layers 3-5 + momentum.
  const adjusted_edge = base_edge * time_factor * category_factor * volume_factor * momentum_factor;

  const include_in_basket =
    !excludedByScreener &&
    adjusted_edge >= EDGE_INCLUDE_THRESHOLD &&
    p_market >= P_MARKET_INCLUDE_MIN &&
    p_market <= P_MARKET_INCLUDE_MAX;

  return {
    p_model,
    base_edge,
    time_factor,
    category_factor,
    volume_factor,
    adjusted_edge,
    category,
    include_in_basket,
    impossible_edge: false,
    hard_excluded: false,
  };
}

/**
 * Score one market and persist. Layered model — see file header.
 *
 * `isImpossible` arg overrides the screened-row impossible flag. In normal
 * use the caller passes nothing and we read it off `input.screened`.
 */
export async function scoreMarket(
  input: MarketToScore,
  isImpossibleOverride?: boolean,
): Promise<ScoredMarket> {
  const s = input.screened;
  const isImpossible =
    typeof isImpossibleOverride === 'boolean' ? isImpossibleOverride : s.impossible === true;

  const layered = computeLayeredScore({
    p_market: s.p_market ?? 0,
    question: s.question,
    isImpossible,
    excludedByScreener: s.excluded === true,
    volume: input.volume ?? null,
    days_to_close: input.days_to_close ?? null,
    category: input.category ?? null,
  });

  return upsertScoredMarket({
    condition_id: s.condition_id,
    source: s.source,
    question: s.question,
    p_market: s.p_market ?? 0,
    p_model: layered.p_model,
    edge: layered.base_edge,
    volume: input.volume ?? null,
    days_to_close: input.days_to_close ?? null,
    category: layered.category,
    include_in_basket: layered.include_in_basket,
    model_version: MODEL_VERSION,
    impossible_edge: layered.impossible_edge,
    adjusted_edge: layered.adjusted_edge,
    time_factor: layered.time_factor,
    category_factor: layered.category_factor,
    volume_factor: layered.volume_factor,
    momentum_factor: 1.0, // momentum job updates this once 7d of history exists
  });
}

export async function scoreAllMarkets(inputs: MarketToScore[]): Promise<{
  scored: ScoredMarket[];
  included: number;
  impossible_included: number;
  hard_excluded: number;
}> {
  const scored: ScoredMarket[] = [];
  let impossibleIncluded = 0;
  let hardExcluded = 0;
  for (const m of inputs) {
    try {
      const isImpossible = m.screened.impossible === true;
      const row = await scoreMarket(m, isImpossible);
      scored.push(row);
      if (isImpossible && row.include_in_basket) impossibleIncluded += 1;
      if ((row.adjusted_edge ?? 0) === 0 && !row.include_in_basket) hardExcluded += 1;
    } catch (e) {
      console.warn(
        `[ml-scorer] failed ${m.screened.condition_id}: ${(e as Error).message}`,
      );
    }
  }
  const included = scored.filter((r) => r.include_in_basket).length;
  return { scored, included, impossible_included: impossibleIncluded, hard_excluded: hardExcluded };
}
