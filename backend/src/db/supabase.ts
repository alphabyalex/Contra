/**
 * Supabase client factory.
 *
 * The backend treats Supabase as optional — if SUPABASE_URL or
 * SUPABASE_SERVICE_KEY is missing, getSupabase() returns null and the
 * caller is expected to fall back to the in-memory store in queries.ts.
 * This keeps `npm run dev` working with zero external dependencies.
 *
 * Always use the SERVICE key on the server. The anon key cannot write
 * with the row-level security policies we will add later.
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';

let cached: SupabaseClient | null = null;
let resolved = false;
let warned = false;

export function getSupabase(): SupabaseClient | null {
  if (resolved) return cached;
  resolved = true;

  const url = process.env.SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_KEY?.trim();

  if (!url || !key) {
    if (!warned) {
      console.warn(
        '[supabase] SUPABASE_URL or SUPABASE_SERVICE_KEY missing — using in-memory store. ' +
          'Set both in .env to persist data.',
      );
      warned = true;
    }
    cached = null;
    return null;
  }

  cached = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    db: { schema: 'public' },
  });
  return cached;
}

export function isSupabaseEnabled(): boolean {
  return Boolean(
    process.env.SUPABASE_URL?.trim() && process.env.SUPABASE_SERVICE_KEY?.trim(),
  );
}

/**
 * Lightweight liveness check. Returns true iff a trivial query against
 * the `baskets` table succeeds. Useful for /health endpoints.
 */
export async function pingSupabase(): Promise<boolean> {
  const client = getSupabase();
  if (!client) return false;
  const { error } = await client.from('baskets').select('id', { head: true, count: 'exact' }).limit(1);
  return !error;
}
