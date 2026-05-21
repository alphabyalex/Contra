import * as path from 'path';
import { config as loadDotenv } from 'dotenv';
loadDotenv({ path: path.resolve(__dirname, '..', '.env') });
import { listScoredMarkets } from '../backend/src/db/queries';

async function main() {
  const all = await listScoredMarkets();
  const politics = all.filter((m) => (m.category ?? '').toLowerCase() === 'politics');
  console.log('politics total in scored_markets:', politics.length);
  const eligible = politics.filter(
    (p) =>
      (p.days_to_close == null || (p.days_to_close >= 3 && p.days_to_close <= 365)) &&
      Number(p.volume ?? 0) >= 100_000,
  );
  console.log('eligible (3-365d AND vol>=100k):', eligible.length);
  for (const p of eligible) {
    console.log(
      '  ELIG',
      String(p.question).slice(0, 60).padEnd(60),
      'days=' + p.days_to_close,
      'vol=' + Number(p.volume ?? 0),
    );
  }
  const nearTerm = politics.filter((p) => p.days_to_close != null && p.days_to_close >= 3 && p.days_to_close <= 365);
  console.log('\nnear-term (3-365d, any volume):', nearTerm.length);
  for (const p of nearTerm) {
    console.log(
      '  NEAR',
      String(p.question).slice(0, 60).padEnd(60),
      'days=' + p.days_to_close,
      'vol=' + Number(p.volume ?? 0),
    );
  }
  const closed = politics.filter((p) => p.days_to_close != null && p.days_to_close < 3);
  console.log('\n<3d politics (excluded):', closed.length);
  for (const p of closed) {
    console.log('  CLOSED', String(p.question).slice(0, 60).padEnd(60), 'days=' + p.days_to_close);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
