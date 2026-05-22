/**
 * Anthropic-based factual screener.
 *
 * One-shot call to claude-sonnet-4-20250514 per market that asks: is this
 * outcome impossible / already resolved / ambiguous? Excluded markets are
 * filtered out before we ever score them. Results are cached forever in
 * `screened_markets` keyed by condition_id, so each market is screened
 * exactly once.
 *
 * We hit the REST API directly with fetch instead of pulling in
 * @anthropic-ai/sdk — keeps the dependency tree (and the running tsx-watch
 * process) untouched.
 */

import {
  getScreenedMarket,
  upsertScreenedMarket,
  upsertScoredMarket,
  upsertTrackedMarket,
  listTrackedMarkets,
  listScoredMarkets,
  type ScreenedMarket,
} from '../db/queries';
import { getAllActiveMarkets, flattenOutcomes, daysToClose } from './polymarket';
import { computeLayeredScore } from './ml-scorer';

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-4-20250514';
const ANTHROPIC_VERSION = '2023-06-01';
const BATCH_DELAY_MS = 500;

export interface MarketToScreen {
  condition_id: string;
  source: 'polymarket' | 'kalshi';
  question: string;
  p_market: number | null;
}

export interface ScreenResult {
  condition_id: string;
  impossible: boolean;
  already_resolved: boolean;
  ambiguous: boolean;
  excluded: boolean;
  reason: string;
}

const SYSTEM_PROMPT =
  'You are a factual screener for a prediction market system. Be objective and politically neutral. ' +
  'Base decisions only on known facts, not opinions, sensitivities, or moral judgments.';

function userPrompt(question: string, pMarket: number | null): string {
  const priceStr = pMarket == null ? 'unknown' : pMarket.toFixed(4);
  return `Market question: ${question}
Current implied probability: ${priceStr}

Answer based purely on objective facts:

1. IMPOSSIBLE: Is this outcome physically, legally, or factually impossible based on currently known facts? Examples of impossible: a person buying a company they already own, a deceased person winning an election, a physical law being violated. Religious or unlikely events that have no known mechanism for occurring also qualify.

2. ALREADY_RESOLVED: Has this event already definitively occurred or been decided?

3. AMBIGUOUS: Is the resolution criteria so vague that a clear YES/NO outcome cannot be objectively determined?

Return only valid JSON, no other text:
{
  "impossible": true or false,
  "already_resolved": true or false,
  "ambiguous": true or false,
  "excluded": true or false,
  "reason": "one sentence factual explanation"
}

excluded must be true if any of the above three are true. Be concise.`;
}

interface AnthropicResponse {
  content?: { type: string; text?: string }[];
  error?: { type: string; message: string };
}

function extractJson(raw: string): Record<string, unknown> {
  // Models occasionally wrap JSON in fenced blocks despite "no other text".
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : raw;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`screener: no JSON object in model output: ${raw.slice(0, 120)}`);
  }
  return JSON.parse(candidate.slice(start, end + 1));
}

