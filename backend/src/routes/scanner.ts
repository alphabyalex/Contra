/**
 * Scanner API.
 *   GET /api/scanner/markets   — PRIMARY display endpoint. Reads the
 *                                scored_markets table (full curated pool,
 *                                178+ rows) enriched with screened_markets
 *                                + tracked_markets. Layered factors
 *                                (adjusted_edge / time / category / volume)
 *                                are recomputed on the fly from the ML
 *                                scorer so they stay consistent with the
 *                                active model even though they are not
 *                                persisted as columns.
 *   GET /api/scanner/market/:id — single-market detail (live snapshot join)
 *   GET /api/scanner/snapshot   — raw merged live markets (debug)
 *   GET /api/scanner/live       — SSE stream
 *   GET /api/scanner/history    — most recent scored scan output
 *
 * The live Polymarket / Kalshi APIs are intentionally NOT the source for
 * /markets — they are only used by the weekly screener (new market
 * discovery) and the price collector (price updates).
 */

import { Router, Request, Response } from 'express';
import { runScanner } from '../services/cron';
import {
  getAllActiveMarkets as getAllPoly,
  flattenOutcomes as flattenPoly,
  daysToClose,
} from '../services/polymarket';
import { getLastKalshiError, getLastKalshiThrottled } from '../services/kalshi';
import {
  listScoredMarkets,
  listScreenedMarkets,
  listTrackedMarkets,
  getScreenedMarket,
  getScoredMarket,
  listRecentlyExcluded,
  type ScreenedMarket,
  type TrackedMarket,
} from '../db/queries';
import {
  computeLayeredScore,
  detectTournamentGroup,
  detectSportsSubcategory,
  getSportsSubcategoryPModel,
  getSportsCalibratedPModel,
  getTournamentFavorites,
  classifySignal,
  TOURNAMENT_EDGE_INCLUDE_THRESHOLD,
  type Signal,
} from '../services/ml-scorer';

export const scannerRouter: Router = Router();

interface ScannerMarketRow {
  condition_id: string;
  marketId: string; // alias of condition_id for legacy frontend consumers
  question: string;
  source: string;
  p_market: number;
  p_model: number;
  adjusted_edge: number;
  edge: number; // raw base edge (p_market - p_model), legacy alias for raw_edge
  raw_edge: number; // calibration_v5_1 — always p_market − p_model, never zeroed
  signal: Signal;   // calibration_v5_1 — short/long/fair tag
  time_factor: number;
  category_factor: number;
  volume_factor: number;
  category: string;
  days_to_close: number | null;
  daysToClose: number | null; // alias for legacy frontend consumers
  volume: number | null;
  screened: boolean;
  excluded: boolean;
  impossible: boolean;
  exclusion_reason: string | null;
  include_in_basket: boolean;
  model_version: string | null;
  // calibration_v5 tournament normalization (computed on the fly so they
  // appear in the response even when scored_markets hasn't been ALTERed)
  tournament_group: string | null;
  is_tournament_market: boolean;
  normalized_p_market: number | null;
  is_favorite: boolean;
  /**
   * True when this row is sourced from the live-Polymarket ephemeral
   * favorites cache (i.e. NOT in `scored_markets`). The default scanner
   * view filters these out so high-volume tournament participants with
   * negligible win odds (Uzbekistan 0.1% etc.) don't flood the top 25.
   * They still surface when the user searches by question text.
   */
  is_ephemeral: boolean;
}

interface ScoredCacheEntry {
  at: number;
  rows: ScannerMarketRow[];
}

let scoredCache: ScoredCacheEntry | null = null;
const SCORED_TTL_MS = 30_000;

