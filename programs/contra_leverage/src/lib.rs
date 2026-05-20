// READY TO BUILD — run `anchor build` from WSL or Linux when Solana toolchain is available

//! contra_leverage — leveraged short-basket position manager.
//!
//! Chains CPIs across both other CONTRA programs:
//!   open_position  : lending::borrow → vault::deposit
//!   close_position : vault::redeem (or exit_active) → lending::repay → refund user
//!   liquidate      : same as close, but anyone may call when HF < 1.15
//!                    and the caller earns a 5% bonus from the recovered USDC
//!   update_health  : authority recomputes HF using a passed-in mark-to-market NAV
//!
//! Health factor = (ctrs_held × NAV) / debt_usdc  (all 1e6-scaled).
//! Liquidatable below 1.15. Max leverage 3.00x. User must put up at least
//! 40% of total exposure as collateral (i.e. leverage <= 2.5x in practice
//! for the 40% min, but 3x is also allowed since 1/3 = 33.3% < 40%; the
//! min-collateral check is enforced and overrides the 3x cap when binding).
//!
//! Init split (3 instructions) to stay under the BPF 4KB stack budget:
//!   1. initialize_borrower_authority — global PDA used to sign all
//!      lending::borrow / lending::repay CPIs
//!   2. init_position                  — Position PDA itself
//!   3. init_position_tokens           — position USDC + CTRS token accts

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};
use contra_lending::cpi::accounts::{Borrow, Repay};
use contra_lending::program::ContraLending;
use contra_vault::cpi::accounts::{Deposit as VaultDeposit, ExitActive, Redeem};
use contra_vault::program::ContraVault;

declare_id!("5Y4oQ2QcQoBKdcRzPmdHNBGMg4As535GysADjjbdQS9V");

pub const BORROWER_AUTH_SEED: &[u8] = b"borrower_authority";
pub const POSITION_SEED: &[u8] = b"position";
pub const POSITION_USDC_SEED: &[u8] = b"position_usdc";
pub const POSITION_CTRS_SEED: &[u8] = b"position_ctrs";

pub const HEALTH_SCALE: u64 = 1_000_000;
pub const LIQUIDATION_THRESHOLD: u64 = 1_150_000;     // 1.15x
pub const LIQUIDATOR_BONUS_BPS: u64 = 500;            // 5%
pub const BPS_DENOM: u64 = 10_000;
pub const MAX_LEVERAGE_BPS: u64 = 30_000;             // 3.00x
pub const MIN_LEVERAGE_BPS: u64 = 10_000;             // 1.00x
pub const MIN_USER_COLLATERAL_BPS: u64 = 4_000;       // 40%
pub const NAV_SCALE: u64 = 1_000_000;

#[program]
pub mod contra_leverage {
    use super::*;

    pub fn initialize_borrower_authority(ctx: Context<InitializeBorrowerAuthority>) -> Result<()> {
        let auth = &mut ctx.accounts.borrower_authority;
        auth.authority = ctx.accounts.authority.key();
        auth.bump = ctx.bumps.borrower_authority;
        Ok(())
    }

    pub fn init_position(
        ctx: Context<InitPosition>,
        basket_uuid: [u8; 16],
    ) -> Result<()> {
        let pos = &mut ctx.accounts.position;
        pos.owner = ctx.accounts.user.key();
        pos.basket_vault = ctx.accounts.vault.key();
        pos.basket_uuid = basket_uuid;
        pos.collateral_usdc = 0;
        pos.debt_usdc = 0;
        pos.ctrs_held = 0;
        pos.leverage_bps = 0;
        pos.health_factor = HEALTH_SCALE;
        pos.opened_at = 0;
        pos.closed_at = 0;
        pos.status = PositionStatus::Initializing as u8;
        pos.bump = ctx.bumps.position;
        pos.usdc_bump = 0;
        pos.ctrs_bump = 0;
        Ok(())
    }

