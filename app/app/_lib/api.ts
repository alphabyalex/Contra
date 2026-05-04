/**
 * Thin fetch wrapper around the CONTRA backend. All endpoints return
 * JSON; non-2xx responses throw with the parsed `error` field. The
 * frontend NEVER imports Anchor — every Solana action goes through
 * /api/deposit/prepare → wallet → /api/deposit/confirm.
 */

import { BACKEND_URL } from './tokens';

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

export const api = {
  health: () => jsonRequest<{ ok: boolean; supabase: any; idls: any; authority: boolean }>('/health'),

  baskets: {
    list: () => jsonRequest<{ baskets: any[] }>('/api/baskets'),
    get: (id: string) => jsonRequest<{ basket: any; legs: any[]; nav: number; breakdown: any }>(`/api/baskets/${id}`),
    nav: (id: string) => jsonRequest<{ history: Array<{ nav: number; snapshotted_at: string }> }>(`/api/baskets/${id}/nav`),
    construct: (input: { leverageType: 'conservative' | 'aggressive' | 'degen'; name?: string; category?: string }) =>
      jsonRequest('/api/baskets/construct', { method: 'POST', body: JSON.stringify(input) }),
  },

  deposit: {
    prepare: (input: { basketId: string; walletAddress: string; amountUsdc: number }) =>
      jsonRequest<{
        transactionBase64: string;
        recentBlockhash: string;
        lastValidBlockHeight: number;
        vaultPda: string;
        contraMint: string;
        amountRaw: string;
      }>('/api/deposit/prepare', { method: 'POST', body: JSON.stringify(input) }),
    confirm: (input: { basketId: string; walletAddress: string; amountUsdc: number; signature: string }) =>
      jsonRequest<{ status: string; signature: string }>('/api/deposit/confirm', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
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
    markets: (min = 0.02, max = 0.15) =>
      jsonRequest<{
        at: number;
        count: number;
        counts: { polymarket: number; kalshi: number };
        kalshi_error?: string | null;
        kalshi_throttled?: boolean;
        rows: Array<{
          question: string;
          source: 'kalshi' | 'polymarket';
          marketId: string;
          outcomeLabel?: string;
          p_market: number;
          volume?: number;
          daysToClose?: number | null;
          endDateIso?: string;
        }>;
      }>(`/api/scanner/markets?min=${min}&max=${max}`),
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
  },
};
