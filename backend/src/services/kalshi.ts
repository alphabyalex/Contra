/**
 * Kalshi REST client (v2 trade-api).
 *
 * Auth: Kalshi v2 signs every request with RSA-PSS (SHA-256). The signed
 * payload is `${timestamp_ms}${METHOD}${path}` where `path` is the
 * request path WITHOUT query parameters (e.g. `/trade-api/v2/markets`,
 * not `/trade-api/v2/markets?limit=100`). The signature goes in the
 * KALSHI-ACCESS-SIGNATURE header alongside KALSHI-ACCESS-KEY (the key id
 * from KALSHI_KEY_ID) and KALSHI-ACCESS-TIMESTAMP. There is NO
 * Authorization: Bearer header and NO JWT — that was the old (wrong)
 * scheme.
 *
 * Price format: Kalshi completed a migration in March 2026 — prices are
 * now decimal strings like "0.0650" rather than integer cents. All price
 * fields are parsed with parseFloat and treated as probabilities in
 * [0,1]; a value > 1 is defensively divided by 100 (legacy cents).
 *
 * Graceful degradation:
 *   - missing KALSHI_KEY_ID / private key → skip auth, return [].
 *   - PEM body without BEGIN/END headers → auto-wrap before parsing.
 *   - any HTTP failure → log warn, return [].
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

export interface RawKalshiMarket {
  ticker: string;
  event_ticker?: string;
  series_ticker?: string;
  title: string;
  subtitle?: string;
  // Post-March-2026 migration: prices are decimal-dollar STRINGS in
  // `*_dollars` fields (e.g. "0.0650" = 6.5%), volumes in `*_fp` fields.
  yes_bid_dollars?: number | string;
  yes_ask_dollars?: number | string;
  no_bid_dollars?: number | string;
  no_ask_dollars?: number | string;
  last_price_dollars?: number | string;
  previous_price_dollars?: number | string;
  volume_fp?: number | string;
  volume_24h_fp?: number | string;
  open_interest_fp?: number | string;
  // Legacy (pre-migration) field names — kept as fallback.
  yes_bid?: number | string;
  yes_ask?: number | string;
  no_bid?: number | string;
  no_ask?: number | string;
  last_price?: number | string;
  price?: number | string;
  volume?: number | string;
  open_interest?: number | string;
  close_time?: string;
  category?: string;
  status?: string;
}

export interface KalshiOutcome {
  ticker: string;
  question: string;
  outcomeLabel: 'YES' | 'NO';
  pMarket: number;
  volumeUsd: number;
  endDateIso?: string;
  category?: string;
}

const BASE = (): string =>
  process.env.KALSHI_BASE_URL?.trim() || 'https://api.elections.kalshi.com/trade-api/v2';

let warnedNoKey = false;
let cachedKey: crypto.KeyObject | null = null;
let keyAttempted = false;

function loadPrivateKey(): crypto.KeyObject | null {
  if (keyAttempted) return cachedKey;
  keyAttempted = true;

  const rawPath = process.env.KALSHI_PRIVATE_KEY_PATH?.trim();
  if (!rawPath) {
    if (!warnedNoKey) {
      console.warn('[kalshi] KALSHI_PRIVATE_KEY_PATH missing — Kalshi calls will skip silently.');
      warnedNoKey = true;
    }
    return null;
  }

  // Try a few resolutions: as-given, against CWD, against repo root.
  const candidates = [
    rawPath,
    path.resolve(process.cwd(), rawPath),
    path.resolve(__dirname, '..', '..', '..', rawPath.replace(/^\.\//, '')),
  ];
  let pemPath: string | null = null;
  for (const c of candidates) {
    if (fs.existsSync(c)) {
      pemPath = c;
      break;
    }
  }
  if (!pemPath) {
    if (!warnedNoKey) {
      console.warn(`[kalshi] private key file not found at ${rawPath} (tried multiple paths)`);
      warnedNoKey = true;
    }
    return null;
  }

  try {
    let pem = fs.readFileSync(pemPath, 'utf8').trim();
    // Tolerate keys pasted without the BEGIN/END wrappers.
    if (!/-----BEGIN [A-Z ]+PRIVATE KEY-----/.test(pem)) {
      pem = `-----BEGIN RSA PRIVATE KEY-----\n${pem}`;
    }
    if (!/-----END [A-Z ]+PRIVATE KEY-----/.test(pem)) {
      pem = `${pem}\n-----END RSA PRIVATE KEY-----`;
    }
    cachedKey = crypto.createPrivateKey(pem);
    return cachedKey;
  } catch (e) {
    if (!warnedNoKey) {
      console.warn(`[kalshi] private key parse failed: ${(e as Error).message}`);
      warnedNoKey = true;
    }
    return null;
  }
}

/** Last *real* error message from Kalshi (auth/etc) — surfaced as a red
 * debug line in the scanner UI. 429s are NOT treated as errors and do
 * not populate this field; they go through `_lastKalshiThrottled`. */
