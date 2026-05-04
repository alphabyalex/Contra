/**
 * Markets API — single-market lookups + on-demand mispricing scan.
 *   GET /api/markets/scan    — current scan output (cached briefly)
 *   GET /api/markets/:id     — single market by source-prefixed id
 *                              (e.g. polymarket:0x... or kalshi:TICKER)
 */

import { Router } from 'express';
import { runScanner } from '../services/cron';
import {
  flattenOutcomes as flattenPoly,
  getAllActiveMarkets as getAllPoly,
} from '../services/polymarket';
import {
  flattenOutcomes as flattenKalshi,
  getAllOpenMarkets as getAllKalshi,
} from '../services/kalshi';
import { scoreMarket } from '../services/mispricing';

export const marketsRouter: Router = Router();

let scanCache: { at: number; rows: Awaited<ReturnType<typeof runScanner>> } | null = null;
const SCAN_CACHE_MS = 60_000;

marketsRouter.get('/scan', async (_req, res) => {
  try {
    const fresh = scanCache && Date.now() - scanCache.at < SCAN_CACHE_MS;
    if (!fresh) {
      const rows = await runScanner();
      scanCache = { at: Date.now(), rows };
    }
    res.json({ scanned_at: scanCache!.at, rows: scanCache!.rows.slice(0, 100) });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

marketsRouter.get('/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const colon = id.indexOf(':');
    if (colon < 0) return res.status(400).json({ error: 'id must be source:marketId' });
    const source = id.slice(0, colon);
    const marketId = id.slice(colon + 1);

    if (source === 'polymarket') {
      const all = await getAllPoly(2);
      const market = all.find((m) => m.conditionId === marketId);
      if (!market) return res.status(404).json({ error: 'not_found' });
      const outcomes = flattenPoly(market).map((o) =>
        scoreMarket({
          source: 'polymarket',
          marketId: o.conditionId,
          question: o.question,
          outcomeLabel: o.outcomeLabel,
          pMarket: o.pMarket,
          volumeUsd: o.volumeUsd,
          endDateIso: o.endDateIso,
          category: o.category,
        }),
      );
      return res.json({ source, market, outcomes });
    }
    if (source === 'kalshi') {
      const all = await getAllKalshi(5);
      const market = all.find((m) => m.ticker === marketId);
      if (!market) return res.status(404).json({ error: 'not_found' });
      const outcomes = flattenKalshi(market).map((o) =>
        scoreMarket({
          source: 'kalshi',
          marketId: o.ticker,
          question: o.question,
          outcomeLabel: o.outcomeLabel,
          pMarket: o.pMarket,
          volumeUsd: o.volumeUsd,
          endDateIso: o.endDateIso,
          category: o.category,
        }),
      );
      return res.json({ source, market, outcomes });
    }
    res.status(400).json({ error: 'unknown_source' });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});
