// READY TO BUILD — run `anchor build` from WSL or Linux when Solana toolchain is available

//! contra_vault — short basket vault for the CONTRA protocol.
//!
//! Users deposit USDC and receive CTRS basket tokens. Each basket holds N legs
//! (overpriced longshot prediction-market outcomes). As legs resolve NO, the
//! payout_ratio rises; as they resolve YES, it falls. This is the inverse of the
//! reference long-vault pattern — NO is "won" for us, YES is "lost".
//!
//! Init is split into 3 instructions (vault PDA → mint PDA → vault USDC ATA-PDA)
//! because creating all three in one ix blows the BPF 4KB stack budget. Legs are
//! loaded via `add_leg` after init because the full leg table won't fit in the
//! 1232-byte tx size limit for large baskets.
//!
//! Share accounting: 1 USDC == 1 CTRS at deposit (6 decimals each). The
//! payout_ratio is computed at finalize and applied at redeem. exit_active gives
//! the holder back their pro-rata USDC minus exit_fee_bps; the haircut stays in
//! the vault for remaining holders.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Burn, Mint, MintTo, Token, TokenAccount, Transfer};

declare_id!("5t7Juh2ZpxNGeaMCjvLjA6YnXnFahWcYWKouMzeahNgt");

pub const VAULT_SEED: &[u8] = b"vault";
pub const MINT_SEED: &[u8] = b"contra_mint";
pub const VAULT_USDC_SEED: &[u8] = b"vault_usdc";

pub const CTRS_DECIMALS: u8 = 6;
pub const RATIO_SCALE: u64 = 1_000_000;
pub const WEIGHT_TOTAL: u32 = 1_000_000;
pub const PRICE_SCALE: u32 = 1_000_000;
pub const MAX_LEGS: u16 = 256;
pub const BPS_DENOMINATOR: u64 = 10_000;
pub const DEFAULT_EXIT_FEE_BPS: u16 = 30;

#[program]
pub mod contra_vault {
    use super::*;

    pub fn initialize_vault(
        ctx: Context<InitializeVault>,
        basket_uuid: [u8; 16],
        num_legs: u16,
        exit_fee_bps: u16,
    ) -> Result<()> {
        require!(num_legs > 0 && num_legs <= MAX_LEGS, ContraError::InvalidLegCount);
        require!(exit_fee_bps <= 1000, ContraError::ExitFeeTooHigh);

        let vault = &mut ctx.accounts.vault;
        vault.authority = ctx.accounts.authority.key();
        vault.basket_uuid = basket_uuid;
        vault.usdc_mint = ctx.accounts.usdc_mint.key();
        vault.contra_mint = Pubkey::default();
        vault.vault_usdc_account = Pubkey::default();
        vault.status = VaultStatus::Initializing as u8;
        vault.num_legs = num_legs;
        vault.legs_added = 0;
        vault.legs_resolved = 0;
        vault.legs_won = 0;
        vault.total_deposited = 0;
        vault.total_shares = 0;
        vault.payout_ratio = RATIO_SCALE;
        vault.exit_fee_bps = exit_fee_bps;
        vault.bump = ctx.bumps.vault;
        vault.mint_bump = 0;
        vault.vault_token_bump = 0;
        vault.legs = vec![Leg::default(); num_legs as usize];

        Ok(())
    }

    pub fn initialize_contra_mint(ctx: Context<InitializeContraMint>) -> Result<()> {
        let vault = &mut ctx.accounts.vault;
        require!(
            vault.status == VaultStatus::Initializing as u8,
            ContraError::WrongStatus
        );
        require!(vault.contra_mint == Pubkey::default(), ContraError::AlreadyInitialized);

        vault.contra_mint = ctx.accounts.contra_mint.key();
        vault.mint_bump = ctx.bumps.contra_mint;
        Ok(())
    }

    pub fn initialize_vault_tokens(ctx: Context<InitializeVaultTokens>) -> Result<()> {
        let vault = &mut ctx.accounts.vault;
        require!(
            vault.status == VaultStatus::Initializing as u8,
            ContraError::WrongStatus
        );
        require!(
            vault.vault_usdc_account == Pubkey::default(),
            ContraError::AlreadyInitialized
        );
        require_keys_eq!(
            ctx.accounts.usdc_mint.key(),
            vault.usdc_mint,
            ContraError::WrongMint
        );

        vault.vault_usdc_account = ctx.accounts.vault_usdc_account.key();
        vault.vault_token_bump = ctx.bumps.vault_usdc_account;
        Ok(())
    }

