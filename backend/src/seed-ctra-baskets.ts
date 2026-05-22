/**
 * Seeds CTRA-1.1 (short, 43 legs) and CTRA-02 (long, 7 legs) into the DB
 * with status='initializing'. Matches each target question to a
 * condition_id by token-Jaccard similarity:
 *   - short legs  → scored_markets (calibration_v5_1 layered scoring)
 *   - long  legs  → live scanner pool (tournament favorites, normalized)
 *
 * Weights are equal (1/N) but drift-corrected to integer 1e6 units so the
 * on-chain activate_vault weight-sum == 1_000_000 check passes (the admin
 * init route rounds each leg.weight × 1e6 independently, no drift fix).
 *
 * Writes NOTHING on-chain — run scripts/init-vaults.ts + POST
 * /api/admin/init-vault afterwards for the vault PDA + mint + add_leg.
 *
 * Run:  cd backend && npx tsx src/seed-ctra-baskets.ts
 *       SEED_DRY_RUN=true npx tsx src/seed-ctra-baskets.ts   (no writes)
 */

import * as path from 'path';
import { config as loadDotenv } from 'dotenv';
loadDotenv({ path: path.resolve(__dirname, '..', '..', '.env'), override: true });

import {
  createBasket,
  insertLegs,
  listScoredMarkets,
  listScreenedMarkets,
  listTrackedMarkets,
} from './db/queries';
import {
  computeLayeredScore,
  detectTournamentGroup,
  detectSportsSubcategory,
  getSportsSubcategoryPModel,
  getSportsCalibratedPModel,
} from './services/ml-scorer';

const BACKEND = process.env.SEED_BACKEND_URL ?? 'http://localhost:3001';

interface Cand {
  conditionId: string;
  source: string;
  question: string;
  pMarket: number;
  pModel: number;
  edge: number;
  normalizedPMarket: number | null;
}

function tokenize(s: string): Set<string> {
  return new Set(s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((t) => t.length > 2));
}
function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}
function bestMatch(target: string, cands: Cand[]): { c: Cand; score: number } | null {
  const tt = tokenize(target);
  let best: { c: Cand; score: number } | null = null;
  for (const c of cands) {
    const score = jaccard(tt, tokenize(c.question));
    if (!best || score > best.score) best = { c, score };
  }
  return best;
}
function equalWeights(n: number): number[] {
  const base = Math.floor(1_000_000 / n);
  const scaled = Array(n).fill(base);
  let drift = 1_000_000 - base * n;
  for (let i = 0; drift > 0; i++, drift--) scaled[i % n] += 1;
  return scaled.map((s) => s / 1_000_000);
}

async function shortPool(): Promise<Cand[]> {
  const [scored, screened, tracked] = await Promise.all([
    listScoredMarkets(),
    listScreenedMarkets().catch(() => []),
    listTrackedMarkets().catch(() => []),
  ]);
  const screenedById = new Map(screened.map((s) => [s.condition_id, s]));
  const trackedById = new Map(tracked.map((t) => [t.condition_id, t]));

  interface Row extends Cand { tournamentGroup: string | null }
  const rows: Row[] = scored.map((sd) => {
    const sc = screenedById.get(sd.condition_id);
    const tm = trackedById.get(sd.condition_id);
    const impossible = sc?.impossible ?? sd.impossible_edge ?? false;
    const volume = sd.volume ?? null;
    let days = sd.days_to_close ?? null;
    if (days == null && tm?.resolution_date) {
      const t = Date.parse(tm.resolution_date);
      if (!Number.isNaN(t)) days = Math.max(0, Math.round((t - Date.now()) / 86_400_000));
    }
    const l = computeLayeredScore({
      p_market: sd.p_market ?? 0,
      question: sd.question,
      isImpossible: impossible,
      excludedByScreener: sc?.excluded ?? false,
      volume,
      days_to_close: days,
      category: sd.category ?? null,
    });
    return {
      conditionId: sd.condition_id,
      source: sd.source,
      question: sd.question,
      pMarket: sd.p_market ?? 0,
      pModel: l.p_model,
      edge: l.raw_edge,
      normalizedPMarket: null,
      tournamentGroup: detectTournamentGroup(sd.question),
    };
  });

  const groups = new Map<string, Row[]>();
  for (const r of rows) if (r.tournamentGroup) {
    const a = groups.get(r.tournamentGroup) ?? [];
    a.push(r);
    groups.set(r.tournamentGroup, a);
  }
  for (const [, members] of groups) {
    if (members.length < 2) continue;
    const sumP = members.reduce((s, m) => s + m.pMarket, 0);
    if (sumP < 0.5 || sumP > 2.5) continue;
    const ni = members.map((m) => m.pMarket / sumP);
    const pm = members.map((m, i) => {
      const sub = detectSportsSubcategory(m.question);
      return sub ? getSportsSubcategoryPModel(sub, ni[i]) : getSportsCalibratedPModel(ni[i]);
    });
    const sumPM = pm.reduce((s, p) => s + p, 0);
    if (sumPM <= 0) continue;
    const pmn = pm.map((p) => p / sumPM);
    members.forEach((m, i) => {
      m.normalizedPMarket = ni[i];
      m.pModel = pmn[i];
      m.edge = ni[i] - pmn[i];
    });
  }
  return rows;
}

