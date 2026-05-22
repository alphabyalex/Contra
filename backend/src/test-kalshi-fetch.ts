import * as path from 'path';
import { config as loadDotenv } from 'dotenv';
loadDotenv({ path: path.resolve(__dirname, '..', '..', '.env'), override: true });
import { fetchKalshiMarkets } from './services/kalshi';

async function main() {
  const markets = await fetchKalshiMarkets();
  console.log(`\n=== Kalshi markets passing filter: ${markets.length} ===`);
  const sorted = [...markets].sort((a, b) => b.volume - a.volume);
  for (const m of sorted.slice(0, 10)) {
    console.log(`  ${(m.p_market * 100).toFixed(1)}% | vol $${Math.round(m.volume).toLocaleString()} | ${m.days_to_close}d | ${m.ticker} | ${m.title.slice(0, 50)}`);
  }
  // Also show the looser picture: how many priced in 0.02-0.12 ignoring volume.
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
