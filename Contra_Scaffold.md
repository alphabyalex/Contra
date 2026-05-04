# CONTRA — Full Project Scaffold
> Paste this into your Contra repo root. Every file listed below should be created as an empty file with this path. Claude Code will fill them in order.

## Directory Structure

```
contra/
├── Anchor.toml
├── Cargo.toml
├── .env.example
├── README.md
├── CLAUDE_BRIEF.md
│
├── programs/
│   ├── contra_vault/
│   │   └── src/lib.rs
│   ├── contra_lending/
│   │   └── src/lib.rs
│   └── contra_leverage/
│       └── src/lib.rs
│
├── backend/
│   └── src/
│       ├── index.ts
│       ├── routes/
│       │   ├── baskets.ts
│       │   ├── deposit.ts
│       │   ├── markets.ts
│       │   ├── portfolio.ts
│       │   ├── scanner.ts
│       │   ├── leverage.ts
│       │   └── admin.ts
│       ├── services/
│       │   ├── kalshi.ts
│       │   ├── polymarket.ts
│       │   ├── mispricing.ts
│       │   ├── basket-builder.ts
│       │   ├── nav.ts
│       │   ├── leverage.ts
│       │   └── cron.ts
│       ├── solana/
│       │   ├── client.ts
│       │   ├── deposit.ts
│       │   ├── resolve.ts
│       │   └── pda.ts
│       ├── db/
│       │   ├── supabase.ts
│       │   ├── queries.ts
│       │   └── schema.sql
│       └── idl/
│           └── .gitkeep
│
├── app/
│   └── app/
│       ├── layout.tsx
│       ├── page.tsx
│       ├── baskets/
│       │   ├── page.tsx
│       │   └── [id]/
│       │       └── page.tsx
│       ├── scanner/
│       │   └── page.tsx
│       ├── portfolio/
│       │   └── page.tsx
│       ├── _lib/
│       │   ├── state.tsx
│       │   ├── wallet.tsx
│       │   ├── api.ts
│       │   ├── tokens.ts
│       │   └── deposit-client.ts
│       └── _components/
│           ├── BasketCard.tsx
│           ├── NavChart.tsx
│           ├── LegTable.tsx
│           ├── DepositForm.tsx
│           └── ScannerRow.tsx
│
├── ml/
│   ├── train.py
│   ├── features.py
│   ├── scorer.py
│   ├── backtest.py
│   ├── requirements.txt
│   └── artifacts/
│       └── .gitkeep
│
├── scripts/
│   ├── deploy-devnet.sh
│   ├── sync-idl.sh
│   ├── init-vaults.ts
│   ├── demo-lifecycle.ts
│   └── seed-baskets.ts
│
└── tests/
    ├── contra_vault.ts
    ├── contra_lending.ts
    └── contra_leverage.ts
```

---

## File Purpose Map

### On-Chain Programs (`programs/`)

#### `contra_vault/src/lib.rs`
**What it is:** The core short basket vault. Users deposit USDC, receive CTRS basket tokens. As legs resolve NO, NAV increases. As legs resolve YES (longshot hits), NAV decreases.

**CRITICAL INVERSION vs reference:** NAV goes UP on NO resolution, not YES. This is the opposite of the Senthos-Demo traxis_vault. Everything else structurally mirrors it.

**Instructions to build:**
- `initialize_vault(args)` — Create Vault PDA, store leg metadata, basket UUID
- `initialize_contra_mint()` — Create CTRS SPL mint PDA ← split into own instruction, BPF stack limit
- `initialize_vault_tokens()` — Create USDC token account PDA ← split, same reason
- `deposit(amount_usdc)` — Transfer USDC → vault, mint CTRS to user at current NAV
- `resolve_leg(leg_index, outcome)` — outcome=0 (NO) = win, outcome=1 (YES) = loss
- `finalize_vault()` — Lock payout_ratio once all legs resolved. ratio > 1.0 = profit
- `redeem(amount_tokens)` — Burn CTRS, receive USDC × payout_ratio
- `exit_active(amount_tokens)` — Early exit with 30bps haircut

