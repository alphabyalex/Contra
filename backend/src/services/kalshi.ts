/**
 * Kalshi REST client (v2 trade-api).
 *
 * Auth: Kalshi v2 signs every request with RSA-PSS (SHA-256). The signed
 * payload is `${timestamp_ms}${METHOD}${url_path}` and goes into the
 * KALSHI-ACCESS-SIGNATURE header alongside KALSHI-ACCESS-KEY (the key
 * id from KALSHI_KEY_ID env) and KALSHI-ACCESS-TIMESTAMP. The private
 * key is read once from KALSHI_PRIVATE_KEY_PATH (resolved against the
 * repo root, falling back to CWD).
 *
 * Graceful degradation:
 *   - missing KALSHI_API_KEY / KALSHI_KEY_ID → skip auth, return [].
 *   - missing PEM file → skip, log once, return [].
 *   - PEM body without BEGIN/END headers → auto-wrap before parsing.
 *   - any HTTP failure → log warn, return [].
 *
 * The user-facing spec said RS256 but Kalshi v2 actually requires
 * RSASSA-PSS — implementing what works. The header set is identical.
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
  yes_bid?: number;
  yes_ask?: number;
  no_bid?: number;
  no_ask?: number;
  last_price?: number;
  volume?: number;
  open_interest?: number;
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
  process.env.KALSHI_BASE_URL?.trim() || 'https://trading-api.kalshi.com/trade-api/v2';

let warnedNoCreds = false;
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
let _lastKalshiThrottled: boolean = false;
export function getLastKalshiError(): string | null {
  return _lastKalshiError;
}
export function getLastKalshiThrottled(): boolean {
  return _lastKalshiThrottled;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function buildJwt(sub: string, key: crypto.KeyObject): string {
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = { sub, nonce: Date.now().toString() };
  const headerB64 = b64url(Buffer.from(JSON.stringify(header)));
  const payloadB64 = b64url(Buffer.from(JSON.stringify(payload)));
  const signingInput = `${headerB64}.${payloadB64}`;
  const sig = crypto.sign('sha256', Buffer.from(signingInput), {
    key,
    padding: crypto.constants.RSA_PKCS1_PADDING, // RS256 uses PKCS1 v1.5
  });
  return `${signingInput}.${b64url(sig)}`;
}

function signedHeaders(): Record<string, string> | null {
  const keyId = process.env.KALSHI_KEY_ID?.trim() || process.env.KALSHI_API_KEY?.trim();
  const key = loadPrivateKey();
  if (!keyId || !key) {
    if (!warnedNoCreds) {
      console.warn('[kalshi] KALSHI_KEY_ID or private key missing — calls will skip silently.');
      warnedNoCreds = true;
    }
    return null;
  }
  let token: string;
  try {
    token = buildJwt(keyId, key);
  } catch (e) {
    _lastKalshiError = `JWT sign failed: ${(e as Error).message}`;
    console.warn(`[kalshi] ${_lastKalshiError}`);
    return null;
  }
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
  };
}

interface KalshiHttpResult<T> { data: T | null; status: number }

async function getJson<T>(pathSeg: string, search?: URLSearchParams): Promise<KalshiHttpResult<T>> {
  const headers = signedHeaders();
  if (!headers) return { data: null, status: 0 };
  const base = BASE().replace(/\/+$/g, '');
  const url = `${base}${pathSeg}${search ? `?${search}` : ''}`;
  try {
    const res = await fetch(url, { headers });
    if (!res.ok) {
      let body = '';
      try { body = (await res.text()).slice(0, 240); } catch { /* ignore */ }
      if (res.status === 429) {
        // Rate-limited — not an auth error. Don't pollute the red error line.
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
    return { data: (await res.json()) as T, status: res.status };
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

export async function getMarkets(params: {
  limit?: number;
  status?: 'open' | 'closed' | 'settled';
  cursor?: string;
} = {}): Promise<RawKalshiMarket[]> {
  const search = new URLSearchParams();
  search.set('limit', String(params.limit ?? 200));
  if (params.status) search.set('status', params.status);
  if (params.cursor) search.set('cursor', params.cursor);
  const r = await getJson<MarketsResponse>('/markets', search);
  return r.data?.markets ?? [];
}

/**
 * Paginate Kalshi /markets up to `maxPages` (default 10 → ~2000 markets).
 * Most Kalshi markets are unpriced sports props on early pages, so we
 * keep walking until we've found at least 50 priced markets in a wider
 * longshot range (0.01..0.20). The wider band is intentional — Kalshi's
 * pricing model can sit slightly outside the Polymarket window we use
 * for the final display filter.
 *
 * Logs total / priced / in-range so the operator can see progress.
 */
export async function getAllOpenMarkets(maxPages = 10): Promise<RawKalshiMarket[]> {
  const all: RawKalshiMarket[] = [];
  let cursor: string | undefined;
  let priced = 0;
  let inRange = 0;
  let throttled = false;
  for (let i = 0; i < maxPages; i++) {
    if (i > 0) await sleep(300); // 300ms between pages to dodge Kalshi rate limits
    const search = new URLSearchParams({ limit: '200', status: 'open' });
    if (cursor) search.set('cursor', cursor);
    const r = await getJson<MarketsResponse>('/markets', search);
    if (r.status === 429) {
      throttled = true;
      break; // stop immediately on rate limit; return whatever we found
    }
    if (!r.data || !r.data.markets || r.data.markets.length === 0) break;
    all.push(...r.data.markets);

    priced = 0;
    inRange = 0;
    for (const m of all) {
      const cents = midPriceCents(m);
      if (cents == null) continue;
      priced++;
      const yesP = cents / 100;
      const noP = 1 - yesP;
      if ((yesP >= 0.01 && yesP <= 0.20) || (noP >= 0.01 && noP <= 0.20)) inRange++;
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

function midPriceCents(m: RawKalshiMarket): number | null {
  if (typeof m.last_price === 'number') return m.last_price;
  if (typeof m.yes_bid === 'number' && typeof m.yes_ask === 'number') {
    return (m.yes_bid + m.yes_ask) / 2;
  }
  return null;
}

export function flattenOutcomes(m: RawKalshiMarket): KalshiOutcome[] {
  const cents = midPriceCents(m);
  if (cents == null) return [];
  const yesPrice = cents / 100;
  return [
    {
      ticker: m.ticker,
      question: m.title,
      outcomeLabel: 'YES',
      pMarket: yesPrice,
      volumeUsd: Number(m.volume ?? 0) || 0,
      endDateIso: m.close_time,
      category: m.category,
    },
    {
      ticker: m.ticker,
      question: m.title,
      outcomeLabel: 'NO',
      pMarket: 1 - yesPrice,
      volumeUsd: Number(m.volume ?? 0) || 0,
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

export async function getOrderbook(ticker: string): Promise<unknown | null> {
  const r = await getJson(`/markets/${encodeURIComponent(ticker)}/orderbook`);
  return r.data;
}