    pub fn init_position_tokens(ctx: Context<InitPositionTokens>) -> Result<()> {
        let pos = &mut ctx.accounts.position;
        require!(pos.status == PositionStatus::Initializing as u8, LeverageError::WrongStatus);
        pos.usdc_bump = ctx.bumps.position_usdc;
        pos.ctrs_bump = ctx.bumps.position_ctrs;
        Ok(())
    }

    pub fn open_position(
        ctx: Context<OpenPosition>,
        collateral_usdc: u64,
        leverage_bps: u64,
    ) -> Result<()> {
        require!(
            leverage_bps >= MIN_LEVERAGE_BPS && leverage_bps <= MAX_LEVERAGE_BPS,
            LeverageError::InvalidLeverage
        );
        require!(collateral_usdc > 0, LeverageError::ZeroAmount);

        let pos = &mut ctx.accounts.position;
        require!(pos.status == PositionStatus::Initializing as u8, LeverageError::WrongStatus);

        let total = (collateral_usdc as u128)
            .checked_mul(leverage_bps as u128).ok_or(LeverageError::MathOverflow)?
            .checked_div(BPS_DENOM as u128).ok_or(LeverageError::MathOverflow)?;
        require!(total <= u64::MAX as u128, LeverageError::MathOverflow);
        let total_u64 = total as u64;
        let debt = total_u64
            .checked_sub(collateral_usdc)
            .ok_or(LeverageError::MathOverflow)?;
        let min_collateral = (total_u64 as u128)
            .checked_mul(MIN_USER_COLLATERAL_BPS as u128).ok_or(LeverageError::MathOverflow)?
            .checked_div(BPS_DENOM as u128).ok_or(LeverageError::MathOverflow)?;
        require!(
            collateral_usdc as u128 >= min_collateral,
            LeverageError::InsufficientCollateral
        );

        // Step 1 — pull collateral from user → position USDC account.
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.user_usdc_account.to_account_info(),
                    to: ctx.accounts.position_usdc_account.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            collateral_usdc,
        )?;

        // Step 2 — borrow from contra_lending into position USDC account.
        let auth_bump = ctx.accounts.borrower_authority.bump;
        let auth_signer: &[&[&[u8]]] = &[&[BORROWER_AUTH_SEED, &[auth_bump]]];
        if debt > 0 {
            contra_lending::cpi::borrow(
                CpiContext::new_with_signer(
                    ctx.accounts.contra_lending_program.to_account_info(),
                    Borrow {
                        pool: ctx.accounts.lending_pool.to_account_info(),
                        pool_usdc_account: ctx.accounts.lending_pool_usdc.to_account_info(),
                        borrow_authority: ctx.accounts.borrower_authority.to_account_info(),
                        destination_usdc_account: ctx.accounts.position_usdc_account.to_account_info(),
                        token_program: ctx.accounts.token_program.to_account_info(),
                    },
                    auth_signer,
                ),
                debt,
            )?;
        }

        // Step 3 — deposit total exposure into the basket vault, minting CTRS
        // back to position_ctrs_account. The position PDA signs as `user`.
        let basket_uuid = pos.basket_uuid;
        let pos_bump = pos.bump;
        let user_pk = pos.owner;
        let pos_signer: &[&[&[u8]]] = &[&[
            POSITION_SEED,
            basket_uuid.as_ref(),
            user_pk.as_ref(),
            &[pos_bump],
        ]];
        contra_vault::cpi::deposit(
            CpiContext::new_with_signer(
                ctx.accounts.contra_vault_program.to_account_info(),
                VaultDeposit {
                    vault: ctx.accounts.vault.to_account_info(),
                    contra_mint: ctx.accounts.contra_mint.to_account_info(),
                    vault_usdc_account: ctx.accounts.vault_usdc_account.to_account_info(),
                    user: ctx.accounts.position.to_account_info(),
                    user_usdc_account: ctx.accounts.position_usdc_account.to_account_info(),
                    user_contra_account: ctx.accounts.position_ctrs_account.to_account_info(),
                    token_program: ctx.accounts.token_program.to_account_info(),
                },
                pos_signer,
            ),
            total_u64,
        )?;