**Reference:** `Senthos-Demo/programs/traxis_vault/src/lib.rs` — copy the account structure, PDA seeds pattern, and 3-instruction split. Rewrite all instruction logic.

---

#### `contra_lending/src/lib.rs`
**What it is:** USDC lending pool. LPs deposit to earn yield. contra_leverage borrows from here on behalf of users who want 2x/3x exposure.

**Instructions to build:**
- `initialize_pool()` — Bootstrap pool, set rate curve params
- `lend(amount_usdc)` — LP deposits, receives LP tokens
- `withdraw(amount_lp)` — LP redeems for USDC + accrued interest
- `borrow(amount)` — CPI-only, callable by contra_leverage program only
- `repay(amount)` — CPI-only, called by contra_leverage on position close

**Interest rate curve:**
- 0% utilization → 3% APY
- 80% utilization → 8% APY
- 100% utilization → 50% APY

**Reference:** `Senthos-Demo/programs/traxis_lending/src/lib.rs` — coded but never deployed. Use for account structure only.

---

#### `contra_leverage/src/lib.rs`
**What it is:** Leveraged position manager. Chains CPIs from contra_lending (borrow) → contra_vault (deposit). Tracks health factor. Triggers liquidations.

**Instructions to build:**
- `open_position(collateral_usdc, leverage, basket_id)` — borrow → deposit → record position
- `close_position(position_pubkey)` — redeem → repay → return remainder to user
- `liquidate(position_pubkey)` — callable by anyone when health < 1.15, liquidator earns 5% bonus
- `update_health(position_pubkey)` — recalculate health_factor from current NAV

**Health factor:** `position_value / debt`. Liquidatable below 1.15.

**Max leverage devnet:** 3x. User deposits minimum 40% of total exposure.

**Reference:** `Senthos-Demo/programs/traxis_ppn/src/lib.rs` — CPI pattern into traxis_vault is exactly what you need for CPIs into contra_vault. Adapt the CPI call structure only.

---

### Backend (`backend/src/`)

#### `index.ts`
Express server entry point. Mount all routes. Start cron. Load ML artifacts on startup. Port 3001. Degrade gracefully if Supabase creds missing (use in-memory mock).

---

#### `routes/baskets.ts`
```
GET  /api/baskets              — list active baskets with current NAV
GET  /api/baskets/:id          — basket detail + legs + model scores
GET  /api/baskets/:id/nav      — NAV history array for chart
POST /api/baskets/construct    — trigger basket construction (admin)
```

---

#### `routes/deposit.ts`
```
POST /api/deposit/prepare      — build unsigned VersionedTransaction, return base64
POST /api/deposit/confirm      — confirm on-chain landing, write Supabase position
```
**CRITICAL:** Backend builds ALL Solana transactions. Frontend never imports Anchor. Frontend gets base64 tx → passes to Phantom → posts signature back.

**Reference:** `Senthos-Demo/backend/src/routes/deposit.ts` — the prepare/confirm two-step flow is exactly right. Rebuild with your PDA seeds and program ID.

---

#### `routes/markets.ts`
```
GET /api/markets/scan          — run live mispricing scan, return ranked candidates
GET /api/markets/:id           — single market detail with model score
```

---

#### `routes/scanner.ts`
```
GET /api/scanner/live          — SSE stream of top mispriced markets updating live
GET /api/scanner/history       — recent scan results from DB
```

---

#### `routes/leverage.ts`
```
POST /api/leverage/prepare     — build open_position tx, return base64
POST /api/leverage/confirm     — confirm position opening
POST /api/leverage/close       — build close_position tx
GET  /api/leverage/:wallet     — user's open leveraged positions
```

---

#### `routes/portfolio.ts`
```
GET /api/portfolio/:wallet     — all positions (basket + leveraged) for wallet
```

---

