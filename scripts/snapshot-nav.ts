/**
 * One-shot NAV snapshot + breakdown printer.
 *
 *   Usage:  cd backend && npx tsx ../scripts/snapshot-nav.ts [basketName]
 *
 * Resolves the basket by name (default 'CTRA-01'), snapshots its NAV
 * using the new mark-to-market formula, persists the snapshot row, then
 * prints:
 *   - per-leg contribution (entry p_market, current p_market, leg pnl)
 *   - total NAV
 *   - the 3 most recent nav_snapshots rows from Supabase
 */

import * as path from 'path';
import { config as loadDotenv } from 'dotenv';
loadDotenv({ path: path.resolve(__dirname, '..', '.env') });

import { listBaskets, listLegs } from '../backend/src/db/queries';
import { getSupabase } from '../backend/src/db/supabase';
import { computeBasketNav, loadCurrentPrices, snapshotBasket } from '../backend/src/services/nav';

async function main() {
  const wantName = (process.argv[2] ?? 'CTRA-01').toUpperCase();
  const baskets = await listBaskets();
  const basket = baskets.find((b) => b.name.toUpperCase() === wantName);
  if (!basket) {
    console.error(`basket "${wantName}" not found`);
    process.exit(1);
  }
  console.log(`Basket: ${basket.name} (${basket.id}), status=${basket.status}`);

  const legs = await listLegs(basket.id);
  console.log(`Legs: ${legs.length}`);

  const prices = await loadCurrentPrices(legs);
  console.log(`Price lookup: ${prices.size} of ${legs.length} open legs have current price`);

  const dryRun = computeBasketNav(legs, prices);

  console.log('\nPer-leg breakdown (top 10 by |leg_pnl| desc):');
  const sorted = [...dryRun.contributions].sort((a, b) => Math.abs(b.legPnl) - Math.abs(a.legPnl));
  for (const c of sorted.slice(0, 10)) {
    const cur = c.currentPMarket == null ? '   —   ' : c.currentPMarket.toFixed(4);
    const sign = c.legPnl >= 0 ? '+' : '';
    console.log(
      `  leg ${String(c.legIndex).padStart(2)} ${c.marketId.slice(0, 14)}…  ` +
        `entry=${c.entryPMarket.toFixed(4)}  cur=${cur}  ` +
        `status=${c.status.padEnd(4)}  weight=${(c.weight * 100).toFixed(2)}%  ` +
        `pnl=${sign}${c.legPnl.toFixed(6)}`,
    );
  }

  console.log(`\nTotal NAV: ${dryRun.nav.toFixed(8)}  (legs resolved: ${dryRun.legsResolved}/${dryRun.legsTotal})`);

  // Persist now.
  const persisted = await snapshotBasket(basket.id, prices);
  console.log(`Persisted: nav=${persisted.nav.toFixed(8)}`);

  // Read last 3 from Supabase.
  const sb = getSupabase();
  if (sb) {
    const { data, error } = await sb
      .from('nav_snapshots')
      .select('*')
      .eq('basket_id', basket.id)
      .order('snapshotted_at', { ascending: false })
      .limit(3);
    if (error) {
      console.warn('failed to read nav_snapshots:', error.message);
    } else {
      console.log('\nLatest 3 nav_snapshots rows:');
      for (const r of (data ?? []) as any[]) {
        console.log(
          `  ${r.snapshotted_at}  nav=${Number(r.nav).toFixed(8)}  legs_resolved=${r.legs_resolved}`,
        );
      }
    }
  } else {
    console.log('(Supabase not configured — running in-memory; no history)');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
