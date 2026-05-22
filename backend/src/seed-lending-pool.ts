/**
 * P2 — stand up the contra_lending pool and fund it.
 *   1. initialize_borrower_authority (contra_leverage) — the only allowed borrower
 *   2. initialize_pool / _lending_mint / _lending_tokens (contra_lending)
 *   3. lend USDC from the authority (target 500, capped at available balance)
 * Logs pool PDA, LP tokens received, pool balance.
 *
 * NOTE: devnet USDC (4zMMC9…) mint authority is a 2-of-3 multisig we don't
 * control, so the authority can only lend the USDC it already holds.
 *
 * Run: cd backend && npx tsx src/seed-lending-pool.ts
 */
import * as path from 'path';
import { config as loadDotenv } from 'dotenv';
loadDotenv({ path: path.resolve(__dirname, '..', '..', '.env'), override: true });

import {
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  Transaction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
} from '@solana/spl-token';
import { BN } from '@coral-xyz/anchor';
import {
  getConnection,
  getAuthorityKeypair,
  usdcMint,
  getLendingProgram,
  getLeverageProgram,
} from './solana/client';
import {
  deriveLendingPool,
  deriveLpMint,
  derivePoolUsdc,
  deriveBorrowerAuthority,
} from './solana/pda';

const TARGET_USDC = 500;

async function main() {
  const conn = getConnection();
  const authority = getAuthorityKeypair();
  const usdc = usdcMint();

  const [pool] = deriveLendingPool();
  const [lpMint] = deriveLpMint(pool);
  const [poolUsdc] = derivePoolUsdc(pool);
  const [borrowerAuth] = deriveBorrowerAuthority();

  // 1. borrower_authority (leverage) — idempotent
  const baInfo = await conn.getAccountInfo(borrowerAuth);
  if (!baInfo) {
    await getLeverageProgram().methods
      .initializeBorrowerAuthority()
      .accounts({ borrowerAuthority: borrowerAuth, authority: authority.publicKey, systemProgram: SystemProgram.programId })
      .signers([authority])
      .rpc({ commitment: 'confirmed' });
    console.log('✓ initialize_borrower_authority', borrowerAuth.toBase58());
  } else {
    console.log('• borrower_authority already exists', borrowerAuth.toBase58());
  }

  // 2. pool 3-step init — idempotent
  const lending = getLendingProgram();
  const poolInfo = await conn.getAccountInfo(pool);
  if (!poolInfo) {
    await lending.methods
      .initializePool(borrowerAuth)
      .accounts({ pool, usdcMint: usdc, authority: authority.publicKey, systemProgram: SystemProgram.programId })
      .signers([authority])
      .rpc({ commitment: 'confirmed' });
    console.log('✓ initialize_pool');
    await lending.methods
      .initializeLendingMint()
      .accounts({ pool, lpMint, authority: authority.publicKey, tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId, rent: SYSVAR_RENT_PUBKEY })
      .signers([authority])
      .rpc({ commitment: 'confirmed' });
    console.log('✓ initialize_lending_mint');
    await lending.methods
      .initializeLendingTokens()
      .accounts({ pool, usdcMint: usdc, poolUsdcAccount: poolUsdc, authority: authority.publicKey, tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId, rent: SYSVAR_RENT_PUBKEY })
      .signers([authority])
      .rpc({ commitment: 'confirmed' });
    console.log('✓ initialize_lending_tokens');
  } else {
    console.log('• pool already initialized');
  }

  // 3. lend available USDC (min of target, balance)
  const lenderUsdc = getAssociatedTokenAddressSync(usdc, authority.publicKey);
  const lenderLp = getAssociatedTokenAddressSync(lpMint, authority.publicKey);
  let avail = 0;
  try {
    const bal = await conn.getTokenAccountBalance(lenderUsdc);
    avail = Number(bal.value.uiAmount ?? 0);
  } catch { avail = 0; }
  // Optional override so we can keep a reserve in the authority wallet for
  // a live leveraged-position test (SEED_LEND_USDC=17 leaves 3 for collateral).
  const target = process.env.SEED_LEND_USDC ? Number(process.env.SEED_LEND_USDC) : TARGET_USDC;
  const lendUi = Math.min(target, avail);
  console.log(`authority USDC available: ${avail} → lending ${lendUi}`);

  if (lendUi > 0) {
    const lendRaw = Math.floor(lendUi * 1_000_000);
    const ataIx = createAssociatedTokenAccountIdempotentInstruction(authority.publicKey, lenderLp, authority.publicKey, lpMint);
    const lendIx = await lending.methods
      .lend(new BN(lendRaw))
      .accounts({
        pool,
        lpMint,
        poolUsdcAccount: poolUsdc,
        lender: authority.publicKey,
        lenderUsdcAccount: lenderUsdc,
        lenderLpAccount: lenderLp,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .instruction();
    const tx = new Transaction().add(ataIx, lendIx);
    const sig = await sendAndConfirmTransaction(conn, tx, [authority], { commitment: 'confirmed' });
    console.log('✓ lend', lendUi, 'USDC — sig', sig);
    try {
      const lp = await conn.getTokenAccountBalance(lenderLp);
      console.log('  LP tokens received:', lp.value.uiAmountString);
    } catch {}
  } else {
    console.log('⚠ no USDC available to lend — pool initialized but unfunded (need ≥1 USDC of', usdc.toBase58(), ')');
  }

  try {
    const pb = await conn.getTokenAccountBalance(poolUsdc);
    console.log('pool USDC balance now:', pb.value.uiAmountString);
  } catch { console.log('pool USDC balance: 0'); }

  console.log('\nLENDING_POOL_PDA=' + pool.toBase58());
}

main().then(() => process.exit(0)).catch((e) => { console.error('ERROR:', e.message ?? e); process.exit(1); });