async function buildScoredRows(): Promise<ScannerMarketRow[]> {
  const [scored, screened, tracked] = await Promise.all([
    listScoredMarkets(),
    listScreenedMarkets().catch(() => [] as ScreenedMarket[]),
    listTrackedMarkets().catch(() => [] as TrackedMarket[]),
  ]);

  const screenedById = new Map<string, ScreenedMarket>();
  for (const s of screened) screenedById.set(s.condition_id, s);

  const trackedById = new Map<string, TrackedMarket>();
  for (const t of tracked) trackedById.set(t.condition_id, t);

  const rows: ScannerMarketRow[] = scored.map((sd) => {
    const sc = screenedById.get(sd.condition_id) ?? null;
    const tm = trackedById.get(sd.condition_id) ?? null;

    const impossible = sc?.impossible ?? sd.impossible_edge ?? false;
    const excludedByScreener = sc?.excluded ?? false;

    // Volume / days: scored_markets carries both; fall back to tracked.
    const volume =
      sd.volume ??
      (tm && (tm as unknown as { volume_at_start?: number | null }).volume_at_start) ??
      null;

    let days = sd.days_to_close ?? null;
    if (days == null && tm?.resolution_date) {
      const t = Date.parse(tm.resolution_date);
      if (!Number.isNaN(t)) days = Math.max(0, Math.round((t - Date.now()) / 86_400_000));
    }

    const layered = computeLayeredScore({
      p_market: sd.p_market ?? 0,
      question: sd.question,
      isImpossible: impossible,
      excludedByScreener,
      volume,
      days_to_close: days,
      category: sd.category ?? null,
    });

    return {
      condition_id: sd.condition_id,
      marketId: sd.condition_id,
      question: sd.question,
      source: sd.source,
      p_market: sd.p_market ?? 0,
      p_model: layered.p_model,
      adjusted_edge: layered.adjusted_edge,
      edge: layered.raw_edge,
      raw_edge: layered.raw_edge,
      signal: layered.signal,
      time_factor: layered.time_factor,
      category_factor: layered.category_factor,
      volume_factor: layered.volume_factor,
      category: layered.category,
      days_to_close: days,
      daysToClose: days,
      volume,
      screened: Boolean(sc),
      excluded: excludedByScreener,
      impossible,
      exclusion_reason: sc?.exclusion_reason ?? null,
      include_in_basket: layered.include_in_basket,
      model_version: sd.model_version ?? null,
      tournament_group: detectTournamentGroup(sd.question),
      is_tournament_market: false,
      normalized_p_market: null,
      is_favorite: false,
      is_ephemeral: false,
    };
  });

  applyTournamentNormalizationInPlace(rows);

  // Inject ephemeral favorites cached by the most recent
  // applyTournamentNormalization pass — these are tournament participants
  // sitting above the screener's 0.10 ceiling (France, Brazil at 20%+
  // etc.) that aren't in scored_markets but are needed for the long
  // basket signal.
  const cachedFavorites = getTournamentFavorites();
  for (const f of cachedFavorites) {
    rows.push({
      condition_id: f.condition_id,
      marketId: f.condition_id,
      question: f.question,
      source: f.source,
      p_market: f.p_market,
      p_model: f.p_model,
      raw_edge: f.raw_edge,
      edge: f.raw_edge,
      adjusted_edge: f.adjusted_edge,
      time_factor: f.time_factor,
      category_factor: 1.0,
      volume_factor: f.volume_factor,
      signal: f.signal,
      category: f.category,
      days_to_close: f.days_to_close,
      daysToClose: f.days_to_close,
      volume: f.volume,
      screened: false,
      excluded: false,
      impossible: false,
      exclusion_reason: null,
      include_in_basket: false,
      model_version: f.model_version,
      tournament_group: f.tournament_group,
      is_tournament_market: true,
      normalized_p_market: f.normalized_p_market,
      // is_favorite reflects the model's view (raw_edge ≤ 0). Set on the
      // cache row by ml-scorer's applyTournamentNormalization; ephemeral
      // rows whose raw_edge ended up positive (tournament longshots
      // sitting above the screener ceiling) are NOT tagged as favorites.
      is_favorite: (f as { is_favorite?: boolean }).is_favorite ?? f.raw_edge <= 0,
      is_ephemeral: true,
    });
  }

  return rows;
}

/**
 * In-memory equivalent of `applyTournamentNormalization` for the scanner
 * route. We can't rely on persisted `tournament_group` / `is_favorite`
 * columns because the calibration_v5 ALTER statements may not have been
 * run in Supabase yet. Doing it here means the scanner gets the right
 * values today; once the ALTERs land we can read them off the row instead.
 */
