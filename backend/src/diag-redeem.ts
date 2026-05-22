import * as path from 'path';
import { config as loadDotenv } from 'dotenv';
loadDotenv({ path: path.resolve(__dirname, '..', '..', '.env'), override: true });
import { getSupabase } from './db/supabase';

const WALLET = '4pRZrqvf3qKbLi6emrg24boEa8tr6gL63fieins9iBDt';

async function main() {
  const sb = getSupabase();
  if (!sb) { console.error('no supabase'); process.exit(1); }

  const baskets = await sb.from('baskets').select('id,name,status').eq('name', 'CTRA-02');
  const ctra02 = baskets.data?.[0];
  console.log('CTRA-02:', ctra02?.id, ctra02?.status);

  const pos = await sb.from('positions').select('*').eq('wallet', WALLET);
  console.log('\n=== POSITIONS ===');
  for (const p of pos.data ?? []) console.log(`basket=${p.basket_id} tokens_held=${p.tokens_held} usdc_deposited=${p.usdc_deposited}`);

  const txs = await sb.from('transactions').select('*').eq('wallet', WALLET).order('created_at', { ascending: false }).limit(15);
  console.log('\n=== TRANSACTIONS (latest 15) ===');
  for (const t of txs.data ?? []) {
    console.log(`${(t.created_at ?? '').slice(0, 19)} | ${String(t.type).padEnd(14)} | usdc_delta=${t.usdc_delta} tokens_delta=${t.tokens_delta} | sig=${String(t.tx_signature ?? '').slice(0, 24)}`);
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error('ERROR', e.message ?? e); process.exit(1); });
