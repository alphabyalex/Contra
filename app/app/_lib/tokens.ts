/**
 * Single source of truth for design tokens, backend URL, and constants
 * used by the frontend. Keeping them here avoids hardcoding hex values
 * and URLs in twenty different components.
 */

export const COLORS = {
  bg: '#F7F7F5',
  surface: '#FFFFFF',
  card: '#FFFFFF',
  accent: '#1A56DB',
  accentSoft: '#EBF0FF',
  positive: '#00875A',
  negative: '#CC2936',
  text: '#0A0A0A',
  secondary: '#4A4A4A',
  body: '#6B6B6B',
  muted: '#9B9B9B',
  border: '#E5E5E3',
  numpad: '#F0F0EE',
} as const;

export const FONTS = {
  logo: '"Bebas Neue", system-ui, sans-serif',
  ui: '"DM Sans", system-ui, sans-serif',
  num: '"IBM Plex Mono", ui-monospace, monospace',
} as const;

// Primary env var is NEXT_PUBLIC_API_URL; NEXT_PUBLIC_BACKEND_URL is
// kept as a fallback for older deploys. On Vercel where neither is
// set, every call falls through to localhost:3001 (unreachable) and
// the snapshot fallback in api.ts takes over.
export const BACKEND_URL =
  process.env.NEXT_PUBLIC_API_URL
  ?? process.env.NEXT_PUBLIC_BACKEND_URL
  ?? 'http://localhost:3001';

export const CLUSTER = (process.env.NEXT_PUBLIC_SOLANA_CLUSTER ?? 'devnet') as
  | 'devnet'
  | 'mainnet-beta';

export const RPC_URL =
  process.env.NEXT_PUBLIC_SOLANA_RPC_URL ?? 'https://api.devnet.solana.com';

export const USDC_DECIMALS = 6;

/** Mock data for UI development before live data lands. */
export const MOCK_BASKETS = [
  {
    id: 'mock-1',
    name: 'Macro Longshot Short #4',
    nav: 1.221,
    avg_edge: 0.112,
    legs: 43,
    leverage: '3x',
    source: 'Kalshi',
    leverage_type: 'aggressive' as const,
    category: 'macro',
  },
  {
    id: 'mock-2',
    name: 'Politics Tail Risk #7',
    nav: 1.094,
    avg_edge: 0.094,
    legs: 10,
    leverage: '2x',
    source: 'Both',
    leverage_type: 'conservative' as const,
    category: 'politics',
  },
  {
    id: 'mock-3',
    name: 'Crypto Longshot #2',
    nav: 1.063,
    avg_edge: 0.081,
    legs: 33,
    leverage: '1x',
    source: 'Polymarket',
    leverage_type: 'aggressive' as const,
    category: 'crypto',
  },
  {
    id: 'mock-4',
    name: 'Mixed Tail Short #11',
    nav: 1.021,
    avg_edge: 0.063,
    legs: 24,
    leverage: '1x',
    source: 'Both',
    leverage_type: 'conservative' as const,
    category: 'mixed',
  },
  {
    id: 'mock-5',
    name: 'Degen Short #1',
    nav: 0.961,
    avg_edge: 0.147,
    legs: 16,
    leverage: '3x',
    source: 'Kalshi',
    leverage_type: 'degen' as const,
    category: 'mixed',
  },
];

export const MOCK_SCANNER = [
  { question: 'Will Barron Trump become Fed Chair?',  source: 'Kalshi',     p_market: 0.08, p_model: 0.01, edge: 0.07 },
  { question: 'Will BTC hit $250k before July?',       source: 'Polymarket', p_market: 0.12, p_model: 0.02, edge: 0.10 },
  { question: 'Will Apple acquire Netflix in 2026?',   source: 'Kalshi',     p_market: 0.06, p_model: 0.01, edge: 0.05 },
  { question: 'Will Fed cut rates 5x in 2026?',        source: 'Kalshi',     p_market: 0.09, p_model: 0.02, edge: 0.07 },
  { question: 'Will Elon buy Twitter again?',          source: 'Polymarket', p_market: 0.07, p_model: 0.01, edge: 0.06 },
  { question: 'Will S&P 500 drop 40% this year?',      source: 'Both',       p_market: 0.11, p_model: 0.02, edge: 0.09 },
];
