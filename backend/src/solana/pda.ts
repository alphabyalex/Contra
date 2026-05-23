/**
 * All PDA derivations for the CONTRA on-chain programs. Centralised so
 * that backend and any scripts derive addresses identically. The seed
 * constants here MUST match the constants in each program's lib.rs —
 * mismatch is the most common cause of "Account does not match" errors.
 */

import { PublicKey } from '@solana/web3.js';

// ---------- seeds (must match Rust) ----------------------------------

export const VAULT_SEED = Buffer.from('vault');
export const CONTRA_MINT_SEED = Buffer.from('contra_mint');
export const VAULT_USDC_SEED = Buffer.from('vault_usdc');

export const POOL_SEED = Buffer.from('lending_pool');
export const LP_MINT_SEED = Buffer.from('lending_lp_mint');
export const POOL_USDC_SEED = Buffer.from('lending_usdc');

export const BORROWER_AUTH_SEED = Buffer.from('borrower_authority');
export const POSITION_SEED = Buffer.from('position');
export const POSITION_USDC_SEED = Buffer.from('position_usdc');
export const POSITION_CTRS_SEED = Buffer.from('position_ctrs');

// ---------- program IDs (read from env, lazily) ----------------------

function programId(envKey: string): PublicKey {
  const v = process.env[envKey];
  if (!v) {
    throw new Error(
      `${envKey} is not set in env. Run \`anchor deploy\` then copy the printed program ID into .env.`,
    );
  }
  return new PublicKey(v);
}

export const contraVaultProgramId = () => programId('CONTRA_VAULT_PROGRAM_ID');
export const contraLendingProgramId = () => programId('CONTRA_LENDING_PROGRAM_ID');
export const contraLeverageProgramId = () => programId('CONTRA_LEVERAGE_PROGRAM_ID');

// ---------- helpers --------------------------------------------------

/**
 * Convert a UUID string ("550e8400-e29b-41d4-a716-446655440000") to the
 * 16-byte Buffer the on-chain program expects. Hyphens are stripped.
 */
export function uuidToBytes(uuid: string): Buffer {
  const hex = uuid.replace(/-/g, '');
  if (hex.length !== 32) throw new Error(`Bad UUID length: ${uuid}`);
  return Buffer.from(hex, 'hex');
}

// ---------- vault derivations ---------------------------------------

export function deriveVaultPda(basketUuid: string | Buffer): [PublicKey, number] {
  const bytes = typeof basketUuid === 'string' ? uuidToBytes(basketUuid) : basketUuid;
  return PublicKey.findProgramAddressSync([VAULT_SEED, bytes], contraVaultProgramId());
}

export function deriveContraMint(vaultPda: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [CONTRA_MINT_SEED, vaultPda.toBuffer()],
    contraVaultProgramId(),
  );
}

export function deriveVaultUsdc(vaultPda: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [VAULT_USDC_SEED, vaultPda.toBuffer()],
    contraVaultProgramId(),
  );
}

// ---------- lending derivations -------------------------------------

export function deriveLendingPool(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([POOL_SEED], contraLendingProgramId());
}

export function deriveLpMint(poolPda: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [LP_MINT_SEED, poolPda.toBuffer()],
    contraLendingProgramId(),
  );
}

export function derivePoolUsdc(poolPda: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [POOL_USDC_SEED, poolPda.toBuffer()],
    contraLendingProgramId(),
  );
}

// ---------- leverage derivations ------------------------------------

export function deriveBorrowerAuthority(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [BORROWER_AUTH_SEED],
    contraLeverageProgramId(),
  );
}

export function derivePosition(
  basketUuid: string | Buffer,
  wallet: PublicKey,
  nonce: bigint,
): [PublicKey, number] {
  const bytes = typeof basketUuid === 'string' ? uuidToBytes(basketUuid) : basketUuid;
  // Match the on-chain seed: u64 little-endian, 8 bytes.
  const nonceBytes = Buffer.alloc(8);
  nonceBytes.writeBigUInt64LE(nonce);
  return PublicKey.findProgramAddressSync(
    [POSITION_SEED, bytes, wallet.toBuffer(), nonceBytes],
    contraLeverageProgramId(),
  );
}

export function derivePositionUsdc(positionPda: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [POSITION_USDC_SEED, positionPda.toBuffer()],
    contraLeverageProgramId(),
  );
}

export function derivePositionCtrs(positionPda: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [POSITION_CTRS_SEED, positionPda.toBuffer()],
    contraLeverageProgramId(),
  );
}
