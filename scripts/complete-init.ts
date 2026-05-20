import * as path from 'path';
import { config as loadDotenv } from 'dotenv';
loadDotenv({ path: path.resolve(__dirname, '..', '.env') });

import { SystemProgram, SYSVAR_RENT_PUBKEY } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { updateBasket } from '../backend/src/db/queries';
import { getVaultProgram, getAuthorityKeypair, usdcMint, getConnection } from '../backend/src/solana/client';
import { deriveContraMint, deriveVaultPda, deriveVaultUsdc } from '../backend/src/solana/pda';

async function main() {
  const basketId = process.argv[2];
  if (!basketId) throw new Error('usage: complete-init.ts <basketId>');

  const program = getVaultProgram();
  const authority = getAuthorityKeypair();
  const usdc = usdcMint();
  const conn = getConnection();
  const [vaultPda] = deriveVaultPda(basketId);
  const [contraMint] = deriveContraMint(vaultPda);
  const [vaultUsdc] = deriveVaultUsdc(vaultPda);

  console.log('vault PDA:', vaultPda.toBase58());
  console.log('contra mint:', contraMint.toBase58());
  console.log('vault USDC:', vaultUsdc.toBase58());

  // Skip step 1 if vault exists
  const vaultInfo = await conn.getAccountInfo(vaultPda);
  console.log('vault account exists:', !!vaultInfo);

  const mintInfo = await conn.getAccountInfo(contraMint);
  if (!mintInfo) {
    console.log('Step 2: initialize_contra_mint');
    const sig = await program.methods
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
    console.log('  ✓', sig);
  } else {
    console.log('Step 2: skipped (contra_mint exists)');
  }

  const usdcAccInfo = await conn.getAccountInfo(vaultUsdc);
  if (!usdcAccInfo) {
    console.log('Step 3: initialize_vault_tokens');
    const sig = await program.methods
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
    console.log('  ✓', sig);
  } else {
    console.log('Step 3: skipped (vault_usdc exists)');
  }

  await updateBasket(basketId, {
    vault_pda: vaultPda.toBase58(),
    contra_mint: contraMint.toBase58(),
  });
  console.log('basket row updated');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
