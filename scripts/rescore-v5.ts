/**
 * Rescore all stored markets against calibration_v5, apply tournament
 * normalization, and print a full diagnostic.
 *
 * Why we recompute adj_edge in this script: Supabase's scored_markets
 * table is missing the calibration_v2+ layered columns (adjusted_edge,
 * time_factor, category_factor, volume_factor, plus the v5 tournament
 * columns). The adaptive upsert in queries.ts silently strips them on
 * every save. So we read back the persisted base fields (p_market,
 * p_model, edge, etc.) and recompute the layered output in-memory the
 * same way the /api/scanner/markets endpoint does.
 *
 * Usage:  cd backend && npx tsx ../scripts/rescore-v5.ts
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
  detectPoliticsSubcategory,
} from '../backend/src/services/ml-scorer';

interface EnrichedRow {
  question: string;
  source: string;
  category: string;
  p_market: number;
  p_model_layered: number;
  adj_edge_layered: number;
  base_edge: number;
  include_in_basket: boolean;
  tournament_group: string | null;
  sports_sub: ReturnType<typeof detectSportsSubcategory>;
  politics_sub: ReturnType<typeof detectPoliticsSubcategory>;
  hard_excluded: boolean;
  days_to_close: number | null;
  volume: number | null;
}

async function main() {
  console.log('==> rescoring all stored markets → calibration_v5');
  const result = await rescoreAllStored();
  console.log(`Rescored: ${result.rescored}/${result.total} (model_version=${result.model_version})`);

  // Read the persisted rows so we get the actual screened/impossible flags.
  const [scored, screened] = await Promise.all([
    listScoredMarkets(),
    listScreenedMarkets().catch(() => [] as ScreenedMarket[]),
  ]);
  const screenedById = new Map(screened.map((s) => [s.condition_id, s]));

  const enriched: EnrichedRow[] = scored.map((sd) => {
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
    return {
      question: sd.question,
      source: sd.source,
      category: layered.category,
      p_market: sd.p_market ?? 0,
      p_model_layered: layered.p_model,
      adj_edge_layered: layered.adjusted_edge,
      base_edge: layered.base_edge,
      include_in_basket: layered.include_in_basket,
      tournament_group: detectTournamentGroup(sd.question),
      sports_sub: layered.category === 'sports' ? detectSportsSubcategory(sd.question) : null,
      politics_sub: layered.category === 'politics' ? detectPoliticsSubcategory(sd.question) : null,
      hard_excluded: layered.hard_excluded,
      days_to_close: sd.days_to_close ?? null,
      volume: sd.volume ?? null,
    };
  });

  // --- Tournament group breakdown (in-memory from rescore summary) ---
  if (result.tournaments) {
    console.log('\n--- Tournament groups detected ---');
    for (const g of result.tournaments.groups) {
      if (g.skipped) {
        console.log(
          `  ${g.key.padEnd(34)}  members=${g.members}  SKIPPED (${g.skipped_reason}, sum_p=${g.sum_p_market.toFixed(3)})`,
        );
        continue;
      }
      console.log(
        `  ${g.key.padEnd(34)}  members=${g.members}  favorites=${g.favorites}  longshots=${g.longshots}  avg_longshot_edge=${g.avg_longshot_edge.toFixed(4)}  sum_p=${g.sum_p_market.toFixed(3)}`,
      );
    }
  }

  // Per-group detail for the two groups the user wants to see
  const printGroup = (groupKey: string, label: string) => {
    const members = enriched
      .filter((r) => r.tournament_group === groupKey)
      .sort((a, b) => b.p_market - a.p_market);
    if (members.length === 0) return;
    console.log(`\n--- ${label} (${groupKey}) — detected ${members.length} teams ---`);
    console.log('  team_question (50 chars)                            | p_mkt   | p_model | adj_edge | sub  | tag');
    for (const m of members) {
      const tag = m.hard_excluded ? 'EXCL' : m.include_in_basket ? 'LONGSHOT' : 'middle';
      console.log(
        `  ${truncate(m.question, 50).padEnd(50)} | ${m.p_market.toFixed(4)} | ${m.p_model_layered.toFixed(4)}  | ${signed(m.adj_edge_layered)} | ${(m.sports_sub ?? '-').padEnd(4)} | ${tag}`,
      );
    }
  };
  const groupKeys = Array.from(new Set(enriched.map((r) => r.tournament_group).filter(Boolean))) as string[];
  const fifaKey = groupKeys.find((k) => k.startsWith('fifa_world_cup_'));
  const nbaKey = groupKeys.find((k) => k.startsWith('nba_finals_'));
  if (fifaKey) printGroup(fifaKey, 'FIFA World Cup');
  if (nbaKey) printGroup(nbaKey, 'NBA Finals');

  // --- Top 10 by recomputed adj_edge ---
  const top = [...enriched]
    .filter((r) => !r.hard_excluded)
    .sort((a, b) => b.adj_edge_layered - a.adj_edge_layered)
    .slice(0, 10);
  console.log('\n--- Top 10 by adjusted_edge (in-memory) ---');
  console.log('  question (60 chars)                                          | p_mkt   | p_model | adj_edge | cat       | sub');
  for (const m of top) {
    const sub = m.sports_sub ?? m.politics_sub ?? '-';
    console.log(
      `  ${truncate(m.question, 60).padEnd(60)} | ${m.p_market.toFixed(4)} | ${m.p_model_layered.toFixed(4)}  | ${signed(m.adj_edge_layered)} | ${(m.category ?? '-').padEnd(9)} | ${sub}`,
    );
  }

  // --- Counts ---
  const tournamentCount = enriched.filter((r) => r.tournament_group != null).length;
  const includedCount = enriched.filter((r) => r.include_in_basket && !r.hard_excluded).length;
  console.log('\n--- Summary ---');
  console.log(`  Total markets:           ${enriched.length}`);
  console.log(`  Tournament markets:      ${tournamentCount}`);
  console.log(`  Non-tournament markets:  ${enriched.length - tournamentCount}`);
  console.log(`  Include_in_basket=true:  ${includedCount}`);
  console.log(`  Hard excluded:           ${enriched.filter((r) => r.hard_excluded).length}`);
}

function truncate(s: string, n: number): string {
  if (!s) return '';
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}

function signed(v: number): string {
  return (v >= 0 ? '+' : '') + v.toFixed(4);
}

main().catch((e) => { console.error(e); process.exit(1); });