async function longPool(): Promise<Cand[]> {
  const res = await fetch(`${BACKEND}/api/scanner/markets?search=win&limit=2000`);
  const j: any = await res.json();
  return (j.rows ?? []).map((r: any) => ({
    conditionId: r.condition_id,
    source: r.source,
    question: r.question,
    pMarket: r.p_market,
    pModel: r.p_model,
    edge: r.raw_edge,
    normalizedPMarket: r.normalized_p_market ?? null,
  }));
}

const SHORT_QS = [
  'Will there be no change in Fed interest rates after the June meeting',
  'Kharg Island no longer under Iranian control by June 30',
  'Will MetaMask launch a token by June 30',
  'Will Silver (SI) hit (HIGH) $120 by end of June',
  'Will Crude Oil (CL) hit (HIGH) $175 by end of June',
  "Will Alexander Zverev win the 2026 Men's French Open",
  "Will Novak Djokovic be the 2026 Men's Wimbledon winner",
  'Will Portugal win the 2026 FIFA World Cup',
  'Bitcoin all time high by September 30 2026',
  'Will Crude Oil (CL) hit (HIGH) $200 by end of June',
  "Will Amanda Anisimova be the 2026 Women's Wimbledon Winner",
  'Will France UK or Germany strike Iran by June 30',
  'Will the Minnesota Timberwolves win the NBA Western Conference Finals',
  'Will Germany win the 2026 FIFA World Cup',
  'Will the Detroit Pistons win the 2026 NBA Finals',
  'Will Reza Pahlavi enter Iran by June 30',
  "Will Alexander Zverev be the 2026 Men's Wimbledon winner",
  'Will Renan Santos finish 2nd in the first round Brazil',
  'Will the Buffalo Sabres win the 2026 NHL Stanley Cup',
  'Will Jay Collins be the Republican nominee for Florida Governor',
  'Will Netherlands win the 2026 FIFA World Cup',
  'Will Renan Santos win the 2026 Brazilian presidential election',
  'Will the LDPR gain the most seats Russia',
  'Will the Sweden Democrats win the most seats',
  'Will there be no change in Fed interest rates after the July meeting',
  'Will San Diego Padres win the 2026 NL Championship',
  'Will Steve Hilton win the California Governor Election',
  'Will the Republican Party hold exactly 28 or 29 governorships',
  'Will the Minnesota Wild win the 2026 NHL Stanley Cup',
  'Will the Anaheim Ducks win the 2026 NHL Stanley Cup',
  "Will Mirra Andreeva be the 2026 Women's Wimbledon Winner",
  'Will JB Bickerstaff win the 2025-2026 NBA Coach of the Year',
  'Will the Fed increase interest rates by 25 bps after June',
  'Will the Chicago Cubs win the 2026 World Series',
  'Will Cleveland Guardians win the 2026 AL Championship',
  'Will the Seattle Mariners win the 2026 World Series',
  'Will Shai Gilgeous-Alexander win the 2025-2026 NBA MVP',
  "Will Lorenzo Musetti win the 2026 Men's French Open",
  'Will Romeu Zema win the 2026 Brazilian presidential election',
  'Will the KPRF gain the most seats Russia',
  'Will Fernando Haddad win the 2026 Brazilian presidential election',
  'Will Cleveland Cavaliers win the 2026 NBA Finals',
  'Will David Lisnard win the 2027 French presidential election',
];

const LONG_QS = [
  'Will France win the 2026 FIFA World Cup',
  'Will Spain win the 2026 FIFA World Cup',
  'Will England win the 2026 FIFA World Cup',
  'Will Brazil win the 2026 FIFA World Cup',
  'Will Argentina win the 2026 FIFA World Cup',
  'Will the Carolina Hurricanes win the 2026 NHL Stanley Cup',
  'Will the Colorado Avalanche win the 2026 NHL Stanley Cup',
];

