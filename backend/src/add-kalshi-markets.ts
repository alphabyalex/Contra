import * as path from 'path';
import { config as loadDotenv } from 'dotenv';
loadDotenv({ path: path.resolve(__dirname, '..', '..', '.env'), override: true });
import { fetchKalshiMarkets, type InternalCategory } from './services/kalshi';
import { computeLayeredScore, MODEL_VERSION } from './services/ml-scorer';
import { upsertScoredMarket, upsertTrackedMarket, getTrackedMarket, upsertScreenedMarket } from './db/queries';

async function main() {
  // fetchKalshiMarkets() pulls from BOTH /markets and /events internally,
  // dedupes by ticker, and stamps an inferred category on each row.
  const markets = await fetchKalshiMarkets();
  console.log(`fetched-passing: ${markets.length}`);

  // Per-category breakdown BEFORE inserting.
  const byCat = new Map<InternalCategory, number>();
  for (const k of markets) byCat.set(k.category, (byCat.get(k.category) ?? 0) + 1);
  console.log('passed per category:');
  for (const [cat, n] of [...byCat.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${cat.padEnd(9)} ${n}`);
  }

  let inserted = 0;   // new tracked_markets rows
  let skippedDup = 0; // already tracked (dedupe)
  let scoredOk = 0;
  let failed = 0;
  const scored: Array<{ q: string; cat: string; p: number; pm: number; edge: number; adj: number }> = [];

  for (const k of markets) {
    const days = k.days_to_close;
    const l = computeLayeredScore({ p_market: k.p_market, question: k.title, volume: k.volume, days_to_close: days, category: k.category });
    try {
      // FK: scored_markets.condition_id → screened_markets.condition_id, so
      // the screened row must exist first. Kalshi longshots pass screening
      // (binary, not impossible/ambiguous) — record as non-excluded.
      await upsertScreenedMarket({
        condition_id: k.ticker, source: 'kalshi', question: k.title, p_market: k.p_market,
        impossible: false, already_resolved: false, ambiguous: false, excluded: false,
        exclusion_reason: null, screening_model: 'kalshi-auto',
      });
      await upsertScoredMarket({
        condition_id: k.ticker, source: 'kalshi', question: k.title,
        p_market: k.p_market, p_model: l.p_model, edge: l.raw_edge, raw_edge: l.raw_edge,
        signal: l.signal, adjusted_edge: l.adjusted_edge, time_factor: l.time_factor,
        category_factor: l.category_factor, volume_factor: l.volume_factor, volume: k.volume,
        days_to_close: days, category: k.category, include_in_basket: l.include_in_basket,
        impossible_edge: false, model_version: MODEL_VERSION, momentum_factor: 1.0,
        tournament_group: null, is_tournament_market: false, normalized_p_market: null, is_favorite: false,
      } as any);
      scoredOk += 1;

      const existing = await getTrackedMarket(k.ticker);
      if (!existing) {
        await upsertTrackedMarket({
          condition_id: k.ticker, source: 'kalshi', question: k.title, token_id: null,
          category: k.category, p_market_initial: k.p_market, p_model_initial: l.p_model,
          edge_initial: l.raw_edge, resolution_date: null, in_basket: false, outcome: null, resolved_at: null,
        });
        inserted += 1;
      } else {
        skippedDup += 1;
      }
      scored.push({ q: k.title, cat: k.category, p: k.p_market, pm: l.p_model, edge: l.raw_edge, adj: l.adjusted_edge });
    } catch (e) {
      failed += 1;
      console.warn(`failed ${k.ticker}: ${(e as Error).message}`);
    }
  }

  console.log(`\nscored upserts: ${scoredOk} | tracked inserted: ${inserted} | skipped (already tracked): ${skippedDup} | failed: ${failed}`);
  scored.sort((a, b) => Math.abs(b.adj) - Math.abs(a.adj));
  console.log(`\nTop 8 by |adj_edge|:`);
  for (const s of scored.slice(0, 8)) {
    console.log(`  [${s.cat.padEnd(8)}] p=${(s.p * 100).toFixed(1)}% pm=${(s.pm * 100).toFixed(1)}% edge=${(s.edge * 100).toFixed(2)}% adj=${(s.adj * 100).toFixed(2)}% | ${s.q.slice(0, 50)}`);
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error('ERROR:', e.message ?? e); process.exit(1); });