#### `routes/admin.ts`
```
POST /api/admin/init-vault     — 3-step vault initialization (authority only)
POST /api/admin/resolve-leg    — resolve a leg manually or from webhook
POST /api/admin/finalize       — finalize vault after all legs resolve
```
Authority keypair loaded from AUTHORITY_KEYPAIR env var.

---

#### `services/kalshi.ts`
Kalshi REST API client. Primary data source.
- `getMarkets(params)` — paginate all markets
- `getTokenizedMarkets()` — Solana SPL tokenized markets only (DFlow integration)
- `scanLongshots(threshold)` — filter p_market <= threshold, return ranked list
- `getOrderbook(ticker)` — liquidity depth check before basket inclusion

Auth: Bearer token, KALSHI_API_KEY env var.
Rate limit: 10 req/sec.

---

#### `services/polymarket.ts`
Polymarket Gamma API client. Secondary data source. No API key needed.
- `getMarkets(params)` — paginate (500/page max)
- `getMultiOutcomeMarkets()` — markets with >2 outcomes (multiple legs per market)
- `scanLongshots(threshold)` — including per-outcome for multi-outcome markets
- `getHistoricalResolutions()` — for ML training data

Base URL: `https://gamma-api.polymarket.com`

---

#### `services/mispricing.ts`
ML scoring engine. Loads JSON artifacts at startup. Pure TypeScript — no Python at runtime.

**Artifacts to load from `ml/artifacts/`:**
- `model_coefficients.json` — logistic regression weights
- `category_base_rates.json` — historical resolution rates by category + prob bucket
- `feature_stats.json` — mean/std for normalization
- `model_metrics.json` — precision, threshold, metadata

**Features (must match `ml/features.py` exactly):**
- `p_market` — current YES price
- `days_to_close` — temporal decay signal
- `log_volume` — log10(volume + 1)
- `category_encoded` — one-hot (politics/macro/crypto/sports/culture/other)
- `historical_rate` — base rate for category × probability bucket
- `liquidity_score` — normalized orderbook depth

**Core function:** `scoreMarket(market) → { ...market, p_model, edge, include }`
Edge threshold: 0.06 minimum to include in basket.

**Reference:** `Senthos-Demo/backend/src/services/correlation.ts` — artifact loading pattern and deterministic TS implementation pattern. All math is new.

---

#### `services/basket-builder.ts`
Constructs diversified short baskets from scored markets.
- Deduplicates correlated markets (text similarity > 0.8)
- Enforces category diversification (max 40% per category)
- Assigns weights: equal base, edge-adjusted, max 3% per leg
- Three basket types: Conservative (100+ legs), Aggressive (20-50), Degen (5-10)
- Cascade redeployment: as legs resolve, redeploy freed capital into new legs

---

#### `services/nav.ts`
Computes basket NAV. Short basket formula:
- NO resolution: `contribution = weight × (1 / p_market_at_entry)`
- YES resolution: `contribution = 0`
- Open leg: `contribution = weight × mark_to_market`
- Snapshots to DB every 2 minutes via cron

---

#### `services/leverage.ts`
Off-chain leverage accounting. Tracks health factors. Identifies liquidatable positions. Feeds into contra_leverage program CPIs.

---

#### `services/cron.ts`
node-cron jobs:
- Every 2 min: snapshot NAVs, check liquidations
- Every 6 hours: run scanner, construct new baskets
- Every 30 min: refresh leg prices (mark-to-market)
- On webhook: resolve leg immediately

---

#### `solana/client.ts`
Anchor provider setup. RPC connection. Program clients for all 3 programs. Loaded from IDL files in `backend/src/idl/`.

**Reference:** `Senthos-Demo/backend/src/solana/` — provider setup and IDL loading pattern.

---

#### `solana/deposit.ts`
Builds VersionedTransaction for deposit. Derives all PDAs. Sets compute budget. Returns base64. This is the hardest backend file — get it right.

**Reference:** `Senthos-Demo/backend/src/routes/deposit.ts` `buildDepositTx` function — same pattern, new PDA seeds.

---

