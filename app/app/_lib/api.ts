/**
 * Thin fetch wrapper around the CONTRA backend. All endpoints return
 * JSON; non-2xx responses throw with the parsed `error` field. The
 * frontend NEVER imports Anchor — every Solana action goes through
 * /api/deposit/prepare → wallet → /api/deposit/confirm.
 */

import { BACKEND_URL } from './tokens';
import {
  snapshotBasketsListResponse,
  snapshotBasketGetResponse,
  snapshotBasketNavResponse,
  snapshotScannerResponse,
} from './snapshot';

/** Shape of a single scanner row returned by /api/scanner/markets. */
export interface ScannerRowAPI {
  question: string;
  source: 'kalshi' | 'polymarket';
  marketId: string;
  outcomeLabel?: string;
  p_market: number;
  volume?: number;
  daysToClose?: number | null;
  endDateIso?: string;
  category?: string;
  screened?: boolean;
  excluded?: boolean;
  impossible?: boolean;
  exclusion_reason?: string | null;
  p_model?: number | null;
  edge?: number | null;
  raw_edge?: number | null;
  adjusted_edge?: number | null;
  signal?: 'strong_short' | 'short' | 'weak_short' | 'fair_value' | 'long' | 'strong_long' | null;
  time_factor?: number | null;
  category_factor?: number | null;
  volume_factor?: number | null;
  include_in_basket?: boolean | null;
  tournament_group?: string | null;
  is_tournament_market?: boolean;
  normalized_p_market?: number | null;
  is_favorite?: boolean;
  is_ephemeral?: boolean;
  p_market_screened?: number;
  zone?: 0 | 1 | 2 | 3 | 4;
  residual?: number | null;
  model_stale?: boolean;
  resolved_likely?: boolean;
  /** raw_edge × log10(volume + 1) — set on category-grouped responses. */
  score?: number;
}