    pub fn add_leg(
        ctx: Context<AddLeg>,
        leg_index: u16,
        weight: u32,
        p_market_entry: u32,
    ) -> Result<()> {
        let vault = &mut ctx.accounts.vault;
        require!(
            vault.status == VaultStatus::Initializing as u8,
            ContraError::WrongStatus
        );
        require!(leg_index < vault.num_legs, ContraError::LegIndexOutOfBounds);
        require!(weight > 0 && weight <= WEIGHT_TOTAL, ContraError::InvalidWeight);
        require!(
            p_market_entry > 0 && p_market_entry < PRICE_SCALE,
            ContraError::InvalidPrice
        );

        let leg = &mut vault.legs[leg_index as usize];
        require!(leg.outcome == Leg::OUTCOME_UNSET, ContraError::LegAlreadySet);

        leg.weight = weight;
        leg.p_market_entry = p_market_entry;
        leg.outcome = Leg::OUTCOME_OPEN;
        vault.legs_added = vault.legs_added.checked_add(1).ok_or(ContraError::MathOverflow)?;
        Ok(())
    }

    pub fn activate_vault(ctx: Context<ActivateVault>) -> Result<()> {
        let vault = &mut ctx.accounts.vault;
        require!(
            vault.status == VaultStatus::Initializing as u8,
            ContraError::WrongStatus
        );
        require!(
            vault.legs_added == vault.num_legs,
            ContraError::LegsIncomplete
        );
        require!(vault.contra_mint != Pubkey::default(), ContraError::NotInitialized);
        require!(
            vault.vault_usdc_account != Pubkey::default(),
            ContraError::NotInitialized
        );

        let weight_sum: u64 = vault.legs.iter().map(|l| l.weight as u64).sum();
        require!(weight_sum == WEIGHT_TOTAL as u64, ContraError::WeightsDoNotSumToOne);

        vault.status = VaultStatus::Active as u8;
        Ok(())
    }

