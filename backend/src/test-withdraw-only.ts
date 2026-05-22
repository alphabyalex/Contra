import * as path from 'path';
import { config as loadDotenv } from 'dotenv';
loadDotenv({ path: path.resolve(__dirname, '..', '..', '.env'), override: true });

import { VersionedTransaction } from '@solana/web3.js';
import { getConnection, getAuthorityKeypair } from './solana/client';
import { buildRedeemTransaction } from './solana/redeem';

const BASKET_ID = '75612c1c-d0cb-47a1-b8a4-73f74ca044ef';

async function main() {
  const conn = getConnection();
  const authority = getAuthorityKeypair();
  const red = await buildRedeemTransaction({
    basketUuid: BASKET_ID,
    walletAddress: authority.publicKey.toBase58(),
    tokenAmount: 0.25,
    navScaled: 1_000_000,
  });
  const tx = VersionedTransaction.deserialize(Uint8Array.from(Buffer.from(red.transactionBase64, 'base64')));
  tx.sign([authority]);
  // Simulate first to capture full logs.
  const sim = await conn.simulateTransaction(tx, { commitment: 'confirmed' });
  console.log('SIM err:', JSON.stringify(sim.value.err));
  console.log('SIM logs:\n' + (sim.value.logs ?? []).join('\n'));
}
main().then(() => process.exit(0)).catch((e) => { console.error('ERROR:', e.message ?? e); process.exit(1); });
