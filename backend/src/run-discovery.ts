import * as path from 'path';
import { config as loadDotenv } from 'dotenv';
loadDotenv({ path: path.resolve(__dirname, '..', '..', '.env'), override: true });
import { discoverNewMarkets } from './services/screener';

async function main() {
  const s = await discoverNewMarkets();
  console.log(`\n=== DISCOVERY: checked ${s.checked}, candidates ${s.candidates}, added ${s.added} ===`);
}
main().then(() => process.exit(0)).catch((e) => { console.error('ERROR:', e.message ?? e); process.exit(1); });