function applyTournamentNormalizationInPlace(rows: ScannerMarketRow[]): void {
  const groups = new Map<string, ScannerMarketRow[]>();
  for (const r of rows) {
    if (!r.tournament_group) continue;
    const arr = groups.get(r.tournament_group) ?? [];
    arr.push(r);
    groups.set(r.tournament_group, arr);
  }

  for (const [, members] of groups) {
    if (members.length < 2) continue;
    const sumP = members.reduce((s, m) => s + (m.p_market ?? 0), 0);
    // Match ml-scorer's sanity gate exactly — if the group's coverage is
    // too far from a true distribution we leave each row scored on its own
    // (the canonical per-row layered output is already in adjusted_edge).
    if (sumP < 0.5 || sumP > 2.5) continue;

    const normalizedImplied = members.map((m) => (m.p_market ?? 0) / sumP);
    const pModelsRaw = members.map((m, i) => {
      const sub = detectSportsSubcategory(m.question);
      return sub
        ? getSportsSubcategoryPModel(sub, normalizedImplied[i])
        : getSportsCalibratedPModel(normalizedImplied[i]);
    });
    const sumPModel = pModelsRaw.reduce((s, p) => s + p, 0);
    if (sumPModel <= 0) continue;
    const pModelsNorm = pModelsRaw.map((p) => p / sumPModel);

    for (let i = 0; i < members.length; i++) {
      const m = members[i];
      const newPMarket = normalizedImplied[i];
      const newPModel = pModelsNorm[i];
      const newRawEdge = newPMarket - newPModel;
      const newAdjEdge = newRawEdge * m.time_factor * m.volume_factor;
      m.is_tournament_market = true;
      m.normalized_p_market = newPMarket;
      m.is_favorite = newRawEdge <= 0;
      m.p_model = newPModel;
      m.raw_edge = newRawEdge;
      m.edge = newRawEdge;
      m.adjusted_edge = newAdjEdge;
      m.signal = classifySignal(newRawEdge);
      // Tournament longshot threshold (0.02) is looser than the standard
      // EDGE_INCLUDE_THRESHOLD because normalized edges sit closer to 0.
      m.include_in_basket = newRawEdge > TOURNAMENT_EDGE_INCLUDE_THRESHOLD;
    }
  }
}

/**
 * Score function for category-top-5 ranking. Rewards both edge magnitude
 * and market liquidity so a 3% edge in a $50M market beats an 8% edge in
 * a $200k market. Uses raw_edge (not adj_edge) so far-future markets can
 * still rank — they're flagged as basket-ineligible separately via
 * days_to_close > 365. Null-volume markets get a $10k baseline so they
 * stay rankable rather than collapsing to score 0.
 */
function categoryScore(row: ScannerMarketRow): number {
  const rawEdge = Math.abs(Number(row.raw_edge ?? row.edge ?? 0));
  const volume = Math.max(Number(row.volume ?? 10_000), 1);
  return rawEdge * Math.log10(volume + 1);
}

const CATEGORY_ORDER: Array<'politics' | 'sports' | 'macro' | 'crypto' | 'other'> = [
  'politics', 'sports', 'macro', 'crypto', 'other',
];

interface CategoryGroup {
  category: string;
  markets: ScannerMarketRow[];
  short_count: number;
  long_count: number;
  /** Index inside `markets` where the long section starts (sports only). */
  long_section_start: number | null;
}

function isShortSignal(s: string | undefined): boolean {
  return s === 'strong_short' || s === 'short' || s === 'weak_short';
}
function isLongSignal(s: string | undefined): boolean {
  return s === 'strong_long' || s === 'long';
}

/** Markets that are essentially closed (resolves in < 3 days). */
function isNearClosed(r: ScannerMarketRow): boolean {
  return r.days_to_close != null && r.days_to_close < 3;
}

/** Inside the 3-365d basket window. */
function isInBasketWindow(r: ScannerMarketRow): boolean {
  const d = r.days_to_close;
  return d == null || (d >= 3 && d <= 365);
}

