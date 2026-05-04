/**
 * Authority-signed admin actions: resolve_leg + finalize_vault. These
 * transactions are signed by the AUTHORITY_KEYPAIR backend-side and sent
 * directly — no two-step prepare/confirm dance, no wallet involved.
 *
 * Only callable from /api/admin/* routes (auth-gated) and the cron
 * runner that picks up Helius webhook events.
 */

import { getConnection, getVaultProgram, getAuthorityKeypair } from './client';
import { deriveContraMint, deriveVaultPda, deriveVaultUsdc } from './pda';

export type Outcome = 0 | 1; // 0 = NO (won), 1 = YES (lost)

export async function sendResolveLeg(
  basketUuid: string,
  legIndex: number,
  outcome: Outcome,
): Promise<string> {
  const program = getVaultProgram();
  const authority = getAuthorityKeypair();
  const [vaultPda] = deriveVaultPda(basketUuid);

  const sig = await program.methods
    .resolveLeg(legIndex, outcome)
    .accounts({ vault: vaultPda, authority: authority.publicKey })
    .signers([authority])
    .rpc({ commitment: 'confirmed' });

  return sig;
}

export async function sendFinalizeVault(basketUuid: string): Promise<string> {
  const program = getVaultProgram();
  const authority = getAuthorityKeypair();
  const [vaultPda] = deriveVaultPda(basketUuid);

  const sig = await program.methods
    .finalizeVault()
    .accounts({ vault: vaultPda, authority: authority.publicKey })
    .signers([authority])
    .rpc({ commitment: 'confirmed' });

  return sig;
}

export async function sendActivateVault(basketUuid: string): Promise<string> {
  const program = getVaultProgram();
  const authority = getAuthorityKeypair();
  const [vaultPda] = deriveVaultPda(basketUuid);

  return program.methods
    .activateVault()
    .accounts({ vault: vaultPda, authority: authority.publicKey })
    .signers([authority])
    .rpc({ commitment: 'confirmed' });
}

export async function sendAddLeg(
  basketUuid: string,
  legIndex: number,
  weightScaled: number,
  pMarketScaled: number,
): Promise<string> {
  const program = getVaultProgram();
  const authority = getAuthorityKeypair();
  const [vaultPda] = deriveVaultPda(basketUuid);

  return program.methods
    .addLeg(legIndex, weightScaled, pMarketScaled)
    .accounts({ vault: vaultPda, authority: authority.publicKey })
    .signers([authority])
    .rpc({ commitment: 'confirmed' });
}

/**
 * Convenience helper: returns the on-chain vault account or null if it
 * doesn't exist (e.g. init wasn't run yet).
 */
export async function fetchVaultAccount(basketUuid: string): Promise<unknown | null> {
  const program = getVaultProgram();
  const conn = getConnection();
  const [vaultPda] = deriveVaultPda(basketUuid);
  const info = await conn.getAccountInfo(vaultPda);
  if (!info) return null;
  return (program.account as any).vault.fetch(vaultPda);
}
