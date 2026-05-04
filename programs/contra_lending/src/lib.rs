// READY TO BUILD — run `anchor build` from WSL or Linux when Solana toolchain is available

//! contra_lending — single-asset USDC lending pool for the CONTRA stack.
//!
//! LPs `lend` USDC and receive LP-share SPL tokens; the contra_leverage
//! program is the *only* allowed borrower (enforced by a borrow_authority
//! PDA stored at pool init). Interest accrues continuously off a kink-rate
//! curve (3% APY at 0% util, 8% APY at 80% util, 50% APY at 100% util).
//!
//! Init is split into 3 instructions (pool PDA → LP mint → USDC vault
//! token account) for the same BPF 4KB stack reason as contra_vault.
//! Interest is accrued lazily on every state-changing instruction via
//! the borrow_index / supply_index pattern (Compound v2 style, 1e18-scaled).

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Burn, Mint, MintTo, Token, TokenAccount, Transfer};

declare_id!("Contra2222222222222222222222222222222222222");

pub const POOL_SEED: &[u8] = b"lending_pool";
pub const LP_MINT_SEED: &[u8] = b"lending_lp_mint";
pub const POOL_USDC_SEED: &[u8] = b"lending_usdc";
pub const LP_DECIMALS: u8 = 6;

/// 1e18 fixed-point used for borrow_index / supply_index.
pub const RATE_SCALE: u128 = 1_000_000_000_000_000_000;
pub const SECONDS_PER_YEAR: u128 = 365 * 24 * 3600;
/// Basis-point denominator (10_000 bps = 100%).
pub const BPS: u128 = 10_000;

/// Kink-rate curve (basis points of APY).
pub const RATE_AT_ZERO_BPS: u128 = 300;       // 3.00%
pub const RATE_AT_KINK_BPS: u128 = 800;       // 8.00%
pub const RATE_AT_FULL_BPS: u128 = 5_000;     // 50.00%
pub const KINK_UTILIZATION_BPS: u128 = 8_000; // 80%

#[program]
pub mod contra_lending {
    use super::*;

    pub fn initialize_pool(ctx: Context<InitializePool>, borrow_authority: Pubkey) -> Result<()> {
        let pool = &mut ctx.accounts.pool;
        pool.authority = ctx.accounts.authority.key();
        pool.usdc_mint = ctx.accounts.usdc_mint.key();
        pool.lp_mint = Pubkey::default();
        pool.pool_usdc_account = Pubkey::default();
        pool.borrow_authority = borrow_authority;
        pool.total_principal = 0;
        pool.total_borrows = 0;
        pool.total_lp_supply = 0;
        pool.borrow_index = RATE_SCALE as u64;
        pool.last_accrual_ts = Clock::get()?.unix_timestamp;
        pool.bump = ctx.bumps.pool;
        pool.lp_mint_bump = 0;
        pool.vault_bump = 0;
        pool.status = PoolStatus::Initializing as u8;
        Ok(())
    }

    pub fn initialize_lending_mint(ctx: Context<InitializeLendingMint>) -> Result<()> {
        let pool = &mut ctx.accounts.pool;
        require!(pool.status == PoolStatus::Initializing as u8, LendingError::WrongStatus);
        require!(pool.lp_mint == Pubkey::default(), LendingError::AlreadyInitialized);

        pool.lp_mint = ctx.accounts.lp_mint.key();
        pool.lp_mint_bump = ctx.bumps.lp_mint;
        Ok(())
    }

    pub fn initialize_lending_tokens(ctx: Context<InitializeLendingTokens>) -> Result<()> {
        let pool = &mut ctx.accounts.pool;
        require!(pool.status == PoolStatus::Initializing as u8, LendingError::WrongStatus);
        require!(pool.pool_usdc_account == Pubkey::default(), LendingError::AlreadyInitialized);
        require_keys_eq!(ctx.accounts.usdc_mint.key(), pool.usdc_mint, LendingError::WrongMint);

        pool.pool_usdc_account = ctx.accounts.pool_usdc_account.key();
        pool.vault_bump = ctx.bumps.pool_usdc_account;
        pool.status = PoolStatus::Active as u8;
        Ok(())
    }

