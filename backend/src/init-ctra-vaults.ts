/**
 * Full on-chain init for every basket in status='initializing':
 *   1. initialize_vault → initialize_contra_mint → initialize_vault_tokens
 *   2. add_leg ×N
 *   3. activate_vault
 * Writes vault_pda + contra_mint back to the basket row and flips status
 * to 'active'. Logs the vault PDA + mint per basket.
 *
 * Run:  cd backend && npx tsx src/init-ctra-vaults.ts
 */

import * as path from 'path';
import { config as loadDotenv } from 'dotenv';
loadDotenv({ path: path.resolve(__dirname, '..', '..', '.env'), override: true });

import { SystemProgram, SYSVAR_RENT_PUBKEY } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { listBaskets, listLegs, updateBasket } from './db/queries';
import { getVaultProgram, getAuthorityKeypair, usdcMint } from './solana/client';
import { sendAddLeg, sendActivateVault } from './solana/resolve';
import { deriveContraMint, deriveVaultPda, deriveVaultUsdc, uuidToBytes } from './solana/pda';

const EXIT_FEE_BPS = 30;

async function init3Step(basketId: string, numLegs: number) {
  const program = getVaultProgram();
  const authority = getAuthorityKeypair();
  const usdc = usdcMint();
  const basketUuidBytes = uuidToBytes(basketId);
  const [vaultPda] = deriveVaultPda(basketId);
  const [contraMint] = deriveContraMint(vaultPda);
  const [vaultUsdc] = deriveVaultUsdc(vaultPda);

  await program.methods
    .initializeVault([...basketUuidBytes] as any, numLegs, EXIT_FEE_BPS)
    .accounts({ vault: vaultPda, usdcMint: usdc, authority: authority.publicKey, systemProgram: SystemProgram.programId })
    .signers([authority])
    .rpc({ commitment: 'confirmed' });
  console.log('  ✓ initialize_vault');

  await program.methods
    .initializeContraMint()
    .accounts({ vault: vaultPda, contraMint, authority: authority.publicKey, tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId, rent: SYSVAR_RENT_PUBKEY })
    .signers([authority])
    .rpc({ commitment: 'confirmed' });
  console.log('  ✓ initialize_contra_mint');

  await program.methods
    .initializeVaultTokens()
    .accounts({ vault: vaultPda, usdcMint: usdc, vaultUsdcAccount: vaultUsdc, authority: authority.publicKey, tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId, rent: SYSVAR_RENT_PUBKEY })
    .signers([authority])
    .rpc({ commitment: 'confirmed' });
  console.log('  ✓ initialize_vault_tokens');

  await updateBasket(basketId, { vault_pda: vaultPda.toBase58(), contra_mint: contraMint.toBase58() });
  return { vaultPda: vaultPda.toBase58(), contraMint: contraMint.toBase58() };
}

async function addLegsAndActivate(basketId: string) {
  const legs = await listLegs(basketId);
  for (const leg of legs) {
    await sendAddLeg(
      basketId,
      leg.leg_index,
      Math.round(Number(leg.weight) * 1_000_000),
      Math.max(1, Math.min(999_999, Math.round(Number(leg.p_market_entry) * 1_000_000))),
    );
  }
  console.log(`  ✓ add_leg ×${legs.length}`);
  await sendActivateVault(basketId);
  console.log('  ✓ activate_vault');
  await updateBasket(basketId, { status: 'active', activated_at: new Date().toISOString() });
}

async function main() {
  const pending = await listBaskets({ status: 'initializing' });
  if (pending.length === 0) {
    console.log('no baskets in initializing status');
    return;
  }
  for (const b of pending) {
    console.log(`\n=== ${b.name} (${b.id}) — ${b.num_legs} legs ===`);
    try {
      const { vaultPda, contraMint } = await init3Step(b.id, b.num_legs);
      await addLegsAndActivate(b.id);
      console.log(`  ► ${b.name} ACTIVE`);
      console.log(`     vault PDA  : ${vaultPda}`);
      console.log(`     CTRA mint  : ${contraMint}`);
    } catch (e) {
      console.error(`  ✗ ${b.name}:`, (e as Error).message);
    }
  }
  console.log('\ndone');
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
