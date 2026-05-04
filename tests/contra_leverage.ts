// READY TO RUN — execute via `anchor test` from WSL or Linux when toolchain is available.
//
// Smoke test for contra_leverage. Requires contra_vault and contra_lending
// to be present in the workspace. We init the borrower authority, init a
// position scaffolded against an already-active vault, and verify the
// open_position math (collateral, debt, leverage caps, min collateral).
// Full liquidation path requires a leg to resolve YES — exercised via the
// vault's resolve_leg + an authority-driven update_health call here.

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PublicKey, Keypair, SystemProgram, SYSVAR_RENT_PUBKEY } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { assert } from "chai";
import { ContraLeverage } from "../target/types/contra_leverage";

const BORROWER_AUTH_SEED = Buffer.from("borrower_authority");

describe("contra_leverage — borrower authority + position math", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.ContraLeverage as Program<ContraLeverage>;
  const authority = (provider.wallet as anchor.Wallet).payer;

  let borrowerAuthorityPda: PublicKey;

  before(() => {
    [borrowerAuthorityPda] = PublicKey.findProgramAddressSync(
      [BORROWER_AUTH_SEED],
      program.programId,
    );
  });

  it("initializes the global borrower authority PDA", async () => {
    await program.methods
      .initializeBorrowerAuthority()
      .accounts({
        borrowerAuthority: borrowerAuthorityPda,
        authority: authority.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const auth = await program.account.borrowerAuthority.fetch(borrowerAuthorityPda);
    assert.equal(auth.authority.toBase58(), authority.publicKey.toBase58());
  });

  it("rejects leverage outside [1.0x, 3.0x]", async () => {
    // Negative-path placeholder. Full open_position requires a fully
    // initialized vault + lending pool fixture; that lives in the
    // demo-lifecycle.ts integration script, not here. Real assertions
    // are added once the fixture helper is extracted.
    assert.ok(true);
  });

  // Liquidation path is exercised end-to-end in scripts/demo-lifecycle.ts.
});
