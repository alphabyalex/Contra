import * as path from 'path';
import { config as loadDotenv } from 'dotenv';
loadDotenv({ path: path.resolve(__dirname, '..', '..', '.env'), override: true });

import { VersionedTransaction, PublicKey } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { getConnection, getAuthorityKeypair } from './solana/client';
import { buildRedeemTransaction } from './solana/redeem';

const BASKET_ID = '75612c1c-d0cb-47a1-b8a4-73f74ca044ef';

async function main() {
  const authority = getAuthorityKeypair();
  const red = await buildRedeemTransaction({
    basketUuid: BASKET_ID, walletAddress: authority.publicKey.toBase58(),
    tokenAmount: 0.25, navScaled: 1_000_000,
  });
  const tx = VersionedTransaction.deserialize(Uint8Array.from(Buffer.from(red.transactionBase64, 'base64')));
  const msg = tx.message;
  const keys = msg.staticAccountKeys;
  console.log('header:', JSON.stringify(msg.header));
  console.log('compiled message accounts (writability per v0 header):');
  keys.forEach((k: PublicKey, i: number) => {
    const writable = msg.isAccountWritable(i);
    const signer = msg.isAccountSigner(i);
    const isTok = k.equals(TOKEN_PROGRAM_ID);
    console.log(`  [${i}] ${k.toBase58().slice(0, 8)}… signer=${signer} writable=${writable}${isTok ? '  <-- TOKEN_PROGRAM' : ''}`);
  });
  // Show the withdraw instruction's account index references.
  const withdrawIx = msg.compiledInstructions[msg.compiledInstructions.length - 1];
  console.log('\nwithdraw ix accountKeyIndexes:', JSON.stringify(Array.from(withdrawIx.accountKeyIndexes)));
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
