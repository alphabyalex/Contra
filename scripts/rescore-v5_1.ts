/**
 * Rescore all stored markets against calibration_v5_1, apply tournament
 * normalization with the live Polymarket field, and print:
 *   - Top 10 short candidates (highest raw_edge)
 *   - Top 10 long candidates (most negative raw_edge)
 *   - FIFA World Cup full breakdown with normalized values + signals
 *   - Adj_edge sample for 2028 markets (proves they're non-zero)
 *
 * Usage: cd backend && npx tsx ../scripts/rescore-v5_1.ts
 */

import * as path from 'path';
import { config as loadDotenv } from 'dotenv';
loadDotenv({ path: path.resolve(__dirname, '..', '.env') });

import { listScoredMarkets, listScreenedMarkets, type ScreenedMarket } from '../backend/src/db/queries';
import {
  rescoreAllStored,
  computeLayeredScore,
  detectTournamentGroup,
  detectSportsSubcategory,
  classifySignal,
  getTournamentFavorites,
} from '../backend/src/services/ml-scorer';

interface Row {
  question: string;
  source: string;
  category: string;
  p_market: number;          // raw or normalized depending on tournament
  normalized_p_market: number | null;
  p_model: number;
  raw_edge: number;
  adj_edge: number;
  time_factor: number;
  volume_factor: number;
  signal: string;
  include: boolean;
  hard_excluded: boolean;
  is_tournament: boolean;
  is_favorite: boolean;
  tournament_group: string | null;
  days_to_close: number | null;
  volume: number | null;
}

