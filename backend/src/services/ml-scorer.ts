/**
 * ML scorer — calibration_v4.
 *
 * Invariant: adj_edge = p_market − p_model_shown (the persisted p_model
 * field). Factors adjust p_model, NOT the edge directly. p_model is
 * always capped at p_market × 0.95 so some edge is preserved.
 *
 * Pipeline (per market):
 *   Layer 1  base calibration
 *     non-sports → p_calib from 11-bucket lookup
 *     sports     → tiered within-probability rule (replaces lookup):
 *                    p_market > 0.08 → 0.75 × p_market   (contender)
 *                    p_market > 0.05 → 0.35 × p_market   (moderate)
 *                    p_market > 0.02 → 0.90 × lookup     (genuine longshot)
 *                    else            → lookup            (extreme longshot)
 *   Layer 2  hard exclusion → days <3 / days >365 / volume <100k
 *                              → adj_edge = 0, include = false, stop
 *   Layer 3  factor stack applied to p_model:
 *              p_model_adj = base × time_factor × category_factor × volume_factor
 *              p_model_adj = min(p_model_adj, p_market × 0.95)
 *              adj_edge    = p_market − p_model_adj
 *   Layer 4  impossible override:
 *              p_model_adj = 0, adj_edge = p_market, include if adj_edge ≥ 0.02
 *
 *   category_factor = getDomainHorizonMultiplier(category, days_to_close)
 *
 *   momentum_factor is persisted (default 1.0) and applied by the daily
 *   momentum job by adjusting p_model so the adj_edge = p_market − p_model
 *   invariant continues to hold.
 *
 * Inclusion gate (after layers):
 *   adj_edge ≥ 0.03 AND p_market ∈ [0.02, 0.12] AND not excluded.
 */

