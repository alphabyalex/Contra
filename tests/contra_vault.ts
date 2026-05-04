// READY TO RUN — execute via `anchor test` from WSL or Linux when toolchain is available.
//
// Full lifecycle smoke for contra_vault:
//   init_vault → init_contra_mint → init_vault_tokens
//   add_leg ×N → activate_vault
//   deposit (user) → resolve_leg (mix of NO/YES) → finalize_vault
//   redeem (user) — verify payout matches NAV math for short semantics

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  PublicKey,
  Keypair,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  getAssociatedTokenAddress,
} from "@solana/spl-token";
import { assert } from "chai";
import { ContraVault } from "../target/types/contra_vault";

const VAULT_SEED = Buffer.from("vault");
const MINT_SEED = Buffer.from("contra_mint");
const VAULT_USDC_SEED = Buffer.from("vault_usdc");

const PRICE_SCALE = 1_000_000;
const WEIGHT_TOTAL = 1_000_000;
const RATIO_SCALE = 1_000_000;

describe("contra_vault — full short-basket lifecycle", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.ContraVault as Program<ContraVault>;
  const authority = (provider.wallet as anchor.Wallet).payer;

  let usdcMint: PublicKey;
  let user: Keypair;
  let basketUuid: Buffer;
  let vaultPda: PublicKey;
  let contraMintPda: PublicKey;
  let vaultUsdcPda: PublicKey;

  const numLegs = 4;
  // 4 legs, equal-weighted, p_market = 0.10 each. 3 NO + 1 YES → ratio = 0.75 / 0.10 = 7.5
  // Wait: weights sum to 1.0 (1e6). Each leg w=250_000 (0.25). NO contribution = 0.25 / 0.10 = 2.5.
  // Three NO legs → 7.5. One YES → 0. Sum = 7.5 (1e6 scale = 7_500_000).
  const legPrice = 100_000; // 0.10
  const legWeight = WEIGHT_TOTAL / numLegs;

  before(async () => {
    user = Keypair.generate();
    // fund user
    const sig = await provider.connection.requestAirdrop(user.publicKey, 2e9);
    await provider.connection.confirmTransaction(sig);

    usdcMint = await createMint(
      provider.connection,
      authority,
      authority.publicKey,
      null,
      6,
    );

    basketUuid = Buffer.alloc(16);
    basketUuid.write("contra-test-vault");

    [vaultPda] = PublicKey.findProgramAddressSync(
      [VAULT_SEED, basketUuid],
      program.programId,
    );
    [contraMintPda] = PublicKey.findProgramAddressSync(
      [MINT_SEED, vaultPda.toBuffer()],
      program.programId,
    );
    [vaultUsdcPda] = PublicKey.findProgramAddressSync(
      [VAULT_USDC_SEED, vaultPda.toBuffer()],
      program.programId,
    );
  });

  it("3-step initialization succeeds", async () => {
    await program.methods
      .initializeVault([...basketUuid] as any, numLegs, 30)
      .accounts({
        vault: vaultPda,
        usdcMint,
        authority: authority.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    await program.methods
      .initializeContraMint()
      .accounts({
        vault: vaultPda,
        contraMint: contraMintPda,
        authority: authority.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .rpc();

    await program.methods
      .initializeVaultTokens()
      .accounts({
        vault: vaultPda,
        usdcMint,
        vaultUsdcAccount: vaultUsdcPda,
        authority: authority.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .rpc();

    const vault = await program.account.vault.fetch(vaultPda);
    assert.equal(vault.status, 0, "Initializing");
    assert.equal(vault.numLegs, numLegs);
  });

  it("loads legs and activates vault", async () => {
    for (let i = 0; i < numLegs; i++) {
      await program.methods
        .addLeg(i, legWeight, legPrice)
        .accounts({ vault: vaultPda, authority: authority.publicKey })
        .rpc();
    }
    await program.methods
      .activateVault()
      .accounts({ vault: vaultPda, authority: authority.publicKey })
      .rpc();

    const vault = await program.account.vault.fetch(vaultPda);
    assert.equal(vault.status, 1, "Active");
    assert.equal(vault.legsAdded, numLegs);
  });

  it("user can deposit USDC and receive CTRS 1:1", async () => {
    const userUsdc = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      authority,
      usdcMint,
      user.publicKey,
    );
    await mintTo(provider.connection, authority, usdcMint, userUsdc.address, authority, 1_000_000_000);

    const userCtrs = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      user,
      contraMintPda,
      user.publicKey,
    );

    await program.methods
      .deposit(new anchor.BN(100_000_000)) // 100 USDC
      .accounts({
        vault: vaultPda,
        contraMint: contraMintPda,
        vaultUsdcAccount: vaultUsdcPda,
        user: user.publicKey,
        userUsdcAccount: userUsdc.address,
        userContraAccount: userCtrs.address,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([user])
      .rpc();

    const vault = await program.account.vault.fetch(vaultPda);
    assert.equal(vault.totalDeposited.toNumber(), 100_000_000);
    assert.equal(vault.totalShares.toNumber(), 100_000_000);
  });

  it("resolves 3 NO and 1 YES leg, finalizes with ratio 7.5x", async () => {
    // 3 NO wins, 1 YES loss
    for (let i = 0; i < 3; i++) {
      await program.methods
        .resolveLeg(i, 0)
        .accounts({ vault: vaultPda, authority: authority.publicKey })
        .rpc();
    }
    await program.methods
      .resolveLeg(3, 1)
      .accounts({ vault: vaultPda, authority: authority.publicKey })
      .rpc();

    await program.methods
      .finalizeVault()
      .accounts({ vault: vaultPda, authority: authority.publicKey })
      .rpc();

    const vault = await program.account.vault.fetch(vaultPda);
    assert.equal(vault.status, 3, "Finalized");
    // Expected ratio = (3 × 0.25 / 0.10) = 7.5 → 7_500_000
    assert.equal(vault.payoutRatio.toNumber(), 7_500_000);
  });

  it("user redeems CTRS for proportional USDC × payout_ratio", async () => {
    // Authority must top up vault USDC to cover ratio > 1. Mint extra USDC
    // to vault_usdc_account directly to simulate the protocol funding payout.
    await mintTo(
      provider.connection,
      authority,
      usdcMint,
      vaultUsdcPda,
      authority,
      650_000_000, // ratio - 1 = 6.5 × 100 USDC = 650 USDC
    );

    const userUsdc = await getAssociatedTokenAddress(usdcMint, user.publicKey);
    const userCtrs = await getAssociatedTokenAddress(contraMintPda, user.publicKey);

    await program.methods
      .redeem(new anchor.BN(100_000_000))
      .accounts({
        vault: vaultPda,
        contraMint: contraMintPda,
        vaultUsdcAccount: vaultUsdcPda,
        user: user.publicKey,
        userContraAccount: userCtrs,
        userUsdcAccount: userUsdc,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([user])
      .rpc();

    const balance = await provider.connection.getTokenAccountBalance(userUsdc);
    // 100 USDC × 7.5 = 750 USDC. Started with 1000 - 100 deposited = 900. Now 900 + 750 = 1650.
    assert.equal(Number(balance.value.amount), 1_650_000_000);
  });
});
