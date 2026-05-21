import * as path from 'path';
import { config as loadDotenv } from 'dotenv';
loadDotenv({ path: path.resolve(__dirname, '..', '.env') });

import { getSupabase } from '../backend/src/db/supabase';

async function main() {
  const sb = getSupabase();
  if (!sb) { console.error('no supabase'); process.exit(1); }
  const { data: positions } = await sb.from('positions').select('*');
  console.log('positions:', positions?.length ?? 0);
  for (const p of positions ?? []) {
    console.log('  wallet:', p.wallet, 'basket:', p.basket_id, 'tokens_held:', p.tokens_held, 'usdc_deposited:', p.usdc_deposited, 'entry_nav:', p.entry_nav);
  }
  const { data: txs } = await sb.from('transactions').select('*').order('created_at', { ascending: false }).limit(5);
  console.log('recent transactions:', txs?.length ?? 0);
  for (const t of txs ?? []) {
    console.log('  type:', t.type, 'wallet:', t.wallet, 'usdc_delta:', t.usdc_delta, 'tokens_delta:', t.tokens_delta, 'tx_sig:', String(t.tx_signature).slice(0, 16));
  }
}
main().catch(e => { console.error(e); process.exit(1); });
