/**
 * Seeds 5 illustrative baskets with mock legs for UI dev. Useful before
 * the ML pipeline + scanner produce real proposals.
 *
 * Writes to Supabase if configured, otherwise the in-memory store
 * (which lives only inside the running backend process — start the
 * backend first, then run this script with a second process).
 *
 * Run:  cd backend && npx tsx ../scripts/seed-baskets.ts
 */

import 'dotenv/config';
import { createBasket, insertLegs } from '../backend/src/db/queries';

interface SeedDef {
  name: string;
  category: string;
  leverage_type: 'conservative' | 'aggressive' | 'degen';
  legs: number;
  source_mix: 'kalshi' | 'polymarket' | 'both';
  fake_questions: string[];
}

const SEEDS: SeedDef[] = [
  {
    name: 'Macro Longshot Short #4',
    category: 'macro',
    leverage_type: 'aggressive',
    legs: 142,
    source_mix: 'kalshi',
    fake_questions: [
      'Will Fed cut rates 5x in 2026?',
      'Will US enter recession by Q3?',
      'Will 10y yield exceed 6%?',
      'Will EUR/USD hit parity?',
    ],
  },
  {
    name: 'Politics Tail Risk #7',
    category: 'politics',
    leverage_type: 'conservative',
    legs: 203,
    source_mix: 'both',
    fake_questions: [
      'Will Barron Trump become Fed Chair?',
      'Will Newsom win 2028 nomination?',
      'Will third-party candidate win any state?',
    ],
  },
  {
    name: 'Crypto Longshot #2',
    category: 'crypto',
    leverage_type: 'aggressive',
    legs: 89,
    source_mix: 'polymarket',
    fake_questions: [
      'Will BTC hit $250k before July?',
      'Will ETH flip BTC by EOY?',
      'Will SOL exceed $1000?',
    ],
  },
  {
    name: 'Mixed Tail Short #11',
    category: 'mixed',
    leverage_type: 'conservative',
    legs: 178,
    source_mix: 'both',
    fake_questions: [
      'Will Apple acquire Netflix in 2026?',
      'Will SpaceX IPO this year?',
      'Will OpenAI go public?',
    ],
  },
  {
    name: 'Degen Short #1',
    category: 'mixed',
    leverage_type: 'degen',
    legs: 5,
    source_mix: 'kalshi',
    fake_questions: [
      'Will Elon buy Twitter again?',
      'Will Taylor Swift run for office?',
    ],
  },
];

function randomLeg(idx: number, def: SeedDef) {
  const q = def.fake_questions[idx % def.fake_questions.length] + ` (#${idx + 1})`;
  const pMarket = 0.04 + Math.random() * 0.18;
  const pModel = pMarket * (0.3 + Math.random() * 0.4);
  const edge = pMarket - pModel;
  const source: 'kalshi' | 'polymarket' =
    def.source_mix === 'both'
      ? Math.random() < 0.5
        ? 'kalshi'
        : 'polymarket'
      : def.source_mix;
  const weight = 1 / def.legs;
  return {
    leg_index: idx,
    source,
    market_id: `${source}-mock-${idx}`,
    question: q,
    outcome_label: 'YES',
    p_market_entry: pMarket,
    p_model: pModel,
    edge,
    weight,
    outcome: null as 0 | 1 | null,
  };
}

async function main() {
  for (const def of SEEDS) {
    const b = await createBasket({
      name: def.name,
      description: `Seeded mock basket — ${def.legs} legs.`,
      leverage_type: def.leverage_type,
      category: def.category,
      num_legs: def.legs,
    });
    await insertLegs(
      Array.from({ length: def.legs }, (_, i) => ({ ...randomLeg(i, def), basket_id: b.id })),
    );
    console.log(`seeded ${def.name} (${b.id})`);
  }
  console.log('done');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