import {
  upsertScoredMarket,
  listScoredMarkets,
  listScreenedMarkets,
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

export const MODEL_VERSION = 'calibration_v4';

/** p_model_adjusted is never allowed above p_market × P_MODEL_CAP_FRAC. */
export const P_MODEL_CAP_FRAC = 0.95;

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

/**
 * Sports-only tiered base p_model. Replaces the standard CALIBRATION_TABLE
 * lookup for sports markets where the question is structurally "does
 * country X / team X win the tournament" — outright lookups badly
 * undershoot contenders (Brazil at 8% is not a 1.7% longshot).
 */
export function getSportsCalibratedPModel(p_market: number): number {
  if (!Number.isFinite(p_market)) return 0;
  if (p_market > 0.08) return p_market * 0.75;       // contender, ~25% overpriced max
  if (p_market > 0.05) return p_market * 0.35;       // moderate longshot
  if (p_market > 0.02) return getPModel(p_market) * 0.90; // genuine longshot, strong bias
  return getPModel(p_market);                        // extreme longshot, full bias
}

export function getBasePModel(p_market: number, category: string | null): number {
  return (category ?? 'other').toLowerCase() === 'sports'
    ? getSportsCalibratedPModel(p_market)
    : getPModel(p_market);
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
  // general sports terms
  'win','championship','cup','tournament','league','player','coach','season','playoff',
  'score','match','game','football','basketball','baseball','hockey','soccer','tennis',
  'golf','olympic','fifa','world cup','nba','nfl','mlb','nhl','stanley','finals','series',
  'medal','podium','race','grand prix',
  // countries (national teams)
  'england','france','spain','germany','brazil','argentina','portugal','japan','norway',
  'netherlands','mexico','usa','canada','australia','italy','belgium','croatia','senegal',
  'morocco','korea',
  // NBA teams
  'knicks','lakers','celtics','warriors','bulls','heat','nets','bucks','suns','nuggets',
  'clippers','mavs','mavericks','spurs','rockets','pistons','cavaliers','cavs','pacers',
  'hawks','hornets','magic','wizards','raptors','sixers','76ers','jazz','thunder','blazers',
  'grizzlies','pelicans','kings','timberwolves','wolves',
  // NHL teams
  'canadiens','maple leafs','bruins','rangers','penguins','blackhawks','red wings','oilers',
  'flames','canucks','avalanche','lightning','golden knights','capitals','flyers','blues',
  'stars','sharks','ducks','coyotes','devils','islanders','hurricanes','panthers','senators',
  'sabres','jets','kraken','wild','predators',
  // MLB teams
  'yankees','red sox','dodgers','cubs','cardinals','giants','astros','braves','mets',
  'phillies','nationals','brewers','pirates','reds','rockies','padres','mariners','athletics',
  'tigers','indians','guardians','twins','royals','white sox','orioles','rays','blue jays',
  'angels','diamondbacks','marlins',
  // NFL teams
  'patriots','cowboys','packers','steelers','49ers','chiefs','ravens','eagles','bears',
  'lions','seahawks','rams','broncos','raiders','chargers','colts','dolphins','bills',
  'browns','bengals','falcons','saints','buccaneers','vikings','texans','jaguars','titans',
  'commanders',
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

/**
 * calibration_v3 domain × horizon multiplier. Applied to the base
 * calibration lookup to produce p_model. Captures the empirical finding
 * that miscalibration scales with both domain and time-to-resolution —
 * long-horizon political markets are the most overpriced.
 *
 * `days == null` falls back to the medium-horizon bucket for that domain.
 */
export function getDomainHorizonMultiplier(
  category: string | null,
  days: number | null,
): number {
  const cat = (category ?? 'other').toLowerCase();
  const d = days; // may be null → use medium bucket per domain

  switch (cat) {
    case 'politics':
      if (d == null) return 0.70; // medium-term default
      if (d <= 30) return 0.85; // near-term: fairly well priced
      if (d <= 180) return 0.70; // medium-term: strong bias, very overpriced
      return 0.55; // long-term: extremely overpriced (>365 hard-excluded)
    case 'sports':
      if (d == null) return 0.80;
      if (d <= 30) return 0.90; // near-term: moderately well priced
      if (d <= 90) return 0.80; // medium-term: fans overweight longshots
      return 0.75; // 90–365
    case 'macro':
      if (d == null) return 1.0;
      if (d <= 90) return 1.0; // economists involved, well calibrated
      return 0.85; // 90–365
    case 'crypto':
      return 0.90; // informed traders, moderate calibration
    case 'culture':
      return 0.80; // fan bias, award predictions heavily biased
    default:
      return 0.95; // other
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
  const category_factor = isImpossible
    ? 1.0
    : getDomainHorizonMultiplier(category, days_to_close);

  // Layer 4 — impossible override. p_model = 0, edge = p_market.
  if (isImpossible) {
    const hard_excluded = isHardExcluded(days_to_close, volume);
    const adjusted_edge = hard_excluded ? 0 : p_market;
    return {
      p_model: 0.0,
      base_edge: p_market,
      time_factor,
      category_factor,
      volume_factor,
      adjusted_edge,
      category,
      include_in_basket: !hard_excluded && adjusted_edge >= IMPOSSIBLE_INCLUDE_THRESHOLD,
      impossible_edge: true,
      hard_excluded,
    };
  }

  // Layer 1 — base calibration (sports uses tiered rule, others use lookup).
  const base_p_model = getBasePModel(p_market, category);
  const base_edge = getEdge(p_market, base_p_model);

  // Layer 2 — hard exclusion. Stops further scoring.
  if (isHardExcluded(days_to_close, volume)) {
    return {
      p_model: base_p_model,
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

  // Layer 3 — factor stack applies to p_model, never to edge directly.
  // Cap p_model at 95% of p_market so some edge is always preserved.
  const p_model_unfolded = base_p_model * time_factor * category_factor * volume_factor;
  const p_model_adj = Math.min(p_model_unfolded, p_market * P_MODEL_CAP_FRAC);
  // Invariant: adj_edge = p_market − p_model_shown.
  // momentum_factor is intentionally NOT applied here — the momentum job
  // folds it into p_model later so the invariant continues to hold.
  void momentum_factor;
  const adjusted_edge = p_market - p_model_adj;

  const include_in_basket =
    !excludedByScreener &&
    adjusted_edge >= EDGE_INCLUDE_THRESHOLD &&
    p_market >= P_MARKET_INCLUDE_MIN &&
    p_market <= P_MARKET_INCLUDE_MAX;

  return {
    p_model: p_model_adj,
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

/**
 * Re-score every existing scored_markets row against the current model
 * (calibration_v3). Reads volume / days_to_close / category straight off
 * the persisted scored rows so we don't depend on the live APIs and
 * don't clobber existing metadata. Screened flags (impossible / excluded)
 * are joined from screened_markets; rows with no screened entry are
 * treated as not-excluded / not-impossible.
 */
export async function rescoreAllStored(): Promise<{
  total: number;
  rescored: number;
  included: number;
  model_version: string;
}> {
  const [scored, screened] = await Promise.all([
    listScoredMarkets(),
    listScreenedMarkets().catch(() => [] as ScreenedMarket[]),
  ]);
  const screenedById = new Map<string, ScreenedMarket>();
  for (const s of screened) screenedById.set(s.condition_id, s);

  let rescored = 0;
  let included = 0;
  for (const sd of scored) {
    const sc = screenedById.get(sd.condition_id);
    const synthScreened: ScreenedMarket = sc ?? {
      id: sd.id,
      condition_id: sd.condition_id,
      source: sd.source as ScreenedMarket['source'],
      question: sd.question,
      p_market: sd.p_market ?? 0,
      impossible: sd.impossible_edge ?? false,
      already_resolved: false,
      ambiguous: false,
      excluded: false,
      exclusion_reason: null,
      screened_at: sd.scored_at,
      screening_model: null,
    };
    try {
      const row = await scoreMarket({
        screened: synthScreened,
        volume: sd.volume ?? null,
        days_to_close: sd.days_to_close ?? null,
        category: sd.category ?? null,
      });
      rescored += 1;
      if (row.include_in_basket) included += 1;
    } catch (e) {
      console.warn(`[ml-scorer] rescore failed ${sd.condition_id}: ${(e as Error).message}`);
    }
  }

  console.info(
    `[ml-scorer] rescoreAllStored: ${rescored}/${scored.length} rows → ${MODEL_VERSION} (${included} include_in_basket)`,
  );
  return { total: scored.length, rescored, included, model_version: MODEL_VERSION };
}
