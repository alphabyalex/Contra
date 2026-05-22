import * as path from 'path';
import { config as loadDotenv } from 'dotenv';
loadDotenv({ path: path.resolve(__dirname, '..', '..', '.env'), override: true });
import { getSupabase } from './db/supabase';

async function main() {
  const sb = getSupabase();
  if (!sb) { console.error('Supabase not configured'); process.exit(1); }

  // FIX 2 — recategorize Nobel Prize markets sports → other.
  const nobel = await sb.from('scored_markets').update({ category: 'other' })
    .ilike('question', '%nobel%prize%').eq('category', 'sports').select('condition_id');
  if (nobel.error) console.error('nobel update error:', nobel.error.message);
  console.log(`Nobel recategorized (sports→other): ${nobel.data?.length ?? 0}`);

  // FIX 4 — remove recently auto-discovered markets with volume < $50k.
  const lowVol = await sb.from('scored_markets').delete()
    .eq('model_version', 'auto_discovery').lt('volume', 50_000).select('condition_id');
  if (lowVol.error) console.error('lowvol delete error:', lowVol.error.message);
  console.log(`Low-volume (<$50k) auto-discovered removed: ${lowVol.data?.length ?? 0}`);
}
main().then(() => process.exit(0)).catch((e) => { console.error('ERROR:', e.message ?? e); process.exit(1); });