/**
 * Pick up to `n` rows in three priority tiers. Rows resolving in < 3
 * days are hard-excluded entirely (Fix 2).
 *
 *   tier 1: in window AND volume ≥ $100k  (fully basket-eligible)
 *   tier 2: in window (any volume)        (near-term but liquidity unclear)
 *   tier 3: outside window                (2028 elections, far-future)
 *
 * Within each tier rows sort by categoryScore DESC so a 5% edge in $20M
 * beats a 8% edge in $200k inside the same tier.
 *
 * The two-step "window first, then volume" tiering is what lets the
 * politics section show near-term markets (Brazilian primary, etc.)
 * even when their volume hasn't been populated yet — they outrank
 * 2028 US elections which are squarely out of basket window.
 */
function pickEligibleFirst(rows: ScannerMarketRow[], n: number): ScannerMarketRow[] {
  const usable = rows.filter((r) => !isNearClosed(r));
  const byScore = (a: ScannerMarketRow, b: ScannerMarketRow) => categoryScore(b) - categoryScore(a);

  const tier1 = usable.filter((r) => isInBasketWindow(r) && Number(r.volume ?? 0) >= 100_000).sort(byScore);
  const tier2 = usable.filter((r) => isInBasketWindow(r) && Number(r.volume ?? 0) < 100_000).sort(byScore);
  const tier3 = usable.filter((r) => !isInBasketWindow(r)).sort(byScore);

  return [...tier1, ...tier2, ...tier3].slice(0, n);
}

function getCategoryTopMarkets(
  curated: ScannerMarketRow[],
  fullPool: ScannerMarketRow[],
): CategoryGroup[] {
  const bucketize = (rows: ScannerMarketRow[]) => {
    const m = new Map<string, ScannerMarketRow[]>();
    for (const r of rows) {
      const cat = (r.category ?? 'other').toLowerCase();
      const bucket = CATEGORY_ORDER.includes(cat as typeof CATEGORY_ORDER[number])
        ? cat
        : 'other';
      const arr = m.get(bucket) ?? [];
      arr.push(r);
      m.set(bucket, arr);
    }
    return m;
  };

  const curatedByCat = bucketize(curated);
  // For sports longs we tap the full pool (curated + ephemeral tournament
  // favorites). Other categories stay on the curated pool only.
  const fullByCat = bucketize(fullPool);

  const groups: CategoryGroup[] = [];
  for (const cat of CATEGORY_ORDER) {
    const curatedCat = curatedByCat.get(cat) ?? [];
    let picked: ScannerMarketRow[];
    let longStart: number | null = null;
    let shortCount = 0;
    let longCount = 0;

    if (cat === 'sports') {
      // Sports shorts come from the curated pool with eligible-first
      // ranking — same as every other category.
      const shorts = pickEligibleFirst(
        curatedCat.filter((r) => isShortSignal(r.signal)),
        3,
      );
      // Sports longs come from the FULL pool because tournament favorites
      // (France, OKC Thunder, Carolina Hurricanes etc.) live in the
      // ephemeral cache. Per spec, LONG slots are allowed to use
      // ephemeral rows regardless of basket eligibility — they're
      // surfaced for the long-basket product, not for the short basket.
      const fullCat = fullByCat.get(cat) ?? [];
      const longs = fullCat
        .filter((r) => isLongSignal(r.signal) && !isNearClosed(r))
        .sort((a, b) => categoryScore(b) - categoryScore(a))
        .slice(0, 2);
      picked = [...shorts, ...longs];
      shortCount = shorts.length;
      longCount = longs.length;
      longStart = shorts.length > 0 && longs.length > 0 ? shorts.length : null;
    } else {
      // Politics / macro / crypto / other: 5 slots filled eligible-first.
      // 2028-election questions only appear when fewer than 5 near-term
      // basket-eligible rows exist in the category.
      picked = pickEligibleFirst(curatedCat, 5);
      shortCount = picked.filter((r) => isShortSignal(r.signal)).length;
      longCount = picked.filter((r) => isLongSignal(r.signal)).length;
    }

    const enriched = picked.map((r) => ({ ...r, score: Number(categoryScore(r).toFixed(6)) }));
    groups.push({
      category: cat,
      markets: enriched,
      short_count: shortCount,
      long_count: longCount,
      long_section_start: longStart,
    });
  }
  return groups;
}