async function callClaude(question: string, pMarket: number | null): Promise<Omit<ScreenResult, 'condition_id'>> {
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');

  const res = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 256,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userPrompt(question, pMarket) }],
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Anthropic ${res.status} ${res.statusText} — ${body.slice(0, 200)}`);
  }

  const json = (await res.json()) as AnthropicResponse;
  if (json.error) throw new Error(`Anthropic error: ${json.error.message}`);
  const text = json.content?.find((c) => c.type === 'text')?.text?.trim();
  if (!text) throw new Error('screener: empty response from model');

  const parsed = extractJson(text);
  const impossible = Boolean(parsed.impossible);
  const already_resolved = Boolean(parsed.already_resolved);
  const ambiguous = Boolean(parsed.ambiguous);
  const reason = typeof parsed.reason === 'string' ? parsed.reason : '';
  // Trust the model's "excluded" only if it's consistent; otherwise derive.
  const derived = impossible || already_resolved || ambiguous;
  const excluded = typeof parsed.excluded === 'boolean' ? parsed.excluded || derived : derived;

  return { impossible, already_resolved, ambiguous, excluded, reason };
}

/**
 * Screen one market. Returns the cached row if condition_id was previously
 * screened; otherwise calls Claude and persists the result.
 */
export async function screenMarket(market: MarketToScreen): Promise<ScreenedMarket> {
  const cached = await getScreenedMarket(market.condition_id);
  if (cached) return cached;

  const verdict = await callClaude(market.question, market.p_market);
  const row = await upsertScreenedMarket({
    condition_id: market.condition_id,
    source: market.source,
    question: market.question,
    p_market: market.p_market,
    impossible: verdict.impossible,
    already_resolved: verdict.already_resolved,
    ambiguous: verdict.ambiguous,
    excluded: verdict.excluded,
    exclusion_reason: verdict.reason || null,
  });

  // If Supabase is offline upsertScreenedMarket still returns the row from
  // the in-memory store; nothing else to do here. Always log so operators
  // can see the verdict stream.
  console.info(
    `[screener] ${market.condition_id} excluded=${verdict.excluded} reason="${verdict.reason}"`,
  );
  return row;
}

/**
 * Screen many markets sequentially with a 500ms delay between calls so we
 * stay under Anthropic's per-minute caps. Cached condition_ids are skipped
 * (no API call, no delay incurred).
 */
export async function batchScreenMarkets(markets: MarketToScreen[]): Promise<{
  results: ScreenedMarket[];
  newlyScreened: number;
  excluded: number;
  errors: { condition_id: string; error: string }[];
}> {
  const results: ScreenedMarket[] = [];
  const errors: { condition_id: string; error: string }[] = [];
  let newlyScreened = 0;
  let calledOnce = false;

  for (const m of markets) {
    const cached = await getScreenedMarket(m.condition_id);
    if (cached) {
      results.push(cached);
      continue;
    }
    if (calledOnce) await new Promise((r) => setTimeout(r, BATCH_DELAY_MS));
    calledOnce = true;
    try {
      const row = await screenMarket(m);
      results.push(row);
      newlyScreened += 1;
    } catch (e) {
      const msg = (e as Error).message;
      errors.push({ condition_id: m.condition_id, error: msg });
      console.warn(`[screener] failed ${m.condition_id}: ${msg}`);
    }
  }

  const excluded = results.filter((r) => r.excluded).length;
  return { results, newlyScreened, excluded, errors };
}

// =====================================================================
// Automated market discovery (no Anthropic call — volume/probability +
// ML scoring only). New markets appear in the scanner next cycle.
// =====================================================================

export interface DiscoverySummary {
  checked: number;
  candidates: number;
  added: number;
}

/** Range/bracket markets ("between $1T and $1.25T") are not binary — skip. */
export function isRangeMarket(question: string): boolean {
  const q = (question || '').toLowerCase();
  if (!/\bbetween\b/.test(q)) return false;
  if (!/\band\b|&/.test(q)) return false;
  return /[%$]|\d\s*[bt]\b/.test(q);
}

/**
 * Lightweight discovery: pull live Polymarket markets, keep zone-1/2/3
 * candidates not already tracked, ML-score them, and persist to
 * screened_markets (FK parent) + scored_markets + tracked_markets.
 * scored_markets.model_version = 'auto_discovery' marks them as
 * not-yet-Anthropic-screened (the Sunday deep screen promotes them).
 */
export async function discoverNewMarkets(): Promise<DiscoverySummary> {
  const markets = await getAllActiveMarkets(5).catch((e) => {
    console.warn('[discovery] Polymarket fetch failed:', (e as Error).message);
    return [] as Awaited<ReturnType<typeof getAllActiveMarkets>>;
  });
  const tracked = await listTrackedMarkets().catch(() => []);
  const known = new Set(tracked.map((t) => t.condition_id));

  let candidates = 0;
  let added = 0;
  const seen = new Set<string>();

  for (const m of markets) {
    const outs = flattenOutcomes(m);
    const yes = outs.find((o) => /^yes$/i.test(o.outcomeLabel ?? '')) ?? outs[0];
    if (!yes) continue;
    const id = yes.conditionId;
    if (!id || seen.has(id) || known.has(id)) continue;

    if (isRangeMarket(yes.question)) continue; // FIX 1: no range/bracket markets
    const p = yes.pMarket;
    const inZone = (p >= 0.02 && p <= 0.2) || p >= 0.9; // zones 1, 2, 3
    if (!inZone) continue;
    if ((yes.volumeUsd ?? 0) < 50_000) continue; // FIX 4: $50k min (was $10k)
    const days = daysToClose(yes.endDateIso);
    if (days == null || days < 3 || days > 365) continue;

    candidates += 1;
    seen.add(id);
    const dRounded = Math.round(days);
    try {
      // FK: screened_markets row must exist before scored_markets.
      await upsertScreenedMarket({
        condition_id: id, source: 'polymarket', question: yes.question, p_market: p,
        impossible: false, already_resolved: false, ambiguous: false, excluded: false,
        exclusion_reason: null, screening_model: 'auto_discovery',
      });
      const l = computeLayeredScore({
        p_market: p, question: yes.question, volume: yes.volumeUsd,
        days_to_close: dRounded, category: yes.category ?? null,
      });
      await upsertScoredMarket({
        condition_id: id, source: 'polymarket', question: yes.question,
        p_market: p, p_model: l.p_model, edge: l.raw_edge, raw_edge: l.raw_edge,
        signal: l.signal, adjusted_edge: l.adjusted_edge, time_factor: l.time_factor,
        category_factor: l.category_factor, volume_factor: l.volume_factor, volume: yes.volumeUsd,
        days_to_close: dRounded, category: l.category, include_in_basket: l.include_in_basket,
        impossible_edge: false, model_version: 'auto_discovery', momentum_factor: 1.0,
        tournament_group: null, is_tournament_market: false, normalized_p_market: null, is_favorite: false,
      } as any);
      const existing = tracked.find((t) => t.condition_id === id);
      if (!existing) {
        await upsertTrackedMarket({
          condition_id: id, source: 'polymarket', question: yes.question, token_id: yes.tokenId ?? null,
          category: yes.category ?? null, p_market_initial: p, p_model_initial: l.p_model,
          edge_initial: l.raw_edge, resolution_date: yes.endDateIso ?? null,
          in_basket: false, outcome: null, resolved_at: null,
        });
      }
      added += 1;
    } catch (e) {
      console.warn(`[discovery] add failed ${id}: ${(e as Error).message}`);
    }
  }

  console.info(`[discovery] checked ${markets.length} markets, ${candidates} new candidates found, ${added} added`);
  return { checked: markets.length, candidates, added };
}

/**
 * CRON 3 (Sunday) deep screen: run the Anthropic impossibility check on
 * auto-discovered markets that are >7 days old and not yet Anthropic-
 * screened. Impossibles get p_model=0 + impossible_edge=true; all promoted
 * markets have model_version flipped from 'auto_discovery' to the live
 * calibration version (our proxy for anthropic_screened=true, since the DB
 * column can't be ALTERed via the JS client). Capped per run.
 */
export async function promoteDiscoveredMarkets(maxToScreen = 50): Promise<{ screened: number; impossibles: number; promoted: number }> {
  const scored = await listScoredMarkets();
  const cutoff = Date.now() - 7 * 86_400_000;
  const discovered = scored
    .filter((s) => s.model_version === 'auto_discovery' && (!s.scored_at || Date.parse(s.scored_at) < cutoff))
    .slice(0, maxToScreen);

  let screened = 0;
  let impossibles = 0;
  let promoted = 0;
  for (const sd of discovered) {
    try {
      const verdict = await screenMarket({
        condition_id: sd.condition_id,
        source: (sd.source === 'kalshi' ? 'kalshi' : 'polymarket') as 'kalshi' | 'polymarket',
        question: sd.question,
        p_market: sd.p_market,
      });
      screened += 1;
      const isImp = verdict.impossible;
      if (isImp) impossibles += 1;
      await upsertScoredMarket({
        condition_id: sd.condition_id, source: sd.source, question: sd.question,
        p_market: sd.p_market ?? 0,
        p_model: isImp ? 0 : (sd.p_model ?? 0),
        edge: isImp ? (sd.p_market ?? 0) : (sd.edge ?? 0),
        raw_edge: isImp ? (sd.p_market ?? 0) : ((sd as { raw_edge?: number | null }).raw_edge ?? sd.edge ?? 0),
        signal: (sd as { signal?: string | null }).signal ?? null,
        adjusted_edge: sd.adjusted_edge ?? 0, time_factor: sd.time_factor ?? 1,
        category_factor: sd.category_factor ?? 1, volume_factor: sd.volume_factor ?? 1,
        volume: sd.volume ?? null, days_to_close: sd.days_to_close ?? null, category: sd.category ?? null,
        include_in_basket: isImp ? false : (sd.include_in_basket ?? false),
        impossible_edge: isImp, model_version: 'calibration_v5_1', momentum_factor: sd.momentum_factor ?? 1,
        tournament_group: (sd as { tournament_group?: string | null }).tournament_group ?? null,
        is_tournament_market: (sd as { is_tournament_market?: boolean }).is_tournament_market ?? false,
        normalized_p_market: (sd as { normalized_p_market?: number | null }).normalized_p_market ?? null,
        is_favorite: (sd as { is_favorite?: boolean }).is_favorite ?? false,
      } as Parameters<typeof upsertScoredMarket>[0]);
      promoted += 1;
    } catch (e) {
      console.warn(`[deep-screen] failed ${sd.condition_id}: ${(e as Error).message}`);
    }
  }
  console.info(`[deep-screen] ${screened} discovered markets screened, ${impossibles} impossibles flagged, ${promoted} promoted`);
  return { screened, impossibles, promoted };
}
