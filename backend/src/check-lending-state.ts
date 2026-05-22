import * as path from 'path';
import { config as loadDotenv } from 'dotenv';
loadDotenv({ path: path.resolve(__dirname, '..', '..', '.env'), override: true });

import { PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import { getConnection, getAuthorityKeypair, usdcMint, getLendingProgram } from './solana/client';
import { deriveLendingPool, deriveLpMint, derivePoolUsdc, deriveBorrowerAuthority } from './solana/pda';

async function main() {
  const conn = getConnection();
  const authority = getAuthorityKeypair();
  const usdc = usdcMint();
  console.log('authority:', authority.publicKey.toBase58());
  console.log('usdc mint (env):', usdc.toBase58());

  // SOL balance
  const sol = await conn.getBalance(authority.publicKey);
  console.log('authority SOL:', (sol / 1e9).toFixed(4));

  // USDC balance
  const ata = getAssociatedTokenAddressSync(usdc, authority.publicKey);
  console.log('authority USDC ATA:', ata.toBase58());
  try {
    const bal = await conn.getTokenAccountBalance(ata);
    console.log('authority USDC balance:', bal.value.uiAmountString);
  } catch (e) {
    console.log('authority USDC balance: ATA missing / 0 (', (e as Error).message, ')');
  }

  // Pool state
  const [pool] = deriveLendingPool();
  const [lpMint] = deriveLpMint(pool);
  const [poolUsdc] = derivePoolUsdc(pool);
  const [borrowerAuth] = deriveBorrowerAuthority();
  console.log('\npool PDA:', pool.toBase58());
  console.log('lp mint:', lpMint.toBase58());
  console.log('pool usdc:', poolUsdc.toBase58());
  console.log('borrower authority PDA:', borrowerAuth.toBase58());

  const poolInfo = await conn.getAccountInfo(pool);
  console.log('pool initialized?', Boolean(poolInfo));
  if (poolInfo) {
    try {
      const acct = await (getLendingProgram().account as any).pool.fetch(pool);
      console.log('  status:', acct.status, '| lp_mint set:', acct.lpMint?.toBase58?.(), '| pool_usdc set:', acct.poolUsdcAccount?.toBase58?.());
      console.log('  total_principal:', acct.totalPrincipal?.toString?.(), '| total_borrows:', acct.totalBorrows?.toString?.());
      try {
        const pb = await conn.getTokenAccountBalance(poolUsdc);
        console.log('  pool USDC balance:', pb.value.uiAmountString);
      } catch { console.log('  pool USDC balance: 0/missing'); }
    } catch (e) {
      console.log('  could not decode pool:', (e as Error).message);
    }
  }
  const baInfo = await conn.getAccountInfo(borrowerAuth);
  console.log('borrower_authority initialized?', Boolean(baInfo));
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
