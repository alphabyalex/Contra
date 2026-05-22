/**
 * End-to-end withdraw test (authority acts as the user). Deposits a small
 * amount into CTRA-1.1 to mint CTRS, then withdraws part of it — proving the
 * withdraw tx submits with no "writable privilege escalated" error and the
 * fee routes to the treasury. authority == vault.authority, so it satisfies
 * both the user role and the withdraw co-signer.
 *
 * Run: cd backend && npx tsx src/test-withdraw-e2e.ts
 */
import * as path from 'path';
import { config as loadDotenv } from 'dotenv';
loadDotenv({ path: path.resolve(__dirname, '..', '..', '.env'), override: true });

import { VersionedTransaction } from '@solana/web3.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import { getConnection, getAuthorityKeypair, usdcMint } from './solana/client';
import { buildDepositTransaction } from './solana/deposit';
import { buildRedeemTransaction } from './solana/redeem';
import { deriveVaultPda, deriveContraMint } from './solana/pda';

const BASKET_ID = '75612c1c-d0cb-47a1-b8a4-73f74ca044ef';
const DEPOSIT = 0.5;
const WITHDRAW_TOKENS = 0.25;

async function send(conn: any, b64: string, authority: any, bh: string, lvbh: number, label: string) {
  const tx = VersionedTransaction.deserialize(Uint8Array.from(Buffer.from(b64, 'base64')));
  tx.sign([authority]); // authority == user here, so this fully signs
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 });
  await conn.confirmTransaction({ signature: sig, blockhash: bh, lastValidBlockHeight: lvbh }, 'confirmed');
  console.log(`✓ ${label} — ${sig}`);
  return sig;
}

async function main() {
  const conn = getConnection();
  const authority = getAuthorityKeypair();
  const usdc = usdcMint();
  const [vaultPda] = deriveVaultPda(BASKET_ID);
  const [contraMint] = deriveContraMint(vaultPda);
  const ctrsAta = getAssociatedTokenAddressSync(contraMint, authority.publicKey);
  const ftAta = getAssociatedTokenAddressSync(usdc, authority.publicKey);

  const ftBefore = await conn.getTokenAccountBalance(ftAta).then((b: any) => b.value.uiAmount).catch(() => 0);
  console.log('fee_treasury USDC before:', ftBefore);

  // 1. deposit
  const dep = await buildDepositTransaction({ basketUuid: BASKET_ID, walletAddress: authority.publicKey.toBase58(), amountUsdc: DEPOSIT });
  await send(conn, dep.transactionBase64, authority, dep.recentBlockhash, dep.lastValidBlockHeight, `deposit ${DEPOSIT} USDC`);
  const ctrsAfterDep = await conn.getTokenAccountBalance(ctrsAta).then((b: any) => b.value.uiAmountString).catch(() => '0');
  console.log('  CTRS minted to authority:', ctrsAfterDep);

  // 2. withdraw (the previously-failing path)
  const red = await buildRedeemTransaction({
    basketUuid: BASKET_ID,
    walletAddress: authority.publicKey.toBase58(),
    tokenAmount: WITHDRAW_TOKENS,
    navScaled: 1_000_000,
  });
  await send(conn, red.transactionBase64, authority, red.recentBlockhash, red.lastValidBlockHeight, `withdraw ${WITHDRAW_TOKENS} CTRS`);

  const ctrsAfterW = await conn.getTokenAccountBalance(ctrsAta).then((b: any) => b.value.uiAmountString).catch(() => '0');
  const ftAfter = await conn.getTokenAccountBalance(ftAta).then((b: any) => b.value.uiAmount).catch(() => 0);
  console.log('  CTRS after withdraw:', ctrsAfterW);
  console.log('  fee_treasury USDC after:', ftAfter, '(Δ', (ftAfter - ftBefore).toFixed(6), 'from deposit+withdraw fees)');
  console.log('\n✅ withdraw submitted with NO writable-escalation error');
}
main().then(() => process.exit(0)).catch(async (e) => {
  console.error('ERROR:', e.message ?? e);
  try { const logs = typeof e.getLogs === 'function' ? await e.getLogs() : e.logs; if (logs) console.error('LOGS:\n' + (Array.isArray(logs) ? logs.join('\n') : logs)); } catch {}
  process.exit(1);
});
