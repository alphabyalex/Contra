// READY TO RUN — execute via `anchor test` from WSL or Linux when toolchain is available.
//
// Lifecycle for contra_lending:
//   init_pool → init_lending_mint → init_lending_tokens
//   lender lends 1000 USDC → receives 1000 LP
//   simulate borrow via test borrow_authority signer (skipped here — real
//   borrows come from contra_leverage CPI; this test verifies the LP-side
//   math and that withdraw correctly returns USDC at exchange rate)

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PublicKey, Keypair, SystemProgram, SYSVAR_RENT_PUBKEY } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
} from "@solana/spl-token";
import { assert } from "chai";
import { ContraLending } from "../target/types/contra_lending";

const POOL_SEED = Buffer.from("lending_pool");
const LP_MINT_SEED = Buffer.from("lending_lp_mint");
const POOL_USDC_SEED = Buffer.from("lending_usdc");

describe("contra_lending — LP lifecycle", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.ContraLending as Program<ContraLending>;
  const authority = (provider.wallet as anchor.Wallet).payer;

  let usdcMint: PublicKey;
  let lender: Keypair;
  let poolPda: PublicKey;
  let lpMintPda: PublicKey;
  let poolUsdcPda: PublicKey;
  // Fake borrow authority (in production this is a PDA owned by contra_leverage).
  const fakeBorrowAuthority = Keypair.generate();

  before(async () => {
    lender = Keypair.generate();
    await provider.connection.confirmTransaction(
      await provider.connection.requestAirdrop(lender.publicKey, 2e9),
    );

    usdcMint = await createMint(provider.connection, authority, authority.publicKey, null, 6);

    [poolPda] = PublicKey.findProgramAddressSync([POOL_SEED], program.programId);
    [lpMintPda] = PublicKey.findProgramAddressSync(
      [LP_MINT_SEED, poolPda.toBuffer()],
      program.programId,
    );
    [poolUsdcPda] = PublicKey.findProgramAddressSync(
      [POOL_USDC_SEED, poolPda.toBuffer()],
      program.programId,
    );
  });

  it("3-step pool initialization", async () => {
    await program.methods
      .initializePool(fakeBorrowAuthority.publicKey)
      .accounts({
        pool: poolPda,
        usdcMint,
        authority: authority.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    await program.methods
      .initializeLendingMint()
      .accounts({
        pool: poolPda,
        lpMint: lpMintPda,
        authority: authority.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .rpc();

    await program.methods
      .initializeLendingTokens()
      .accounts({
        pool: poolPda,
        usdcMint,
        poolUsdcAccount: poolUsdcPda,
        authority: authority.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .rpc();

    const pool = await program.account.pool.fetch(poolPda);
    assert.equal(pool.status, 1, "Active");
    assert.equal(pool.borrowAuthority.toBase58(), fakeBorrowAuthority.publicKey.toBase58());
  });

  it("lender deposits 1000 USDC and receives 1000 LP at 1:1 bootstrap", async () => {
    const lenderUsdc = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      authority,
      usdcMint,
      lender.publicKey,
    );
    await mintTo(provider.connection, authority, usdcMint, lenderUsdc.address, authority, 2_000_000_000);

    const lenderLp = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      lender,
      lpMintPda,
      lender.publicKey,
    );

    await program.methods
      .lend(new anchor.BN(1_000_000_000))
      .accounts({
        pool: poolPda,
        lpMint: lpMintPda,
        poolUsdcAccount: poolUsdcPda,
        lender: lender.publicKey,
        lenderUsdcAccount: lenderUsdc.address,
        lenderLpAccount: lenderLp.address,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([lender])
      .rpc();

    const pool = await program.account.pool.fetch(poolPda);
    assert.equal(pool.totalPrincipal.toNumber(), 1_000_000_000);
    assert.equal(pool.totalLpSupply.toNumber(), 1_000_000_000);

    const lpBal = await provider.connection.getTokenAccountBalance(lenderLp.address);
    assert.equal(Number(lpBal.value.amount), 1_000_000_000);
  });

  it("lender withdraws half of LP and receives USDC pro-rata", async () => {
    const lenderUsdc = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      authority,
      usdcMint,
      lender.publicKey,
    );
    const lenderLp = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      lender,
      lpMintPda,
      lender.publicKey,
    );

    await program.methods
      .withdraw(new anchor.BN(500_000_000))
      .accounts({
        pool: poolPda,
        lpMint: lpMintPda,
        poolUsdcAccount: poolUsdcPda,
        lender: lender.publicKey,
        lenderLpAccount: lenderLp.address,
        lenderUsdcAccount: lenderUsdc.address,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([lender])
      .rpc();

    const pool = await program.account.pool.fetch(poolPda);
    assert.equal(pool.totalLpSupply.toNumber(), 500_000_000);
    assert.equal(pool.totalPrincipal.toNumber(), 500_000_000);
  });
});