        let pos = &mut ctx.accounts.position;
        pos.collateral_usdc = collateral_usdc;
        pos.debt_usdc = debt;
        pos.ctrs_held = total_u64; // contra_vault mints 1:1 during Active
        pos.leverage_bps = leverage_bps;
        pos.health_factor = HEALTH_SCALE; // NAV = 1.0 at open
        pos.opened_at = Clock::get()?.unix_timestamp;
        pos.status = PositionStatus::Open as u8;
        Ok(())
    }

    /// Recompute health using a fresh NAV passed by the authority (off-chain
    /// oracle for now — leg outcomes live in DB until resolve_leg fires).
    pub fn update_health(ctx: Context<UpdateHealth>, current_nav_scaled: u64) -> Result<()> {
        let pos = &mut ctx.accounts.position;
        require!(pos.status == PositionStatus::Open as u8, LeverageError::WrongStatus);
        pos.health_factor = compute_health(pos.ctrs_held, current_nav_scaled, pos.debt_usdc)?;
        Ok(())
    }

    pub fn close_position(ctx: Context<ClosePosition>, vault_finalized: bool) -> Result<()> {
        let pos = &mut ctx.accounts.position;
        require!(pos.status == PositionStatus::Open as u8, LeverageError::WrongStatus);
        unwind_position(
            &ctx.accounts.contra_vault_program,
            &ctx.accounts.contra_lending_program,
            &ctx.accounts.token_program,
            &ctx.accounts.vault,
            &ctx.accounts.contra_mint,
            &ctx.accounts.vault_usdc_account,
            &ctx.accounts.position,
            &mut ctx.accounts.position_usdc_account,
            &ctx.accounts.position_ctrs_account,
            &ctx.accounts.lending_pool,
            &ctx.accounts.lending_pool_usdc,
            &ctx.accounts.borrower_authority,
            &ctx.accounts.user_usdc_account,
            None, // no liquidator bonus
            vault_finalized,
        )?;
        let pos = &mut ctx.accounts.position;
        pos.status = PositionStatus::Closed as u8;
        pos.closed_at = Clock::get()?.unix_timestamp;
        Ok(())
    }

    /// Anyone may liquidate when health_factor < 1.15. Liquidator gets a 5%
    /// bonus skimmed off the recovered USDC; user gets the rest after debt repay.
    pub fn liquidate(ctx: Context<Liquidate>, current_nav_scaled: u64, vault_finalized: bool) -> Result<()> {
        let pos = &mut ctx.accounts.position;
        require!(pos.status == PositionStatus::Open as u8, LeverageError::WrongStatus);
        let hf = compute_health(pos.ctrs_held, current_nav_scaled, pos.debt_usdc)?;
        require!(hf < LIQUIDATION_THRESHOLD, LeverageError::HealthyPosition);
        pos.health_factor = hf;

        unwind_position(
            &ctx.accounts.contra_vault_program,
            &ctx.accounts.contra_lending_program,
            &ctx.accounts.token_program,
            &ctx.accounts.vault,
            &ctx.accounts.contra_mint,
            &ctx.accounts.vault_usdc_account,
            &ctx.accounts.position,
            &mut ctx.accounts.position_usdc_account,
            &ctx.accounts.position_ctrs_account,
            &ctx.accounts.lending_pool,
            &ctx.accounts.lending_pool_usdc,
            &ctx.accounts.borrower_authority,
            &ctx.accounts.user_usdc_account,
            Some(&ctx.accounts.liquidator_usdc_account),
            vault_finalized,
        )?;

        let pos = &mut ctx.accounts.position;
        pos.status = PositionStatus::Liquidated as u8;
        pos.closed_at = Clock::get()?.unix_timestamp;
        Ok(())
    }
}

// ---------- shared unwind logic --------------------------------------

