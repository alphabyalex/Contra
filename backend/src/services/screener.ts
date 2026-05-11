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
  type ScreenedMarket,
} from '../db/queries';

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