let _lastKalshiError: string | null = null;
let _lastKalshiThrottled = false;
export function getLastKalshiError(): string | null {
  return _lastKalshiError;
}
export function getLastKalshiThrottled(): boolean {
  return _lastKalshiThrottled;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Build the RSA-PSS signed headers for a request. `signedPath` must be
 * the URL pathname WITHOUT the query string (Kalshi signs the path only).
 */
function signedHeaders(method: string, signedPath: string): Record<string, string> | null {
  const keyId = process.env.KALSHI_KEY_ID?.trim();
  const key = loadPrivateKey();
  if (!keyId || !key) {
    _lastKalshiError = 'KALSHI_KEY_ID or private key missing';
    return null;
  }

  const timestamp = Date.now().toString(); // milliseconds, as a string
  const messageToSign = timestamp + method.toUpperCase() + signedPath;

  let signature: string;
  try {
    signature = crypto
      .sign('RSA-SHA256', Buffer.from(messageToSign), {
        key,
        padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
        saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
      })
      .toString('base64');
  } catch (e) {
    _lastKalshiError = `RSA-PSS sign failed: ${(e as Error).message}`;
    console.warn(`[kalshi] ${_lastKalshiError}`);
    return null;
  }

  return {
    'KALSHI-ACCESS-KEY': keyId,
    'KALSHI-ACCESS-TIMESTAMP': timestamp,
    'KALSHI-ACCESS-SIGNATURE': signature,
    'Content-Type': 'application/json',
  };
}

interface KalshiHttpResult<T> {
  data: T | null;
  status: number;
}

let loggedRawShape = false;

async function getJson<T>(pathSeg: string, search?: URLSearchParams): Promise<KalshiHttpResult<T>> {
  const base = BASE().replace(/\/+$/g, '');
  const url = `${base}${pathSeg}${search ? `?${search}` : ''}`;
  // Kalshi signs the path WITHOUT query params. Derive it from the full
  // URL so the /trade-api/v2 prefix from KALSHI_BASE_URL is included.
  const signedPath = new URL(url).pathname;
  const headers = signedHeaders('GET', signedPath);
  if (!headers) return { data: null, status: 0 };

  try {
    const res = await fetch(url, { headers });
    if (!res.ok) {
      let body = '';
      try {
        body = (await res.text()).slice(0, 240);
      } catch {
        /* ignore */
      }
      if (res.status === 429) {
        _lastKalshiThrottled = true;
        console.info(`[kalshi] 429 throttled — backing off — ${url}`);
      } else {
        _lastKalshiError = `${res.status} ${res.statusText} ${body ? '— ' + body : ''}`;
        console.warn(`[kalshi] ${_lastKalshiError} — ${url}`);
      }
      return { data: null, status: res.status };
    }
    _lastKalshiError = null;
    _lastKalshiThrottled = false;
    const json = (await res.json()) as T;

    // One-time: dump the raw shape of the first market so we can see
    // exactly which price fields Kalshi returns post-migration.
    if (!loggedRawShape) {
      const markets = (json as unknown as { markets?: unknown[] })?.markets;
      if (Array.isArray(markets) && markets.length > 0) {
        loggedRawShape = true;
        console.info(
          '[kalshi] RAW first market structure:\n' + JSON.stringify(markets[0], null, 2),
        );
        console.info('[kalshi] first market keys: ' + Object.keys(markets[0] as object).join(', '));
      }
    }

    return { data: json, status: res.status };
  } catch (e) {
    _lastKalshiError = `fetch error: ${(e as Error).message}`;
    console.warn(`[kalshi] ${_lastKalshiError}`);
    return { data: null, status: 0 };
  }
}

interface MarketsResponse {
  markets: RawKalshiMarket[];
  cursor?: string;
}

/**
 * Parse a Kalshi price field. Post-March-2026 these are decimal strings
 * like "0.0650"; older responses used integer cents. parseFloat handles
 * the string case; a value > 1 is treated as legacy cents and divided
 * by 100. Returns null when the field is absent / unparseable.
 */
function parsePrice(v: number | string | undefined | null): number | null {
  if (v == null || v === '') return null;
  const n = parseFloat(String(v));
  if (!Number.isFinite(n)) return null;
  if (n > 1) return n / 100; // defensive: legacy integer cents
  return n;
}

/** Best available YES probability for a market, or null if unpriced. */
function yesProb(m: RawKalshiMarket): number | null {
  // Post-migration `*_dollars` strings first, then legacy names.
  const bid = parsePrice(m.yes_bid_dollars) ?? parsePrice(m.yes_bid);
  const ask = parsePrice(m.yes_ask_dollars) ?? parsePrice(m.yes_ask);
  if (bid != null && ask != null) return (bid + ask) / 2;
  const single =
    bid ??
    ask ??
    parsePrice(m.last_price_dollars) ??
    parsePrice(m.previous_price_dollars) ??
    parsePrice(m.last_price) ??
    parsePrice(m.price);
  return single ?? null;
}

function volumeUsd(m: RawKalshiMarket): number {
  const n = parseFloat(
    String(m.volume_fp ?? m.volume_24h_fp ?? m.volume ?? 0),
  );
  return Number.isFinite(n) ? n : 0;
}

export async function getMarkets(
  params: {
    limit?: number;
    status?: 'open' | 'closed' | 'settled';
    cursor?: string;
  } = {},
): Promise<RawKalshiMarket[]> {
  const search = new URLSearchParams();
  search.set('limit', String(params.limit ?? 200));
  if (params.status) search.set('status', params.status);
  if (params.cursor) search.set('cursor', params.cursor);
  const r = await getJson<MarketsResponse>('/markets', search);
  return r.data?.markets ?? [];
}

/**
 * Paginate Kalshi /markets up to `maxPages`. Most Kalshi markets are
 * unpriced sports props on early pages, so we keep walking until we've
 * found at least 50 priced markets in the wider 0.01..0.20 longshot band.
 */
export async function getAllOpenMarkets(maxPages = 10): Promise<RawKalshiMarket[]> {
  const all: RawKalshiMarket[] = [];
  let cursor: string | undefined;
  let priced = 0;
  let inRange = 0;
  let throttled = false;
  for (let i = 0; i < maxPages; i++) {
    if (i > 0) await sleep(300); // dodge Kalshi rate limits
    const search = new URLSearchParams({ limit: '200', status: 'open' });
    if (cursor) search.set('cursor', cursor);
    const r = await getJson<MarketsResponse>('/markets', search);
    if (r.status === 429) {
      throttled = true;
      break;
    }
    if (!r.data || !r.data.markets || r.data.markets.length === 0) break;
    all.push(...r.data.markets);

    priced = 0;
    inRange = 0;
    for (const m of all) {
      const yesP = yesProb(m);
      if (yesP == null) continue;
      priced++;
      const noP = 1 - yesP;
      if ((yesP >= 0.01 && yesP <= 0.2) || (noP >= 0.01 && noP <= 0.2)) inRange++;
    }
    if (inRange >= 50) break;
    if (!r.data.cursor) break;
    cursor = r.data.cursor;
  }
  console.info(
    `[kalshi] fetched ${all.length} total markets, ${priced} priced, ${inRange} in longshot range${throttled ? ' (throttled)' : ''}`,
  );
  return all;
}

export interface KalshiScreenerMarket {
  ticker: string;
  title: string;
  p_market: number;
  volume: number;
  days_to_close: number | null;
  source: 'kalshi';
}

/**
 * Fetch + filter Kalshi markets for the screener (Artemis Track #2).
 * Paginates open markets, applies the same longshot band as the Polymarket
 * screener (0.02 ≤ p ≤ 0.12, volume ≥ $100k, resolves within 365d), skips
 * non-binary spread/range markets. Returns one row per market (YES side).
 */
export async function fetchKalshiMarkets(maxPages = 10): Promise<KalshiScreenerMarket[]> {
  const out: KalshiScreenerMarket[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  let fetched = 0;

  for (let page = 0; page < maxPages; page++) {
    if (page > 0) await sleep(500); // avoid rate limits
    const search = new URLSearchParams({ limit: '200', status: 'open', with_nested_markets: 'true' });
    if (cursor) search.set('cursor', cursor);
    const r = await getJson<MarketsResponse>('/markets', search);
    if (r.status === 429) { console.info('[kalshi] fetchKalshiMarkets throttled, stopping'); break; }
    const markets = r.data?.markets ?? [];
    if (markets.length === 0) break;
    fetched += markets.length;

    for (const m of markets) {
      if (seen.has(m.ticker)) continue;
      seen.add(m.ticker);
      const title = m.title ?? '';
      if (/\b(spread|range)\b/i.test(title)) continue; // non-binary
      const p = yesProb(m);
      if (p == null || p < 0.02 || p > 0.12) continue;
      // Kalshi volume_fp is CONTRACT COUNT (not USD). 500 contracts is a
      // reasonable price-discovery floor for the longshot band.
      const vol = volumeUsd(m);
      if (vol < 500) continue;
      let days: number | null = null;
      if (m.close_time) {
        const t = Date.parse(m.close_time);
        if (!Number.isNaN(t)) days = Math.round((t - Date.now()) / 86_400_000);
      }
      if (days != null && (days < 0 || days > 365)) continue;
      out.push({ ticker: m.ticker, title, p_market: p, volume: vol, days_to_close: days, source: 'kalshi' });
    }

    if (!r.data?.cursor) break;
    cursor = r.data.cursor;
  }
  console.info(`[kalshi] fetchKalshiMarkets: ${fetched} fetched, ${out.length} passed filter`);
  return out;
}

export function flattenOutcomes(m: RawKalshiMarket): KalshiOutcome[] {
  const yesPrice = yesProb(m);
  if (yesPrice == null) return [];
  const vol = volumeUsd(m);
  return [
    {
      ticker: m.ticker,
      question: m.title,
      outcomeLabel: 'YES',
      pMarket: yesPrice,
      volumeUsd: vol,
      endDateIso: m.close_time,
      category: m.category,
    },
    {
      ticker: m.ticker,
      question: m.title,
      outcomeLabel: 'NO',
      pMarket: 1 - yesPrice,
      volumeUsd: vol,
      endDateIso: m.close_time,
      category: m.category,
    },
  ];
}

export async function scanLongshots(
  threshold = 0.25,
  minVolumeUsd = 5_000,
): Promise<KalshiOutcome[]> {
  const markets = await getAllOpenMarkets();
  const flat = markets.flatMap(flattenOutcomes);
  return flat
    .filter((o) => o.pMarket > 0 && o.pMarket <= threshold && o.volumeUsd >= minVolumeUsd)
    .sort((a, b) => a.pMarket - b.pMarket);
}

/** Single-market YES probability + volume for the price collector. */
export async function getKalshiMarketPrice(
  ticker: string,
): Promise<{ p_market: number; volume: number } | null> {
  const r = await getJson<{ market?: RawKalshiMarket }>(`/markets/${encodeURIComponent(ticker)}`);
  const m = r.data?.market;
  if (!m) return null;
  const p = yesProb(m);
  if (p == null) return null;
  return { p_market: p, volume: volumeUsd(m) };
}

export async function getOrderbook(ticker: string): Promise<unknown | null> {
  const r = await getJson(`/markets/${encodeURIComponent(ticker)}/orderbook`);
  return r.data;
}

/**
 * One-shot auth smoke test. Hits GET /trade-api/v2/markets?limit=5&status=open
 * and logs the full response so we can confirm the RSA-PSS auth works and
 * see what the post-migration price fields look like. Fired once on module
 * load; never throws.
 */
export async function testKalshiAuth(): Promise<void> {
  try {
    const search = new URLSearchParams({ limit: '5', status: 'open' });
    const r = await getJson<MarketsResponse>('/markets', search);
    if (r.data) {
      console.info(
        `[kalshi] AUTH TEST OK (HTTP ${r.status}) — ${r.data.markets?.length ?? 0} markets returned`,
      );
      console.info(
        '[kalshi] AUTH TEST full response:\n' + JSON.stringify(r.data, null, 2).slice(0, 4000),
      );
    } else {
      console.warn(
        `[kalshi] AUTH TEST FAILED (HTTP ${r.status}) — ${_lastKalshiError ?? 'no data'}`,
      );
    }
  } catch (e) {
    console.warn(`[kalshi] AUTH TEST threw: ${(e as Error).message}`);
  }
}

// Fire the smoke test shortly after startup (non-blocking).
setTimeout(() => {
  void testKalshiAuth();
}, 2000);