async function jsonRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${BACKEND_URL}${path}`, {
    headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
    ...init,
  });
  let body: any = null;
  try {
    body = await res.json();
  } catch {
    /* non-JSON */
  }
  if (!res.ok) {
    const msg = body?.error ?? `${res.status} ${res.statusText}`;
    throw new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
  }
  return body as T;
}

/**
 * Read-only GET wrapper with a 3 second timeout and a silent snapshot
 * fallback. Used by the read endpoints (baskets, scanner) so the public
 * Vercel deployment renders cleanly even though it has no backend.
 *
 * Writes (deposit, redeem, leverage close) keep using jsonRequest and
 * surface real errors because they require a signed transaction round-trip.
 */
async function fetchWithFallback<T>(url: string, fallback: T): Promise<T> {
  try {
    const ctrl: AbortController | null =
      typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer =
      ctrl && typeof setTimeout !== 'undefined'
        ? setTimeout(() => ctrl.abort(), 3000)
        : null;
    try {
      const res = await fetch(`${BACKEND_URL}${url}`, {
        signal: ctrl?.signal,
        headers: { 'Content-Type': 'application/json' },
      });
      if (!res.ok) throw new Error('not ok');
      return (await res.json()) as T;
    } finally {
      if (timer != null) clearTimeout(timer as ReturnType<typeof setTimeout>);
    }
  } catch {
    return fallback;
  }
}

export const api = {
  health: () => jsonRequest<{ ok: boolean; supabase: any; idls: any; authority: boolean }>('/health'),

  baskets: {
    list: () => fetchWithFallback<{ baskets: any[] }>('/api/baskets', snapshotBasketsListResponse()),
    get: (id: string) =>
      fetchWithFallback<{ basket: any; legs: any[]; nav: number; breakdown: any }>(
        `/api/baskets/${id}`,
        (snapshotBasketGetResponse(id) ?? { basket: null, legs: [], nav: 1, breakdown: null }) as {
          basket: any; legs: any[]; nav: number; breakdown: any;
        },
      ),
    nav: (id: string) =>
      fetchWithFallback<{ history: Array<{ nav: number; snapshotted_at: string }> }>(
        `/api/baskets/${id}/nav`,
        snapshotBasketNavResponse(id),
      ),
    construct: (input: { leverageType: 'conservative' | 'aggressive' | 'degen'; name?: string; category?: string }) =>
      jsonRequest('/api/baskets/construct', { method: 'POST', body: JSON.stringify(input) }),
  },

  deposit: {
    prepare: (input: { basketId: string; walletAddress: string; amountUsdc: number; leverage?: 1 | 2 | 3 }) =>
      jsonRequest<{
        transactionBase64: string;
        recentBlockhash: string;
        lastValidBlockHeight: number;
        vaultPda?: string;
        contraMint?: string;
        amountRaw?: string;
        leveraged?: boolean;
        leverage?: 1 | 2 | 3;
        positionPda?: string;
        collateral?: number;
        borrowed?: number;
        total_exposure?: number;
        liquidation_nav?: number;
        interest_rate?: number;
        daily_interest?: number;
        entry_nav?: number;
      }>('/api/deposit/prepare', { method: 'POST', body: JSON.stringify(input) }),
    confirm: (input: {
      basketId: string;
      walletAddress: string;
      amountUsdc: number;
      signature: string;
      leverage?: 1 | 2 | 3;
      positionPda?: string;
    }) =>
      jsonRequest<{
        status: string;
        signature: string;
        leveraged?: boolean;
        collateral?: number;
        borrowed?: number;
        total_exposure?: number;
        vault_tokens?: number;
        liquidation_nav?: number;
        daily_interest?: number;
      }>('/api/deposit/confirm', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
  },

  redeem: {
    prepare: (input: {
      basketId: string;
      walletAddress: string;
      tokenAmount?: number;
      usdcAmount?: number;
    }) =>
      jsonRequest<{
        transaction_b64: string;
        recentBlockhash: string;
        lastValidBlockHeight: number;
        tokenAmount: number;
        gross_usdc: number;
        fee: number;
        net_usdc: number;
        current_nav: number;
        vault_pda: string;
        contra_mint: string;
      }>('/api/redeem/prepare', { method: 'POST', body: JSON.stringify(input) }),
    confirm: (input: { signature: string; walletAddress: string; basketId: string; tokenAmount: number }) =>
      jsonRequest<{ success: boolean; net_usdc: number; realized_pnl: number; closed: boolean }>(
        '/api/redeem/confirm',
        { method: 'POST', body: JSON.stringify(input) },
      ),
  },

  markets: {
    scan: () => jsonRequest<{ scanned_at: number; rows: any[] }>('/api/markets/scan'),
    get: (id: string) => jsonRequest<{ source: string; market: any; outcomes: any[] }>(`/api/markets/${encodeURIComponent(id)}`),
  },

  scanner: {
    history: () => jsonRequest<{ at: number; rows: any[] }>('/api/scanner/history'),
    snapshot: (min = 0.02, max = 0.15) =>
      jsonRequest<{ at: number; count: number; rows: any[] }>(
        `/api/scanner/snapshot?min=${min}&max=${max}`,
      ),
    markets: (
      opts: {
        min?: number;
        max?: number;
        sort?: 'volume' | 'edge' | 'days' | 'p_market';
        search?: string;
        limit?: number;
      } = {},
    ) => {
      const p = new URLSearchParams();
      p.set('min', String(opts.min ?? 0.02));
      p.set('max', String(opts.max ?? 0.15));
      p.set('sort', opts.sort ?? 'volume');
      if (opts.search) p.set('search', opts.search);
      if (opts.limit != null) p.set('limit', String(opts.limit));
      return fetchWithFallback<{
        at: number;
        count: number;
        /** Curated-pool size (scored_markets only — excludes ephemeral). */
        watched_count?: number;
        counts: { polymarket: number; kalshi: number };
        kalshi_error?: string | null;
        kalshi_throttled?: boolean;
        sort?: string;
        search?: string | null;
        total_after_filter?: number;
        /** Layout hint set by the backend: 'category_grouped' for default,
         *  'search' for any query response. */
        view?: 'category_grouped' | 'search';
        /** Present only when view = 'category_grouped'. */
        groups?: Array<{
          category: string;
          short_count: number;
          long_count: number;
          /** Index inside `markets` where the LONG section starts (sports). */
          long_section_start: number | null;
          markets: ScannerRowAPI[];
        }>;
        rows: ScannerRowAPI[];
      }>(
        `/api/scanner/markets?${p.toString()}`,
        snapshotScannerResponse(opts) as unknown as {
          at: number;
          count: number;
          watched_count?: number;
          counts: { polymarket: number; kalshi: number };
          kalshi_error?: string | null;
          kalshi_throttled?: boolean;
          sort?: string;
          search?: string | null;
          total_after_filter?: number;
          view?: 'category_grouped' | 'search';
          groups?: Array<{
            category: string;
            short_count: number;
            long_count: number;
            long_section_start: number | null;
            markets: ScannerRowAPI[];
          }>;
          rows: ScannerRowAPI[];
        },
      );
    },
    /** Returns the EventSource — caller must close it on unmount. */
    live: (onMessage: (rows: any[]) => void): EventSource => {
      const es = new EventSource(`${BACKEND_URL}/api/scanner/live`);
      es.onmessage = (e) => {
        try {
          const { rows } = JSON.parse(e.data);
          if (Array.isArray(rows)) onMessage(rows);
        } catch {
          /* ignore */
        }
      };
      return es;
    },
  },

  portfolio: (wallet: string) =>
    jsonRequest<{
      wallet: string;
      basket_positions: any[];
      leveraged_positions: any[];
      recent_transactions: any[];
    }>(`/api/portfolio/${wallet}`),

  leverage: {
    list: (wallet: string) => jsonRequest<{ positions: any[] }>(`/api/leverage/${wallet}`),
    get: (id: string) => jsonRequest<{ position: any }>(`/api/leverage/${id}`),
    close: (id: string, body: { tokenAmount?: number; usdcAmount?: number }) =>
      jsonRequest<{ position: any; preview: { tokensClosed: number; gross: number; repay: number; interest: number; fee: number; net: number } }>(
        `/api/leverage/${id}/close`,
        { method: 'POST', body: JSON.stringify(body) },
      ),
    confirm: (id: string, body: { signature: string; tokenAmount?: number }) =>
      jsonRequest<{ success: boolean; net_usdc: number; closed: boolean }>(`/api/leverage/${id}/confirm`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
  },
};