/**
 * GET /api/scanner/markets
 *
 * Default (no search):
 *   Top 5 per category, ordered politics → sports → macro → crypto → other.
 *   Sports section splits into 3 shorts + 2 longs.
 *   Ranking = abs(raw_edge) × log10(volume + 1).
 *
 * Search:
 *   Full pool filter, sorted by ?sort=volume|edge|days|p_market (default volume).
 *   Includes ephemeral tournament favorites for tournament-context lookups.
 */
scannerRouter.get('/markets', async (req, res) => {
  try {
    const sortParam = String(req.query.sort ?? 'volume').toLowerCase();
    const search = (req.query.search ?? '').toString().trim().toLowerCase();
    const limitParam =
      req.query.limit != null ? Math.max(1, Math.min(2000, Number(req.query.limit))) : null;

    const fresh = scoredCache && Date.now() - scoredCache.at < SCORED_TTL_MS;
    if (!fresh) {
      scoredCache = { at: Date.now(), rows: await buildScoredRows() };
    }
    const all = scoredCache!.rows;

    const polymarket = all.filter((r) => r.source === 'polymarket').length;
    const kalshi = all.filter((r) => r.source === 'kalshi').length;

    // Curated-pool count for the default-view label. Ephemeral tournament
    // rows (live favorites cached separately) are excluded — they only
    // surface on explicit search.
    const watchedCount = all.filter((r) => !r.is_ephemeral).length;

    // Default view = curated pool only. Ephemeral tournament favorites
    // (Uzbekistan etc. with $20M+ raw volume but 0.1% win odds) only
    // surface when the user actually searches for them — otherwise they
    // would dominate the top-25-by-volume default.
    let filtered = search ? all : all.filter((r) => !r.is_ephemeral);
    if (search) {
      filtered = filtered.filter((r) => r.question?.toLowerCase().includes(search));
    }

    const cmp = (a: ScannerMarketRow, b: ScannerMarketRow): number => {
      switch (sortParam) {
        case 'edge':
          return (b.adjusted_edge ?? 0) - (a.adjusted_edge ?? 0);
        case 'days':
          return (
            (a.days_to_close ?? Number.POSITIVE_INFINITY) -
            (b.days_to_close ?? Number.POSITIVE_INFINITY)
          );
        case 'p_market':
          return a.p_market - b.p_market;
        case 'volume':
        default:
          return (b.volume ?? 0) - (a.volume ?? 0);
      }
    };

    // Category-grouped default view: top 5 per category by raw_edge ×
    // log10(volume). Sports gets 3 short + 2 long. Search bypasses this
    // and falls back to the legacy sorted-and-sliced layout.
    //
    // We pass BOTH the curated pool (no ephemeral) and the full pool
    // because the sports-long slot needs to consider tournament
    // favorites — they sit above the screener's 0.10 ceiling so they
    // never appear in scored_markets, but they ARE the long candidates.
    if (!search) {
      const grouped = getCategoryTopMarkets(filtered, all);
      res.json({
        at: scoredCache!.at,
        count: all.length,
        watched_count: watchedCount,
        counts: { polymarket, kalshi },
        kalshi_error: getLastKalshiError(),
        kalshi_throttled: getLastKalshiThrottled(),
        sort: sortParam,
        search: null,
        total_after_filter: filtered.length,
        view: 'category_grouped',
        groups: grouped,
        rows: grouped.flatMap((g) => g.markets),
      });
      return;
    }

    const sorted = [...filtered].sort(cmp);
    const limit = limitParam ?? sorted.length;
    const sliced = sorted.slice(0, limit);

    res.json({
      at: scoredCache!.at,
      count: all.length,
      watched_count: watchedCount,
      counts: { polymarket, kalshi },
      kalshi_error: getLastKalshiError(),
      kalshi_throttled: getLastKalshiThrottled(),
      sort: sortParam,
      search: search,
      total_after_filter: filtered.length,
      view: 'search',
      rows: sliced,
    });
  } catch (e) {
    res.status(500).json({
      error: (e as Error).message,
      rows: [],
      counts: { polymarket: 0, kalshi: 0 },
      kalshi_error: getLastKalshiError(),
      kalshi_throttled: getLastKalshiThrottled(),
    });
  }
});

/**
 * GET /api/scanner/market/:condition_id
 *
 * Full detail for a single market — joins the scored row with the
 * screened verdict. Falls back to a live snapshot lookup if the market
 * isn't in scored_markets yet.
 */
