/**
 * Seeds CTRA-02 (long, 10 legs) into the DB with status='initializing'.
 *
 * Legs are explicit condition_ids resolved offline against scored_markets
 * for the long-signal pool (signal in {long, strong_long}, include_in_basket
 * true, volume > 10k, days 7-260). Equal weighting with drift-corrected 1e6
 * integer scaling so the on-chain activate_vault weight-sum == 1_000_000.
 *
 * Writes baskets + legs rows only. Run scripts/init-vaults.ts and POST
 * /api/admin/init-vault afterwards for the vault PDA + mint + add_leg +
 * activate_vault.
 *
 * Run:  cd backend && npx tsx src/seed-ctra-02.ts
 *       SEED_DRY_RUN=true npx tsx src/seed-ctra-02.ts   (no writes)
 */

import * as path from 'path';
import { config as loadDotenv } from 'dotenv';
loadDotenv({ path: path.resolve(__dirname, '..', '..', '.env'), override: true });

import {
  createBasket,
  insertLegs,
  getScoredMarket,
  type ScoredMarket,
} from './db/queries';

interface Target {
  display: string;
  conditionId: string;
}

// 10 long candidates from the calibration_v6_partial scored pool. Ordered
// by abs(raw_edge) * log10(volume + 1) descending so leg_index 0 is the
// strongest signal (England) and the tail is the weakest (Tampa Bay).
const TARGETS: Target[] = [
  { display: '01 England FIFA WC',         conditionId: '0x375409bc5eeeff961e82b479caeccc20f33d15738e5bce1186d628aa3d9dfb1f' },
  { display: '02 Musetti French Open',     conditionId: '0x99783ea5344cd6535f671ed6642006a66157cd8a2398aca295f1ab99aaf50e34' },
  { display: '03 Yankees World Series',    conditionId: '0x3df7be753c8b6ebbddf31d6d63535c4b31c836cb25b1a73085508a271bc103db' },
  { display: '04 Canadiens Stanley Cup',   conditionId: '0x52847ca1413b76a5570b97c0c432e38dbe61b0140f9d45e912604591b08f6fca' },
  { display: '05 Braves World Series',     conditionId: '0x7c6d624563d7efee94f7ef54da8d35fd794b3cde9ead02df0d413d6ad3886570' },
  { display: '06 OKC Thunder NBA Finals',  conditionId: '0x22e7b5e35423e76842dd3a5e1a21d13793811080d5e7b2896d0c001bd5e97d54' },
  { display: '07 Cubs World Series',       conditionId: '0xae0363bfe26b7de87f4526c47d5de9b324bab3d14690112bd89b34c9ed3552fc' },
  { display: '08 Shelton French Open',     conditionId: '0x2dba5d6bcf0ad364a444985f07286ebf2dc5bc0ee7989ef1227d14c245e301fb' },
  { display: '09 Mariners World Series',   conditionId: '0x8a638b539c43375ea04e0e2501f4a877df4ab35ae67a1f60d0e034d75c8c38ef' },
  { display: '10 Rays World Series',       conditionId: '0x4d9567b9fa71a94b6e43ddb62ea6104cbb01926813938d241cce336bd72a8ba5' },
];

const CTRA02_DESC =
  'Long exposure to underpriced tournament favorites and contenders across major sporting events. Positions appreciate as favorites gain probability ahead of resolution.';

function equalWeights(n: number): number[] {
  const base = Math.floor(1_000_000 / n);
  const scaled = Array(n).fill(base);
  let drift = 1_000_000 - base * n;
  for (let i = 0; drift > 0; i++, drift--) scaled[i % n] += 1;
  return scaled.map((s) => s / 1_000_000);
}

async function main() {
  interface Matched { t: Target; row: ScoredMarket }
  const matched: Matched[] = [];
  const missing: Target[] = [];
  for (const t of TARGETS) {
    const row = await getScoredMarket(t.conditionId);
    if (!row) { missing.push(t); continue; }
    matched.push({ t, row });
  }

  console.log(`matched ${matched.length}/${TARGETS.length}`);
  if (missing.length) {
    console.error('MISSING legs:');
    for (const t of missing) console.error(`  ${t.display}  cid=${t.conditionId.slice(0, 20)}...`);
    throw new Error(`cannot seed: ${missing.length} legs not found in scored_markets`);
  }

  const weights = equalWeights(matched.length);

  if (process.env.SEED_DRY_RUN === 'true') {
    console.log('\n[DRY RUN] would seed CTRA-02 with these legs:');
    matched.forEach((m, i) => {
      const rawEdge = Number((m.row as any).raw_edge ?? m.row.edge ?? 0);
      console.log(
        `  #${(i + 1).toString().padStart(2, '0')} w=${(weights[i] * 100).toFixed(3)}%  ${m.row.source.padEnd(11)} ` +
        `p=${Number(m.row.p_market).toFixed(4)} edge=${rawEdge.toFixed(4)}  ` +
        `sig=${(m.row as any).signal ?? '-'}  ${m.row.question.slice(0, 70)}`,
      );
    });
    const sumScaled = weights.reduce((s, w) => s + Math.round(w * 1_000_000), 0);
    console.log(`\nweight check: Sum round(w x 1e6) = ${sumScaled}  (must be 1000000)`);
    return;
  }

  const basket = await createBasket({
    name: 'CTRA-02',
    description: CTRA02_DESC,
    leverage_type: 'aggressive',
    category: 'sports',
    num_legs: matched.length,
  });

  await insertLegs(
    matched.map((m, i) => {
      // For long legs we want entry priced at the normalized (vig-removed)
      // mid where the basket builder has one, otherwise the raw p_market.
      const normalized = (m.row as any).normalized_p_market;
      const entryP =
        normalized != null && Number.isFinite(Number(normalized))
          ? Number(normalized)
          : Number(m.row.p_market);
      return {
        basket_id: basket.id,
        leg_index: i,
        source: (m.row.source === 'kalshi' ? 'kalshi' : 'polymarket') as 'kalshi' | 'polymarket',
        market_id: m.row.condition_id,
        question: m.row.question,
        outcome_label: 'YES',
        p_market_entry: entryP,
        p_model: Number(m.row.p_model ?? 0),
        edge: Number((m.row as any).raw_edge ?? m.row.edge ?? 0),
        weight: weights[i],
      };
    }),
  );

  const sumScaled = weights.reduce((s, w) => s + Math.round(w * 1_000_000), 0);
  console.log(`\nseeded CTRA-02 id=${basket.id}`);
  console.log(`  ${matched.length} legs, status=initializing, weight sum (1e6) = ${sumScaled}`);
  console.log(`  next: run scripts/init-vaults.ts, then POST /api/admin/init-vault basketId=${basket.id}`);
}

main().then(() => process.exit(0)).catch((e) => {
  console.error(e);
  process.exit(1);
});
