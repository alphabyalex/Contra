-- =====================================================================
-- CONTRA — Supabase / Postgres schema
-- Run this in the Supabase SQL editor before starting the backend.
-- All tables are owned by the service_role; the anon key cannot mutate.
-- =====================================================================

create extension if not exists pgcrypto;

-- ---------- baskets --------------------------------------------------
-- One row per short basket. The on-chain Vault PDA + CTRS mint are
-- written back here after the 3-step initialization completes.
create table if not exists baskets (
    id                  uuid primary key default gen_random_uuid(),
    name                text not null,
    description         text,
    status              text not null default 'initializing'
                          check (status in ('initializing','active','resolving','finalized')),
    leverage_type       text not null
                          check (leverage_type in ('conservative','aggressive','degen')),
    category            text,                       -- politics/macro/crypto/sports/culture/other
    vault_pda           text,                       -- base58 Pubkey, set after init
    contra_mint         text,                       -- base58 Pubkey, set after init
    num_legs            integer not null check (num_legs > 0),
    final_payout_ratio  numeric(20,8),              -- > 1.0 = profitable basket
    created_at          timestamptz not null default now(),
    activated_at        timestamptz,
    finalized_at        timestamptz
);

create index if not exists idx_baskets_status on baskets (status);
create index if not exists idx_baskets_category on baskets (category);

-- ---------- legs -----------------------------------------------------
-- One row per prediction-market outcome inside a basket. leg_index
-- mirrors the on-chain Leg slot index used by add_leg / resolve_leg.
create table if not exists legs (
    id                  uuid primary key default gen_random_uuid(),
    basket_id           uuid not null references baskets(id) on delete cascade,
    leg_index           smallint not null check (leg_index >= 0),
    source              text not null check (source in ('kalshi','polymarket')),
    market_id           text not null,              -- Polymarket conditionId or Kalshi ticker
    question            text not null,
    outcome_label       text,                       -- which side we are short ("YES"/"NO"/multi-outcome label)
    p_market_entry      numeric(10,8) not null check (p_market_entry > 0 and p_market_entry < 1),
    p_model             numeric(10,8) not null check (p_model >= 0 and p_model <= 1),
    edge                numeric(10,8) not null,     -- p_market - p_model
    weight              numeric(10,8) not null check (weight > 0 and weight <= 1),
    outcome             smallint check (outcome in (0,1)),  -- null=open, 0=NO(won), 1=YES(lost)
    resolved_at         timestamptz,
    created_at          timestamptz not null default now(),
    unique (basket_id, leg_index)
);

create index if not exists idx_legs_basket on legs (basket_id);
create index if not exists idx_legs_open on legs (basket_id) where outcome is null;
create index if not exists idx_legs_market_id on legs (source, market_id);

-- ---------- positions (un-leveraged basket holders) ------------------
create table if not exists positions (
    id                  uuid primary key default gen_random_uuid(),
    basket_id           uuid not null references baskets(id) on delete cascade,
    wallet              text not null,              -- base58 Pubkey
    tokens_held         numeric(20,6) not null,     -- CTRS, 6 decimals
    usdc_deposited      numeric(20,6) not null,     -- cumulative USDC in
    entry_nav           numeric(20,8) not null default 1.0,
    entry_tx            text,                       -- first deposit signature
    created_at          timestamptz not null default now(),
    updated_at          timestamptz not null default now(),
    unique (basket_id, wallet)
);

create index if not exists idx_positions_wallet on positions (wallet);
create index if not exists idx_positions_basket on positions (basket_id);

-- ---------- leveraged_positions --------------------------------------
-- Each row is one open or closed leveraged exposure managed by the
-- contra_leverage program. Health factor < 1.15 is liquidatable.
create table if not exists leveraged_positions (
    id                  uuid primary key default gen_random_uuid(),
    basket_id           uuid not null references baskets(id),
    wallet              text not null,
    position_pda        text,                       -- base58, set after open_position
    collateral_usdc     numeric(20,6) not null,     -- user's principal
    debt_usdc           numeric(20,6) not null,     -- borrowed from contra_lending
    vault_tokens        numeric(20,6) not null,     -- CTRS held by position PDA
    leverage            numeric(4,2) not null check (leverage >= 1 and leverage <= 3),
    health_factor       numeric(10,4) not null,
    opened_at           timestamptz not null default now(),
    closed_at           timestamptz,
    closed_pnl_usdc     numeric(20,6),
    liquidated          boolean not null default false
);

create index if not exists idx_lev_wallet on leveraged_positions (wallet);
create index if not exists idx_lev_basket on leveraged_positions (basket_id);
create index if not exists idx_lev_open_health
    on leveraged_positions (health_factor) where closed_at is null;

-- ---------- nav_snapshots --------------------------------------------
-- Time-series of basket NAV for charts. Cron writes one row every 2 min.
create table if not exists nav_snapshots (
    id              uuid primary key default gen_random_uuid(),
    basket_id       uuid not null references baskets(id) on delete cascade,
    nav             numeric(20,8) not null,
    legs_resolved   smallint not null default 0,
    snapshotted_at  timestamptz not null default now()
);

create index if not exists idx_nav_basket_time
    on nav_snapshots (basket_id, snapshotted_at desc);

-- ---------- transactions (audit log of all on-chain actions) ---------
create table if not exists transactions (
    id              uuid primary key default gen_random_uuid(),
    basket_id       uuid references baskets(id) on delete set null,
    wallet          text not null,
    type            text not null check (type in
                      ('deposit','redeem','exit','leverage_open','leverage_close','liquidation','resolve_leg','finalize')),
    usdc_delta      numeric(20,6),                  -- signed: + into user, - out
    tokens_delta    numeric(20,6),                  -- signed CTRS movement
    tx_signature    text not null unique,
    created_at      timestamptz not null default now()
);

create index if not exists idx_tx_wallet_time on transactions (wallet, created_at desc);
create index if not exists idx_tx_basket on transactions (basket_id);
create index if not exists idx_tx_type on transactions (type);

-- ---------- updated_at trigger for positions -------------------------
create or replace function set_updated_at() returns trigger as $$
begin
    new.updated_at = now();
    return new;
end;
$$ language plpgsql;

drop trigger if exists positions_set_updated_at on positions;
create trigger positions_set_updated_at
    before update on positions
    for each row execute function set_updated_at();
