import * as path from 'path';
import { config as loadDotenv } from 'dotenv';
loadDotenv({ path: path.resolve(__dirname, '..', '.env') });

import { listScoredMarkets } from '../backend/src/db/queries';

async function main() {
  const scored = await listScoredMarkets();
  console.log(`Total scored: ${scored.length}`);
  const sample = scored.find((m) => m.question.includes('Tucker Carlson'));
  if (sample) {
    console.log('\nTucker Carlson row:');
    for (const k of Object.keys(sample)) {
      console.log(`  ${k}: ${JSON.stringify((sample as any)[k])}`);
    }
  }

  console.log(`\ninclude_in_basket=true rows: ${scored.filter((m) => m.include_in_basket).length}`);
  const top = scored
    .filter((m) => m.include_in_basket)
    .sort((a, b) => Number(b.adjusted_edge ?? 0) - Number(a.adjusted_edge ?? 0))
    .slice(0, 5);
  console.log('\nTop 5 included by adj_edge:');
  for (const m of top) {
    console.log(
      `  p_mkt=${Number(m.p_market).toFixed(4)} p_model=${Number(m.p_model ?? 0).toFixed(4)} adj_edge=${Number(m.adjusted_edge ?? 0).toFixed(4)} ${m.model_version} :: ${m.question.slice(0, 60)}`,
    );
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
