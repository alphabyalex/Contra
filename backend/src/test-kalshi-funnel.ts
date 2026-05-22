import * as path from 'path';
import { config as loadDotenv } from 'dotenv';
loadDotenv({ path: path.resolve(__dirname, '..', '..', '.env'), override: true });
import { getAllOpenMarkets, flattenOutcomes } from './services/kalshi';

async function main() {
  const markets = await getAllOpenMarkets(10);
  let priced = 0, inBand = 0;
  const bandRows: { t: string; p: number; v: number }[] = [];
  for (const m of markets) {
    const outs = flattenOutcomes(m);
    const yes = outs.find((o) => o.outcomeLabel === 'YES');
    if (!yes) continue;
    priced++;
    if (yes.pMarket >= 0.02 && yes.pMarket <= 0.12) {
      inBand++;
      bandRows.push({ t: yes.question.slice(0, 40), p: yes.pMarket, v: yes.volumeUsd });
    }
  }
  bandRows.sort((a, b) => b.v - a.v);
  console.log(`\nTOTAL fetched: ${markets.length}`);
  console.log(`priced (YES has price): ${priced}`);
  console.log(`in band 0.02-0.12: ${inBand}`);
  console.log(`  of those, volume>=100000: ${bandRows.filter((r) => r.v >= 100000).length}`);
  console.log(`  volume>=10000: ${bandRows.filter((r) => r.v >= 10000).length}`);
  console.log(`  volume>=1000: ${bandRows.filter((r) => r.v >= 1000).length}`);
  console.log('\ntop 10 in-band by volume:');
  for (const r of bandRows.slice(0, 10)) console.log(`  ${(r.p * 100).toFixed(1)}% | vol ${Math.round(r.v).toLocaleString()} | ${r.t}`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