    pub fn lend(ctx: Context<Lend>, amount_usdc: u64) -> Result<()> {
        require!(amount_usdc > 0, LendingError::ZeroAmount);
        let pool = &mut ctx.accounts.pool;
        require!(pool.status == PoolStatus::Active as u8, LendingError::WrongStatus);
        accrue_interest(pool)?;

        // Pull USDC.
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.lender_usdc_account.to_account_info(),
                    to: ctx.accounts.pool_usdc_account.to_account_info(),
                    authority: ctx.accounts.lender.to_account_info(),
                },
            ),
            amount_usdc,
        )?;

        // Mint LP shares at current exchange rate.
        let total_assets = total_pool_assets(pool)?;
        let lp_to_mint = if pool.total_lp_supply == 0 || total_assets == 0 {
            amount_usdc // bootstrap 1:1
        } else {
            mul_div_u64(amount_usdc, pool.total_lp_supply, total_assets)?
        };

        let bump = pool.bump;
        let signer_seeds: &[&[&[u8]]] = &[&[POOL_SEED, &[bump]]];
        token::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                MintTo {
                    mint: ctx.accounts.lp_mint.to_account_info(),
                    to: ctx.accounts.lender_lp_account.to_account_info(),
                    authority: pool.to_account_info(),
                },
                signer_seeds,
            ),
            lp_to_mint,
        )?;

        pool.total_principal = pool
            .total_principal
            .checked_add(amount_usdc)
            .ok_or(LendingError::MathOverflow)?;
        pool.total_lp_supply = pool
            .total_lp_supply
            .checked_add(lp_to_mint)
            .ok_or(LendingError::MathOverflow)?;
        Ok(())
    }

    pub fn withdraw(ctx: Context<Withdraw>, amount_lp: u64) -> Result<()> {
        require!(amount_lp > 0, LendingError::ZeroAmount);
        let pool = &mut ctx.accounts.pool;
        require!(pool.status == PoolStatus::Active as u8, LendingError::WrongStatus);
        accrue_interest(pool)?;

        let total_assets = total_pool_assets(pool)?;
        require!(pool.total_lp_supply > 0, LendingError::NoLpSupply);
        let usdc_out = mul_div_u64(amount_lp, total_assets, pool.total_lp_supply)?;
        let liquidity = pool
            .total_principal
            .checked_sub(pool.total_borrows.min(pool.total_principal))
            .unwrap_or(0)
            .checked_add(realized_interest(pool)?)
            .ok_or(LendingError::MathOverflow)?;
        require!(usdc_out <= liquidity, LendingError::InsufficientLiquidity);

        // Burn LP first.
        token::burn(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Burn {
                    mint: ctx.accounts.lp_mint.to_account_info(),
                    from: ctx.accounts.lender_lp_account.to_account_info(),
                    authority: ctx.accounts.lender.to_account_info(),
                },
            ),
            amount_lp,
        )?;

        // Then transfer USDC out.
        let bump = pool.bump;
        let signer_seeds: &[&[&[u8]]] = &[&[POOL_SEED, &[bump]]];
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.pool_usdc_account.to_account_info(),
                    to: ctx.accounts.lender_usdc_account.to_account_info(),
                    authority: pool.to_account_info(),
                },
                signer_seeds,
            ),
            usdc_out,
        )?;

        pool.total_lp_supply = pool
            .total_lp_supply
            .checked_sub(amount_lp)
            .ok_or(LendingError::MathOverflow)?;
        pool.total_principal = pool
            .total_principal
            .checked_sub(usdc_out.min(pool.total_principal))
            .ok_or(LendingError::MathOverflow)?;
        Ok(())
    }

    /// CPI-only entrypoint. Caller must be the borrow_authority PDA stored
    /// at pool init (set to a PDA owned by contra_leverage).
    pub fn borrow(ctx: Context<Borrow>, amount: u64) -> Result<()> {
        require!(amount > 0, LendingError::ZeroAmount);
        let pool = &mut ctx.accounts.pool;
        require!(pool.status == PoolStatus::Active as u8, LendingError::WrongStatus);
        require_keys_eq!(
            ctx.accounts.borrow_authority.key(),
            pool.borrow_authority,
            LendingError::Unauthorized
        );
        accrue_interest(pool)?;

        let liquidity = pool
            .total_principal
            .checked_sub(pool.total_borrows)
            .ok_or(LendingError::InsufficientLiquidity)?;
        require!(amount <= liquidity, LendingError::InsufficientLiquidity);

        let bump = pool.bump;
        let signer_seeds: &[&[&[u8]]] = &[&[POOL_SEED, &[bump]]];
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.pool_usdc_account.to_account_info(),
                    to: ctx.accounts.destination_usdc_account.to_account_info(),
                    authority: pool.to_account_info(),
                },
                signer_seeds,
            ),
            amount,
        )?;

        pool.total_borrows = pool
            .total_borrows
            .checked_add(amount)
            .ok_or(LendingError::MathOverflow)?;
        Ok(())
    }

    /// CPI-only. The leverage program calls this on close/liquidate.
    pub fn repay(ctx: Context<Repay>, amount: u64) -> Result<()> {
        require!(amount > 0, LendingError::ZeroAmount);
        let pool = &mut ctx.accounts.pool;
        require!(pool.status == PoolStatus::Active as u8, LendingError::WrongStatus);
        accrue_interest(pool)?;

        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.source_usdc_account.to_account_info(),
                    to: ctx.accounts.pool_usdc_account.to_account_info(),
                    authority: ctx.accounts.repayer.to_account_info(),
                },
            ),
            amount,
        )?;

        let principal_repaid = amount.min(pool.total_borrows);
        pool.total_borrows = pool
            .total_borrows
            .checked_sub(principal_repaid)
            .ok_or(LendingError::MathOverflow)?;
        // Anything paid above outstanding principal is interest, which
        // accrues to LPs as additional pool assets (already in vault).
        let interest_to_lps = amount
            .checked_sub(principal_repaid)
            .unwrap_or(0);
        pool.total_principal = pool
            .total_principal
            .checked_add(interest_to_lps)
            .ok_or(LendingError::MathOverflow)?;
        Ok(())
    }
}

