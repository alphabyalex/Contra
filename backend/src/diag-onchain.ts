import * as path from 'path';
import { config as loadDotenv } from 'dotenv';
loadDotenv({ path: path.resolve(__dirname, '..', '..', '.env'), override: true });
import { getSupabase } from './db/supabase';
import { getConnection, usdcMint, getAuthorityKeypair } from './solana/client';
import { PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';

const WALLET = '4pRZrqvf3qKbLi6emrg24boEa8tr6gL63fieins9iBDt';

async function main() {
  const sb = getSupabase();
  const conn = getConnection();
  const usdc = usdcMint();
  const user = new PublicKey(WALLET);
  const authority = getAuthorityKeypair();
  const userUsdcAta = getAssociatedTokenAddressSync(usdc, user).toBase58();
  const feeTreasuryAta = getAssociatedTokenAddressSync(usdc, authority.publicKey).toBase58();
  console.log('userUsdcAta   :', userUsdcAta);
  console.log('feeTreasuryAta:', feeTreasuryAta);

  // Latest redeem signature for this wallet.
  const txs = await sb!.from('transactions').select('*').eq('wallet', WALLET).eq('type', 'redeem').order('created_at', { ascending: false }).limit(1);
  const sig = txs.data?.[0]?.tx_signature;
  console.log('\nlatest redeem sig:', sig);
  if (!sig || sig.startsWith('pending')) { console.log('no real signature'); return; }

  const tx = await conn.getParsedTransaction(sig, { maxSupportedTransactionVersion: 0 });
  if (!tx) { console.log('tx not found on-chain (maybe expired from RPC history)'); return; }
  console.log('slot:', tx.slot, '| err:', JSON.stringify(tx.meta?.err));
  console.log('\n=== USDC token balance changes (pre → post) ===');
  const pre = tx.meta?.preTokenBalances ?? [];
  const post = tx.meta?.postTokenBalances ?? [];
  const keys = tx.transaction.message.accountKeys.map((k: any) => (k.pubkey ?? k).toString());
  for (let i = 0; i < post.length; i++) {
    const pb = post[i];
    const prb = pre.find((x) => x.accountIndex === pb.accountIndex);
    const acct = keys[pb.accountIndex];
    const preAmt = prb ? Number(prb.uiTokenAmount.uiAmount ?? 0) : 0;
    const postAmt = Number(pb.uiTokenAmount.uiAmount ?? 0);
    const tag = acct === userUsdcAta ? ' <-- USER USDC' : acct === feeTreasuryAta ? ' <-- FEE TREASURY' : '';
    console.log(`acct ${acct.slice(0, 8)}… owner=${(pb.owner ?? '').slice(0, 8)}… ${preAmt} → ${postAmt} (Δ ${(postAmt - preAmt).toFixed(6)})${tag}`);
  }
  console.log('\nlogs:'); for (const l of tx.meta?.logMessages ?? []) console.log('  ', l);
}
main().then(() => process.exit(0)).catch((e) => { console.error('ERROR', e.message ?? e); process.exit(1); });
