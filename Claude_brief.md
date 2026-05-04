# PRISM — Claude Code Project Brief
> Read this entire file before touching any code. It is the single source of truth for what we are building, why, and how.

---

## 1. What Is PRISM?

A Solana-native protocol that lets users **short overpriced prediction market outcomes in bulk**, via tokenized baskets, with optional leverage.

**Core insight:** Prediction markets have a documented behavioral bias called "longshot bias" — retail traders chronically overprice low-probability outcomes. An ML model compares `P_model` (true probability) vs `P_market` (market price). When `P_market >> P_model`, that outcome is a short candidate. We bundle hundreds of these into a single SPL token basket. Users buy the basket token = they are collectively short hundreds of longshots. As predictions resolve NO (expected outcome), basket NAV rises.

**One-liner:** Bloomberg Terminal meets Polymarket, but you're the house.

---

## 2. What We Are NOT Building

- Not a prediction market (we don't create markets)
- Not a long index (Senthos does that — we are legally and strategically differentiated)
- Not a cross-platform arbitrage bot (those exist already)
- Not tranches, PPNs, or a lending pool (that's Senthos's lane)

---

## 3. Codebase Situation

There is a reference codebase in this repo from a hackathon. **Legal ownership confirmed.**

### What to EXTRACT and ADAPT from the hackathon code:
The goal is to understand the Solana plumbing patterns, not copy business logic.

- **Vault PDA initialization pattern** — specifically the 3-instruction split (`initialize_vault` → `initialize_mint` → `initialize_vault_tokens`). This split exists because a single instruction exceeds Solana's BPF 4KB stack budget. Do not try to merge them.
- **SPL mint tied to vault** — how the STHS mint PDA is derived and initialized
- **Non-custodial deposit flow** — backend builds `VersionedTransaction` → frontend passes to wallet (Phantom) for signing → frontend posts signature back → backend confirms. The frontend **never imports Anchor directly**.
- **`resolve_leg` / `finalize_vault` / `redeem` instruction pattern** — lifecycle of a vault
- **IDL sync workflow** — `anchor build` → `sync-idl.sh` → `backend/src/idl/`. Must run after every program change or deposits break silently.
- **Devnet deploy scripts** — structure of `deploy-devnet.sh`

### What to REBUILD from scratch (do not copy):
- All program logic — new program ID, new keypair, your own deploy
- All API keys and credentials (Supabase, Anthropic, RPC endpoint — all new)
- All business logic (mispricing model, basket construction, NAV math)
- Database schema (similar tables but adapted for short semantics)
- Frontend (entirely new UI/UX)
- ML model (entirely new — see Section 6)

---

## 4. The Critical Inversion

Senthos vaults are **long** — NAV rises when legs resolve YES.
PRISM vaults are **short** — NAV rises when legs resolve NO.

This single semantic inversion affects:
- `finalize_vault` payout ratio calculation
- NAV math throughout
- How `resolve_leg` contributes to basket value

Everything else in the on-chain plumbing is structurally identical. This is the most important thing to get right.

---

## 5. Technical Stack

### On-Chain (Solana)
- **Framework:** Anchor 0.30.1 (match hackathon version for reference parity)
- **Program name:** `prism_vault` (single program to start — no lending, no PPN)
- **Token standard:** SPL Token
- **Collateral:** USDC (6 decimals)
- **Network:** Devnet only for now

**Instructions to implement:**
| Instruction | Signer | Purpose |
|---|---|---|
| `initialize_vault(args)` | authority | Create Vault PDA, store leg metadata |
| `initialize_prism_mint()` | authority | Create SPL mint PDA for basket token |
| `initialize_vault_tokens()` | authority | Create USDC token account PDA |
| `deposit(amount_usdc)` | user | Transfer USDC → vault, mint basket token to user |
| `resolve_leg(leg_index, outcome)` | authority | Mark leg Won/Lost. NO = positive for NAV |
| `finalize_vault()` | authority | Lock final payout ratio once all legs resolved |
| `redeem(amount_tokens)` | holder | Burn basket token, receive USDC at final ratio |
| `exit_active(amount_tokens)` | holder | Early exit with small haircut fee |

### Backend
- **Runtime:** Node.js + TypeScript
- **Framework:** Express
- **Port:** 3001
- **DB:** Supabase Postgres (degrade gracefully to in-memory if creds absent)
- **Key invariant:** Backend is the ONLY component that builds Solana transactions

### Frontend
- **Framework:** Next.js (App Router)
- **Wallet:** Phantom via `@solana/wallet-adapter`
- **Styling:** Tailwind CSS
- **Key invariant:** Frontend never imports Anchor. It calls `/api/deposit/prepare`, gets base64 tx, passes to wallet, posts signature back.

### External APIs
- **Polymarket Gamma API** — public, no API key needed. Base URL: `https://gamma-api.polymarket.com`. Use `/markets` endpoint with pagination (500 per page).
- **Kalshi API** — optional Phase 2. Requires account.
- **Helius** — webhook for on-chain event listening (new key required)
- **Anthropic API** — optional, for AI portfolio composer feature (new key required)
- **Supabase** — new project required (new key required)

---

## 6. ML Model (Mispricing Scorer)

### Purpose
For each prediction market, compute `P_model` (estimated true probability) and compare to `P_market` (current market price). The signal is:

```
edge = P_market - P_model
```

If `edge > threshold` (e.g., 0.08), the market is an overpriced longshot → short candidate.

### Feature Set (start simple, expand later)
- `P_market` — current YES price from Polymarket
- `days_to_resolution` — temporal decay signal
- `volume_usd` — liquidity proxy
- `category` — NLP-classified category (politics, sports, crypto, macro, etc.)
- `historical_resolution_rate` — by category and probability bucket (key longshot-bias signal)
- `liquidity_depth` — orderbook depth at current price

### Model Stack
1. **Baseline (build first):** Calibrated logistic regression — fast, interpretable, good for backtesting display
2. **Alpha layer (Phase 2):** LightGBM / XGBoost on full feature set
3. **Training data:** Historical Polymarket resolutions (public on-chain + Gamma API historical data)

### Runtime
- Train model offline in Python (sklearn / LightGBM)
- Export as JSON artifacts (coefficients or ONNX)
- Load at backend startup — Python is never called at runtime
- TypeScript re-implements scoring deterministically from loaded artifacts
- This matches the hackathon pattern exactly (`correlation.ts` loads JSON artifacts)

### Basket Construction
1. Score all active markets → ranked list by `edge`
2. Filter: `P_market < 0.25` (longshots only), `edge > 0.08`, min liquidity threshold
3. Deduplicate correlated markets (same event, different wording)
4. Take top N (target: 50–200 per basket)
5. Weight by inverse correlation (similar to hackathon's `optimizeWeights` greedy approach)
6. Mint new SPL basket token for each constructed basket

---

## 7. Database Schema (Supabase)

```sql
-- Baskets (equivalent to hackathon "bundles")
baskets (
  id uuid primary key,
  name text,
  status text, -- 'active' | 'resolved' | 'finalized'
  vault_pda text,
  prism_mint text,
  created_at timestamptz,
  resolved_at timestamptz,
  final_payout_ratio numeric -- > 1.0 means short basket won
)

-- Individual prediction market positions in each basket
legs (
  id uuid primary key,
  basket_id uuid references baskets,
  condition_id text, -- Polymarket conditionId
  market_question text,
  p_market numeric, -- price when added
  p_model numeric, -- our model's estimate
  edge numeric, -- p_market - p_model
  outcome smallint, -- null=open, 0=NO(won for us), 1=YES(lost for us)
  weight numeric,
  resolved_at timestamptz
)

-- User positions
positions (
  id uuid primary key,
  basket_id uuid references baskets,
  wallet_address text,
  tokens_held numeric,
  usdc_deposited numeric,
  entry_tx_signature text,
  created_at timestamptz
)

-- NAV history for charting
nav_snapshots (
  id uuid primary key,
  basket_id uuid references baskets,
  nav numeric,
  snapshotted_at timestamptz
)

-- Transaction log
transactions (
  id uuid primary key,
  basket_id uuid references baskets,
  wallet_address text,
  type text, -- 'deposit' | 'redeem' | 'exit'
  usdc_delta numeric,
  tx_signature text,
  created_at timestamptz
)
```

---

## 8. Key Backend Routes to Build

```
POST /api/baskets/construct     — run scanner, score markets, build new basket
GET  /api/baskets               — list all active baskets
GET  /api/baskets/:id           — basket detail + legs + current NAV
GET  /api/baskets/:id/nav       — NAV history for chart

POST /api/deposit/prepare       — build unsigned VersionedTransaction, return base64
POST /api/deposit/confirm       — confirm on-chain landing, write Supabase

GET  /api/markets/scan          — run mispricing scanner, return ranked candidates
GET  /api/markets/:conditionId  — single market detail + model score

POST /api/admin/resolve-leg     — authority resolves a leg (webhook or manual)
POST /api/admin/finalize        — authority finalizes vault after all legs resolve

GET  /api/portfolio/:wallet     — user positions across all baskets
```

---

## 9. Frontend Pages to Build

```
/                           — Landing page, pitch, CTA
/app/baskets                — Grid of active short baskets, each with:
                              - Basket name
                              - # of legs
                              - Current NAV
                              - Avg edge (P_market - P_model)
                              - % legs resolved
/app/baskets/[id]           — Basket detail:
                              - Live NAV chart
                              - Leg table (market question, P_market, P_model, edge, status)
                              - Deposit form
/app/portfolio              — User's positions, P&L, redeemable baskets
/app/scanner                — Live mispricing scanner output (show the model working)
```

---

## 10. Build Order (Devnet Demo)

**Step 1 — Anchor program**
- New workspace: `anchor init prism`
- Implement all 8 instructions (reference hackathon vault program for structure)
- Unit tests with `anchor test`
- Deploy to devnet: `anchor deploy`
- Sync IDL to backend

**Step 2 — Polymarket scanner**
- Hit Gamma API, paginate all markets
- Run NLP classifier (category) — can reuse hackathon NLP patterns
- Compute `P_market` from `outcomePrices`
- Stub `P_model` initially (use calibrated heuristic before ML is ready)
- Rank by edge, filter, output basket candidates

**Step 3 — Backend**
- Express + TypeScript skeleton
- Supabase connection (in-memory fallback)
- Implement `/api/deposit/prepare` — this is the hardest part, reference hackathon `deposit.ts` closely
- Basket construction endpoint
- Admin resolve/finalize endpoints

**Step 4 — Frontend**
- Next.js + Phantom wallet adapter
- Baskets grid page
- Basket detail + deposit form
- Portfolio page

**Step 5 — ML model**
- Train on historical Polymarket data in Python
- Export JSON artifacts
- Implement TypeScript scorer in backend
- Replace stub `P_model` with real scores

**Step 6 — Demo lifecycle**
- Script: construct basket → deposit → simulate leg resolutions → finalize → redeem
- Record/screenshot for grant pitch

---

## 11. Hard Rules (Do Not Violate)

1. **Backend builds all Solana transactions.** Frontend never imports Anchor.
2. **3-instruction vault initialization.** Do not merge — BPF stack limit.
3. **IDL sync after every program change.** Or deposits break with no clear error.
4. **NAV logic is inverted vs hackathon.** NO resolution = positive. YES resolution = loss.
5. **All credentials are new.** No reuse of any API keys, program IDs, or keypairs from the reference code.
6. **Degrade gracefully.** Missing Supabase creds → in-memory mock. Never crash on missing env vars.
7. **Polymarket Gamma API is public.** No API key needed. Do not add auth headers.

---

## 12. Grant Pitch Framing (Solana Foundation — pitch after 6/5/2026)

- Frame as **DeFi infrastructure**, not a trading app
- "First structured short-selling derivatives layer for the global prediction market industry"
- Solana's speed (Alpenglow targeting ~150ms finality) is a core technical requirement for our settlement latency
- Creates new TVL and fee revenue for Solana ecosystem
- ML-driven, technically sophisticated, defensible moat
- Prediction markets are a stated Solana growth vertical

---

*Last updated: May 2026 | Owner: Alex Schuessler*