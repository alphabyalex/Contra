/**
 * Live 2x leveraged-position test. Uses the authority keypair AS the user
 * (only keypair we can sign with headless), builds the leveraged tx via the
 * real backend builder, signs, submits, and verifies the on-chain position.
 *
 * Run: cd backend && npx tsx src/test-leverage-open.ts
 */
import * as path from 'path';
import { config as loadDotenv } from 'dotenv';
loadDotenv({ path: path.resolve(__dirname, '..', '..', '.env'), override: true });

import {
  ComputeBudgetProgram,
  PublicKey,
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
import { getConnection, getAuthorityKeypair, getLeverageProgram, usdcMint } from './solana/client';
import {
  deriveVaultPda,
  deriveContraMint,
  deriveVaultUsdc,
  derivePosition,
  derivePositionUsdc,
  derivePositionCtrs,
  deriveLendingPool,
  derivePoolUsdc,
  deriveBorrowerAuthority,
  contraVaultProgramId,
  contraLendingProgramId,
  uuidToBytes,
} from './solana/pda';

const BASKET_ID = '75612c1c-d0cb-47a1-b8a4-73f74ca044ef'; // CTRA-1.1
const COLLATERAL = 2;
const LEVERAGE = 2 as const;

async function main() {
  const conn = getConnection();
  const authority = getAuthorityKeypair();
  const user = authority.publicKey;
  const leverage = getLeverageProgram();
  const usdc = usdcMint();
  console.log('user (=authority):', user.toBase58());

  const [pool] = deriveLendingPool();
  const [poolUsdc] = derivePoolUsdc(pool);
  const [vaultPda] = deriveVaultPda(BASKET_ID);
  const [contraMint] = deriveContraMint(vaultPda);
  const [vaultUsdc] = deriveVaultUsdc(vaultPda);
  const [position] = derivePosition(BASKET_ID, user);
  const [positionUsdc] = derivePositionUsdc(position);
  const [positionCtrs] = derivePositionCtrs(position);
  const [borrowerAuth] = deriveBorrowerAuthority();
  const userUsdc = getAssociatedTokenAddressSync(usdc, user);
  const feeTreasury = getAssociatedTokenAddressSync(usdc, authority.publicKey);
  const uuidBytes = [...uuidToBytes(BASKET_ID)] as number[];
  const collateralRaw = Math.round(COLLATERAL * 1e6);
  const leverageBps = LEVERAGE * 10_000;

  const poolBefore = (await conn.getTokenAccountBalance(poolUsdc)).value.uiAmountString;
  console.log('pool USDC before:', poolBefore);

  // --- tx1: init_position + init_position_tokens (skip if already done) ---
  const existing = await conn.getAccountInfo(position);
  if (!existing) {
    const initIx = await leverage.methods
      .initPosition(uuidBytes)
      .accounts({ vault: vaultPda, position, user, systemProgram: SystemProgram.programId })
      .instruction();
    const initTokensIx = await leverage.methods
      .initPositionTokens()
      .accounts({
        position, vault: vaultPda, usdcMint: usdc, contraMint, positionUsdc, positionCtrs,
        user, tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId, rent: SYSVAR_RENT_PUBKEY,
      })
      .instruction();
    const tx1 = new Transaction().add(initIx, initTokensIx);
    const sig1 = await sendAndConfirmTransaction(conn, tx1, [authority], { commitment: 'confirmed' });
    console.log('✓ tx1 init_position + init_position_tokens —', sig1);
  } else {
    // Position exists from a prior run. If it's already Open, nothing to do.
    const acct: any = await (getLeverageProgram().account as any).position.fetch(position);
    if (acct.status !== 0) {
      console.log('position already opened (status', acct.status, ') — skipping open. ctrs_held:', acct.ctrsHeld?.toString?.());
      return;
    }
    console.log('• position already initialized (status Initializing) — proceeding to open');
  }

  // --- tx2: open_position ---
  const openIx = await leverage.methods
    .openPosition(new BN(collateralRaw), new BN(leverageBps))
    .accounts({
      position, vault: vaultPda, contraMint, vaultUsdcAccount: vaultUsdc, feeTreasury,
      lendingPool: pool, lendingPoolUsdc: poolUsdc, borrowerAuthority: borrowerAuth,
      positionUsdcAccount: positionUsdc, positionCtrsAccount: positionCtrs,
      user, userUsdcAccount: userUsdc,
      contraVaultProgram: contraVaultProgramId(), contraLendingProgram: contraLendingProgramId(),
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .instruction();
  const feeAtaIx = createAssociatedTokenAccountIdempotentInstruction(user, feeTreasury, authority.publicKey, usdc);
  const tx2 = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }),
    feeAtaIx,
    openIx,
  );
  const sig = await sendAndConfirmTransaction(conn, tx2, [authority], { commitment: 'confirmed' });
  console.log('✓ open_position landed — sig', sig);

  // Verify on-chain
  const acct: any = await (getLeverageProgram().account as any).position.fetch(position);
  console.log('\non-chain position:');
  console.log('  collateral_usdc:', acct.collateralUsdc?.toString?.());
  console.log('  debt_usdc:', acct.debtUsdc?.toString?.());
  console.log('  ctrs_held:', acct.ctrsHeld?.toString?.());
  console.log('  leverage_bps:', acct.leverageBps?.toString?.());
  console.log('  status:', acct.status);
  try {
    const ctrsBal = await conn.getTokenAccountBalance(positionCtrs);
    console.log('  position CTRS balance:', ctrsBal.value.uiAmountString);
  } catch {}
  const poolAfter = (await conn.getTokenAccountBalance(poolUsdc)).value.uiAmountString;
  console.log('pool USDC after:', poolAfter, '(borrow reduces available liquidity)');
  console.log('\nexplorer: https://explorer.solana.com/tx/' + sig + '?cluster=devnet');
}

main().then(() => process.exit(0)).catch(async (e) => {
  console.error('ERROR:', e.message ?? e);
  try {
    const logs = typeof e.getLogs === 'function' ? await e.getLogs() : e.logs;
    if (logs) console.error('LOGS:\n' + (Array.isArray(logs) ? logs.join('\n') : logs));
  } catch {}
  process.exit(1);
});