    pub fn deposit(ctx: Context<Deposit>, amount_usdc: u64) -> Result<()> {
        require!(amount_usdc > 0, ContraError::ZeroAmount);
        let vault = &mut ctx.accounts.vault;
        require!(
            vault.status == VaultStatus::Active as u8,
            ContraError::DepositsClosed
        );

        let cpi_accounts = Transfer {
            from: ctx.accounts.user_usdc_account.to_account_info(),
            to: ctx.accounts.vault_usdc_account.to_account_info(),
            authority: ctx.accounts.user.to_account_info(),
        };
        token::transfer(
            CpiContext::new(ctx.accounts.token_program.to_account_info(), cpi_accounts),
            amount_usdc,
        )?;

        // 1:1 share minting during Active. payout_ratio is applied at redeem.
        let shares_to_mint = amount_usdc;

        let basket_uuid = vault.basket_uuid;
        let bump = vault.bump;
        let signer_seeds: &[&[&[u8]]] = &[&[VAULT_SEED, &basket_uuid, &[bump]]];

        let cpi_accounts = MintTo {
            mint: ctx.accounts.contra_mint.to_account_info(),
            to: ctx.accounts.user_contra_account.to_account_info(),
            authority: vault.to_account_info(),
        };
        token::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                cpi_accounts,
                signer_seeds,
            ),
            shares_to_mint,
        )?;

        vault.total_deposited = vault
            .total_deposited
            .checked_add(amount_usdc)
            .ok_or(ContraError::MathOverflow)?;
        vault.total_shares = vault
            .total_shares
            .checked_add(shares_to_mint)
            .ok_or(ContraError::MathOverflow)?;

        Ok(())
    }

    pub fn resolve_leg(ctx: Context<ResolveLeg>, leg_index: u16, outcome: u8) -> Result<()> {
        let vault = &mut ctx.accounts.vault;
        require!(
            vault.status == VaultStatus::Active as u8
                || vault.status == VaultStatus::Resolving as u8,
            ContraError::WrongStatus
        );
        require!(leg_index < vault.num_legs, ContraError::LegIndexOutOfBounds);
        require!(
            outcome == Leg::OUTCOME_NO || outcome == Leg::OUTCOME_YES,
            ContraError::InvalidOutcome
        );

        let leg = &mut vault.legs[leg_index as usize];
        require!(leg.outcome == Leg::OUTCOME_OPEN, ContraError::LegAlreadyResolved);

        leg.outcome = outcome;
        vault.legs_resolved = vault
            .legs_resolved
            .checked_add(1)
            .ok_or(ContraError::MathOverflow)?;
        if outcome == Leg::OUTCOME_NO {
            vault.legs_won = vault.legs_won.checked_add(1).ok_or(ContraError::MathOverflow)?;
        }

        if vault.status == VaultStatus::Active as u8 {
            vault.status = VaultStatus::Resolving as u8;
        }

        Ok(())
    }

    pub fn finalize_vault(ctx: Context<FinalizeVault>) -> Result<()> {
        let vault = &mut ctx.accounts.vault;
        require!(
            vault.status == VaultStatus::Active as u8
                || vault.status == VaultStatus::Resolving as u8,
            ContraError::WrongStatus
        );
        require!(
            vault.legs_resolved == vault.num_legs,
            ContraError::LegsUnresolved
        );

        // payout_ratio = Σ(weight_i × NO_indicator_i / p_market_entry_i)
        // Weights and prices are 1e6-scaled. Ratio is also 1e6-scaled.
        // contribution_i (1e6-scale) = weight_i * 1e6 / p_market_entry_i
        // when leg resolved NO; 0 otherwise.
        let mut acc: u128 = 0;
        for leg in vault.legs.iter() {
            if leg.outcome == Leg::OUTCOME_NO {
                let numerator = (leg.weight as u128)
                    .checked_mul(RATIO_SCALE as u128)
                    .ok_or(ContraError::MathOverflow)?;
                let contribution = numerator
                    .checked_div(leg.p_market_entry as u128)
                    .ok_or(ContraError::MathOverflow)?;
                acc = acc.checked_add(contribution).ok_or(ContraError::MathOverflow)?;
            }
        }
        // acc is currently in (1e6-weight × 1e6-ratio) / 1e6-price units = 1e6-ratio.
        // Normalize from weight-units (sum=1e6) back to fractional (÷ WEIGHT_TOTAL).
        let payout_ratio = acc
            .checked_div(WEIGHT_TOTAL as u128)
            .ok_or(ContraError::MathOverflow)?;
        require!(payout_ratio <= u64::MAX as u128, ContraError::MathOverflow);

        vault.payout_ratio = payout_ratio as u64;
        vault.status = VaultStatus::Finalized as u8;
        Ok(())
    }

    pub fn redeem(ctx: Context<Redeem>, amount_tokens: u64) -> Result<()> {
        require!(amount_tokens > 0, ContraError::ZeroAmount);
        let vault = &mut ctx.accounts.vault;
        require!(
            vault.status == VaultStatus::Finalized as u8,
            ContraError::NotFinalized
        );

        let usdc_out_u128 = (amount_tokens as u128)
            .checked_mul(vault.payout_ratio as u128)
            .ok_or(ContraError::MathOverflow)?
            .checked_div(RATIO_SCALE as u128)
            .ok_or(ContraError::MathOverflow)?;
        require!(usdc_out_u128 <= u64::MAX as u128, ContraError::MathOverflow);
        let usdc_out = usdc_out_u128 as u64;

        // Burn user's CTRS first (user-signed), then transfer USDC out (vault-signed).
        let cpi_accounts = Burn {
            mint: ctx.accounts.contra_mint.to_account_info(),
            from: ctx.accounts.user_contra_account.to_account_info(),
            authority: ctx.accounts.user.to_account_info(),
        };
        token::burn(
            CpiContext::new(ctx.accounts.token_program.to_account_info(), cpi_accounts),
            amount_tokens,
        )?;

        let basket_uuid = vault.basket_uuid;
        let bump = vault.bump;
        let signer_seeds: &[&[&[u8]]] = &[&[VAULT_SEED, &basket_uuid, &[bump]]];

        if usdc_out > 0 {
            let cpi_accounts = Transfer {
                from: ctx.accounts.vault_usdc_account.to_account_info(),
                to: ctx.accounts.user_usdc_account.to_account_info(),
                authority: vault.to_account_info(),
            };
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    cpi_accounts,
                    signer_seeds,
                ),
                usdc_out,
            )?;
        }

        vault.total_shares = vault
            .total_shares
            .checked_sub(amount_tokens)
            .ok_or(ContraError::MathOverflow)?;

        Ok(())
    }

    pub fn exit_active(ctx: Context<ExitActive>, amount_tokens: u64) -> Result<()> {
        require!(amount_tokens > 0, ContraError::ZeroAmount);
        let vault = &mut ctx.accounts.vault;
        require!(
            vault.status == VaultStatus::Active as u8
                || vault.status == VaultStatus::Resolving as u8,
            ContraError::WrongStatus
        );
        require!(vault.total_shares > 0, ContraError::NoShares);

        // Pro-rata USDC out at par, then haircut.
        let gross = (amount_tokens as u128)
            .checked_mul(vault.total_deposited as u128)
            .ok_or(ContraError::MathOverflow)?
            .checked_div(vault.total_shares as u128)
            .ok_or(ContraError::MathOverflow)?;
        let fee_factor = (BPS_DENOMINATOR - vault.exit_fee_bps as u64) as u128;
        let net = gross
            .checked_mul(fee_factor)
            .ok_or(ContraError::MathOverflow)?
            .checked_div(BPS_DENOMINATOR as u128)
            .ok_or(ContraError::MathOverflow)?;
        require!(net <= u64::MAX as u128, ContraError::MathOverflow);
        let usdc_out = net as u64;

        let cpi_accounts = Burn {
            mint: ctx.accounts.contra_mint.to_account_info(),
            from: ctx.accounts.user_contra_account.to_account_info(),
            authority: ctx.accounts.user.to_account_info(),
        };
        token::burn(
            CpiContext::new(ctx.accounts.token_program.to_account_info(), cpi_accounts),
            amount_tokens,
        )?;

        let basket_uuid = vault.basket_uuid;
        let bump = vault.bump;
        let signer_seeds: &[&[&[u8]]] = &[&[VAULT_SEED, &basket_uuid, &[bump]]];

        if usdc_out > 0 {
            let cpi_accounts = Transfer {
                from: ctx.accounts.vault_usdc_account.to_account_info(),
                to: ctx.accounts.user_usdc_account.to_account_info(),
                authority: vault.to_account_info(),
            };
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    cpi_accounts,
                    signer_seeds,
                ),
                usdc_out,
            )?;
        }

        vault.total_shares = vault
            .total_shares
            .checked_sub(amount_tokens)
            .ok_or(ContraError::MathOverflow)?;
        // total_deposited tracks USDC paid out at par; the haircut stays as
        // realized gain for remaining holders, so it is NOT subtracted.
        vault.total_deposited = vault
            .total_deposited
            .checked_sub(usdc_out)
            .ok_or(ContraError::MathOverflow)?;

        Ok(())
    }
}