// ---------- helpers ---------------------------------------------------

fn current_utilization_bps(pool: &Pool) -> Result<u128> {
    if pool.total_principal == 0 {
        return Ok(0);
    }
    Ok((pool.total_borrows as u128)
        .checked_mul(BPS)
        .ok_or(LendingError::MathOverflow)?
        .checked_div(pool.total_principal as u128)
        .unwrap_or(0))
}

fn borrow_apy_bps(util_bps: u128) -> u128 {
    if util_bps <= KINK_UTILIZATION_BPS {
        // Linear from RATE_AT_ZERO at 0 util to RATE_AT_KINK at 80%.
        let span = RATE_AT_KINK_BPS - RATE_AT_ZERO_BPS;
        RATE_AT_ZERO_BPS + (util_bps * span) / KINK_UTILIZATION_BPS
    } else {
        // Linear from RATE_AT_KINK at 80% to RATE_AT_FULL at 100%.
        let span = RATE_AT_FULL_BPS - RATE_AT_KINK_BPS;
        let over = util_bps - KINK_UTILIZATION_BPS;
        let denom = BPS - KINK_UTILIZATION_BPS;
        RATE_AT_KINK_BPS + (over * span) / denom
    }
}

/// Lazy interest accrual. Bumps borrow_index, materializes the interest as
/// added principal so total_pool_assets() is correct on the next read.
fn accrue_interest(pool: &mut Pool) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let elapsed = now.saturating_sub(pool.last_accrual_ts).max(0) as u128;
    if elapsed == 0 || pool.total_borrows == 0 {
        pool.last_accrual_ts = now;
        return Ok(());
    }

    let util = current_utilization_bps(pool)?;
    let apy_bps = borrow_apy_bps(util);
    // simple_interest = total_borrows × apy_bps / BPS × elapsed / SECONDS_PER_YEAR
    let interest = (pool.total_borrows as u128)
        .checked_mul(apy_bps).ok_or(LendingError::MathOverflow)?
        .checked_mul(elapsed).ok_or(LendingError::MathOverflow)?
        .checked_div(BPS).ok_or(LendingError::MathOverflow)?
        .checked_div(SECONDS_PER_YEAR).ok_or(LendingError::MathOverflow)?;
    let interest_u64 = u64::try_from(interest).map_err(|_| LendingError::MathOverflow)?;

    if interest_u64 > 0 {
        // Increase borrow_index proportionally so existing debt grows.
        let factor = RATE_SCALE
            .checked_add(
                interest
                    .checked_mul(RATE_SCALE).ok_or(LendingError::MathOverflow)?
                    .checked_div(pool.total_borrows as u128).ok_or(LendingError::MathOverflow)?
            )
            .ok_or(LendingError::MathOverflow)?;
        let new_index = (pool.borrow_index as u128)
            .checked_mul(factor).ok_or(LendingError::MathOverflow)?
            .checked_div(RATE_SCALE).ok_or(LendingError::MathOverflow)?;
        pool.borrow_index = u64::try_from(new_index).map_err(|_| LendingError::MathOverflow)?;
        pool.total_borrows = pool
            .total_borrows
            .checked_add(interest_u64)
            .ok_or(LendingError::MathOverflow)?;
        pool.total_principal = pool
            .total_principal
            .checked_add(interest_u64)
            .ok_or(LendingError::MathOverflow)?;
    }
    pool.last_accrual_ts = now;
    Ok(())
}

