import * as path from 'path';
import { config as loadDotenv } from 'dotenv';
loadDotenv({ path: path.resolve(__dirname, '..', '..', '.env'), override: true });
import { rescoreAllStored, rescoreMovedMarkets, MODEL_VERSION } from './services/ml-scorer';

async function main() {
  console.log('MODEL_VERSION =', MODEL_VERSION);
  const all = await rescoreAllStored();
  console.log(`rescoreAllStored: ${all.rescored}/${all.total} rescored, ${all.included} included`);
  const moved = await rescoreMovedMarkets();
  console.log(`rescoreMovedMarkets: ${moved.rescored} rescored of ${moved.moved} moved (${moved.checked} checked)`);
}
main().then(() => process.exit(0)).catch((e) => { console.error('ERROR', e.message ?? e); process.exit(1); });
