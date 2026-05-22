import * as path from 'path';
import { config as loadDotenv } from 'dotenv';
loadDotenv({ path: path.resolve(__dirname, '..', '..', '.env'), override: true });
import { insertLeveragedPosition, listLeveragedByWallet } from './db/queries';
import { getAuthorityKeypair } from './solana/client';
import { derivePosition } from './solana/pda';

const BASKET_ID = '75612c1c-d0cb-47a1-b8a4-73f74ca044ef';

async function main() {
  const wallet = getAuthorityKeypair().publicKey.toBase58();
  const existing = (await listLeveragedByWallet(wallet)).filter((p) => p.basket_id === BASKET_ID && !p.closed_at);
  if (existing.length > 0) { console.log('already recorded:', existing.length); return; }
  const [pos] = derivePosition(BASKET_ID, getAuthorityKeypair().publicKey);
  const row = await insertLeveragedPosition({
    basket_id: BASKET_ID, wallet, position_pda: pos.toBase58(),
    collateral_usdc: 2, debt_usdc: 2, vault_tokens: 3.98, leverage: 2,
    health_factor: 2.0, liquidated: false,
  });
  console.log('recorded leveraged position', row.id, 'for', wallet);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
