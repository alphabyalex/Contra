/**
 * Seeds CTRA-03 (short, 34 legs) into the DB with status='initializing'.
 *
 * Leg list and condition_ids are explicit (the operator resolved each
 * from scored_markets via the 18-char prefix probe). Equal weighting
 * with drift-corrected 1e6 integer scaling so the on-chain
 * activate_vault weight-sum == 1_000_000 check passes.
 *
 * Writes baskets + legs rows only. Run scripts/init-vaults.ts and POST
 * /api/admin/init-vault afterwards for the vault PDA + mint + add_leg +
 * activate_vault.
 *
 * Run:  cd backend && npx tsx src/seed-ctra-03.ts
 *       SEED_DRY_RUN=true npx tsx src/seed-ctra-03.ts   (no writes)
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

// 33 legs by full condition_id, resolved offline against scored_markets.
// Choo Mi-ae (previously leg 33) was dropped because the price collector
// had already flagged it signal='resolved_likely' with current mid 0.953,
// which dragged the entry-time NAV down by ~2.6 NAV pts on its own.
const TARGETS: Target[] = [
  { display: '01 Paloma Valencia',     conditionId: '0xd6591e966aebf061547ef34cdf3494ed318969887c8b7fb53f10ed5d5461a547' },
  { display: '02 Charles McCall',      conditionId: '0xf18497fa69a4ca7a92e13814bb332c3c68052d7cd4345970be683d4042a109b7' },
  { display: '03 Israel-Yemen strike', conditionId: '0x3fe18d2b6303ee3a7e406aab679dbc0b0f7504dc6b477a31c69c6ffb04e9e11c' },
  { display: '04 Kharg Island Jun 30', conditionId: '0x6897736d782ce70f47126dfcec6669073f563d6e757e60bc61c0367370d6f73e' },
  { display: '05 Fed July no change',  conditionId: '0x8bf1c1536ecb1c08fe13c6b71e8ab1f58bf3461c4cb79f5f1679f869a06aef86' },
  { display: '06 James Fishback FL',   conditionId: '0xd8b94a79241263ba30e9cd7f58e88bf2a9013ce2ccdce73606916b2f53033466' },
  { display: '07 MetaMask token',      conditionId: '0x44878f202dd18a286de9235acec372e9e6e6ca2b28d269c4138fc2604c9b78a9' },
  { display: '08 OpenAI 750B-1T',      conditionId: '0xb77424a53b7480164118374fb5e97b859bd12b696b1aea55d383ce798c060cf4' },
  { display: '09 Silver 120 Jun',      conditionId: '0x1b252df7e5281d8fb86888619f4ee1f5045c9f2aecb857d361819ca6522e4665' },
  { display: '10 Iran leader change',  conditionId: '0xb196a122933da9aff6cb8b0f3764d0dc5db1859f46c0481c711521eee8524291' },
  { display: '11 Alphabet largest co', conditionId: '0x416242cc0757f9d4aefdfe86893cea90610b3d0928c60e09416e717db7e9f0f0' },
  { display: '12 Tesla robotaxis CA',  conditionId: '0x05854770e1cb3657fffffc0ee4b21768262b7083bd30015247ed4e257cb35a4d' },
  { display: '13 Tampa Bay Rays ALCS', conditionId: '0x538ad2df74cdacae4dd049e16c529921f3d09f10e89400b9f17d970ea4200099' },
  { display: '14 Crude 150 Jun',       conditionId: '0xeda0e0633f131b761cbe6c6e5e16ae347c48d9448a08c5826bfc2c794b63758e' },
  { display: '15 Netanyahu pardoned',  conditionId: '0xc8f7591181f4059ffbdcc4c85b1e9e76f029bef0eb6cc46a80bd5617b947de74' },
  { display: '16 Hegseth out SecDef',  conditionId: '0x269b4de59b444c57f166f690b1ce8c388bf26167c6a68f7613ab5b05e86375a8' },
  { display: '17 Iran coup attempt',   conditionId: '0x17c9dead8bed402d330e2aa5bcfb4d6f7764d3cc60d6508a03be003f4e88e64b' },
  { display: '18 Crude 200 Jun',       conditionId: '0x5f879a52e5349db7f66d386ca75f1a9bb608fdd6a738a1582681613730b23281' },
  { display: '19 BTC ATH Sep 30',      conditionId: '0x6123b5cc75c38ba9783f6c8ea260107b546c7d3454a8f9b5280c9921cc39f3d9' },
  { display: '20 OpenAI 500B-750B',    conditionId: '0x3f9f68feccc892303834833665bf204632438b028254fc2d5bceea757ff61ed3' },
  { display: '21 Valve Cache map',     conditionId: '0xef4ab08541214903ca6eca617416a5fe1867bc3d7008c571f39001b1f62ae58f' },
  { display: '22 Hamas disarm',        conditionId: '0x2cd4df599867b14e835436e67e524cd04bbd67eaa6454c07b294d9dd0470e6b7' },
  { display: '23 Putin out Dec 31',    conditionId: '0x6bd56627aa21311850825edb27e53434a0e17a4f782be0086bc07f71eee00d0d' },
  { display: '24 Yoo Jeong-bok',       conditionId: '0x45d06878c8e37b634909a2216e1d765f88e7f6f3a0cdb7d2c86984543a0ba2cb' },
  { display: '25 Zverev French Open',  conditionId: '0x739e756119534672538d8df821a5b3321e2c802d80afff0c5790126be9b41281' },
  { display: '26 Djokovic Wimbledon',  conditionId: '0x8ba7dc2b5682330a6064966b011f2a6dc6a95b4c6b8589157064f6331ab3e1cd' },
  { display: '27 Trump Nobel',         conditionId: '0x962e5b226a77266ab429029ee04665e8fcfeb10b91af593786ceab871d2e945f' },
  { display: '28 Todd Blanche AG',     conditionId: '0x788c96ce70ff9d8b3a78b4443d5107429d69a658ec956b1db45689771b54c329' },
  { display: '29 Silver 115 Jun',      conditionId: '0x9a8d6ca2d11883eaa923e66ad37e3f490a4171e28003c37d07f9b1040a7cb531' },
  { display: '30 Ukraine peace',       conditionId: '0xa57a027158ce73973cdd13eed901c6e767a1b9e2f88c665dab8757a65b60d203' },
  { display: '31 Oh Se-hoon Seoul',    conditionId: '0xc587bda904f031a973ad3cb57128ca011bfab0f45e6cb3734ed2227c4d4be419' },
  { display: '32 Mbappe Ballon dOr',   conditionId: '0x87091dc5932f015d80c40e71e47cb043c3f8b6098484eb5bc3943cf35ee9afc1' },
  { display: '33 Taylor-Johnson Bond', conditionId: '0x31eaf3b4bfb0c7107250f8aae9dfaf18a821a6c58fe1b5254a1b77542a4c836c' },
];

const CTRA03_DESC =
  'Systematic short exposure to overpriced prediction market outcomes across politics, macro, crypto, and sports. Equal-weighted positions sized by model-estimated mispricing.';

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
    console.log('\n[DRY RUN] would seed CTRA-03 with these legs:');
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
    name: 'CTRA-03',
    description: CTRA03_DESC,
    leverage_type: 'aggressive',
    category: 'mixed',
    num_legs: matched.length,
  });

  await insertLegs(
    matched.map((m, i) => ({
      basket_id: basket.id,
      leg_index: i,
      source: (m.row.source === 'kalshi' ? 'kalshi' : 'polymarket') as 'kalshi' | 'polymarket',
      market_id: m.row.condition_id,
      question: m.row.question,
      outcome_label: 'YES',
      p_market_entry: Number(m.row.p_market),
      p_model: Number(m.row.p_model ?? 0),
      edge: Number((m.row as any).raw_edge ?? m.row.edge ?? 0),
      weight: weights[i],
    })),
  );

  const sumScaled = weights.reduce((s, w) => s + Math.round(w * 1_000_000), 0);
  console.log(`\nseeded CTRA-03 id=${basket.id}`);
  console.log(`  ${matched.length} legs, status=initializing, weight sum (1e6) = ${sumScaled}`);
  console.log(`  next: run scripts/init-vaults.ts, then POST /api/admin/init-vault basketId=${basket.id}`);
}

main().then(() => process.exit(0)).catch((e) => {
  console.error(e);
  process.exit(1);
});
