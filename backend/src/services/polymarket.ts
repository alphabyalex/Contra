/**
 * Polymarket Gamma API client.
 *
 * Public, no auth required. Base URL configured via POLYMARKET_BASE_URL.
 * Pagination: server caps at 500 per page; we paginate until empty.
 *
 * The shape returned by Gamma is irregular — `outcomePrices` is sometimes
 * a JSON-stringified array, sometimes already an array. Both branches are
 * handled in `parseOutcomePrices`.
 */

export interface RawPolymarketMarket {
  id: string;
  conditionId: string;
  question: string;
  description?: string;
  active?: boolean;
  closed?: boolean;
  archived?: boolean;
  resolved?: boolean;
  outcomes?: string | string[];
  outcomePrices?: string | string[];
  clobTokenIds?: string | string[];
  volume?: string | number;
  volumeNum?: number;
  liquidity?: string | number;
  endDate?: string;
  endDateIso?: string;
  category?: string;
  tags?: string[];
  resolutionOutcome?: string;
}

export interface PolymarketOutcome {
  conditionId: string;
  question: string;
  outcomeLabel: string;     // e.g. "Yes" / "No" / multi-outcome label
  pMarket: number;          // 0..1
  volumeUsd: number;
  endDateIso?: string;
  category?: string;
  tokenId?: string;         // Polymarket CLOB token id for the outcome
}

const BASE = (): string =>
  process.env.POLYMARKET_BASE_URL?.trim() || 'https://gamma-api.polymarket.com';

const PAGE_SIZE = 500;

function parseStringArray(v: string | string[] | undefined): string[] {
  if (!v) return [];
  if (Array.isArray(v)) return v;
  try {
    const parsed = JSON.parse(v);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function parseOutcomePrices(v: string | string[] | undefined): number[] {
  return parseStringArray(v).map((s) => Number(s)).filter((n) => Number.isFinite(n));
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Polymarket ${res.status} ${res.statusText} — ${url}`);
  }
  return (await res.json()) as T;
}

export async function getMarkets(opts: {
  limit?: number;
  active?: boolean;
  closed?: boolean;
} = {}): Promise<RawPolymarketMarket[]> {
  const limit = opts.limit ?? PAGE_SIZE;
  const params = new URLSearchParams();
  params.set('limit', String(limit));
  params.set('active', String(opts.active ?? true));
  params.set('closed', String(opts.closed ?? false));
  return getJson(`${BASE()}/markets?${params}`);
}

/** Walk all pages until the API stops returning rows. */
export async function getAllActiveMarkets(maxPages = 20): Promise<RawPolymarketMarket[]> {
  const all: RawPolymarketMarket[] = [];
  for (let page = 0; page < maxPages; page++) {
    const offset = page * PAGE_SIZE;
    const params = new URLSearchParams({
      limit: String(PAGE_SIZE),
      offset: String(offset),
      active: 'true',
      closed: 'false',
    });
    const batch = await getJson<RawPolymarketMarket[]>(`${BASE()}/markets?${params}`);
    if (!batch || batch.length === 0) break;
    all.push(...batch);
    if (batch.length < PAGE_SIZE) break;
  }
  return all;
}

/**
 * Flatten a raw market into one outcome record per side. Binary markets
 * yield two outcomes (YES/NO at p_market and 1-p_market); multi-outcome
 * markets yield one record per leg.
 */
export function flattenOutcomes(m: RawPolymarketMarket): PolymarketOutcome[] {
  const outcomes = parseStringArray(m.outcomes);
  const prices = parseOutcomePrices(m.outcomePrices);
  const tokens = parseStringArray(m.clobTokenIds);
  if (outcomes.length === 0 || prices.length === 0) return [];
  const vol = Number(m.volumeNum ?? m.volume ?? 0) || 0;
  return outcomes.map((label, i) => ({
    conditionId: m.conditionId,
    question: m.question,
    outcomeLabel: label,
    pMarket: prices[i] ?? 0,
    volumeUsd: vol,
    endDateIso: m.endDateIso ?? m.endDate,
    category: m.category,
    tokenId: tokens[i] ?? undefined,
  }));
}

/**
 * Fetch a single market by conditionId. Used by the resolution monitor
 * (cheap, ~1 request per market we expect to settle soon).
 */
export async function getMarketByConditionId(conditionId: string): Promise<RawPolymarketMarket | null> {
  const params = new URLSearchParams({ condition_ids: conditionId, limit: '1' });
  try {
    const arr = await getJson<RawPolymarketMarket[]>(`${BASE()}/markets?${params}`);
    return arr?.[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * Filter to "longshot" outcomes — pMarket below threshold (default 0.25),
 * with volume above the floor — and return them ranked by ascending price.
 */
export async function scanLongshots(
  threshold = 0.25,
  minVolumeUsd = 5_000,
): Promise<PolymarketOutcome[]> {
  const markets = await getAllActiveMarkets();
  const flat = markets.flatMap(flattenOutcomes);
  return flat
    .filter((o) => o.pMarket > 0 && o.pMarket <= threshold && o.volumeUsd >= minVolumeUsd)
    .sort((a, b) => a.pMarket - b.pMarket);
}

export function daysToClose(endDateIso?: string): number | null {
  if (!endDateIso) return null;
  const t = Date.parse(endDateIso);
  if (Number.isNaN(t)) return null;
  return Math.max(0, (t - Date.now()) / (1000 * 60 * 60 * 24));
}