#[allow(clippy::too_many_arguments)]
fn unwind_position<'info>(
    vault_program: &Program<'info, ContraVault>,
    lending_program: &Program<'info, ContraLending>,
    token_program: &Program<'info, Token>,
    vault: &Account<'info, contra_vault::Vault>,
    contra_mint: &Account<'info, Mint>,
    vault_usdc_account: &Account<'info, TokenAccount>,
    position: &Account<'info, Position>,
    position_usdc: &mut Account<'info, TokenAccount>,
    position_ctrs: &Account<'info, TokenAccount>,
    lending_pool: &Account<'info, contra_lending::Pool>,
    lending_pool_usdc: &Account<'info, TokenAccount>,
    borrower_authority: &Account<'info, BorrowerAuthority>,
    user_usdc: &Account<'info, TokenAccount>,
    liquidator_usdc: Option<&Account<'info, TokenAccount>>,
    vault_finalized: bool,
) -> Result<()> {
    let basket_uuid = position.basket_uuid;
    let pos_bump = position.bump;
    let owner = position.owner;
    let pos_signer: &[&[&[u8]]] = &[&[
        POSITION_SEED,
        basket_uuid.as_ref(),
        owner.as_ref(),
        &[pos_bump],
    ]];

    // Step 1 — burn CTRS, pull USDC back into position_usdc_account.
    if position.ctrs_held > 0 {
        if vault_finalized {
            contra_vault::cpi::redeem(
                CpiContext::new_with_signer(
                    vault_program.to_account_info(),
                    Redeem {
                        vault: vault.to_account_info(),
                        contra_mint: contra_mint.to_account_info(),
                        vault_usdc_account: vault_usdc_account.to_account_info(),
                        user: position.to_account_info(),
                        user_contra_account: position_ctrs.to_account_info(),
                        user_usdc_account: position_usdc.to_account_info(),
                        token_program: token_program.to_account_info(),
                    },
                    pos_signer,
                ),
                position.ctrs_held,
            )?;
        } else {
            contra_vault::cpi::exit_active(
                CpiContext::new_with_signer(
                    vault_program.to_account_info(),
                    ExitActive {
                        vault: vault.to_account_info(),
                        contra_mint: contra_mint.to_account_info(),
                        vault_usdc_account: vault_usdc_account.to_account_info(),
                        user: position.to_account_info(),
                        user_contra_account: position_ctrs.to_account_info(),
                        user_usdc_account: position_usdc.to_account_info(),
                        token_program: token_program.to_account_info(),
                    },
                    pos_signer,
                ),
                position.ctrs_held,
            )?;
        }
    }

    // Re-read the recovered USDC balance from the position USDC account.
    position_usdc.reload()?;
    let recovered = position_usdc.amount;

    // Step 2 — repay debt to lending pool. We always repay the full
    // outstanding debt if we can; any shortfall is socialized to LPs as
    // bad debt (acceptable for v0; revisit when adding insurance fund).
    let auth_bump = borrower_authority.bump;
    let auth_signer: &[&[&[u8]]] = &[&[BORROWER_AUTH_SEED, &[auth_bump]]];
    let repay_amount = position.debt_usdc.min(recovered);
    if repay_amount > 0 {
        contra_lending::cpi::repay(
            CpiContext::new_with_signer(
                lending_program.to_account_info(),
                Repay {
                    pool: lending_pool.to_account_info(),
                    pool_usdc_account: lending_pool_usdc.to_account_info(),
                    repayer: borrower_authority.to_account_info(),
                    source_usdc_account: position_usdc.to_account_info(),
                    token_program: token_program.to_account_info(),
                },
                auth_signer,
            ),
            repay_amount,
        )?;
    }

    // Step 3 — distribute remainder. Liquidator gets 5% bonus on remainder
    // (capped at remainder); user receives the rest.
    position_usdc.reload()?;
    let mut remainder = position_usdc.amount;
    if let Some(liq_acct) = liquidator_usdc {
        if remainder > 0 {
            let bonus = (remainder as u128)
                .checked_mul(LIQUIDATOR_BONUS_BPS as u128).ok_or(LeverageError::MathOverflow)?
                .checked_div(BPS_DENOM as u128).ok_or(LeverageError::MathOverflow)? as u64;
            let bonus = bonus.min(remainder);
            if bonus > 0 {
                token::transfer(
                    CpiContext::new_with_signer(
                        token_program.to_account_info(),
                        Transfer {
                            from: position_usdc.to_account_info(),
                            to: liq_acct.to_account_info(),
                            authority: position.to_account_info(),
                        },
                        pos_signer,
                    ),
                    bonus,
                )?;
                remainder -= bonus;
            }
        }
    }
    if remainder > 0 {
        token::transfer(
            CpiContext::new_with_signer(
                token_program.to_account_info(),
                Transfer {
                    from: position_usdc.to_account_info(),
                    to: user_usdc.to_account_info(),
                    authority: position.to_account_info(),
                },
                pos_signer,
            ),
            remainder,
        )?;
    }

    Ok(())
}