async function main() {
  console.log('==> rescoring all stored markets → calibration_v5_1');
  const result = await rescoreAllStored();
  console.log(`Rescored: ${result.rescored}/${result.total} (model_version=${result.model_version})`);

  const [scored, screened] = await Promise.all([
    listScoredMarkets(),
    listScreenedMarkets().catch(() => [] as ScreenedMarket[]),
  ]);
  const screenedById = new Map(screened.map((s) => [s.condition_id, s]));

  const rows: Row[] = scored.map((sd) => {
    const sc = screenedById.get(sd.condition_id) ?? null;
    const impossible = sc?.impossible ?? sd.impossible_edge ?? false;
    const layered = computeLayeredScore({
      p_market: sd.p_market ?? 0,
      question: sd.question,
      isImpossible: impossible,
      excludedByScreener: sc?.excluded === true,
      volume: sd.volume ?? null,
      days_to_close: sd.days_to_close ?? null,
      category: sd.category ?? null,
    });
    // If tournament normalization persisted updated values, use those —
    // they're correct (group-normalized). Otherwise fall back to the
    // freshly-computed layered output.
    const tg = detectTournamentGroup(sd.question);
    const isTournament = Boolean((sd as any).is_tournament_market || tg);
    const normalized = (sd as any).normalized_p_market != null
      ? Number((sd as any).normalized_p_market)
      : null;
    const persistedRaw = (sd as any).raw_edge != null ? Number((sd as any).raw_edge) : null;
    return {
      question: sd.question,
      source: sd.source,
      category: layered.category,
      p_market: sd.p_market ?? 0,
      normalized_p_market: normalized,
      p_model: sd.p_model != null ? Number(sd.p_model) : layered.p_model,
      raw_edge: persistedRaw ?? layered.raw_edge,
      adj_edge: layered.adjusted_edge,
      time_factor: layered.time_factor,
      volume_factor: layered.volume_factor,
      signal: (sd as any).signal ?? classifySignal(persistedRaw ?? layered.raw_edge),
      include: layered.include_in_basket,
      hard_excluded: layered.hard_excluded,
      is_tournament: isTournament,
      is_favorite: Boolean((sd as any).is_favorite),
      tournament_group: tg,
      days_to_close: sd.days_to_close,
      volume: sd.volume,
    };
  });

  // Also include the live favorite cache so the long-edge top-10 sees them.
  const favs = getTournamentFavorites();
  for (const f of favs) {
    rows.push({
      question: f.question,
      source: f.source,
      category: f.category,
      p_market: f.p_market,
      normalized_p_market: f.normalized_p_market,
      p_model: f.p_model,
      raw_edge: f.raw_edge,
      adj_edge: f.adjusted_edge,
      time_factor: f.time_factor,
      volume_factor: f.volume_factor,
      signal: f.signal,
      include: false,
      hard_excluded: false,
      is_tournament: true,
      is_favorite: true,
      tournament_group: f.tournament_group,
      days_to_close: f.days_to_close,
      volume: f.volume,
    });
  }

  // --- Top 10 short candidates (highest raw_edge) ---
  const topShort = [...rows]
    .filter((r) => !r.is_favorite)
    .sort((a, b) => b.raw_edge - a.raw_edge)
    .slice(0, 10);
  console.log('\n--- Top 10 SHORT candidates (highest raw_edge) ---');
  console.log('  question (55 chars)                                     | p_mkt   | p_model | raw_edge | adj_edge | signal');
  for (const r of topShort) {
    console.log(
      `  ${truncate(r.question, 55).padEnd(55)} | ${r.p_market.toFixed(4)} | ${r.p_model.toFixed(4)}  | ${signed(r.raw_edge)} | ${signed(r.adj_edge)} | ${r.signal}`,
    );
  }

  // --- Top 10 long candidates (most negative raw_edge) ---
  const topLong = [...rows]
    .filter((r) => r.raw_edge < 0)
    .sort((a, b) => a.raw_edge - b.raw_edge)
    .slice(0, 10);
  console.log('\n--- Top 10 LONG candidates (most negative raw_edge) ---');
  if (topLong.length === 0) {
    console.log('  (none — no markets with negative raw_edge)');
  } else {
    console.log('  question (55 chars)                                     | p_mkt   | p_model | raw_edge | adj_edge | signal');
    for (const r of topLong) {
      const display = r.normalized_p_market ?? r.p_market;
      console.log(
        `  ${truncate(r.question, 55).padEnd(55)} | ${display.toFixed(4)} | ${r.p_model.toFixed(4)}  | ${signed(r.raw_edge)} | ${signed(r.adj_edge)} | ${r.signal}`,
      );
    }
  }

  // --- FIFA World Cup full breakdown ---
  const fifa = rows.filter((r) => (r.tournament_group ?? '').startsWith('fifa_world_cup_'));
  if (fifa.length > 0) {
    const groupKey = fifa[0].tournament_group;
    console.log(`\n--- FIFA World Cup full breakdown (${groupKey}) — ${fifa.length} teams ---`);
    const sorted = [...fifa].sort(
      (a, b) => (b.normalized_p_market ?? b.p_market) - (a.normalized_p_market ?? a.p_market),
    );
    console.log('  team_question (55 chars)                               | raw_p   | norm_p | p_model | raw_edge | signal       | tag');
    for (const r of sorted) {
      const tag = r.is_favorite ? 'FAVORITE' : r.include ? 'LONGSHOT' : '-';
      const np = r.normalized_p_market ?? r.p_market;
      console.log(
        `  ${truncate(r.question, 55).padEnd(55)} | ${r.p_market.toFixed(4)} | ${np.toFixed(4)} | ${r.p_model.toFixed(4)}  | ${signed(r.raw_edge)} | ${r.signal.padEnd(12)} | ${tag}`,
      );
    }
  }

  // --- adj_edge sanity check for far-future 2028 markets ---
  const farFuture = rows.filter((r) => r.days_to_close != null && r.days_to_close > 365);
  console.log(`\n--- adj_edge spot-check on ${farFuture.length} far-future (>365d) markets ---`);
  const ffSample = [...farFuture]
    .sort((a, b) => b.raw_edge - a.raw_edge)
    .slice(0, 5);
  for (const r of ffSample) {
    console.log(
      `  ${truncate(r.question, 60).padEnd(60)} | days=${r.days_to_close} | raw_edge=${signed(r.raw_edge)} | adj_edge=${signed(r.adj_edge)} | time_f=${r.time_factor.toFixed(2)} | included=${r.include}`,
    );
  }

  // --- Counts ---
  const tournamentRows = rows.filter((r) => r.is_tournament);
  console.log('\n--- Summary ---');
  console.log(`  Total scored rows:          ${rows.length}`);
  console.log(`  Tournament rows (total):    ${tournamentRows.length}`);
  console.log(`  Tournament favorites:       ${tournamentRows.filter((r) => r.is_favorite).length}`);
  console.log(`  Tournament longshots:       ${tournamentRows.filter((r) => !r.is_favorite && r.include).length}`);
  console.log(`  Signal=strong_short:        ${rows.filter((r) => r.signal === 'strong_short').length}`);
  console.log(`  Signal=short:               ${rows.filter((r) => r.signal === 'short').length}`);
  console.log(`  Signal=long:                ${rows.filter((r) => r.signal === 'long').length}`);
  console.log(`  Signal=strong_long:         ${rows.filter((r) => r.signal === 'strong_long').length}`);
  console.log(`  include_in_basket = true:   ${rows.filter((r) => r.include).length}`);
}

function truncate(s: string, n: number): string {
  if (!s) return '';
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}

function signed(v: number): string {
  return `${v >= 0 ? '+' : ''}${v.toFixed(4)}`;
}

main().catch((e) => { console.error(e); process.exit(1); });
