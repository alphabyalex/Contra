/**
 * Withdraw test with a DISTINCT user (≠ authority) to rule out the
 * user==authority account-dedup artifact. Funds a fresh keypair with SOL +
 * CTRS, then runs the withdraw (authority co-signs the NAV, user signs the burn).
 *
 * Run: cd backend && npx tsx src/test-withdraw-distinct.ts
 */
import * as path from 'path';
import { config as loadDotenv } from 'dotenv';
loadDotenv({ path: path.resolve(__dirname, '..', '..', '.env'), override: true });

import {
  Keypair, VersionedTransaction, Transaction, SystemProgram, sendAndConfirmTransaction,
} from '@solana/web3.js';
import {
  getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction,
  createTransferInstruction,
} from '@solana/spl-token';
import { getConnection, getAuthorityKeypair } from './solana/client';
import { buildRedeemTransaction } from './solana/redeem';
import { deriveVaultPda, deriveContraMint } from './solana/pda';

const BASKET_ID = '75612c1c-d0cb-47a1-b8a4-73f74ca044ef';

async function main() {
  const conn = getConnection();
  const authority = getAuthorityKeypair();
  const user = Keypair.generate();
  console.log('fresh user:', user.publicKey.toBase58());

  const [vaultPda] = deriveVaultPda(BASKET_ID);
  const [contraMint] = deriveContraMint(vaultPda);
  const authCtrs = getAssociatedTokenAddressSync(contraMint, authority.publicKey);
  const userCtrs = getAssociatedTokenAddressSync(contraMint, user.publicKey);

  // 1. fund user with SOL + create its CTRS ATA + send 0.2 CTRS
  const fund = new Transaction().add(
    SystemProgram.transfer({ fromPubkey: authority.publicKey, toPubkey: user.publicKey, lamports: 30_000_000 }),
    createAssociatedTokenAccountIdempotentInstruction(authority.publicKey, userCtrs, user.publicKey, contraMint),
    createTransferInstruction(authCtrs, userCtrs, authority.publicKey, 200_000),
  );
  const fsig = await sendAndConfirmTransaction(conn, fund, [authority], { commitment: 'confirmed' });
  console.log('✓ funded user (SOL + 0.2 CTRS) —', fsig);

  // 2. withdraw 0.1 CTRS as the fresh user
  const red = await buildRedeemTransaction({
    basketUuid: BASKET_ID, walletAddress: user.publicKey.toBase58(),
    tokenAmount: 0.1, navScaled: 1_000_000,
  });
  const tx = VersionedTransaction.deserialize(Uint8Array.from(Buffer.from(red.transactionBase64, 'base64')));
  // authority signature already applied by builder; user signs the burn.
  tx.sign([user]);
  const sim = await conn.simulateTransaction(tx, { commitment: 'confirmed' });
  console.log('SIM err:', JSON.stringify(sim.value.err));
  if (sim.value.err) {
    console.log('SIM logs:\n' + (sim.value.logs ?? []).join('\n'));
    return;
  }
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 });
  await conn.confirmTransaction({ signature: sig, blockhash: red.recentBlockhash, lastValidBlockHeight: red.lastValidBlockHeight }, 'confirmed');
  console.log('✅ withdraw landed for distinct user —', sig);
}
main().then(() => process.exit(0)).catch((e) => { console.error('ERROR:', e.message ?? e); process.exit(1); });