fn compute_health(ctrs: u64, nav_scaled: u64, debt: u64) -> Result<u64> {
    if debt == 0 {
        return Ok(u64::MAX);
    }
    // value = ctrs × nav_scaled / NAV_SCALE   (u128)
    // health = value × HEALTH_SCALE / debt    (u128)
    let value = (ctrs as u128)
        .checked_mul(nav_scaled as u128).ok_or(LeverageError::MathOverflow)?
        .checked_div(NAV_SCALE as u128).ok_or(LeverageError::MathOverflow)?;
    let hf = value
        .checked_mul(HEALTH_SCALE as u128).ok_or(LeverageError::MathOverflow)?
        .checked_div(debt as u128).ok_or(LeverageError::MathOverflow)?;
    Ok(u64::try_from(hf).unwrap_or(u64::MAX))
}

// ---------- accounts --------------------------------------------------

#[derive(Accounts)]
pub struct InitializeBorrowerAuthority<'info> {
    #[account(
        init,
        payer = authority,
        space = BorrowerAuthority::SPACE,
        seeds = [BORROWER_AUTH_SEED],
        bump,
    )]
    pub borrower_authority: Account<'info, BorrowerAuthority>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(basket_uuid: [u8; 16])]
pub struct InitPosition<'info> {
    /// The basket vault this position will be entered into. Cross-checked
    /// against basket_uuid via vault.basket_uuid (read-only here).
    pub vault: Account<'info, contra_vault::Vault>,
    #[account(
        init,
        payer = user,
        space = Position::SPACE,
        seeds = [POSITION_SEED, basket_uuid.as_ref(), user.key().as_ref()],
        bump,
        constraint = vault.basket_uuid == basket_uuid @ LeverageError::BasketMismatch,
    )]
    pub position: Account<'info, Position>,
    #[account(mut)]
    pub user: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct InitPositionTokens<'info> {
    #[account(
        mut,
        seeds = [POSITION_SEED, position.basket_uuid.as_ref(), position.owner.as_ref()],
        bump = position.bump,
        constraint = position.owner == user.key() @ LeverageError::Unauthorized,
    )]
    pub position: Account<'info, Position>,
    pub vault: Account<'info, contra_vault::Vault>,
    pub usdc_mint: Account<'info, Mint>,
    #[account(address = vault.contra_mint @ LeverageError::WrongMint)]
    pub contra_mint: Account<'info, Mint>,
    #[account(
        init,
        payer = user,
        seeds = [POSITION_USDC_SEED, position.key().as_ref()],
        bump,
        token::mint = usdc_mint,
        token::authority = position,
    )]
    pub position_usdc: Account<'info, TokenAccount>,
    #[account(
        init,
        payer = user,
        seeds = [POSITION_CTRS_SEED, position.key().as_ref()],
        bump,
        token::mint = contra_mint,
        token::authority = position,
    )]
    pub position_ctrs: Account<'info, TokenAccount>,
    #[account(mut)]
    pub user: Signer<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct OpenPosition<'info> {
    #[account(
        mut,
        seeds = [POSITION_SEED, position.basket_uuid.as_ref(), position.owner.as_ref()],
        bump = position.bump,
        constraint = position.owner == user.key() @ LeverageError::Unauthorized,
    )]
    pub position: Account<'info, Position>,

    #[account(mut)]
    pub vault: Account<'info, contra_vault::Vault>,
    #[account(mut, address = vault.contra_mint @ LeverageError::WrongMint)]
    pub contra_mint: Account<'info, Mint>,
    #[account(mut, address = vault.vault_usdc_account @ LeverageError::WrongVaultAccount)]
    pub vault_usdc_account: Account<'info, TokenAccount>,

    #[account(mut)]
    pub lending_pool: Account<'info, contra_lending::Pool>,
    #[account(mut, address = lending_pool.pool_usdc_account @ LeverageError::WrongVaultAccount)]
    pub lending_pool_usdc: Account<'info, TokenAccount>,
    #[account(seeds = [BORROWER_AUTH_SEED], bump = borrower_authority.bump)]
    pub borrower_authority: Account<'info, BorrowerAuthority>,

    #[account(
        mut,
        seeds = [POSITION_USDC_SEED, position.key().as_ref()],
        bump = position.usdc_bump,
    )]
    pub position_usdc_account: Account<'info, TokenAccount>,
    #[account(
        mut,
        seeds = [POSITION_CTRS_SEED, position.key().as_ref()],
        bump = position.ctrs_bump,
    )]
    pub position_ctrs_account: Account<'info, TokenAccount>,

    #[account(mut)]
    pub user: Signer<'info>,
    #[account(
        mut,
        constraint = user_usdc_account.owner == user.key() @ LeverageError::Unauthorized,
    )]
    pub user_usdc_account: Account<'info, TokenAccount>,

    pub contra_vault_program: Program<'info, ContraVault>,
    pub contra_lending_program: Program<'info, ContraLending>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct UpdateHealth<'info> {
    #[account(
        mut,
        seeds = [POSITION_SEED, position.basket_uuid.as_ref(), position.owner.as_ref()],
        bump = position.bump,
    )]
    pub position: Account<'info, Position>,
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct ClosePosition<'info> {
    #[account(
        mut,
        seeds = [POSITION_SEED, position.basket_uuid.as_ref(), position.owner.as_ref()],
        bump = position.bump,
        constraint = position.owner == user.key() @ LeverageError::Unauthorized,
    )]
    pub position: Account<'info, Position>,

    #[account(mut)]
    pub vault: Account<'info, contra_vault::Vault>,
    #[account(mut, address = vault.contra_mint @ LeverageError::WrongMint)]
    pub contra_mint: Account<'info, Mint>,
    #[account(mut, address = vault.vault_usdc_account @ LeverageError::WrongVaultAccount)]
    pub vault_usdc_account: Account<'info, TokenAccount>,

    #[account(mut)]
    pub lending_pool: Account<'info, contra_lending::Pool>,
    #[account(mut, address = lending_pool.pool_usdc_account @ LeverageError::WrongVaultAccount)]
    pub lending_pool_usdc: Account<'info, TokenAccount>,
    #[account(seeds = [BORROWER_AUTH_SEED], bump = borrower_authority.bump)]
    pub borrower_authority: Account<'info, BorrowerAuthority>,

    #[account(
        mut,
        seeds = [POSITION_USDC_SEED, position.key().as_ref()],
        bump = position.usdc_bump,
    )]
    pub position_usdc_account: Account<'info, TokenAccount>,
    #[account(
        mut,
        seeds = [POSITION_CTRS_SEED, position.key().as_ref()],
        bump = position.ctrs_bump,
    )]
    pub position_ctrs_account: Account<'info, TokenAccount>,

    #[account(mut)]
    pub user: Signer<'info>,
    #[account(
        mut,
        constraint = user_usdc_account.owner == user.key() @ LeverageError::Unauthorized,
    )]
    pub user_usdc_account: Account<'info, TokenAccount>,

    pub contra_vault_program: Program<'info, ContraVault>,
    pub contra_lending_program: Program<'info, ContraLending>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct Liquidate<'info> {
    #[account(
        mut,
        seeds = [POSITION_SEED, position.basket_uuid.as_ref(), position.owner.as_ref()],
        bump = position.bump,
    )]
    pub position: Account<'info, Position>,

    #[account(mut)]
    pub vault: Account<'info, contra_vault::Vault>,
    #[account(mut, address = vault.contra_mint @ LeverageError::WrongMint)]
    pub contra_mint: Account<'info, Mint>,
    #[account(mut, address = vault.vault_usdc_account @ LeverageError::WrongVaultAccount)]
    pub vault_usdc_account: Account<'info, TokenAccount>,

    #[account(mut)]
    pub lending_pool: Account<'info, contra_lending::Pool>,
    #[account(mut, address = lending_pool.pool_usdc_account @ LeverageError::WrongVaultAccount)]
    pub lending_pool_usdc: Account<'info, TokenAccount>,
    #[account(seeds = [BORROWER_AUTH_SEED], bump = borrower_authority.bump)]
    pub borrower_authority: Account<'info, BorrowerAuthority>,

    #[account(
        mut,
        seeds = [POSITION_USDC_SEED, position.key().as_ref()],
        bump = position.usdc_bump,
    )]
    pub position_usdc_account: Account<'info, TokenAccount>,
    #[account(
        mut,
        seeds = [POSITION_CTRS_SEED, position.key().as_ref()],
        bump = position.ctrs_bump,
    )]
    pub position_ctrs_account: Account<'info, TokenAccount>,

    /// The position owner's USDC ATA — receives the post-debt remainder.
    #[account(mut)]
    pub user_usdc_account: Account<'info, TokenAccount>,

    #[account(mut)]
    pub liquidator: Signer<'info>,
    #[account(
        mut,
        constraint = liquidator_usdc_account.owner == liquidator.key() @ LeverageError::Unauthorized,
    )]
    pub liquidator_usdc_account: Account<'info, TokenAccount>,

    pub contra_vault_program: Program<'info, ContraVault>,
    pub contra_lending_program: Program<'info, ContraLending>,
    pub token_program: Program<'info, Token>,
}