fn total_pool_assets(pool: &Pool) -> Result<u64> {
    Ok(pool.total_principal)
}

fn realized_interest(pool: &Pool) -> Result<u64> {
    Ok(pool.total_principal.saturating_sub(pool.total_borrows))
}

fn mul_div_u64(a: u64, b: u64, d: u64) -> Result<u64> {
    require!(d > 0, LendingError::MathOverflow);
    let r = (a as u128)
        .checked_mul(b as u128).ok_or(LendingError::MathOverflow)?
        .checked_div(d as u128).ok_or(LendingError::MathOverflow)?;
    u64::try_from(r).map_err(|_| LendingError::MathOverflow.into())
}

// ---------- accounts --------------------------------------------------

#[derive(Accounts)]
pub struct InitializePool<'info> {
    #[account(
        init,
        payer = authority,
        space = Pool::SPACE,
        seeds = [POOL_SEED],
        bump,
    )]
    pub pool: Account<'info, Pool>,
    pub usdc_mint: Account<'info, Mint>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct InitializeLendingMint<'info> {
    #[account(
        mut,
        seeds = [POOL_SEED],
        bump = pool.bump,
        has_one = authority @ LendingError::Unauthorized,
    )]
    pub pool: Account<'info, Pool>,
    #[account(
        init,
        payer = authority,
        seeds = [LP_MINT_SEED, pool.key().as_ref()],
        bump,
        mint::decimals = LP_DECIMALS,
        mint::authority = pool,
    )]
    pub lp_mint: Account<'info, Mint>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct InitializeLendingTokens<'info> {
    #[account(
        mut,
        seeds = [POOL_SEED],
        bump = pool.bump,
        has_one = authority @ LendingError::Unauthorized,
    )]
    pub pool: Account<'info, Pool>,
    pub usdc_mint: Account<'info, Mint>,
    #[account(
        init,
        payer = authority,
        seeds = [POOL_USDC_SEED, pool.key().as_ref()],
        bump,
        token::mint = usdc_mint,
        token::authority = pool,
    )]
    pub pool_usdc_account: Account<'info, TokenAccount>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct Lend<'info> {
    #[account(
        mut,
        seeds = [POOL_SEED],
        bump = pool.bump,
    )]
    pub pool: Account<'info, Pool>,
    #[account(
        mut,
        seeds = [LP_MINT_SEED, pool.key().as_ref()],
        bump = pool.lp_mint_bump,
        address = pool.lp_mint @ LendingError::WrongMint,
    )]
    pub lp_mint: Account<'info, Mint>,
    #[account(
        mut,
        seeds = [POOL_USDC_SEED, pool.key().as_ref()],
        bump = pool.vault_bump,
        address = pool.pool_usdc_account @ LendingError::WrongVaultAccount,
    )]
    pub pool_usdc_account: Account<'info, TokenAccount>,
    #[account(mut)]
    pub lender: Signer<'info>,
    #[account(
        mut,
        constraint = lender_usdc_account.mint == pool.usdc_mint @ LendingError::WrongMint,
        constraint = lender_usdc_account.owner == lender.key() @ LendingError::Unauthorized,
    )]
    pub lender_usdc_account: Account<'info, TokenAccount>,
    #[account(
        mut,
        constraint = lender_lp_account.mint == pool.lp_mint @ LendingError::WrongMint,
        constraint = lender_lp_account.owner == lender.key() @ LendingError::Unauthorized,
    )]
    pub lender_lp_account: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct Withdraw<'info> {
    #[account(
        mut,
        seeds = [POOL_SEED],
        bump = pool.bump,
    )]
    pub pool: Account<'info, Pool>,
    #[account(
        mut,
        seeds = [LP_MINT_SEED, pool.key().as_ref()],
        bump = pool.lp_mint_bump,
        address = pool.lp_mint @ LendingError::WrongMint,
    )]
    pub lp_mint: Account<'info, Mint>,
    #[account(
        mut,
        seeds = [POOL_USDC_SEED, pool.key().as_ref()],
        bump = pool.vault_bump,
        address = pool.pool_usdc_account @ LendingError::WrongVaultAccount,
    )]
    pub pool_usdc_account: Account<'info, TokenAccount>,
    #[account(mut)]
    pub lender: Signer<'info>,
    #[account(
        mut,
        constraint = lender_lp_account.mint == pool.lp_mint @ LendingError::WrongMint,
        constraint = lender_lp_account.owner == lender.key() @ LendingError::Unauthorized,
    )]
    pub lender_lp_account: Account<'info, TokenAccount>,
    #[account(
        mut,
        constraint = lender_usdc_account.mint == pool.usdc_mint @ LendingError::WrongMint,
        constraint = lender_usdc_account.owner == lender.key() @ LendingError::Unauthorized,
    )]
    pub lender_usdc_account: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct Borrow<'info> {
    #[account(
        mut,
        seeds = [POOL_SEED],
        bump = pool.bump,
    )]
    pub pool: Account<'info, Pool>,
    #[account(
        mut,
        seeds = [POOL_USDC_SEED, pool.key().as_ref()],
        bump = pool.vault_bump,
        address = pool.pool_usdc_account @ LendingError::WrongVaultAccount,
    )]
    pub pool_usdc_account: Account<'info, TokenAccount>,
    /// PDA owned by contra_leverage. Must match pool.borrow_authority.
    pub borrow_authority: Signer<'info>,
    #[account(
        mut,
        constraint = destination_usdc_account.mint == pool.usdc_mint @ LendingError::WrongMint,
    )]
    pub destination_usdc_account: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct Repay<'info> {
    #[account(
        mut,
        seeds = [POOL_SEED],
        bump = pool.bump,
    )]
    pub pool: Account<'info, Pool>,
    #[account(
        mut,
        seeds = [POOL_USDC_SEED, pool.key().as_ref()],
        bump = pool.vault_bump,
        address = pool.pool_usdc_account @ LendingError::WrongVaultAccount,
    )]
    pub pool_usdc_account: Account<'info, TokenAccount>,
    pub repayer: Signer<'info>,
    #[account(
        mut,
        constraint = source_usdc_account.mint == pool.usdc_mint @ LendingError::WrongMint,
    )]
    pub source_usdc_account: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

