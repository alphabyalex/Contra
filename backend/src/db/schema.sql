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

-- =====================================================================
-- Run these in Supabase SQL editor manually.
-- Screening + scoring tables for the weekly mispricing pipeline.
-- =====================================================================

-- ---------- screened_markets -----------------------------------------
-- One row per condition_id ever passed through the Anthropic screener.
-- Cached so we never re-screen the same market twice.
CREATE TABLE IF NOT EXISTS screened_markets (
  id uuid primary key default gen_random_uuid(),
  condition_id text not null unique,
  source text not null check (source in ('polymarket','kalshi')),
  question text not null,
  p_market numeric(10,8),
  impossible boolean not null default false,
  already_resolved boolean not null default false,
  ambiguous boolean not null default false,
  excluded boolean not null default false,
  exclusion_reason text,
  screened_at timestamptz not null default now(),
  screening_model text default 'claude-sonnet-4-20250514'
);

CREATE INDEX IF NOT EXISTS idx_screened_condition ON screened_markets (condition_id);
CREATE INDEX IF NOT EXISTS idx_screened_excluded ON screened_markets (excluded);

-- ---------- scored_markets -------------------------------------------
-- One row per scored market (post-screening). Refreshed every weekly run.
CREATE TABLE IF NOT EXISTS scored_markets (
  id uuid primary key default gen_random_uuid(),
  condition_id text not null unique references screened_markets(condition_id),
  source text not null,
  question text not null,
  p_market numeric(10,8) not null,
  p_model numeric(10,8),
  edge numeric(10,8),
  volume numeric(20,2),
  days_to_close integer,
  category text,
  include_in_basket boolean not null default false,
  scored_at timestamptz not null default now(),
  model_version text default 'stub_v1'
);

CREATE INDEX IF NOT EXISTS idx_scored_edge ON scored_markets (edge desc);
CREATE INDEX IF NOT EXISTS idx_scored_include ON scored_markets (include_in_basket);

-- ---------- prediction_log -------------------------------------------
-- Append-only log of every leg added to a basket, plus its eventual
-- resolution. Drives the analytics service (hit rate, Brier score,
-- calibration, edge realization). One row per (condition_id, basket_id)
-- pair; updated when the leg resolves.
CREATE TABLE IF NOT EXISTS prediction_log (
  id uuid primary key default gen_random_uuid(),
  condition_id text not null,
  source text not null,
  question text not null,
  p_market_at_entry numeric(10,8) not null,
  p_model_at_entry numeric(10,8),
  edge_at_entry numeric(10,8),
  basket_id uuid references baskets(id),
  outcome smallint check (outcome in (0,1)),
  days_held integer,
  resolved_at timestamptz,
  logged_at timestamptz not null default now(),
  model_version text default 'stub_v1'
);

CREATE INDEX IF NOT EXISTS idx_predlog_condition ON prediction_log (condition_id);
CREATE INDEX IF NOT EXISTS idx_predlog_basket ON prediction_log (basket_id);
CREATE INDEX IF NOT EXISTS idx_predlog_outcome ON prediction_log (outcome);
CREATE INDEX IF NOT EXISTS idx_predlog_logged ON prediction_log (logged_at desc);

-- =====================================================================
-- Run these in Supabase SQL editor manually.
-- Tables for the price collector + resolution monitor + tracked-market
-- pipeline (added with calibration_v1).
-- =====================================================================

-- New column on scored_markets for impossible-flagged markets.
ALTER TABLE scored_markets
  ADD COLUMN IF NOT EXISTS impossible_edge boolean NOT NULL DEFAULT false;

-- ---------- tracked_markets -----------------------------------------
-- One row per market we've decided to follow. Created when the screener
-- accepts a market; updated when the price collector or resolution
-- monitor learns more. The price collector tier is derived from
-- (resolution_date - now()).
CREATE TABLE IF NOT EXISTS tracked_markets (
  id uuid primary key default gen_random_uuid(),
  condition_id text not null unique,
  source text not null,
  question text not null,
  token_id text,
  category text,
  p_market_initial numeric(10,8),
  p_model_initial numeric(10,8),
  edge_initial numeric(10,8),
  resolution_date timestamptz,
  in_basket boolean not null default false,
  outcome smallint check (outcome in (0,1)),
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

CREATE INDEX IF NOT EXISTS idx_tracked_condition ON tracked_markets (condition_id);
CREATE INDEX IF NOT EXISTS idx_tracked_open ON tracked_markets (resolved_at) WHERE resolved_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_tracked_resolution ON tracked_markets (resolution_date);

DROP TRIGGER IF EXISTS tracked_set_updated_at ON tracked_markets;
CREATE TRIGGER tracked_set_updated_at
    BEFORE UPDATE ON tracked_markets
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------- market_price_history ------------------------------------
-- Append-only price stream from Polymarket CLOB. Rows are deleted in
-- bulk when a market resolves (history is moved to a CSV in
-- market_data/resolved/).
CREATE TABLE IF NOT EXISTS market_price_history (
  id uuid primary key default gen_random_uuid(),
  condition_id text not null,
  price numeric(10,8) not null,
  days_to_close integer,
  recorded_at timestamptz not null default now()
);

CREATE INDEX IF NOT EXISTS idx_price_condition_time ON market_price_history (condition_id, recorded_at desc);

-- =====================================================================
-- Run these in Supabase SQL editor manually.
-- calibration_v2 layered edge model + momentum prep.
-- =====================================================================

ALTER TABLE scored_markets
  ADD COLUMN IF NOT EXISTS impossible_edge   boolean       NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS adjusted_edge     numeric(10,8),
  ADD COLUMN IF NOT EXISTS time_factor       numeric(6,4),
  ADD COLUMN IF NOT EXISTS category_factor   numeric(6,4),
  ADD COLUMN IF NOT EXISTS volume_factor     numeric(6,4),
  ADD COLUMN IF NOT EXISTS p_market_7d_ago   numeric(10,8),
  ADD COLUMN IF NOT EXISTS momentum          numeric(10,8),
  ADD COLUMN IF NOT EXISTS momentum_factor   numeric(6,4) NOT NULL DEFAULT 1.0;

CREATE INDEX IF NOT EXISTS idx_scored_adjusted_edge ON scored_markets (adjusted_edge desc);
CREATE INDEX IF NOT EXISTS idx_scored_category ON scored_markets (category);
