/**
 * FIX 6 — repoint CTRA-1.1 leg 32 from the wrongly-matched "Fed DECREASE
 * 25 bps (June)" market to the correct "Fed INCREASE 25 bps (July 2026)"
 * market. DB/accounting only — the on-chain vault is Active so its leg
 * table is immutable; this corrects the displayed leg + NAV entry basis.
 *
 * Run: cd backend && npx tsx src/fix-fed-leg.ts
 */
import * as path from 'path';
import { config as loadDotenv } from 'dotenv';
loadDotenv({ path: path.resolve(__dirname, '..', '..', '.env'), override: true });

import { getSupabase } from './db/supabase';

const BASKET_ID = '75612c1c-d0cb-47a1-b8a4-73f74ca044ef';
const LEG_INDEX = 32;
const NEW = {
  market_id: '0xb5c0abeecb5502e6e8d83155c27819174d8317af3c425c3afc5a8c45257a3793',
  question: 'Will the Fed increase interest rates by 25 bps after the July 2026 meeting?',
  p_market_entry: 0.0325,
  p_model: 0.0081,
  edge: 0.0244,
};

async function main() {
  const sb = getSupabase();
  if (!sb) {
    console.error('Supabase not configured');
    process.exit(1);
  }
  const { data, error } = await sb
    .from('legs')
    .update(NEW)
    .eq('basket_id', BASKET_ID)
    .eq('leg_index', LEG_INDEX)
    .select();
  if (error) throw error;
  console.log('updated legs rows:', data?.length ?? 0);
  console.log(JSON.stringify(data?.[0], null, 2));
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
