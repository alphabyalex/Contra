/**
 * READ-ONLY proposal generator. Reuses the exact scanner pool logic
 * (buildScoredRows + tournament normalization + ephemeral favorites)
 * and prints two basket proposals as tables. Writes NOTHING to the DB.
 *
 *   npx tsx src/propose-baskets.ts
 */

import path from 'path';
import { config as loadDotenv } from 'dotenv';
loadDotenv({ path: path.resolve(__dirname, '..', '..', '.env'), override: true });

import {
  listScoredMarkets,
  listScreenedMarkets,
  listTrackedMarkets,
  type ScreenedMarket,
  type TrackedMarket,
} from './db/queries';
import {
  computeLayeredScore,
  detectTournamentGroup,
  detectSportsSubcategory,
  getSportsSubcategoryPModel,
  getSportsCalibratedPModel,
  getTournamentFavorites,
  classifySignal,
  TOURNAMENT_EDGE_INCLUDE_THRESHOLD,
  MODEL_VERSION,
  type Signal,
} from './services/ml-scorer';

interface Row {
  condition_id: string;
  question: string;
  source: string;
  p_market: number;
  p_model: number;
  adjusted_edge: number;
  raw_edge: number;
  signal: Signal;
  time_factor: number;
  volume_factor: number;
  category: string;
  days_to_close: number | null;
  volume: number | null;
  include_in_basket: boolean;
  tournament_group: string | null;
  is_tournament_market: boolean;
  normalized_p_market: number | null;
  is_favorite: boolean;
  is_ephemeral: boolean;
}

// ---- faithful copy of scanner.ts buildScoredRows ----------------------
async function buildScoredRows(): Promise<Row[]> {
  const [scored, screened, tracked] = await Promise.all([
    listScoredMarkets(),
    listScreenedMarkets().catch(() => [] as ScreenedMarket[]),
    listTrackedMarkets().catch(() => [] as TrackedMarket[]),
  ]);

  const screenedById = new Map<string, ScreenedMarket>();
  for (const s of screened) screenedById.set(s.condition_id, s);
  const trackedById = new Map<string, TrackedMarket>();
  for (const t of tracked) trackedById.set(t.condition_id, t);

  const rows: Row[] = scored.map((sd) => {
    const sc = screenedById.get(sd.condition_id) ?? null;
    const tm = trackedById.get(sd.condition_id) ?? null;
    const impossible = sc?.impossible ?? sd.impossible_edge ?? false;
    const excludedByScreener = sc?.excluded ?? false;

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
      question: sd.question,
      source: sd.source,
      p_market: sd.p_market ?? 0,
      p_model: layered.p_model,
      adjusted_edge: layered.adjusted_edge,
      raw_edge: layered.raw_edge,
      signal: layered.signal,
      time_factor: layered.time_factor,
      volume_factor: layered.volume_factor,
      category: layered.category,
      days_to_close: days,
      volume,
      include_in_basket: layered.include_in_basket,
      tournament_group: detectTournamentGroup(sd.question),
      is_tournament_market: false,
      normalized_p_market: null,
      is_favorite: false,
      is_ephemeral: false,
    };
  });

  applyTournamentNormalizationInPlace(rows);

  for (const f of getTournamentFavorites()) {
    rows.push({
      condition_id: f.condition_id,
      question: f.question,
      source: f.source,
      p_market: f.p_market,
      p_model: f.p_model,
      raw_edge: f.raw_edge,
      adjusted_edge: f.adjusted_edge,
      time_factor: f.time_factor,
      volume_factor: f.volume_factor,
      signal: f.signal,
      category: f.category,
      days_to_close: f.days_to_close,
      volume: f.volume,
      include_in_basket: false,
      tournament_group: f.tournament_group,
      is_tournament_market: true,
      normalized_p_market: f.normalized_p_market,
      is_favorite: (f as { is_favorite?: boolean }).is_favorite ?? f.raw_edge <= 0,
      is_ephemeral: true,
    });
  }

  return rows;
}

