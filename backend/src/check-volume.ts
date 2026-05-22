import * as path from 'path';
import { config as loadDotenv } from 'dotenv';
loadDotenv({ path: path.resolve(__dirname, '..', '..', '.env'), override: true });
import { listScoredMarkets } from './db/queries';

async function main() {
  const all = await listScoredMarkets();
  const nonNull = all.filter((m) => m.volume != null && Number(m.volume) > 0);
  const nullVol = all.filter((m) => m.volume == null || Number(m.volume) === 0);
  console.log(`scored_markets total: ${all.length}`);
  console.log(`  volume non-null & >0: ${nonNull.length}`);
  console.log(`  volume null/0: ${nullVol.length}`);
  // category breakdown of null-volume
  const byCat: Record<string, number> = {};
  for (const m of nullVol) { const c = m.category ?? 'other'; byCat[c] = (byCat[c] ?? 0) + 1; }
  console.log('  null-volume by category:', JSON.stringify(byCat));
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