#### `solana/pda.ts`
All PDA derivation functions. Centralized here, imported everywhere.
- `deriveVaultPDA(bundleUUID)`
- `deriveContraMint(vaultPDA)`
- `deriveUSDCVault(vaultPDA)`
- `deriveLendingPool()`
- `derivePosition(wallet, basketId)`

---

#### `solana/resolve.ts`
Builds and sends `resolve_leg` and `finalize_vault` transactions. Signed by AUTHORITY_KEYPAIR.

---

#### `db/schema.sql`
```sql
baskets (id, name, status, vault_pda, contra_mint, category, leverage_type, created_at, finalized_at, final_payout_ratio)
legs (id, basket_id, source, market_id, question, outcome_label, p_market_entry, p_model, edge, weight, outcome, resolved_at)
positions (id, basket_id, wallet, tokens_held, usdc_deposited, entry_nav, entry_tx, created_at)
leveraged_positions (id, basket_id, wallet, collateral_usdc, debt_usdc, vault_tokens, leverage, health_factor, opened_at, closed_at)
nav_snapshots (id, basket_id, nav, snapshotted_at)
transactions (id, basket_id, wallet, type, usdc_delta, tx_signature, created_at)
```

---

### Frontend (`app/`)

#### `app/layout.tsx`
Root layout. Wraps all pages in WalletProvider (Phantom). Global nav with tabs: Baskets / Scanner / Portfolio. No sidebar — tabs only.

**Design system:**
- Background: `#09101E`
- Surface: `#101929`
- Card: `#172338`
- Accent: `#3B82F6`
- Positive: `#34D399`
- Negative: `#F87171`
- Text: `#D4E2F4`
- Muted: `#4A6A90`
- Border: `#1E2F48`
- Font logo: Bebas Neue
- Font UI: DM Sans
- Font numbers: IBM Plex Mono

---

#### `app/baskets/page.tsx`
Main baskets grid. Shows all active short baskets.
- Ticker bar at top (live: markets scanned, avg edge, TVL)
- 4 stat cards: P&L, deployed capital, open legs, best basket
- 30-day NAV sparkline chart
- Sortable table: name, NAV, avg edge, # legs, p_market avg, leverage, source, deposit button
- Filter buttons: All / Politics / Macro / Crypto / Sports

---

#### `app/baskets/[id]/page.tsx`
Basket detail page.
- NAV chart (30 days, line chart)
- Basket metadata: # legs, total weight, category breakdown
- Leg table: market question, source (Kalshi/Poly), p_market, p_model, edge, weight, status (open/NO/YES)
- Deposit form: USDC amount input, leverage selector (1x/2x/3x), submit → calls `/api/deposit/prepare`

---

#### `app/scanner/page.tsx`
Live mispricing scanner — shows the model working in real time.
- Table of top 50 overpriced markets right now
- Columns: market question, source, p_market, p_model, edge, days to close, in basket?
- Two mini bars per row: market probability (blue) vs model probability (cyan)
- Auto-refreshes every 30 seconds

---

#### `app/portfolio/page.tsx`
User's positions.
- Wallet must be connected
- Basket positions: basket name, tokens held, entry NAV, current NAV, P&L
- Leveraged positions: basket, collateral, debt, health factor, current value
- Redeem buttons for finalized baskets

---

#### `_lib/state.tsx`
Single reducer for all frontend state. Portfolio positions, USDC balance, wallet state.

---

#### `_lib/deposit-client.ts`
Two-step deposit: `prepare` → wallet signs → `confirm`.
**Reference:** `Senthos-Demo/app/app/_lib/deposit-client.ts` — exact same two-step pattern. Rebuild for your routes.

---

#### `_lib/tokens.ts`
All design tokens (colors, fonts, BACKEND_URL, constants). Single source of truth.

---

### ML (`ml/`)

#### `features.py`
Feature engineering. Takes raw market data, outputs feature matrix.
Features: p_market, days_to_close, log_volume, category_encoded (one-hot), historical_base_rate, liquidity_score.
Must match TypeScript implementation in `backend/src/services/mispricing.ts` exactly.

