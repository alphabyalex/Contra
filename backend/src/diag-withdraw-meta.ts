import * as path from 'path';
import { config as loadDotenv } from 'dotenv';
loadDotenv({ path: path.resolve(__dirname, '..', '..', '.env'), override: true });

import { PublicKey } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { BN } from '@coral-xyz/anchor';
import { getVaultProgram, getAuthorityKeypair, usdcMint } from './solana/client';
import { deriveVaultPda, deriveContraMint, deriveVaultUsdc } from './solana/pda';

const BASKET_ID = '75612c1c-d0cb-47a1-b8a4-73f74ca044ef';
const USER = new PublicKey('So11111111111111111111111111111111111111112');

async function main() {
  const program = getVaultProgram();
  const usdc = usdcMint();
  const authority = getAuthorityKeypair().publicKey;
  const [vaultPda] = deriveVaultPda(BASKET_ID);
  const [contraMint] = deriveContraMint(vaultPda);
  const [vaultUsdc] = deriveVaultUsdc(vaultPda);
  const userUsdc = getAssociatedTokenAddressSync(usdc, USER);
  const userCtrs = getAssociatedTokenAddressSync(contraMint, USER);
  const feeTreasury = getAssociatedTokenAddressSync(usdc, authority);

  const ix = await program.methods
    .withdraw(new BN(1_000_000), new BN(1_000_000))
    .accounts({
      vault: vaultPda, contraMint, vaultUsdcAccount: vaultUsdc, user: USER,
      userContraAccount: userCtrs, userUsdcAccount: userUsdc, feeTreasury,
      authority, tokenProgram: TOKEN_PROGRAM_ID,
    })
    .instruction();

  const label = (pk: PublicKey) => {
    if (pk.equals(TOKEN_PROGRAM_ID)) return 'TOKEN_PROGRAM';
    if (pk.equals(feeTreasury)) return 'fee_treasury';
    if (pk.equals(vaultPda)) return 'vault';
    if (pk.equals(contraMint)) return 'contra_mint';
    if (pk.equals(vaultUsdc)) return 'vault_usdc';
    if (pk.equals(userUsdc)) return 'user_usdc';
    if (pk.equals(userCtrs)) return 'user_ctrs';
    if (pk.equals(USER)) return 'user';
    if (pk.equals(authority)) return 'authority';
    return pk.toBase58();
  };
  console.log('withdraw ix programId:', ix.programId.toBase58());
  console.log('account metas (Anchor-built):');
  ix.keys.forEach((k, i) => {
    console.log(`  [${i}] ${label(k.pubkey).padEnd(14)} signer=${k.isSigner} writable=${k.isWritable}`);
  });
  const ft = ix.keys.find((k) => k.pubkey.equals(feeTreasury));
  console.log('\nfee_treasury writable?', ft?.isWritable);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
