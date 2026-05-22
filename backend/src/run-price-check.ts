import * as path from 'path';
import { config as loadDotenv } from 'dotenv';
loadDotenv({ path: path.resolve(__dirname, '..', '..', '.env'), override: true });
import { collectAllPrices } from './services/price-collector';

async function main() {
  console.log('running immediate price collection...');
  const s = await collectAllPrices();
  console.log(`\ncollected ${s.collected}, fetched ${s.fetched}, tracked ${s.total}, no-match ${s.skipped_no_match}`);
  console.log(`\n=== FLAGGED (${s.flagged.length}) ===`);
  for (const f of s.flagged) console.log(`  ${(f.price * 100).toFixed(1)}% | ${f.reason} | ${f.condition_id}`);
}
main().then(() => process.exit(0)).catch((e) => { console.error('ERROR:', e.message ?? e); process.exit(1); });
