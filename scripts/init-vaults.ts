/**
 * Reads every basket with status='initializing' from the DB and runs
 * the 3-step on-chain init flow against the contra_vault program:
 *
 *   1. initialize_vault(basket_uuid, num_legs, exit_fee_bps)
 *   2. initialize_contra_mint
 *   3. initialize_vault_tokens
 *
 * It then writes the resulting vault_pda + contra_mint addresses back
 * to the basket row. Add-leg + activate are run by /api/admin/init-vault
 * in a second pass — that lets us retry leg loading without paying
 * re-init rent if a leg ix fails partway through.
 *
 * Run:  cd backend && npx tsx ../scripts/init-vaults.ts
 */

import 'dotenv/config';
import { SystemProgram, SYSVAR_RENT_PUBKEY } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { listBaskets, updateBasket } from '../backend/src/db/queries';
import {
  getVaultProgram,
  getAuthorityKeypair,
  usdcMint,
} from '../backend/src/solana/client';
import {
  deriveContraMint,
  deriveVaultPda,
  deriveVaultUsdc,
  uuidToBytes,
} from '../backend/src/solana/pda';

const EXIT_FEE_BPS = 30;

async function initOne(basketId: string, numLegs: number) {
  const program = getVaultProgram();
  const authority = getAuthorityKeypair();
  const usdc = usdcMint();
  const basketUuidBytes = uuidToBytes(basketId);
  const [vaultPda] = deriveVaultPda(basketId);
  const [contraMint] = deriveContraMint(vaultPda);
  const [vaultUsdc] = deriveVaultUsdc(vaultPda);

  console.log(`> ${basketId} → vault ${vaultPda.toBase58()}`);

  await program.methods
    .initializeVault([...basketUuidBytes] as any, numLegs, EXIT_FEE_BPS)
    .accounts({
      vault: vaultPda,
      usdcMint: usdc,
      authority: authority.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .signers([authority])
    .rpc({ commitment: 'confirmed' });
  console.log('  ✓ initialize_vault');

  await program.methods
    .initializeContraMint()
    .accounts({
      vault: vaultPda,
      contraMint,
      authority: authority.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      rent: SYSVAR_RENT_PUBKEY,
    })
    .signers([authority])
    .rpc({ commitment: 'confirmed' });
  console.log('  ✓ initialize_contra_mint');

  await program.methods
    .initializeVaultTokens()
    .accounts({
      vault: vaultPda,
      usdcMint: usdc,
      vaultUsdcAccount: vaultUsdc,
      authority: authority.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      rent: SYSVAR_RENT_PUBKEY,
    })
    .signers([authority])
    .rpc({ commitment: 'confirmed' });
  console.log('  ✓ initialize_vault_tokens');

  await updateBasket(basketId, {
    vault_pda: vaultPda.toBase58(),
    contra_mint: contraMint.toBase58(),
  });
}

async function main() {
  const pending = await listBaskets({ status: 'initializing' });
  if (pending.length === 0) {
    console.log('no baskets in initializing status');
    return;
  }
  for (const b of pending) {
    try {
      await initOne(b.id, b.num_legs);
    } catch (e) {
      console.error(`  ✗ ${b.id}:`, (e as Error).message);
    }
  }
  console.log('done');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