// -------- accounts --------

#[derive(Accounts)]
#[instruction(basket_uuid: [u8; 16], num_legs: u16)]
pub struct InitializeVault<'info> {
    #[account(
        init,
        payer = authority,
        space = Vault::space(num_legs),
        seeds = [VAULT_SEED, basket_uuid.as_ref()],
        bump,
    )]
    pub vault: Account<'info, Vault>,
    pub usdc_mint: Account<'info, Mint>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct InitializeContraMint<'info> {
    #[account(
        mut,
        seeds = [VAULT_SEED, vault.basket_uuid.as_ref()],
        bump = vault.bump,
        has_one = authority @ ContraError::Unauthorized,
    )]
    pub vault: Account<'info, Vault>,
    #[account(
        init,
        payer = authority,
        seeds = [MINT_SEED, vault.key().as_ref()],
        bump,
        mint::decimals = CTRS_DECIMALS,
        mint::authority = vault,
    )]
    pub contra_mint: Account<'info, Mint>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct InitializeVaultTokens<'info> {
    #[account(
        mut,
        seeds = [VAULT_SEED, vault.basket_uuid.as_ref()],
        bump = vault.bump,
        has_one = authority @ ContraError::Unauthorized,
    )]
    pub vault: Account<'info, Vault>,
    pub usdc_mint: Account<'info, Mint>,
    #[account(
        init,
        payer = authority,
        seeds = [VAULT_USDC_SEED, vault.key().as_ref()],
        bump,
        token::mint = usdc_mint,
        token::authority = vault,
    )]
    pub vault_usdc_account: Account<'info, TokenAccount>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct AddLeg<'info> {
    #[account(
        mut,
        seeds = [VAULT_SEED, vault.basket_uuid.as_ref()],
        bump = vault.bump,
        has_one = authority @ ContraError::Unauthorized,
    )]
    pub vault: Account<'info, Vault>,
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct ActivateVault<'info> {
    #[account(
        mut,
        seeds = [VAULT_SEED, vault.basket_uuid.as_ref()],
        bump = vault.bump,
        has_one = authority @ ContraError::Unauthorized,
    )]
    pub vault: Account<'info, Vault>,
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(
        mut,
        seeds = [VAULT_SEED, vault.basket_uuid.as_ref()],
        bump = vault.bump,
    )]
    pub vault: Account<'info, Vault>,
    #[account(
        mut,
        seeds = [MINT_SEED, vault.key().as_ref()],
        bump = vault.mint_bump,
        address = vault.contra_mint @ ContraError::WrongMint,
    )]
    pub contra_mint: Account<'info, Mint>,
    #[account(
        mut,
        seeds = [VAULT_USDC_SEED, vault.key().as_ref()],
        bump = vault.vault_token_bump,
        address = vault.vault_usdc_account @ ContraError::WrongVaultAccount,
    )]
    pub vault_usdc_account: Account<'info, TokenAccount>,
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(
        mut,
        constraint = user_usdc_account.mint == vault.usdc_mint @ ContraError::WrongMint,
        constraint = user_usdc_account.owner == user.key() @ ContraError::Unauthorized,
    )]
    pub user_usdc_account: Account<'info, TokenAccount>,
    #[account(
        mut,
        constraint = user_contra_account.mint == vault.contra_mint @ ContraError::WrongMint,
        constraint = user_contra_account.owner == user.key() @ ContraError::Unauthorized,
    )]
    pub user_contra_account: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct ResolveLeg<'info> {
    #[account(
        mut,
        seeds = [VAULT_SEED, vault.basket_uuid.as_ref()],
        bump = vault.bump,
        has_one = authority @ ContraError::Unauthorized,
    )]
    pub vault: Account<'info, Vault>,
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct FinalizeVault<'info> {
    #[account(
        mut,
        seeds = [VAULT_SEED, vault.basket_uuid.as_ref()],
        bump = vault.bump,
        has_one = authority @ ContraError::Unauthorized,
    )]
    pub vault: Account<'info, Vault>,
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct Redeem<'info> {
    #[account(
        mut,
        seeds = [VAULT_SEED, vault.basket_uuid.as_ref()],
        bump = vault.bump,
    )]
    pub vault: Account<'info, Vault>,
    #[account(
        mut,
        seeds = [MINT_SEED, vault.key().as_ref()],
        bump = vault.mint_bump,
        address = vault.contra_mint @ ContraError::WrongMint,
    )]
    pub contra_mint: Account<'info, Mint>,
    #[account(
        mut,
        seeds = [VAULT_USDC_SEED, vault.key().as_ref()],
        bump = vault.vault_token_bump,
        address = vault.vault_usdc_account @ ContraError::WrongVaultAccount,
    )]
    pub vault_usdc_account: Account<'info, TokenAccount>,
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(
        mut,
        constraint = user_contra_account.mint == vault.contra_mint @ ContraError::WrongMint,
        constraint = user_contra_account.owner == user.key() @ ContraError::Unauthorized,
    )]
    pub user_contra_account: Account<'info, TokenAccount>,
    #[account(
        mut,
        constraint = user_usdc_account.mint == vault.usdc_mint @ ContraError::WrongMint,
        constraint = user_usdc_account.owner == user.key() @ ContraError::Unauthorized,
    )]
    pub user_usdc_account: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct ExitActive<'info> {
    #[account(
        mut,
        seeds = [VAULT_SEED, vault.basket_uuid.as_ref()],
        bump = vault.bump,
    )]
    pub vault: Account<'info, Vault>,
    #[account(
        mut,
        seeds = [MINT_SEED, vault.key().as_ref()],
        bump = vault.mint_bump,
        address = vault.contra_mint @ ContraError::WrongMint,
    )]
    pub contra_mint: Account<'info, Mint>,
    #[account(
        mut,
        seeds = [VAULT_USDC_SEED, vault.key().as_ref()],
        bump = vault.vault_token_bump,
        address = vault.vault_usdc_account @ ContraError::WrongVaultAccount,
    )]
    pub vault_usdc_account: Account<'info, TokenAccount>,
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(
        mut,
        constraint = user_contra_account.mint == vault.contra_mint @ ContraError::WrongMint,
        constraint = user_contra_account.owner == user.key() @ ContraError::Unauthorized,
    )]
    pub user_contra_account: Account<'info, TokenAccount>,
    #[account(
        mut,
        constraint = user_usdc_account.mint == vault.usdc_mint @ ContraError::WrongMint,
        constraint = user_usdc_account.owner == user.key() @ ContraError::Unauthorized,
    )]
    pub user_usdc_account: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

