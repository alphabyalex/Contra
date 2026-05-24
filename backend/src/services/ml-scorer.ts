/**
 * ML scorer — calibration_v5.
 *
 * Invariant: adj_edge = p_market − p_model_shown.
 *
 * Pipeline (per market):
 *   Layer 1  base calibration
 *     1a. Detect sub-category (FIFA / NBA / NHL / MLB / NFL / Tennis;
 *         US-primary / US-general / US-state / international politics).
 *     1b. If a sub-category matches, use its tiered formula directly.
 *         p_market > t1  →   p_market × f_high
 *         p_market > t2  →   p_market × f_mid
 *         else           →   table_lookup × f_tail
 *     1c. If sports without a sub-category match: use legacy sports tier.
 *     1d. Otherwise: standard 11-bucket calibration lookup.
 *
 *     Sub-category tiers bake the category bias into the base p_model, so
 *     category_factor is set to 1.0 for those rows — no double-dip.
 *
 *   Layer 2  hard exclusion → days <3 / days >260 / volume <100k
 *                              → adj_edge = 0, include = false, stop
 *
 *   Layer 3  factor stack on p_model (NOT on edge):
 *              p_model_adj = base × time_factor × category_factor × volume_factor
 *              p_model_adj = min(p_model_adj, p_market × 0.95)
 *              adj_edge    = p_market − p_model_adj
 *
 *   Layer 4  impossible override:
 *              p_model_adj = 0, adj_edge = p_market, include if ≥ 0.02
 *
 *   Layer 5  tournament group renormalization (cross-row, post-scoring).
 *              Markets in the same tournament are mutually exclusive — one
 *              team can win. The longshot bias pushes probability AWAY from
 *              favorites and TOWARD longshots, so renormalizing the group
 *              both for vig (p_market) and for the calibration's overconfidence
 *              on favorites (p_model) gives a cleaner picture of who is
 *              underpriced (favorite, edge ≤ 0) vs overpriced (longshot,
 *              edge > 0).
 *
 * Inclusion gate (after layers):
 *   Non-tournament: adj_edge ≥ 0.03 AND p_market ∈ [0.02, 0.12] AND not excluded.
 *   Tournament:     normalized edge > 0.02 → include; edge ≤ 0 → favorite, excluded.
 */

import {
  upsertScoredMarket,
  listScoredMarkets,
  listScreenedMarkets,
  getLatestPricesMap,
  type ScreenedMarket,
  type ScoredMarket,
} from '../db/queries';
import { getAllActiveMarkets, flattenOutcomes, type RawPolymarketMarket } from './polymarket';

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

export const MODEL_VERSION = 'calibration_v5_2';

/** p_model_adjusted is never allowed above p_market × P_MODEL_CAP_FRAC. */
export const P_MODEL_CAP_FRAC = 0.95;

// Inclusion gates.
export const EDGE_INCLUDE_THRESHOLD = 0.03;              // non-tournament
export const TOURNAMENT_EDGE_INCLUDE_THRESHOLD = 0.02;   // tournament-normalized
export const IMPOSSIBLE_INCLUDE_THRESHOLD = 0.02;
export const P_MARKET_INCLUDE_MIN = 0.02;
export const P_MARKET_INCLUDE_MAX = 0.12;

// Hard exclusion thresholds (Layer 2).
// MAX_DAYS_TO_CLOSE caps basket eligibility, not screener entry or scanner
// display. 260 days from 2026-05-23 lands just past Super Bowl LXI
// (~Feb 8 2027), capturing NFL futures alongside every Dec 31 2026 longshot.
export const MIN_DAYS_TO_CLOSE = 3;
export const MAX_DAYS_TO_CLOSE = 260;
export const MIN_VOLUME_USD = 100_000;

// ---------------------------------------------------------------------
// Base lookups
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
 * Generic sports tier — used as the fallback for sports markets that don't
 * match any of the more specific sub-category rules.
 */
export function getSportsCalibratedPModel(p_market: number): number {
  if (!Number.isFinite(p_market)) return 0;
  if (p_market > 0.08) return p_market * 0.75;
  if (p_market > 0.05) return p_market * 0.35;
  if (p_market > 0.02) return getPModel(p_market) * 0.90;
  return getPModel(p_market);
}

export function getEdge(p_market: number, p_model: number): number {
  return p_market - p_model;
}

// ---------------------------------------------------------------------
// Sports sub-category detection + tier rules
// ---------------------------------------------------------------------

export type SportsSubcategory =
  | 'fifa' | 'nba' | 'nhl' | 'mlb' | 'nfl' | 'tennis' | null;

export function detectSportsSubcategory(question: string): SportsSubcategory {
  const q = (question || '').toLowerCase();
  if (/\b(world cup|fifa)\b/.test(q)) return 'fifa';
  if (/\b(nba|nba finals|nba playoffs|western conference|eastern conference)\b/.test(q)) return 'nba';
  if (/\b(stanley cup|nhl)\b/.test(q)) return 'nhl';
  if (/\b(world series|mlb)\b/.test(q)) return 'mlb';
  if (/\b(super bowl|nfl)\b/.test(q)) return 'nfl';
  if (/\b(wimbledon|french open|us open|australian open)\b/.test(q)) return 'tennis';
  return null;
}

// calibration_v6 partial: per-(sport, bucket) multipliers ONLY for buckets
// with >= 25 historical samples. Buckets below the gate are absent here and
// fall through to the v5_2 tier rules below. Source: ml/artifacts/calibration_v6.json.
// Updated with the expanded FIFA dataset (Euros 2008-2024 + Copa America
// 2015-2024 added). FIFA 10-15 now crosses the 25-sample gate (n=31) and
// joins as a v6-kept bucket with the bumped multiplier 1.791.
const V6_PARTIAL_MULTIPLIERS: Partial<Record<NonNullable<SportsSubcategory>, Record<string, number>>> = {
  fifa:   { '0-5': 0.576, '5-10': 0.756, '10-15': 1.791 },
  nba:    { '5-10': 1.421 },
  nfl:    { '5-10': 0.949, '10-15': 1.004, '15-20': 0.922 },
  nhl:    { '5-10': 1.219, '10-15': 0.825, '15-20': 0.987 },
  tennis: { '0-5': 1.912, '5-10': 0.455 },
};