---

#### `train.py`
Model training pipeline.
1. Load historical Polymarket/Kalshi resolution data
2. Call `features.py` to build feature matrix
3. Train calibrated logistic regression (sklearn)
4. Evaluate: precision at threshold, walk-forward validation
5. Export artifacts to `ml/artifacts/`:
   - `model_coefficients.json`
   - `category_base_rates.json`
   - `feature_stats.json`
   - `model_metrics.json`

---

#### `scorer.py`
Standalone scorer for testing. Takes a market dict, returns `{ p_model, edge }`. Used to verify TypeScript implementation matches Python.

---

#### `backtest.py`
Historical backtest on resolved markets. Simulates basket construction and resolution. Outputs: expected return, hit rate, Sharpe-equivalent. Used for grant pitch evidence.

---

#### `requirements.txt`
```
scikit-learn
pandas
numpy
lightgbm
requests
python-dotenv
```

---

### Scripts

#### `deploy-devnet.sh`
`anchor build` → `solana program deploy` × 3 programs → `sync-idl.sh`

#### `sync-idl.sh`
Copies `target/idl/*.json` → `backend/src/idl/`. Run after every program change or deposits break.

#### `init-vaults.ts`
Reads active baskets from Supabase, runs 3-step vault initialization for each, writes vault_pda and contra_mint back to DB.

#### `demo-lifecycle.ts`
Full devnet smoke test: construct basket → deposit → simulate leg resolutions → finalize → redeem. Run this before every grant demo.

#### `seed-baskets.ts`
Seeds 3-5 example baskets into Supabase with mock legs (for UI dev before ML is ready).

---

### Tests

#### `tests/contra_vault.ts`
Anchor mocha tests. Full lifecycle: init → deposit → resolve legs (mix of NO and YES) → finalize → redeem. Verify NAV math is correct for short semantics.

#### `tests/contra_lending.ts`
Test lend → borrow (via mock CPI) → repay flow. Verify interest accrual math.

#### `tests/contra_leverage.ts`
Test open_position → NAV changes → health factor → liquidation trigger. Verify liquidator receives bonus.

---

## Environment Variables (`.env.example`)

```env
# Solana
SOLANA_RPC_URL=https://api.devnet.solana.com
AUTHORITY_KEYPAIR=[]   # JSON array of keypair bytes

# Program IDs (set after anchor deploy)
CONTRA_VAULT_PROGRAM_ID=
CONTRA_LENDING_PROGRAM_ID=
CONTRA_LEVERAGE_PROGRAM_ID=

# Supabase
SUPABASE_URL=
SUPABASE_ANON_KEY=
SUPABASE_SERVICE_KEY=

# Kalshi
KALSHI_API_KEY=
KALSHI_BASE_URL=https://trading-api.kalshi.com/trade-api/v2

# Polymarket (no key needed)
POLYMARKET_BASE_URL=https://gamma-api.polymarket.com

# Backend
PORT=3001
FRONTEND_URL=http://localhost:3000
```

---

## Build Order for Claude Code

1. `programs/contra_vault/src/lib.rs` — get this deployed first, everything else depends on it
2. `backend/src/db/schema.sql` + `backend/src/db/supabase.ts` — DB foundation
3. `backend/src/solana/pda.ts` — PDA derivations used everywhere
4. `backend/src/solana/deposit.ts` + `backend/src/routes/deposit.ts` — deposit flow
5. `backend/src/services/kalshi.ts` + `polymarket.ts` — data ingestion
6. `ml/train.py` + `ml/features.py` — train model, export artifacts
7. `backend/src/services/mispricing.ts` — load artifacts, score markets
8. `backend/src/services/basket-builder.ts` — construct baskets
9. `backend/src/services/nav.ts` + `cron.ts` — NAV tracking
10. `programs/contra_lending + contra_leverage` — leverage stack
11. Frontend pages in order: layout → baskets/page → baskets/[id] → scanner → portfolio
12. `scripts/demo-lifecycle.ts` — full end-to-end test