// -------- state --------

#[repr(u8)]
pub enum VaultStatus {
    Initializing = 0,
    Active = 1,
    Resolving = 2,
    Finalized = 3,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy)]
pub struct Leg {
    pub weight: u32,
    pub p_market_entry: u32,
    pub outcome: u8,
}

impl Leg {
    pub const SIZE: usize = 4 + 4 + 1;
    pub const OUTCOME_UNSET: u8 = 254;
    pub const OUTCOME_OPEN: u8 = 255;
    pub const OUTCOME_NO: u8 = 0;
    pub const OUTCOME_YES: u8 = 1;
}

impl Default for Leg {
    fn default() -> Self {
        Self { weight: 0, p_market_entry: 0, outcome: Self::OUTCOME_UNSET }
    }
}

#[account]
pub struct Vault {
    pub authority: Pubkey,
    pub basket_uuid: [u8; 16],
    pub usdc_mint: Pubkey,
    pub contra_mint: Pubkey,
    pub vault_usdc_account: Pubkey,
    pub status: u8,
    pub num_legs: u16,
    pub legs_added: u16,
    pub legs_resolved: u16,
    pub legs_won: u16,
    pub total_deposited: u64,
    pub total_shares: u64,
    pub payout_ratio: u64,
    pub exit_fee_bps: u16,
    pub bump: u8,
    pub mint_bump: u8,
    pub vault_token_bump: u8,
    pub legs: Vec<Leg>,
}