function v6Bucket(p: number): string {
  if (p < 0.05) return '0-5';
  if (p < 0.10) return '5-10';
  if (p < 0.15) return '10-15';
  if (p < 0.20) return '15-20';
  if (p < 0.30) return '20-30';
  if (p < 0.50) return '30-50';
  if (p < 0.75) return '50-75';
  return '75+';
}

function lookupV6PartialMultiplier(sub: SportsSubcategory, p: number): number | null {
  if (!sub) return null;
  const table = V6_PARTIAL_MULTIPLIERS[sub];
  if (!table) return null;
  const mult = table[v6Bucket(p)];
  return typeof mult === 'number' ? mult : null;
}

export function getSportsSubcategoryPModel(sub: SportsSubcategory, p_market: number): number {
  if (!Number.isFinite(p_market)) return 0;
  // calibration_v6 partial: use the v6 multiplier when the bucket had >= 25
  // historical samples. The constant table above holds only those buckets;
  // anything else falls through to the v5_2 tier rules.
  const v6 = lookupV6PartialMultiplier(sub, p_market);
  if (v6 != null) return Math.max(0, Math.min(1, p_market * v6));
  switch (sub) {
    case 'fifa':
      if (p_market > 0.15) return p_market * 0.88;
      if (p_market > 0.08) return p_market * 0.75;
      if (p_market > 0.04) return p_market * 0.35;
      return getPModel(p_market) * 0.85;
    case 'nba':
      if (p_market > 0.08) return p_market * 0.70;
      if (p_market > 0.04) return p_market * 0.40;
      return getPModel(p_market) * 0.90;
    case 'nhl':
      // calibration_v5_2: an NHL team at 15%+ is a real Stanley Cup
      // contender — minimal longshot bias. (Was too aggressive: a 19%
      // team scored ~8% p_model, implying massive overpricing.)
      if (p_market > 0.15) return p_market * 0.88; // leading contender
      if (p_market > 0.08) return p_market * 0.82; // solid contender
      if (p_market > 0.04) return p_market * 0.55; // longshot
      return getPModel(p_market) * 0.92;
    case 'mlb':
      if (p_market > 0.08) return p_market * 0.75;
      if (p_market > 0.04) return p_market * 0.42;
      return getPModel(p_market) * 0.88;
    case 'nfl':
      if (p_market > 0.08) return p_market * 0.78;
      if (p_market > 0.04) return p_market * 0.44;
      return getPModel(p_market) * 0.88;
    case 'tennis':
      if (p_market > 0.08) return p_market * 0.65;
      if (p_market > 0.04) return p_market * 0.32;
      return getPModel(p_market) * 0.80;
    default:
      return getSportsCalibratedPModel(p_market);
  }
}

// ---------------------------------------------------------------------
// Politics sub-category detection + tier rules
// ---------------------------------------------------------------------

export type PoliticsSubcategory =
  | 'us_primary' | 'us_general' | 'us_state' | 'international' | null;

export function detectPoliticsSubcategory(question: string): PoliticsSubcategory {
  const q = (question || '').toLowerCase();
  if (/\b(nomination|democratic primary|republican primary|presidential nomination|presidential nominee)\b/.test(q)) {
    return 'us_primary';
  }
  if (/\b(us presidential election|win the \d{4} us presidential|win the \d{4} presidential election)\b/.test(q)) {
    return 'us_general';
  }
  if (/\b(governor|senate|mayoral|gubernatorial)\b/.test(q)) {
    return 'us_state';
  }
  if (/\b(election|prime minister|parliament|chancellor|prime\b)\b/.test(q)) {
    return 'international';
  }
  return null;
}

export function getPoliticsSubcategoryPModel(sub: PoliticsSubcategory, p_market: number): number {
  if (!Number.isFinite(p_market)) return 0;
  switch (sub) {
    case 'us_primary':
      if (p_market > 0.08) return p_market * 0.55;
      if (p_market > 0.04) return p_market * 0.30;
      return getPModel(p_market) * 0.65;
    case 'us_general':
      if (p_market > 0.08) return p_market * 0.70;
      if (p_market > 0.04) return p_market * 0.45;
      return getPModel(p_market) * 0.75;
    case 'us_state':
      if (p_market > 0.08) return p_market * 0.60;
      if (p_market > 0.04) return p_market * 0.35;
      return getPModel(p_market) * 0.70;
    case 'international':
      return getPModel(p_market) * 0.80;
    default:
      return getPModel(p_market);
  }
}

// ---------------------------------------------------------------------
// Base p_model dispatch (returns model + flag indicating sub-cat baked in)
// ---------------------------------------------------------------------

export interface BaseModelResult {
  p_model: number;
  tier_baked: boolean;
}

export function getBasePModelV5(
  p_market: number,
  question: string,
  category: string | null,
): BaseModelResult {
  const cat = (category ?? '').toLowerCase();
  if (cat === 'sports') {
    const sub = detectSportsSubcategory(question);
    if (sub) return { p_model: getSportsSubcategoryPModel(sub, p_market), tier_baked: true };
    // No matched sub-category for sports → legacy tier still applies and is
    // already calibrated, so bake the category in.
    return { p_model: getSportsCalibratedPModel(p_market), tier_baked: true };
  }
  if (cat === 'politics') {
    const sub = detectPoliticsSubcategory(question);
    if (sub) return { p_model: getPoliticsSubcategoryPModel(sub, p_market), tier_baked: true };
  }
  return { p_model: getPModel(p_market), tier_baked: false };
}