scannerRouter.get('/market/:condition_id', async (req, res) => {
  const id = req.params.condition_id;
  try {
    const [screened, scored] = await Promise.all([
      getScreenedMarket(id).catch(() => null),
      getScoredMarket(id).catch(() => null),
    ]);

    let status:
      | 'impossible'
      | 'excluded_resolved'
      | 'excluded_ambiguous'
      | 'excluded'
      | 'eligible'
      | 'unscreened';
    if (!screened) status = 'unscreened';
    else if (screened.impossible) status = 'impossible';
    else if (screened.already_resolved) status = 'excluded_resolved';
    else if (screened.ambiguous) status = 'excluded_ambiguous';
    else if (screened.excluded) status = 'excluded';
    else status = 'eligible';

    let market: unknown = null;
    if (scored) {
      market = {
        question: scored.question,
        source: scored.source,
        marketId: scored.condition_id,
        p_market: scored.p_market,
        volume: scored.volume,
        daysToClose: scored.days_to_close,
        category: scored.category,
      };
    }

    if (!market && !screened && !scored) {
      return res.status(404).json({ error: 'market_not_found', condition_id: id });
    }

    res.json({ condition_id: id, market, screened, scored, status });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

/**
 * Recently excluded screened markets. Used by the admin dashboard to
 * surface what the screener has been kicking out and why.
 */
scannerRouter.get('/recent-excluded', async (req, res) => {
  try {
    const limit = Math.min(50, Math.max(1, Number(req.query.limit ?? 10)));
    const rows = await listRecentlyExcluded(limit);
    res.json({
      rows: rows.map((r) => ({
        condition_id: r.condition_id,
        question: r.question,
        p_market: r.p_market,
        impossible: r.impossible,
        already_resolved: r.already_resolved,
        ambiguous: r.ambiguous,
        exclusion_reason: r.exclusion_reason,
        screened_at: r.screened_at,
      })),
    });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

// ---- live debug endpoints (raw merged sources, not the curated pool) ---

interface SnapshotRow {
  question: string;
  source: 'kalshi' | 'polymarket';
  marketId: string;
  outcomeLabel: string;
  p_market: number;
  volume: number;
  endDateIso?: string;
  daysToClose?: number | null;
  category?: string;
}

async function safeArr<T>(fn: () => Promise<T[]>): Promise<T[]> {
  try {
    return await fn();
  } catch (e) {
    console.warn('[scanner] data source error:', (e as Error).message);
    return [];
  }
}

scannerRouter.get('/snapshot', async (req, res) => {
  try {
    const min = req.query.min ? Number(req.query.min) : 0.02;
    const max = req.query.max ? Number(req.query.max) : 0.15;
    const poly = await safeArr(() => getAllPoly(2));
    const rows: SnapshotRow[] = [];
    for (const m of poly) {
      for (const o of flattenPoly(m)) {
        if (o.pMarket >= min && o.pMarket <= max) {
          rows.push({
            question: o.question,
            source: 'polymarket',
            marketId: o.conditionId,
            outcomeLabel: o.outcomeLabel,
            p_market: o.pMarket,
            volume: o.volumeUsd,
            endDateIso: o.endDateIso,
            daysToClose: daysToClose(o.endDateIso),
            category: o.category,
          });
        }
      }
    }
    rows.sort((a, b) => a.p_market - b.p_market);
    res.json({ at: Date.now(), count: rows.length, rows: rows.slice(0, 200) });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message, rows: [] });
  }
});

scannerRouter.get('/live', async (req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  let closed = false;
  req.on('close', () => {
    closed = true;
  });
  const send = (data: unknown) => {
    if (closed) return;
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };
  const push = async () => {
    try {
      const rows = await runScanner();
      send({ at: Date.now(), rows: rows.slice(0, 50) });
    } catch (e) {
      send({ at: Date.now(), error: (e as Error).message });
    }
  };
  await push();
  const iv = setInterval(push, 30_000);
  req.on('close', () => clearInterval(iv));
});

scannerRouter.get('/history', async (_req, res) => {
  try {
    const rows = await runScanner();
    res.json({ at: Date.now(), rows: rows.slice(0, 100) });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});