impl Vault {
    pub fn space(num_legs: u16) -> usize {
        8                                    // discriminator
            + 32                             // authority
            + 16                             // basket_uuid
            + 32                             // usdc_mint
            + 32                             // contra_mint
            + 32                             // vault_usdc_account
            + 1                              // status
            + 2 + 2 + 2 + 2                  // num_legs, legs_added, legs_resolved, legs_won
            + 8 + 8 + 8                      // total_deposited, total_shares, payout_ratio
            + 2                              // exit_fee_bps
            + 1 + 1 + 1                      // bump, mint_bump, vault_token_bump
            + 4 + (num_legs as usize) * Leg::SIZE // Vec<Leg>: 4-byte len + entries
    }
}

// -------- errors --------

#[error_code]
pub enum ContraError {
    #[msg("Vault is not in the required status for this instruction.")]
    WrongStatus,
    #[msg("Vault component is already initialized.")]
    AlreadyInitialized,
    #[msg("Vault component has not been initialized yet.")]
    NotInitialized,
    #[msg("Mint provided does not match the vault's expected mint.")]
    WrongMint,
    #[msg("Vault USDC account provided does not match the vault's stored account.")]
    WrongVaultAccount,
    #[msg("Caller is not the vault authority or does not own the token account.")]
    Unauthorized,
    #[msg("Number of legs must be between 1 and MAX_LEGS.")]
    InvalidLegCount,
    #[msg("Leg index is out of bounds for this vault.")]
    LegIndexOutOfBounds,
    #[msg("Leg has already been populated by add_leg.")]
    LegAlreadySet,
    #[msg("Leg weight must be > 0 and <= WEIGHT_TOTAL.")]
    InvalidWeight,
    #[msg("Market price must be in the open interval (0, PRICE_SCALE).")]
    InvalidPrice,
    #[msg("Outcome must be 0 (NO) or 1 (YES).")]
    InvalidOutcome,
    #[msg("Leg has already been resolved.")]
    LegAlreadyResolved,
    #[msg("Cannot activate vault until all legs are added.")]
    LegsIncomplete,
    #[msg("Cannot finalize vault until all legs are resolved.")]
    LegsUnresolved,
    #[msg("Sum of leg weights must equal WEIGHT_TOTAL.")]
    WeightsDoNotSumToOne,
    #[msg("Deposits are only allowed when the vault is Active.")]
    DepositsClosed,
    #[msg("Vault must be Finalized before redeem.")]
    NotFinalized,
    #[msg("Amount must be greater than zero.")]
    ZeroAmount,
    #[msg("Vault has no outstanding shares.")]
    NoShares,
    #[msg("Exit fee in basis points exceeds 10% cap.")]
    ExitFeeTooHigh,
    #[msg("Arithmetic overflow.")]
    MathOverflow,
}