function applyTournamentNormalizationInPlace(rows: Row[]): void {
  const groups = new Map<string, Row[]>();
  for (const r of rows) {
    if (!r.tournament_group) continue;
    const arr = groups.get(r.tournament_group) ?? [];
    arr.push(r);
    groups.set(r.tournament_group, arr);
  }
  for (const [, members] of groups) {
    if (members.length < 2) continue;
    const sumP = members.reduce((s, m) => s + (m.p_market ?? 0), 0);
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
      m.is_tournament_market = true;
      m.normalized_p_market = newPMarket;
      m.is_favorite = newRawEdge <= 0;
      m.p_model = newPModel;
      m.raw_edge = newRawEdge;
      m.adjusted_edge = newRawEdge * m.time_factor * m.volume_factor;
      m.signal = classifySignal(newRawEdge);
      m.include_in_basket = newRawEdge > TOURNAMENT_EDGE_INCLUDE_THRESHOLD;
    }
  }
}

// ---- formatting -------------------------------------------------------
const SHORT: Signal[] = ['strong_short', 'short', 'weak_short'];
const LONG: Signal[] = ['long', 'strong_long'];

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}
function pct(n: number | null): string {
  return n == null ? '—' : (n * 100).toFixed(1) + '%';
}
function signed(n: number): string {
  return (n >= 0 ? '+' : '') + (n * 100).toFixed(2) + '%';
}
function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)),
  );
  const line = (cells: string[]) =>
    '| ' + cells.map((c, i) => c.padEnd(widths[i])).join(' | ') + ' |';
  const sep = '|' + widths.map((w) => '-'.repeat(w + 2)).join('|') + '|';
  return [line(headers), sep, ...rows.map(line)].join('\n');
}

function isKoreanElection(q: string): boolean {
  return /\b(seoul|gyeonggi)\b/i.test(q);
}

async function main() {
  const all = await buildScoredRows();
  console.log(`\nModel: ${MODEL_VERSION}   pool size: ${all.length} rows\n`);

  // ---------- CTRA-1.1 : short basket ----------
  const ctra11 = all
    .filter((r) => SHORT.includes(r.signal))
    .filter((r) => r.days_to_close != null && r.days_to_close >= 7 && r.days_to_close <= 180)
    .filter((r) => r.volume == null || r.volume >= 100_000)
    .filter((r) => !isKoreanElection(r.question))
    .sort((a, b) => b.adjusted_edge - a.adjusted_edge)
    .slice(0, 50);

  console.log(`================ CTRA-1.1  (SHORT basket, replaces CTRA-01) ================`);
  console.log(`legs: ${ctra11.length}  (target 40–50)  | signal=short* | days 7–180 | vol≥$100k or n/a | excl Seoul/Gyeonggi\n`);
  console.log(
    table(
      ['#', 'question', 'src', 'p_market', 'p_model', 'adj_edge', 'days', 'category'],
      ctra11.map((r, i) => [
        String(i + 1),
        truncate(r.question, 58),
        r.source === 'polymarket' ? 'poly' : 'kalshi',
        pct(r.p_market),
        pct(r.p_model),
        signed(r.adjusted_edge),
        String(r.days_to_close),
        r.category,
      ]),
    ),
  );

  // ---------- CTRA-02 : long basket ----------
  const longs = all.filter((r) => LONG.includes(r.signal));
  // tournament favorites preferred → sort favorites first, then by raw_edge
  // ascending (most negative raw_edge = strongest long / most underpriced).
  longs.sort((a, b) => {
    const favA = a.is_tournament_market && a.is_favorite ? 0 : 1;
    const favB = b.is_tournament_market && b.is_favorite ? 0 : 1;
    if (favA !== favB) return favA - favB;
    return a.raw_edge - b.raw_edge;
  });
  const ctra02 = longs.slice(0, 30);

  console.log(`\n\n================ CTRA-02  (LONG basket) ================`);
  console.log(`legs: ${ctra02.length}  (target 20–30)  | signal=long/strong_long | tournament favorites preferred\n`);
  console.log(
    table(
      ['#', 'question', 'norm_p_mkt', 'p_model', 'raw_edge', 'days', 'category', 'fav'],
      ctra02.map((r, i) => [
        String(i + 1),
        truncate(r.question, 56),
        r.normalized_p_market != null ? pct(r.normalized_p_market) : pct(r.p_market),
        pct(r.p_model),
        signed(r.raw_edge),
        r.days_to_close == null ? '—' : String(r.days_to_close),
        r.category,
        r.is_tournament_market && r.is_favorite ? 'Y' : '',
      ]),
    ),
  );

  console.log('\n(Proposals only — nothing was written to the database.)\n');
}

main().then(() => process.exit(0)).catch((e) => {
  console.error(e);
  process.exit(1);
});