// Legacy helper kept for any callers that asked for "base p_model" before
// the v5 split. Prefer getBasePModelV5 in new code.
export function getBasePModel(p_market: number, category: string | null): number {
  return getBasePModelV5(p_market, '', category).p_model;
}

// ---------------------------------------------------------------------
// Category / time / volume factors
// ---------------------------------------------------------------------

/**
 * Time decay applied to raw_edge to produce adj_edge. Far-future markets
 * carry real mispricing (raw_edge stays unchanged) but eligibility for a
 * basket position decays — a 2028 election's 1.9% edge becomes a 0.19%
 * adj_edge that can't pass the 0.03 inclusion gate.
 */
export function getTimeFactor(days: number | null): number {
  if (days == null) return 1.0;
  if (days < 30) return 1.20;
  if (days <= 90) return 1.00;
  if (days <= 180) return 0.70;
  if (days <= 365) return 0.40;
  if (days <= 730) return 0.20;
  return 0.10;
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
  'win','championship','cup','tournament','league','player','coach','season','playoff',
  'score','match','game','football','basketball','baseball','hockey','soccer','tennis',
  'golf','olympic','fifa','world cup','nba','nfl','mlb','nhl','stanley','finals','series',
  'medal','podium','race','grand prix',
  'england','france','spain','germany','brazil','argentina','portugal','japan','norway',
  'netherlands','mexico','usa','canada','australia','italy','belgium','croatia','senegal',
  'morocco','korea',
  'knicks','lakers','celtics','warriors','bulls','heat','nets','bucks','suns','nuggets',
  'clippers','mavs','mavericks','spurs','rockets','pistons','cavaliers','cavs','pacers',
  'hawks','hornets','magic','wizards','raptors','sixers','76ers','jazz','thunder','blazers',
  'grizzlies','pelicans','kings','timberwolves','wolves',
  'canadiens','maple leafs','bruins','rangers','penguins','blackhawks','red wings','oilers',
  'flames','canucks','avalanche','lightning','golden knights','capitals','flyers','blues',
  'stars','sharks','ducks','coyotes','devils','islanders','hurricanes','panthers','senators',
  'sabres','jets','kraken','wild','predators',
  'yankees','red sox','dodgers','cubs','cardinals','giants','astros','braves','mets',
  'phillies','nationals','brewers','pirates','reds','rockies','padres','mariners','athletics',
  'tigers','indians','guardians','twins','royals','white sox','orioles','rays','blue jays',
  'angels','diamondbacks','marlins',
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
  // Nobel Prize markets ("Nobel Peace Prize") trip the sports keyword "win";
  // they belong in 'other', not sports.
  if (/\bnobel\b.*\bprize\b|\bnobel prize\b|\bnobel peace prize\b/.test(q)) return 'other';
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

/**
 * Returns 1.0 when the sub-category already baked the bias into the base
 * p_model — avoids double-counting the category penalty.
 */
export function getCategoryFactorV5(
  category: string | null,
  days: number | null,
  tier_baked: boolean,
): number {
  if (tier_baked) return 1.0;
  return getDomainHorizonMultiplier(category, days);
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

export function getDomainHorizonMultiplier(
  category: string | null,
  days: number | null,
): number {
  const cat = (category ?? 'other').toLowerCase();
  const d = days;
  switch (cat) {
    case 'politics':
      if (d == null) return 0.70;
      if (d <= 30) return 0.85;
      if (d <= 180) return 0.70;
      return 0.55;
    case 'sports':
      if (d == null) return 0.80;
      if (d <= 30) return 0.90;
      if (d <= 90) return 0.80;
      return 0.75;
    case 'macro':
      if (d == null) return 1.0;
      if (d <= 90) return 1.0;
      return 0.85;
    case 'crypto':
      return 0.90;
    case 'culture':
      return 0.80;
    default:
      return 0.95;
  }
}

/**
 * Volume confidence factor. Below the $100k floor we cut adj_edge sharply
 * (10%) so low-liquidity markets stay basket-ineligible — but we no longer
 * zero it out, so raw_edge and signal stay readable in the scanner.
 */
export function getVolumeFactor(volume: number | null): number {
  if (volume == null) return 1.0;
  if (volume < MIN_VOLUME_USD) return 0.10;
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
// Signal classification — used by both short and long basket selection
// and rendered as a badge in the scanner UI.
// ---------------------------------------------------------------------

export type Signal =
  | 'strong_short' | 'short' | 'weak_short'
  | 'fair_value'
  | 'long' | 'strong_long';

/**
 * Constitutional / legal impossibilities the screener may not catch.
 * Currently: Trump winning a 2028+ presidential election — he will have
 * served two terms, so the 22nd Amendment bars a third. These resolve NO
 * with certainty, so p_model = 0 and they're maximum-conviction shorts.
 */
export function isConstitutionallyImpossible(question: string): boolean {
  if (!question) return false;
  const q = question.toLowerCase();
  if (!q.includes('trump')) return false;
  // Only Donald Trump Sr. is term-limited. "Trump Jr." (Donald Jr.) is a
  // different, eligible person — never flag him.
  if (/trump\s+jr\b|donald\s+trump\s+jr/.test(q)) return false;
  const mentions2028 = q.includes('2028') || /\b202[89]\b|\b203\d\b/.test(q);
  if (!mentions2028) return false;
  return (
    q.includes('presidential election') ||
    /\bwin the 202[89]\b/.test(q) ||
    (q.includes('president') && (q.includes('win') || q.includes('elect')))
  );
}

export function classifySignal(raw_edge: number): Signal {
  if (!Number.isFinite(raw_edge)) return 'fair_value';
  if (raw_edge > 0.05) return 'strong_short';
  if (raw_edge > 0.02) return 'short';
  if (raw_edge > 0.00) return 'weak_short';
  if (raw_edge >= -0.01) return 'fair_value';
  if (raw_edge > -0.05) return 'long';
  return 'strong_long';
}

// ---------------------------------------------------------------------
// Tournament group detection
// ---------------------------------------------------------------------

type Pat = { regex: RegExp; key: (m: RegExpMatchArray) => string };

const TOURNAMENT_PATTERNS: Pat[] = [
  // FIFA World Cup — "Will <X> win the 2026 FIFA World Cup" / "World Cup 2026"
  { regex: /\b(\d{4})\s+fifa\s+world\s+cup\b/i, key: (m) => `fifa_world_cup_${m[1]}` },
  { regex: /\bfifa\s+world\s+cup\s+(\d{4})\b/i, key: (m) => `fifa_world_cup_${m[1]}` },
  { regex: /\bworld\s+cup\s+(\d{4})\b/i,        key: (m) => `fifa_world_cup_${m[1]}` },
  { regex: /\b(\d{4})\s+world\s+cup\b/i,        key: (m) => `fifa_world_cup_${m[1]}` },
  // NBA Conference Finals (these have only 4 teams each — narrower group).
  { regex: /\b(\d{4})\s+nba\s+western\s+conference\s+finals\b/i, key: (m) => `nba_west_finals_${m[1]}` },
  { regex: /\b(\d{4})\s+nba\s+eastern\s+conference\s+finals\b/i, key: (m) => `nba_east_finals_${m[1]}` },
  // NBA Finals — checked AFTER the conference variants so "NBA Finals" alone matches the league.
  { regex: /\b(\d{4})\s+nba\s+finals\b/i,       key: (m) => `nba_finals_${m[1]}` },
  { regex: /\bnba\s+finals\s+(\d{4})\b/i,       key: (m) => `nba_finals_${m[1]}` },
  // NHL
  { regex: /\b(\d{4})\s+nhl\s+stanley\s+cup\b/i, key: (m) => `nhl_stanley_cup_${m[1]}` },
  { regex: /\b(\d{4})\s+stanley\s+cup\b/i,       key: (m) => `nhl_stanley_cup_${m[1]}` },
  // MLB
  { regex: /\b(\d{4})\s+world\s+series\b/i,      key: (m) => `mlb_world_series_${m[1]}` },
  // NFL
  { regex: /\b(\d{4})\s+super\s+bowl\b/i,        key: (m) => `nfl_super_bowl_${m[1]}` },
  // Tennis grand slams
  { regex: /\b(\d{4})\s+men'?s\s+wimbledon\b/i,        key: (m) => `tennis_wimbledon_mens_${m[1]}` },
  { regex: /\b(\d{4})\s+women'?s\s+wimbledon\b/i,      key: (m) => `tennis_wimbledon_womens_${m[1]}` },
  { regex: /\b(\d{4})\s+men'?s\s+french\s+open\b/i,    key: (m) => `tennis_french_open_mens_${m[1]}` },
  { regex: /\b(\d{4})\s+men'?s\s+us\s+open\b/i,        key: (m) => `tennis_us_open_mens_${m[1]}` },
  { regex: /\b(\d{4})\s+men'?s\s+australian\s+open\b/i, key: (m) => `tennis_aus_open_mens_${m[1]}` },
];

export function detectTournamentGroup(question: string): string | null {
  if (!question) return null;
  // Tournament normalization only makes sense for winner-take-all
  // questions ("Will <X> win the <YYYY> <tournament>"). Reject anything
  // else — "Will Messi play in the 2026 World Cup", "Will any 2026 World
  // Cup game be held in the US", etc. — because their probabilities
  // don't sum to ~1 across the field and would corrupt the renormalize.
  const isWinnerQuestion = /\bwin\b[^?]*\b(world cup|fifa|nba|stanley cup|nhl|world series|mlb|super bowl|nfl|wimbledon|french open|us open|australian open)\b/i.test(question);
  if (!isWinnerQuestion) return null;
  for (const p of TOURNAMENT_PATTERNS) {
    const m = question.match(p.regex);
    if (m) return p.key(m);
  }
  return null;
}

// ---------------------------------------------------------------------
// scoreMarket
// ---------------------------------------------------------------------

export interface MarketToScore {
  screened: ScreenedMarket;
  volume?: number | null;
  days_to_close?: number | null;
  category?: string | null;
}

export interface LayeredScoreFields {
  p_model: number;
  /** raw_edge = p_market − p_model. The honest model mispricing. */
  raw_edge: number;
  /** Legacy alias of raw_edge for downstream code that hasn't migrated. */
  base_edge: number;
  time_factor: number;
  category_factor: number;
  volume_factor: number;
  /** adj_edge = raw_edge × time_factor × volume_factor. Eligibility metric. */
  adjusted_edge: number;
  signal: Signal;
  category: string;
  include_in_basket: boolean;
  impossible_edge: boolean;
  hard_excluded: boolean;
  tier_baked: boolean;
  /** True when impossibility is a constitutional/legal constraint (Trump 2028). */
  constitutional: boolean;
}

/**
 * calibration_v5_1: raw_edge is the honest p_market − p_model. adj_edge
 * multiplies raw_edge by time and volume factors and is used only for
 * basket-inclusion eligibility; hard exclusion no longer zeros raw_edge.
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
  const hard_excluded = isHardExcluded(days_to_close, volume);

  // Constitutional/legal impossibility (e.g. Trump 2028) is treated exactly
  // like a screener-flagged impossible: p_model = 0, full premium is edge.
  const constitutional = isConstitutionallyImpossible(question);
  const impossible = isImpossible || constitutional;

  // Impossible markets are special: p_model = 0 by definition, so raw_edge
  // equals the full p_market. They still go through the same time/volume
  // decay for adj_edge so impossible far-future longshots aren't basket-
  // eligible just because raw_edge looks fat.
  if (impossible) {
    const p_model = 0;
    const raw_edge = p_market - p_model;
    const adjusted_edge = raw_edge * time_factor * volume_factor;
    // Impossible NO is a max-conviction short regardless of the time penalty.
    const signal: Signal = raw_edge > 0 ? 'strong_short' : classifySignal(raw_edge);
    return {
      p_model,
      raw_edge,
      base_edge: raw_edge,
      time_factor,
      category_factor: 1.0,
      volume_factor,
      adjusted_edge,
      signal,
      category,
      include_in_basket:
        !hard_excluded &&
        adjusted_edge >= IMPOSSIBLE_INCLUDE_THRESHOLD &&
        !excludedByScreener,
      impossible_edge: true,
      hard_excluded,
      tier_baked: false,
      constitutional,
    };
  }

  // Non-impossible. Subcategory tiers bake category bias into p_model so
  // we no longer apply a separate category_factor on top.
  const base = getBasePModelV5(p_market, question, category);
  const p_model = base.p_model;
  const raw_edge = p_market - p_model;
  void getCategoryFactorV5; // intentionally not part of v5_1's adj_edge math
  const adjusted_edge = raw_edge * time_factor * volume_factor;
  void momentum_factor;
  const signal = classifySignal(raw_edge);

  // Short-basket inclusion: positive edge + classic-longshot p_market range.
  const include_short_side =
    !excludedByScreener &&
    !hard_excluded &&
    adjusted_edge >= EDGE_INCLUDE_THRESHOLD &&
    p_market >= P_MARKET_INCLUDE_MIN &&
    p_market <= P_MARKET_INCLUDE_MAX;

  // Long-basket inclusion: negative edge from the classifySignal threshold
  // (signal in long/strong_long), OR raw_edge below the loosened -0.005 gate
  // for fair-value-classified favorites the model still likes. Same hard
  // quality gates (volume floor, days window, not excluded) but a wider
  // p_market window because tournament favorites sit at 0.10..0.35.
  const include_long_side =
    !excludedByScreener &&
    !hard_excluded &&
    ((signal === 'long' || signal === 'strong_long') || raw_edge < -0.005) &&
    p_market >= 0.05 &&
    p_market <= 0.35;

  const include_in_basket = include_short_side || include_long_side;

  return {
    p_model,
    raw_edge,
    base_edge: raw_edge,
    time_factor,
    category_factor: 1.0,
    volume_factor,
    adjusted_edge,
    signal,
    category,
    include_in_basket,
    impossible_edge: false,
    hard_excluded,
    tier_baked: base.tier_baked,
    constitutional: false,
  };
}

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

  // Per-row scoring does NOT set tournament fields — those are filled in
  // by applyTournamentNormalization (Layer 5).
  return upsertScoredMarket({
    condition_id: s.condition_id,
    source: s.source,
    question: s.question,
    p_market: s.p_market ?? 0,
    p_model: layered.p_model,
    edge: layered.base_edge,
    raw_edge: layered.raw_edge,
    signal: layered.signal,
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
    momentum_factor: 1.0,
    tournament_group: null,
    is_tournament_market: false,
    normalized_p_market: null,
    is_favorite: false,
  });
}

// ---------------------------------------------------------------------
// Layer 5 — tournament normalization
// ---------------------------------------------------------------------

export interface TournamentNormalizationSummary {
  groups: Array<{
    key: string;
    members: number;          // count from scored_markets only
    full_field: number;       // count from live polymarket fetch
    favorites: number;
    longshots: number;
    avg_longshot_edge: number;
    sum_p_market: number;     // from full field, not just scored
    skipped: boolean;
    skipped_reason?: string;
  }>;
  total_favorites: number;
  total_longshots: number;
  total_tournament_markets: number;
}

/**
 * Ephemeral display rows for tournament favorites that aren't in
 * scored_markets (their p_market sits above the screener's 0.10 ceiling).
 * Cleared and repopulated on every normalization pass. The scanner route
 * reads from this cache to surface "underpriced favorite" candidates for
 * the long basket without persisting them.
 */
export interface TournamentFavoriteRow {
  condition_id: string;
  question: string;
  source: 'polymarket';
  category: string;
  p_market: number;            // raw market mid
  normalized_p_market: number; // after vig removal
  p_model: number;             // group-normalized
  raw_edge: number;            // p_market - p_model (negative for favorites)
  adjusted_edge: number;       // raw_edge × time × volume (still negative)
  time_factor: number;
  volume_factor: number;
  signal: Signal;
  tournament_group: string;
  is_tournament_market: true;
  /**
   * True when raw_edge ≤ 0 (model thinks underpriced). False when this
   * tournament participant happens to be a longshot the screener filtered
   * out for being above the 0.10 p_market ceiling — they still need to
   * appear in tournament search results but they are NOT long-basket
   * candidates and we must not let the UI render them with a FAVORITE
   * badge while the signal says SHORT.
   */
  is_favorite: boolean;
  volume: number | null;
  days_to_close: number | null;
  model_version: string;
}

const tournamentFavoritesCache: Map<string, TournamentFavoriteRow[]> = new Map();

/** Read-only accessor for the favorites cache, used by the scanner route. */
export function getTournamentFavorites(groupKey?: string): TournamentFavoriteRow[] {
  if (groupKey) return tournamentFavoritesCache.get(groupKey) ?? [];
  return Array.from(tournamentFavoritesCache.values()).flat();
}

/**
 * Pull live Polymarket markets, flatten to one row per outcome, attach
 * tournament group keys. Cached for the duration of a single
 * applyTournamentNormalization run so we don't refetch per group.
 */
async function fetchTournamentContext(): Promise<Map<string, Array<{ marketId: string; question: string; pMarket: number; volume: number; endDateIso?: string }>>> {
  const byGroup = new Map<string, Array<{ marketId: string; question: string; pMarket: number; volume: number; endDateIso?: string }>>();
  let raw: RawPolymarketMarket[] = [];
  try {
    raw = await getAllActiveMarkets(20);
  } catch (e) {
    console.warn('[tournament] live Polymarket fetch failed:', (e as Error).message);
    return byGroup;
  }
  // De-dupe by conditionId — we only want one row per "Will X win" market,
  // and we want the YES side specifically (the probability of the team
  // actually winning). flattenOutcomes returns both YES and NO sides which
  // would double the group and inflate sum_p_market to ~N.
  const seen = new Set<string>();
  for (const m of raw) {
    const outcomes = flattenOutcomes(m);
    for (const o of outcomes) {
      const label = (o.outcomeLabel ?? '').toLowerCase();
      if (label !== 'yes') continue;
      if (seen.has(o.conditionId)) continue;
      const g = detectTournamentGroup(o.question);
      if (!g) continue;
      seen.add(o.conditionId);
      const arr = byGroup.get(g) ?? [];
      arr.push({
        marketId: o.conditionId,
        question: o.question,
        pMarket: o.pMarket,
        volume: o.volumeUsd,
        endDateIso: o.endDateIso,
      });
      byGroup.set(g, arr);
    }
  }
  return byGroup;
}

/**
 * Renormalize each detected tournament group using its FULL live field
 * (fetched from Polymarket), not just the scored_markets tail. Scored
 * members are persisted with new p_model/raw_edge/adj_edge/signal;
 * favorites that aren't in scored_markets are cached as ephemeral display
 * rows the scanner route can return when filtering by that tournament.
 */
export async function applyTournamentNormalization(
  scored: ScoredMarket[],
): Promise<TournamentNormalizationSummary> {
  // Reset the ephemeral favorites cache before we repopulate.
  tournamentFavoritesCache.clear();

  // Bucket scored rows by detected group.
  const scoredByGroup = new Map<string, ScoredMarket[]>();
  for (const m of scored) {
    const g = detectTournamentGroup(m.question);
    if (!g) continue;
    const arr = scoredByGroup.get(g) ?? [];
    arr.push(m);
    scoredByGroup.set(g, arr);
  }

  // Fetch the live full-field context for every tournament we care about.
  const liveByGroup = await fetchTournamentContext();

  const summary: TournamentNormalizationSummary = {
    groups: [],
    total_favorites: 0,
    total_longshots: 0,
    total_tournament_markets: 0,
  };

  // Process every group that appears EITHER in scored OR live data. A
  // tournament that's all favorites still produces a long-basket signal
  // even if zero scored rows match.
  const allGroupKeys = new Set<string>([...scoredByGroup.keys(), ...liveByGroup.keys()]);

  for (const groupKey of allGroupKeys) {
    const scoredMembers = scoredByGroup.get(groupKey) ?? [];
    const liveMembers = liveByGroup.get(groupKey) ?? [];

    // Merge by market_id — scored rows win on conflict (they have richer
    // metadata). Anything in live but not in scored becomes a favorite
    // candidate (raw market mid likely > 0.10, screener-filtered).
    const scoredIds = new Set(scoredMembers.map((m) => m.condition_id));
    const onlyLive = liveMembers.filter((l) => !scoredIds.has(l.marketId));

    // Full-field probabilities and questions.
    interface Member {
      kind: 'scored' | 'live';
      condition_id: string;
      question: string;
      p_market: number;
      volume: number | null;
      days_to_close: number | null;
      scored?: ScoredMarket;
    }
    const fullField: Member[] = [
      ...scoredMembers.map((m): Member => ({
        kind: 'scored',
        condition_id: m.condition_id,
        question: m.question,
        p_market: Number(m.p_market ?? 0),
        volume: m.volume,
        days_to_close: m.days_to_close,
        scored: m,
      })),
      ...onlyLive.map((l): Member => ({
        kind: 'live',
        condition_id: l.marketId,
        question: l.question,
        p_market: l.pMarket,
        volume: l.volume,
        days_to_close: l.endDateIso ? Math.max(0, Math.round((Date.parse(l.endDateIso) - Date.now()) / 86_400_000)) : null,
      })),
    ];

    if (fullField.length < 2) {
      summary.groups.push({
        key: groupKey, members: scoredMembers.length, full_field: fullField.length,
        favorites: 0, longshots: 0, avg_longshot_edge: 0,
        sum_p_market: fullField.reduce((s, m) => s + m.p_market, 0),
        skipped: true, skipped_reason: 'single_member',
      });
      continue;
    }

    const sumP = fullField.reduce((s, m) => s + m.p_market, 0);
    if (sumP < 0.5 || sumP > 2.5) {
      summary.groups.push({
        key: groupKey, members: scoredMembers.length, full_field: fullField.length,
        favorites: 0, longshots: 0, avg_longshot_edge: 0,
        sum_p_market: sumP,
        skipped: true, skipped_reason: `sum_p_market_out_of_range:${sumP.toFixed(3)}`,
      });
      console.warn(
        `[tournament] skipping ${groupKey}: full_field=${fullField.length} sum_p_market=${sumP.toFixed(3)}`,
      );
      continue;
    }

    // Step b — normalize implied probabilities (remove vig).
    const normalizedImplied = fullField.map((m) => m.p_market / sumP);

    // Step c — sub-category calibration applied to the normalized input.
    const pModelsRaw = fullField.map((m, i) => {
      const sub = detectSportsSubcategory(m.question);
      return sub
        ? getSportsSubcategoryPModel(sub, normalizedImplied[i])
        : getSportsCalibratedPModel(normalizedImplied[i]);
    });

    const sumPModel = pModelsRaw.reduce((s, p) => s + p, 0);
    if (sumPModel <= 0) {
      summary.groups.push({
        key: groupKey, members: scoredMembers.length, full_field: fullField.length,
        favorites: 0, longshots: 0, avg_longshot_edge: 0,
        sum_p_market: sumP,
        skipped: true, skipped_reason: 'zero_p_model_sum',
      });
      continue;
    }
    const pModelsNorm = pModelsRaw.map((p) => p / sumPModel);

    let favCount = 0;
    let longshotCount = 0;
    let longshotEdgeSum = 0;
    const favoriteRowsThisGroup: TournamentFavoriteRow[] = [];
    const favoriteSamples: string[] = [];
    const longshotSamples: string[] = [];

    for (let i = 0; i < fullField.length; i++) {
      const member = fullField[i];
      const newPMarket = normalizedImplied[i];
      const newPModel = pModelsNorm[i];
      const newRawEdge = newPMarket - newPModel;
      const time_factor = getTimeFactor(member.days_to_close);
      const volume_factor = getVolumeFactor(member.volume);
      const newAdjEdge = newRawEdge * time_factor * volume_factor;
      const isFavorite = newRawEdge <= 0;
      const signal = classifySignal(newRawEdge);
      // Tournament inclusion: shorts pass when raw_edge exceeds the longshot
      // threshold; longs pass when the renormalized signal is long/strong_long.
      const include =
        newRawEdge > TOURNAMENT_EDGE_INCLUDE_THRESHOLD ||
        signal === 'long' ||
        signal === 'strong_long';
      const category = 'sports';

      if (isFavorite) favCount += 1;
      if (include) { longshotCount += 1; longshotEdgeSum += newRawEdge; }

      if (isFavorite && favoriteSamples.length < 5) {
        favoriteSamples.push(`${shortTeam(member.question)} ${(newPMarket * 100).toFixed(1)}%`);
      }
      if (!isFavorite && longshotSamples.length < 5) {
        longshotSamples.push(`${shortTeam(member.question)} ${(newPMarket * 100).toFixed(1)}% edge ${(newRawEdge * 100).toFixed(1)}%`);
      }

      if (member.kind === 'scored' && member.scored) {
        const m = member.scored;
        m.p_model = newPModel;
        m.edge = newRawEdge;
        m.raw_edge = newRawEdge;
        m.adjusted_edge = newAdjEdge;
        m.include_in_basket = include;
        m.is_tournament_market = true;
        m.tournament_group = groupKey;
        m.normalized_p_market = newPMarket;
        m.is_favorite = isFavorite;
        m.signal = signal;
        m.time_factor = time_factor;
        m.volume_factor = volume_factor;
        m.category_factor = 1.0;
        m.model_version = MODEL_VERSION;

        try {
          await upsertScoredMarket({
            condition_id: m.condition_id,
            source: m.source,
            question: m.question,
            p_market: m.p_market,
            p_model: newPModel,
            edge: newRawEdge,
            raw_edge: newRawEdge,
            signal,
            adjusted_edge: newAdjEdge,
            time_factor,
            category_factor: 1.0,
            volume_factor,
            volume: m.volume ?? null,
            days_to_close: m.days_to_close ?? null,
            category,
            include_in_basket: include,
            impossible_edge: false,
            model_version: MODEL_VERSION,
            momentum_factor: m.momentum_factor ?? 1.0,
            tournament_group: groupKey,
            is_tournament_market: true,
            normalized_p_market: newPMarket,
            is_favorite: isFavorite,
          });
        } catch (e) {
          console.warn(`[tournament] persist failed ${m.condition_id}: ${(e as Error).message}`);
        }
      } else {
        // Live-only row → cached for the scanner so tournament search
        // surfaces it. Two distinct cases get pushed here:
        //   raw_edge ≤ 0  → real favorite (model thinks underpriced) →
        //                   is_favorite=true, signal forced into the
        //                   long/fair range (never short).
        //   raw_edge > 0  → tournament longshot that sits above the
        //                   screener's 0.10 ceiling — NOT a favorite for
        //                   the long basket; signal keeps its natural
        //                   classifySignal output.
        const isLongCandidate = newRawEdge <= 0;
        const clampedSignal: Signal = isLongCandidate
          ? (newRawEdge < -0.05 ? 'strong_long'
            : newRawEdge < -0.01 ? 'long'
            : 'fair_value')
          : signal;
        favoriteRowsThisGroup.push({
          condition_id: member.condition_id,
          question: member.question,
          source: 'polymarket',
          category,
          p_market: member.p_market,
          normalized_p_market: newPMarket,
          p_model: newPModel,
          raw_edge: newRawEdge,
          adjusted_edge: newAdjEdge,
          time_factor,
          volume_factor,
          signal: clampedSignal,
          tournament_group: groupKey,
          is_tournament_market: true,
          is_favorite: isLongCandidate,
          volume: member.volume,
          days_to_close: member.days_to_close,
          model_version: MODEL_VERSION,
        });
      }
    }

    if (favoriteRowsThisGroup.length > 0) {
      tournamentFavoritesCache.set(groupKey, favoriteRowsThisGroup);
    }

    console.info(
      `[tournament] ${groupKey}: full field ${fullField.length} teams, sum_p=${sumP.toFixed(3)}`,
    );
    if (favoriteSamples.length > 0) {
      console.info(
        `[tournament] favorites (excluded from short basket): ${favoriteSamples.join(', ')}`,
      );
    }
    if (longshotSamples.length > 0) {
      console.info(
        `[tournament] longshots (short candidates): ${longshotSamples.join(', ')}`,
      );
    }

    summary.groups.push({
      key: groupKey,
      members: scoredMembers.length,
      full_field: fullField.length,
      favorites: favCount,
      longshots: longshotCount,
      avg_longshot_edge: longshotCount > 0 ? longshotEdgeSum / longshotCount : 0,
      sum_p_market: sumP,
      skipped: false,
    });
    summary.total_favorites += favCount;
    summary.total_longshots += longshotCount;
    summary.total_tournament_markets += fullField.length;
  }

  return summary;
}

function shortTeam(question: string): string {
  // "Will Brazil win the 2026 FIFA World Cup?" → "Brazil"
  const m = question.match(/^Will\s+([A-Za-z][\w\s.'-]{0,40}?)\s+win\b/i);
  return m ? m[1].trim() : question.slice(0, 24);
}

// ---------------------------------------------------------------------
// Bulk operations
// ---------------------------------------------------------------------

export async function scoreAllMarkets(inputs: MarketToScore[]): Promise<{
  scored: ScoredMarket[];
  included: number;
  impossible_included: number;
  hard_excluded: number;
  tournaments?: TournamentNormalizationSummary;
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

  // Layer 5 — apply tournament normalization across the full scored set.
  const tournaments = await applyTournamentNormalization(scored);
  const included = scored.filter((r) => r.include_in_basket).length;
  return {
    scored,
    included,
    impossible_included: impossibleIncluded,
    hard_excluded: hardExcluded,
    tournaments,
  };
}

export async function rescoreAllStored(): Promise<{
  total: number;
  rescored: number;
  included: number;
  model_version: string;
  tournaments?: TournamentNormalizationSummary;
}> {
  const [scored, screened] = await Promise.all([
    listScoredMarkets(),
    listScreenedMarkets().catch(() => [] as ScreenedMarket[]),
  ]);
  const screenedById = new Map<string, ScreenedMarket>();
  for (const s of screened) screenedById.set(s.condition_id, s);

  let rescored = 0;
  const updatedRows: ScoredMarket[] = [];
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
      updatedRows.push(row);
      rescored += 1;
    } catch (e) {
      console.warn(`[ml-scorer] rescore failed ${sd.condition_id}: ${(e as Error).message}`);
    }
  }

  // Layer 5 — apply tournament normalization across the rescored set.
  const tournaments = await applyTournamentNormalization(updatedRows);
  const included = updatedRows.filter((r) => r.include_in_basket).length;

  console.info(
    `[ml-scorer] rescoreAllStored: ${rescored}/${scored.length} rows → ${MODEL_VERSION} (${included} include_in_basket)`,
  );
  console.info(
    `[tournament] processed ${tournaments.groups.length} group(s): ` +
      tournaments.groups
        .filter((g) => !g.skipped)
        .map((g) => `${g.key} (${g.members} teams: ${g.longshots} longshot, ${g.favorites} fav)`)
        .join(', '),
  );
  if (tournaments.total_favorites > 0 || tournaments.total_longshots > 0) {
    console.info(
      `[tournament] excluded ${tournaments.total_favorites} favorite(s), included ${tournaments.total_longshots} longshot(s) across all groups`,
    );
  }

  return { total: scored.length, rescored, included, model_version: MODEL_VERSION, tournaments };
}

// =====================================================================
// Auto-rescore markets that moved (6h cron). Rerun the ML scorer with the
// live price for any market whose price drifted >5pts from its stored value.
// =====================================================================

export async function rescoreMovedMarkets(): Promise<{ checked: number; moved: number; rescored: number }> {
  const scored = await listScoredMarkets();
  const prices = await getLatestPricesMap(scored.map((s) => s.condition_id)).catch(
    () => new Map<string, { price: number; recorded_at: string }>(),
  );
  let moved = 0;
  let rescored = 0;
  for (const sd of scored) {
    const live = prices.get(sd.condition_id);
    if (!live || !Number.isFinite(live.price)) continue;
    const liveP = live.price;
    const baseline = Number(sd.p_market ?? 0);
    if (Math.abs(liveP - baseline) <= 0.05) continue;
    moved += 1;
    // Leave resolved/blown-up markets to the price-collector's flagging —
    // don't un-flag them by rescoring.
    if ((sd as { signal?: string | null }).signal === 'resolved_likely' || liveP >= 0.8 || liveP <= 0.01) continue;
    const l = computeLayeredScore({
      p_market: liveP,
      question: sd.question,
      isImpossible: sd.impossible_edge ?? false,
      volume: sd.volume,
      days_to_close: sd.days_to_close,
      category: sd.category ?? null,
    });
    try {
      await upsertScoredMarket({
        condition_id: sd.condition_id, source: sd.source, question: sd.question,
        p_market: liveP, p_model: l.p_model, edge: l.raw_edge, raw_edge: l.raw_edge,
        signal: l.signal, adjusted_edge: l.adjusted_edge, time_factor: l.time_factor,
        category_factor: l.category_factor, volume_factor: l.volume_factor, volume: sd.volume ?? null,
        days_to_close: sd.days_to_close ?? null, category: l.category, include_in_basket: l.include_in_basket,
        impossible_edge: sd.impossible_edge ?? false, model_version: MODEL_VERSION, momentum_factor: sd.momentum_factor ?? 1.0,
        tournament_group: (sd as { tournament_group?: string | null }).tournament_group ?? null,
        is_tournament_market: (sd as { is_tournament_market?: boolean }).is_tournament_market ?? false,
        normalized_p_market: (sd as { normalized_p_market?: number | null }).normalized_p_market ?? null,
        is_favorite: (sd as { is_favorite?: boolean }).is_favorite ?? false,
      } as Parameters<typeof upsertScoredMarket>[0]);
      rescored += 1;
    } catch (e) {
      console.warn(`[rescore] failed ${sd.condition_id}: ${(e as Error).message}`);
    }
  }
  console.info(`[rescore] checked ${scored.length} markets, ${moved} had >5% movement, ${rescored} rescored`);
  return { checked: scored.length, moved, rescored };
}