// ---------- state -----------------------------------------------------

#[repr(u8)]
pub enum PositionStatus {
    Initializing = 0,
    Open = 1,
    Closed = 2,
    Liquidated = 3,
}

#[account]
pub struct BorrowerAuthority {
    pub authority: Pubkey,
    pub bump: u8,
}

impl BorrowerAuthority {
    pub const SPACE: usize = 8 + 32 + 1;
}

#[account]
pub struct Position {
    pub owner: Pubkey,
    pub basket_vault: Pubkey,
    pub basket_uuid: [u8; 16],
    pub collateral_usdc: u64,
    pub debt_usdc: u64,
    pub ctrs_held: u64,
    pub leverage_bps: u64,
    pub health_factor: u64,
    pub opened_at: i64,
    pub closed_at: i64,
    pub status: u8,
    pub bump: u8,
    pub usdc_bump: u8,
    pub ctrs_bump: u8,
}

impl Position {
    pub const SPACE: usize = 8         // discriminator
        + 32 + 32 + 16                 // owner, basket_vault, basket_uuid
        + 8 * 5                        // 5 u64s (collateral, debt, ctrs, leverage, health)
        + 8 + 8                        // opened_at, closed_at
        + 1 + 1 + 1 + 1;               // status + 3 bumps
}

// ---------- errors ----------------------------------------------------

#[error_code]
pub enum LeverageError {
    #[msg("Position not in the required status for this instruction.")]
    WrongStatus,
    #[msg("Caller is not the position owner.")]
    Unauthorized,
    #[msg("Vault basket UUID does not match position.")]
    BasketMismatch,
    #[msg("Mint provided does not match vault.")]
    WrongMint,
    #[msg("Vault USDC account or pool USDC account mismatch.")]
    WrongVaultAccount,
    #[msg("Leverage outside [1.00x, 3.00x] range.")]
    InvalidLeverage,
    #[msg("Collateral below required 40% of total exposure.")]
    InsufficientCollateral,
    #[msg("Position is healthy and cannot be liquidated.")]
    HealthyPosition,
    #[msg("Amount must be greater than zero.")]
    ZeroAmount,
    #[msg("Arithmetic overflow.")]
    MathOverflow,
}
