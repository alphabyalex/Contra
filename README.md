# Contra

**Bet Against the Obvious.**

Contra is a Solana-native prediction market protocol that gives users systematic exposure to mispriced prediction market outcomes, packaged into tokenized baskets with optional leverage.

## What it does

Prediction markets have a well-documented problem: retail traders consistently overpay for low-probability outcomes. A market priced at 8% might only resolve YES 1.7% of the time. Contra's ML model identifies these mispricings across Kalshi and Polymarket and bundles them into tradeable SPL token vaults.

- **Short baskets (CTRA-01, CTRA-1.1, ...)** — systematic short exposure to overpriced longshots. Collect premium from markets where the crowd is wrong.
- **Long baskets (CTRA-02, CTRA-04, ...)** — long exposure to underpriced favorites in tournament markets. Positions appreciate as favorites gain probability ahead of resolution.

Users deposit USDC, receive CTRA tokens representing their share of the basket NAV, and can optionally apply 2x or 3x leverage. Everything settles on-chain via three chained Anchor programs.

## How the model works

The mispricing model is built on thousands of resolved Polymarket markets and maps implied probability buckets to true historical resolution rates. Markets priced at 5-10% resolve YES only ~1.7% of the time on average. That gap is the edge.

The model layers on top of base calibration:

- Sport-specific and politics-specific calibration tiers
- Tournament renormalization (World Cup, NBA, NHL) to remove vig and identify underpriced favorites
- Time confidence penalties for far-future markets
- Volume filters and hard exclusions for range/bracket markets
- Impossible market detection via Anthropic API (weekly)

354 markets tracked across Kalshi and Polymarket. Scanner updates every 15 minutes with live prices.

## Stack

- **Blockchain** — Solana devnet, Anchor framework
- **Programs** — `contra_vault`, `contra_lending`, `contra_leverage` (3 chained programs)
- **Backend** — Node.js, Express, TypeScript
- **Frontend** — Next.js, TypeScript
- **Database** — Supabase (PostgreSQL)
- **Data** — Kalshi API (RSA-PSS auth), Polymarket Gamma API

## Running locally

```bash
# Backend
cd backend
npm install
npm run dev

# Frontend
cd app
npm install
npm run dev
```

Requires a `.env` file with Supabase, Kalshi, and Anthropic credentials. See `.env.example` for required variables.

## Competition context

Built for the Artemis Quant Research / Trading Strategy Competition, Track 2: Prediction Market Strategy on Kalshi. The core thesis exploits longshot bias as documented in Thaler & Ziemba (1988) and Snowberg & Wolfers (2010).

## Notes

This is a devnet prototype. Not financial advice. Model outputs are estimates, not guarantees.

---

Built by Alexander Schuessler
