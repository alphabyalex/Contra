/**
 * Anchor provider, RPC connection, and lazily-loaded program clients for
 * the three CONTRA programs. IDLs live in `backend/src/idl/` and are
 * dropped there by `scripts/sync-idl.sh` after every `anchor build`.
 *
 * The authority Wallet is loaded from AUTHORITY_KEYPAIR (JSON byte array
 * in env). If absent, the connection is read-only and any tx-sending call
 * throws a clear error rather than silently using a random keypair.
 */

import {
  Connection,
  Keypair,
  PublicKey,
  clusterApiUrl,
} from '@solana/web3.js';
import { AnchorProvider, Program, Wallet, Idl } from '@coral-xyz/anchor';
import * as fs from 'fs';
import * as path from 'path';
import {
  contraVaultProgramId,
  contraLendingProgramId,
  contraLeverageProgramId,
} from './pda';

// ---------- connection / authority -----------------------------------

let conn: Connection | null = null;
export function getConnection(): Connection {
  if (conn) return conn;
  const url = process.env.SOLANA_RPC_URL?.trim() || clusterApiUrl('devnet');
  conn = new Connection(url, 'confirmed');
  return conn;
}

let authority: Keypair | null = null;
export function getAuthorityKeypair(): Keypair {
  if (authority) return authority;
  const raw = process.env.AUTHORITY_KEYPAIR?.trim();
  if (!raw) {
    throw new Error(
      'AUTHORITY_KEYPAIR not set. Generate with `solana-keygen new` and paste the JSON byte array into .env.',
    );
  }
  try {
    const arr = JSON.parse(raw) as number[];
    authority = Keypair.fromSecretKey(Uint8Array.from(arr));
    return authority;
  } catch (e) {
    throw new Error(`AUTHORITY_KEYPAIR is not valid JSON byte array: ${(e as Error).message}`);
  }
}

export function hasAuthority(): boolean {
  return Boolean(process.env.AUTHORITY_KEYPAIR?.trim());
}

let provider: AnchorProvider | null = null;
export function getProvider(): AnchorProvider {
  if (provider) return provider;
  const wallet = new Wallet(getAuthorityKeypair());
  provider = new AnchorProvider(getConnection(), wallet, { commitment: 'confirmed' });
  return provider;
}

// ---------- IDL loader -----------------------------------------------

const IDL_DIR = path.resolve(__dirname, '..', 'idl');

function loadIdl(name: string): Idl {
  const file = path.join(IDL_DIR, `${name}.json`);
  if (!fs.existsSync(file)) {
    throw new Error(
      `IDL not found at ${file}. Run \`scripts/sync-idl.sh\` after \`anchor build\`.`,
    );
  }
  return JSON.parse(fs.readFileSync(file, 'utf8')) as Idl;
}

// ---------- program clients (lazy) -----------------------------------

let vaultProgram: Program | null = null;
export function getVaultProgram(): Program {
  if (vaultProgram) return vaultProgram;
  const idl = loadIdl('contra_vault');
  vaultProgram = new Program(idl, getProvider());
  return vaultProgram;
}

let lendingProgram: Program | null = null;
export function getLendingProgram(): Program {
  if (lendingProgram) return lendingProgram;
  const idl = loadIdl('contra_lending');
  lendingProgram = new Program(idl, getProvider());
  return lendingProgram;
}

let leverageProgram: Program | null = null;
export function getLeverageProgram(): Program {
  if (leverageProgram) return leverageProgram;
  const idl = loadIdl('contra_leverage');
  leverageProgram = new Program(idl, getProvider());
  return leverageProgram;
}

// ---------- common pubkeys -------------------------------------------

export function usdcMint(): PublicKey {
  const m = process.env.USDC_MINT_DEVNET?.trim() || process.env.USDC_MINT?.trim();
  if (!m) throw new Error('USDC_MINT_DEVNET not set in .env');
  return new PublicKey(m);
}

/**
 * Cached check that the IDL files are present without throwing. Used by
 * /health endpoints and admin scripts to verify deploy state.
 */
export function idlsAvailable(): { vault: boolean; lending: boolean; leverage: boolean } {
  const check = (n: string) => fs.existsSync(path.join(IDL_DIR, `${n}.json`));
  return {
    vault: check('contra_vault'),
    lending: check('contra_lending'),
    leverage: check('contra_leverage'),
  };
}
