/**
 * One-off admin script — unwind the zombie leveraged Position PDA at
 * 333y6nY4LQ3UTEkCeDqMjfKYesFiigX8aYeKX2i9nZJg whose DB row says closed but
 * whose on-chain account was never deallocated (DB-only close before the
 * close_position tx-builder existed).
 *
 * Builds and submits `close_position` signed by the authority. Bypasses the
 * DB's closed_at filter when loading the position. Does NOT update the DB.
 *
 * IMPORTANT: this script performs a pre-flight check before sending. The
 * deployed contra_leverage program requires `position.owner == user.key()`
 * on close_position; if the authority is not the original opener, the
 * script refuses to submit (would fail with Unauthorized).
 */

import * as path from 'path';
import { config as loadDotenv } from 'dotenv';
loadDotenv({ path: path.resolve(__dirname, '..', '..', '..', '.env'), override: true });

import {
  ComputeBudgetProgram,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import { getConnection, getLeverageProgram, getAuthorityKeypair, usdcMint } from '../solana/client';
import {
  deriveContraMint,
  deriveVaultPda,
  deriveVaultUsdc,
  derivePosition,
  derivePositionUsdc,
  derivePositionCtrs,
  deriveLendingPool,
  derivePoolUsdc,
  deriveBorrowerAuthority,
  contraVaultProgramId,
  contraLendingProgramId,
} from '../solana/pda';
import { getLeveragedPositionById, getBasket, getLatestNavSnapshot, listLegs } from '../db/queries';
import { computeBasketNav } from '../services/nav';

const POSITION_ID = '7afd0e60-0ccc-438b-a159-7f0c8c858afd';

async function main() {
  const conn = getConnection();
  const program = getLeverageProgram();
  const authority = getAuthorityKeypair();
  const usdc = usdcMint();

  console.log('=== close-zombie-position ===');
  console.log(`DB position id: ${POSITION_ID}`);
  console.log(`authority pubkey: ${authority.publicKey.toBase58()}`);

  // 1) Load DB row, explicitly bypassing the closed_at check.
  const lp = await getLeveragedPositionById(POSITION_ID);
  if (!lp) { console.error('DB row not found'); process.exit(1); }
  console.log(
    `\nDB row: wallet=${lp.wallet}\n` +
    `        basket=${lp.basket_id}\n` +
    `        closed_at=${lp.closed_at}\n` +
    `        vault_tokens=${lp.vault_tokens}  debt=${lp.debt_usdc}  collateral=${lp.collateral_usdc}\n` +
    `        position_pda(DB)=${lp.position_pda}`,
  );

  const basket = await getBasket(lp.basket_id);
  if (!basket) { console.error('basket not found'); process.exit(1); }
  const vaultFinalized = basket.status === 'finalized';
  console.log(`basket: ${basket.name} status=${basket.status} → vault_finalized=${vaultFinalized}`);

  // 2) Derive every PDA close_position expects.
  const owner = new PublicKey(lp.wallet);
  const [vaultPda] = deriveVaultPda(basket.id);
  const [contraMint] = deriveContraMint(vaultPda);
  const [vaultUsdc] = deriveVaultUsdc(vaultPda);
  const [position] = derivePosition(basket.id, owner);
  const [positionUsdc] = derivePositionUsdc(position);
  const [positionCtrs] = derivePositionCtrs(position);
  const [pool] = deriveLendingPool();
  const [poolUsdc] = derivePoolUsdc(pool);
  const [borrowerAuth] = deriveBorrowerAuthority();
  const authorityUsdcAta = getAssociatedTokenAddressSync(usdc, authority.publicKey);

  console.log(`\nderived position PDA: ${position.toBase58()}`);
  console.log(`matches DB position_pda: ${position.toBase58() === lp.position_pda}`);

  // 3) Decode on-chain Position state via the Anchor program coder.
  let onChainOwner: PublicKey | null = null;
  let onChainCtrsHeld = 0n;
  let onChainDebt = 0n;
  let onChainStatus: unknown = null;
  try {
    const acc: any = await (program.account as any).position.fetch(position);
    onChainOwner = acc.owner as PublicKey;
    onChainCtrsHeld = BigInt(acc.ctrsHeld.toString());
    onChainDebt = BigInt(acc.debtUsdc.toString());
    onChainStatus = acc.status;
    console.log(`\non-chain Position:`);
    console.log(`  owner      : ${onChainOwner.toBase58()}`);
    console.log(`  ctrs_held  : ${onChainCtrsHeld} raw (${Number(onChainCtrsHeld) / 1e6} CTRS)`);
    console.log(`  debt_usdc  : ${onChainDebt} raw (${Number(onChainDebt) / 1e6} USDC)`);
    console.log(`  status     : ${onChainStatus}`);
  } catch (e) {
    const info = await conn.getAccountInfo(position);
    if (!info) { console.log('\non-chain: PDA already deallocated. Nothing to do.'); return; }
    console.log(`\non-chain fetch failed: ${(e as Error).message}`);
    console.log(`  raw account: owner=${info.owner.toBase58()} data_len=${info.data.length} lamports=${info.lamports}`);
    process.exit(1);
  }

  // 4) Pre-flight check the program constraints.
  const closeOk = onChainOwner.equals(authority.publicKey);
  let nav = 1;
  const snap = await getLatestNavSnapshot(basket.id).catch(() => null);
  if (snap && Number.isFinite(Number(snap.nav)) && Number(snap.nav) > 0) {
    nav = Number(snap.nav);
  } else {
    const legs = await listLegs(basket.id).catch(() => []);
    if (legs.length) nav = computeBasketNav(legs).nav;
  }
  const navScaled = BigInt(Math.round(nav * 1_000_000));
  const value = (onChainCtrsHeld * navScaled) / 1_000_000n;
  const hf = onChainDebt > 0n ? Number(value) / Number(onChainDebt) : Number.POSITIVE_INFINITY;
  console.log(`\ncurrent NAV: ${nav.toFixed(4)} | computed health factor: ${hf.toFixed(3)}`);

  const liquidateOk = hf < 1.15;
  console.log(`\nprogram constraints:`);
  console.log(`  close_position: owner == authority?  ${closeOk}  (owner=${onChainOwner.toBase58()}, authority=${authority.publicKey.toBase58()})`);
  console.log(`  liquidate     : hf < 1.15?            ${liquidateOk}  (hf=${hf.toFixed(3)})`);

  if (!closeOk) {
    console.log(`\n❌ REFUSING TO SEND — the deployed contra_leverage program enforces`);
    console.log(`   'position.owner == user.key()' on close_position. The original opener`);
    console.log(`   (${onChainOwner.toBase58()}) must sign; the authority cannot.`);
    console.log(`   Submitting anyway would fail preflight with LeverageError::Unauthorized`);
    console.log(`   and not free the PDA.\n`);
    console.log(`   To unblock this PDA on-chain, choose one:`);
    console.log(`     a) Connect the original wallet (${onChainOwner.toBase58()}) in the`);
    console.log(`        frontend and click Close on /leverage/${POSITION_ID} — the`);
    console.log(`        close_position flow is now wired end-to-end.`);
    console.log(`     b) Wait for NAV to drop until hf < 1.15, then anyone can liquidate.`);
    console.log(`     c) Add a new authority-only admin_close_position instruction to the`);
    console.log(`        contra_leverage program and redeploy (requires anchor build).`);
    return;
  }

  // 5) If somehow the authority IS the position owner, build + send the close tx.
  console.log(`\nbuilding close_position signed by authority...`);
  const closeIx = await program.methods
    .closePosition(vaultFinalized)
    .accounts({
      position,
      vault: vaultPda,
      contraMint,
      vaultUsdcAccount: vaultUsdc,
      lendingPool: pool,
      lendingPoolUsdc: poolUsdc,
      borrowerAuthority: borrowerAuth,
      positionUsdcAccount: positionUsdc,
      positionCtrsAccount: positionCtrs,
      user: authority.publicKey,
      userUsdcAccount: authorityUsdcAta,
      contraVaultProgram: contraVaultProgramId(),
      contraLendingProgram: contraLendingProgramId(),
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .instruction();

  const ixs: TransactionInstruction[] = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }),
    createAssociatedTokenAccountIdempotentInstruction(authority.publicKey, authorityUsdcAta, authority.publicKey, usdc),
    closeIx,
  ];
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed');
  const msg = new TransactionMessage({ payerKey: authority.publicKey, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  tx.sign([authority]);

  let sig: string;
  try {
    sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 });
  } catch (e) {
    console.error(`❌ sendRawTransaction failed: ${(e as Error).message}`);
    process.exit(1);
  }
  console.log(`submitted: ${sig}`);
  const res = await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
  if (res.value.err) { console.error(`tx failed on-chain: ${JSON.stringify(res.value.err)}`); process.exit(1); }
  console.log(`confirmed in slot ${res.context.slot}`);

  // 6) Verify the PDA was deallocated.
  const post = await conn.getAccountInfo(position);
  console.log(`\ngetAccountInfo(${position.toBase58()}) = ${post ? `still exists (data_len=${post.data.length}, lamports=${post.lamports})` : 'NULL — deallocated ✓'}`);
}

main().then(() => process.exit(0)).catch((e) => { console.error('ERROR:', e.message ?? e); process.exit(1); });