const CTRA11_DESC =
  'Systematic short exposure to overpriced prediction market outcomes across sports, politics, macro, and crypto. Each position represents a NO on a market our model identifies as statistically mispriced. Designed to be held to resolution.';
const CTRA02_DESC =
  'Long exposure to underpriced tournament favorites across major sporting events. Positions appreciate as favorites gain probability ahead of resolution. Active traders may benefit from selling before final resolution as momentum builds.';

interface Matched { q: string; c: Cand; score: number }

function matchAll(targets: string[], pool: Cand[]): { matched: Matched[]; missing: string[] } {
  const matched: Matched[] = [];
  const missing: string[] = [];
  const used = new Set<string>();
  for (const q of targets) {
    const candsLeft = pool.filter((c) => !used.has(c.conditionId));
    const b = bestMatch(q, candsLeft);
    if (b && b.score >= 0.4) {
      used.add(b.c.conditionId);
      matched.push({ q, c: b.c, score: b.score });
    } else {
      missing.push(q);
      if (b) console.warn(`  weak match for "${q}" → "${b.c.question}" (${b.score.toFixed(2)})`);
    }
  }
  return { matched, missing };
}

async function seed(name: string, type: 'short' | 'long', desc: string, matched: Matched[]) {
  const weights = equalWeights(matched.length);
  const basket = await createBasket({
    name,
    description: desc,
    leverage_type: 'aggressive',
    category: type === 'short' ? 'mixed' : 'sports',
    num_legs: matched.length,
  });
  await insertLegs(
    matched.map((m, i) => {
      const entryP = type === 'long' ? (m.c.normalizedPMarket ?? m.c.pMarket) : m.c.pMarket;
      return {
        basket_id: basket.id,
        leg_index: i,
        source: (m.c.source === 'kalshi' ? 'kalshi' : 'polymarket') as 'kalshi' | 'polymarket',
        market_id: m.c.conditionId,
        question: m.c.question,
        outcome_label: 'YES',
        p_market_entry: entryP,
        p_model: m.c.pModel,
        edge: m.c.edge,
        weight: weights[i],
      };
    }),
  );
  const sumScaled = weights.reduce((s, w) => s + Math.round(w * 1_000_000), 0);
  console.log(`\n✓ seeded ${name} (${basket.id}) — ${matched.length} legs, status=initializing`);
  console.log(`  weight check: Σ round(w×1e6) = ${sumScaled} (must be 1000000)`);
  return basket.id;
}

async function main() {
  console.log('Building pools…');
  const [sPool, lPool] = await Promise.all([shortPool(), longPool()]);
  console.log(`short pool: ${sPool.length} rows | long pool: ${lPool.length} rows`);

  const sMatch = matchAll(SHORT_QS, sPool);
  console.log(`\nCTRA-1.1: matched ${sMatch.matched.length}/${SHORT_QS.length}`);
  if (sMatch.missing.length) console.log('  MISSING:', sMatch.missing);

  const lMatch = matchAll(LONG_QS, lPool);
  console.log(`CTRA-02: matched ${lMatch.matched.length}/${LONG_QS.length}`);
  if (lMatch.missing.length) console.log('  MISSING:', lMatch.missing);

  if (process.env.SEED_DRY_RUN === 'true') {
    console.log('\n[dry run] not writing. Matched short legs:');
    sMatch.matched.forEach((m, i) =>
      console.log(`  ${i + 1}. ${m.c.question} (${m.score.toFixed(2)}) p=${m.c.pMarket.toFixed(3)} pm=${m.c.pModel.toFixed(3)}`),
    );
    console.log('Matched long legs:');
    lMatch.matched.forEach((m, i) =>
      console.log(`  ${i + 1}. ${m.c.question} (${m.score.toFixed(2)}) norm=${(m.c.normalizedPMarket ?? m.c.pMarket).toFixed(3)} pm=${m.c.pModel.toFixed(3)} edge=${m.c.edge.toFixed(3)}`),
    );
    return;
  }

  await seed('CTRA-1.1', 'short', CTRA11_DESC, sMatch.matched);
  await seed('CTRA-02', 'long', CTRA02_DESC, lMatch.matched);
  console.log('\nDone. Next: init vaults on-chain.');
}

main().then(() => process.exit(0)).catch((e) => {
  console.error(e);
  process.exit(1);
});
