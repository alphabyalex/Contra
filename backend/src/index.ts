/**
 * CONTRA backend entrypoint.
 *
 * - Loads .env, mounts routes, starts cron (gated by START_CRON=true).
 * - Health endpoint reports Supabase + IDL availability so the frontend
 *   can render a clear "deploy not done yet" banner instead of a 500.
 * - Degrades gracefully: missing Supabase → in-memory store; missing
 *   AUTHORITY_KEYPAIR → admin/deposit-build routes 5xx with clear error
 *   but list/scanner/portfolio routes keep working.
 */

import * as path from 'path';
import { config as loadDotenv } from 'dotenv';
// Load .env from the repo root (one dir above backend/) so `npm run dev`
// from backend/ picks up the same secrets as scripts that cd into backend/.
loadDotenv({ path: path.resolve(__dirname, '..', '..', '.env') });

import express from 'express';
import cors from 'cors';

import { isSupabaseEnabled, pingSupabase } from './db/supabase';
import { loadArtifacts } from './services/mispricing';
import { startCron } from './services/cron';
import { idlsAvailable, hasAuthority } from './solana/client';

import { basketsRouter } from './routes/baskets';
import { depositRouter } from './routes/deposit';
import { marketsRouter } from './routes/markets';
import { scannerRouter } from './routes/scanner';
import { leverageRouter } from './routes/leverage';
import { portfolioRouter } from './routes/portfolio';
import { adminRouter } from './routes/admin';

const PORT = Number(process.env.PORT ?? 3001);
const FRONTEND_URL = process.env.FRONTEND_URL ?? 'http://localhost:3000';

const app = express();

app.use(cors({ origin: [FRONTEND_URL, 'http://localhost:3000'], credentials: true }));
app.use(express.json({ limit: '1mb' }));
app.use((req, _res, next) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.url}`);
  next();
});

app.get('/health', async (_req, res) => {
  const supabase = isSupabaseEnabled();
  let supabaseLive = false;
  if (supabase) {
    try {
      supabaseLive = await pingSupabase();
    } catch {
      supabaseLive = false;
    }
  }
  res.json({
    ok: true,
    version: '0.1.0',
    supabase: { configured: supabase, live: supabaseLive },
    idls: idlsAvailable(),
    authority: hasAuthority(),
    started_at: new Date().toISOString(),
  });
});

app.use('/api/baskets', basketsRouter);
app.use('/api/deposit', depositRouter);
app.use('/api/markets', marketsRouter);
app.use('/api/scanner', scannerRouter);
app.use('/api/leverage', leverageRouter);
app.use('/api/portfolio', portfolioRouter);
app.use('/api/admin', adminRouter);

app.use((_req, res) => res.status(404).json({ error: 'not_found' }));
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('[error]', err);
  res.status(500).json({ error: err.message ?? 'internal_error' });
});

loadArtifacts();

app.listen(PORT, () => {
  console.log(`╔══════════════════════════════════════════╗`);
  console.log(`║  CONTRA backend on http://localhost:${PORT}  ║`);
  console.log(`╚══════════════════════════════════════════╝`);
  console.log(`Supabase: ${isSupabaseEnabled() ? 'configured' : 'in-memory fallback'}`);
  console.log(`Authority: ${hasAuthority() ? 'loaded' : 'NOT loaded — admin/deposit routes will 5xx'}`);
  console.log(`IDLs: ${JSON.stringify(idlsAvailable())}`);
  startCron();
});
