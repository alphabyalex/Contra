/**
 * P7 — verify partial redemption. Inserts a temporary 10-token position for
 * a dummy wallet, calls /api/redeem/prepare for a partial (5 tokens) and a
 * fractional (0.0001) amount + a usdcAmount case, prints the previews, then
 * removes the temp position. No on-chain submit (prepare only builds the tx).
 *
 * Run: cd backend && npx tsx src/verify-partial-redeem.ts
 */
import * as path from 'path';
import { config as loadDotenv } from 'dotenv';
loadDotenv({ path: path.resolve(__dirname, '..', '..', '.env'), override: true });

import { upsertPosition, listPositionsByWallet } from './db/queries';
import { getSupabase } from './db/supabase';

const BASKET_ID = '75612c1c-d0cb-47a1-b8a4-73f74ca044ef';
// Valid base58 32-byte pubkey (wrapped SOL mint) used purely as a test owner.
const WALLET = 'So11111111111111111111111111111111111111112';
const BASE = process.env.SEED_BACKEND_URL ?? 'http://localhost:3001';

async function prepare(body: any) {
  const r = await fetch(`${BASE}/api/redeem/prepare`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j: any = await r.json();
  return { status: r.status, j };
}

async function main() {
  // 1. temp position: 10 tokens, $10 cost basis
  await upsertPosition({ basket_id: BASKET_ID, wallet: WALLET, tokens_delta: 10, usdc_delta: 10, entry_nav: 1 });
  const before = (await listPositionsByWallet(WALLET)).find((p) => p.basket_id === BASKET_ID);
  console.log('temp position tokens_held:', before?.tokens_held);

  // 2a. partial by tokens
  const a = await prepare({ basketId: BASKET_ID, walletAddress: WALLET, tokenAmount: 5 });
  console.log('\n[tokenAmount=5] status', a.status);
  console.log('  tokenAmount', a.j.tokenAmount, '| nav', a.j.current_nav, '| gross', a.j.gross_usdc, '| fee', a.j.fee, '| net', a.j.net_usdc, '| tx?', Boolean(a.j.transaction_b64));

  // 2b. fractional by tokens
  const b = await prepare({ basketId: BASKET_ID, walletAddress: WALLET, tokenAmount: 0.0001 });
  console.log('[tokenAmount=0.0001] status', b.status, '| tokenAmount', b.j.tokenAmount, '| net', b.j.net_usdc, '| tx?', Boolean(b.j.transaction_b64));

  // 2c. by usdc amount
  const c = await prepare({ basketId: BASKET_ID, walletAddress: WALLET, usdcAmount: 3 });
  console.log('[usdcAmount=3] status', c.status, '| tokenAmount', c.j.tokenAmount, '| gross', c.j.gross_usdc, '| net', c.j.net_usdc);

  // 2d. over-balance guard
  const d = await prepare({ basketId: BASKET_ID, walletAddress: WALLET, tokenAmount: 999 });
  console.log('[tokenAmount=999 over-balance] status', d.status, '| error', d.j.error);

  // 3. cleanup — remove temp position
  const sb = getSupabase();
  if (sb) {
    await sb.from('positions').delete().eq('wallet', WALLET).eq('basket_id', BASKET_ID);
    console.log('\ncleaned up temp position');
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