// ---------- state -----------------------------------------------------

#[repr(u8)]
pub enum PoolStatus {
    Initializing = 0,
    Active = 1,
}

#[account]
pub struct Pool {
    pub authority: Pubkey,
    pub usdc_mint: Pubkey,
    pub lp_mint: Pubkey,
    pub pool_usdc_account: Pubkey,
    pub borrow_authority: Pubkey,
    pub total_principal: u64,
    pub total_borrows: u64,
    pub total_lp_supply: u64,
    pub borrow_index: u64,        // 1e18-scaled but u64 is plenty for early life
    pub last_accrual_ts: i64,
    pub status: u8,
    pub bump: u8,
    pub lp_mint_bump: u8,
    pub vault_bump: u8,
}

impl Pool {
    pub const SPACE: usize = 8     // discriminator
        + 32 * 5                   // 5 pubkeys
        + 8 * 5                    // 5 u64
        + 8                        // last_accrual_ts (i64)
        + 1 + 1 + 1 + 1;           // status + 3 bumps
}

// ---------- errors ----------------------------------------------------

#[error_code]
pub enum LendingError {
    #[msg("Pool not in the required status for this instruction.")]
    WrongStatus,
    #[msg("Pool component already initialized.")]
    AlreadyInitialized,
    #[msg("Mint provided does not match pool's expected mint.")]
    WrongMint,
    #[msg("Pool USDC vault account mismatch.")]
    WrongVaultAccount,
    #[msg("Caller is not the pool authority or borrow authority.")]
    Unauthorized,
    #[msg("Amount must be greater than zero.")]
    ZeroAmount,
    #[msg("Pool has no LP supply.")]
    NoLpSupply,
    #[msg("Insufficient liquidity available in pool.")]
    InsufficientLiquidity,
    #[msg("Arithmetic overflow.")]
    MathOverflow,
}
