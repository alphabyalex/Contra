import * as path from 'path';
import { config as loadDotenv } from 'dotenv';
loadDotenv({ path: path.resolve(__dirname, '..', '..', '.env'), override: true });

const BASE = 'http://localhost:3001';
const WALLET = '4pRZrqvf3qKbLi6emrg24boEa8tr6gL63fieins9iBDt';
const CTRA11 = '75612c1c-d0cb-47a1-b8a4-73f74ca044ef';
const CTRA02 = '9e7f5fa3-3e44-4b18-a35a-997339dff1e7';
const LEV_POS = '85076011-868a-4100-b079-fad3f161c616';
const ADMIN = process.env.ADMIN_TOKEN ?? '';

async function get(p: string, headers: Record<string, string> = {}) {
  const r = await fetch(`${BASE}${p}`, { headers });
  return { status: r.status, j: await r.json().catch(() => null) as any };
}
async function post(p: string, body: any) {
  const r = await fetch(`${BASE}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, j: await r.json().catch(() => null) as any };
}
function deserOk(b64?: string) { try { if (!b64) return false; Buffer.from(b64, 'base64'); return b64.length > 50; } catch { return false; } }

const results: Array<{ j: string; status: string; notes: string }> = [];
function rec(j: string, pass: boolean, notes: string) { results.push({ j, status: pass ? 'PASS' : 'FAIL', notes }); }

async function main() {
  // J1 — portfolio
  try {
    const { j } = await get(`/api/portfolio/${WALLET}`);
    const bp = j.basket_positions ?? [];
    const allPos = bp.every((p: any) => Number(p.token_amount ?? p.tokens_held) > 0);
    const fields = bp.every((p: any) => 'current_nav' in p && 'current_value_usdc' in p && 'pnl_usdc' in p);
    const noPending = (j.recent_transactions ?? []).every((t: any) => !(t.tx_signature ?? '').startsWith('pending-'));
    rec('1 portfolio', allPos && (bp.length === 0 || fields) && noPending,
      `basket_positions=${bp.length} (all>0:${allPos}, fields:${fields}), leveraged=${(j.leveraged_positions ?? []).length}, txs=${(j.recent_transactions ?? []).length} noPending:${noPending}`);
  } catch (e) { rec('1 portfolio', false, String(e)); }

  // J2 — scanner default
  try {
    const { j } = await get(`/api/scanner/markets`);
    const rows = j.rows ?? [];
    const fair = rows.filter((r: any) => r.p_market >= 0.2 && r.p_market <= 0.89);
    const resolved = rows.filter((r: any) => r.resolved_likely);
    const nearClosed = rows.filter((r: any) => r.days_to_close != null && r.days_to_close < 3);
    const z3 = rows.filter((r: any) => r.zone === 3);
    // The blown-up SpaceX IPO sits at ~98.5%; a legit "SpaceX not IPO 2027"
    // longshot at 2.4% is fine. Only flag a HIGH-priced SpaceX leaking in.
    const spacex = rows.find((r: any) => /spacex/i.test(r.question) && r.p_market > 0.5);
    const korea = rows.find((r: any) => /seoul|gyeonggi|incheon|korea/i.test(r.question) && r.p_market > 0.5);
    const pass = fair.length === 0 && resolved.length === 0 && nearClosed.length === 0 && !spacex && !korea;
    rec('2 scanner default', pass,
      `rows=${rows.length} fair(20-89%)=${fair.length} resolved=${resolved.length} <3d=${nearClosed.length} zone3=${z3.length} spacex=${!!spacex} koreaHigh=${!!korea}`);
  } catch (e) { rec('2 scanner default', false, String(e)); }

  // J3 — baskets
  try {
    const list = await get(`/api/baskets`);
    const names = (list.j.baskets ?? []).map((b: any) => b.name);
    const has = ['CTRA-01', 'CTRA-1.1', 'CTRA-02'].every((n) => names.includes(n));
    const navs = (list.j.baskets ?? []).every((b: any) => typeof b.nav === 'number' || typeof b.current_nav === 'number');
    const detail = await get(`/api/baskets/${CTRA11}`);
    const detailOk = detail.j.basket && Array.isArray(detail.j.legs) && detail.j.legs.length > 0;
    const navHist = await get(`/api/baskets/${CTRA11}/nav`);
    const navOk = Array.isArray(navHist.j.history);
    rec('3 baskets', has && navs && detailOk && navOk,
      `names=${names.join('/')} navs:${navs} detailLegs=${detail.j.legs?.length} navHist=${navHist.j.history?.length}`);
  } catch (e) { rec('3 baskets', false, String(e)); }

  // J4 — deposit prepare 1x
  try {
    const { j } = await post(`/api/deposit/prepare`, { walletAddress: WALLET, basketId: CTRA11, amountUsdc: 10, leverage: 1 });
    const b64 = j.transaction_b64 ?? j.transactionBase64;
    const feeOk = Math.abs((j.fee ?? -1) - 0.05) < 1e-6 && Math.abs((j.net ?? -1) - 9.95) < 1e-6;
    rec('4 deposit prepare 1x', deserOk(b64) && feeOk, `tx:${deserOk(b64)} fee=${j.fee} net=${j.net}`);
  } catch (e) { rec('4 deposit prepare 1x', false, String(e)); }

  // J5 — leverage deposit prepare 2x
  try {
    const { j } = await post(`/api/deposit/prepare`, { walletAddress: WALLET, basketId: CTRA11, amountUsdc: 5, leverage: 2 });
    const ok = j.collateral === 5 && Math.abs(j.borrowed - 5) < 1e-6 && Math.abs(j.total_exposure - 10) < 1e-6 && j.liquidation_nav > 0 && j.daily_interest > 0;
    rec('5 leverage prepare 2x', ok, `collateral=${j.collateral} borrowed=${j.borrowed} exposure=${j.total_exposure} liq=${j.liquidation_nav?.toFixed?.(4)} daily=${j.daily_interest?.toFixed?.(6)}`);
  } catch (e) { rec('5 leverage prepare 2x', false, String(e)); }

  // J6 — redeem prepare (wallet has no CTRA-02 → expect insufficient_balance)
  try {
    const { status, j } = await post(`/api/redeem/prepare`, { walletAddress: WALLET, basketId: CTRA02, tokenAmount: 5 });
    if (status === 200) {
      const ok = deserOk(j.transaction_b64) && j.gross_usdc > 0 && Math.abs(j.fee - j.gross_usdc * 0.005) < 1e-4 && Math.abs(j.net_usdc - (j.gross_usdc - j.fee)) < 1e-4;
      rec('6 redeem prepare', ok, `tx:${deserOk(j.transaction_b64)} gross=${j.gross_usdc?.toFixed?.(4)} fee=${j.fee?.toFixed?.(6)} net=${j.net_usdc?.toFixed?.(4)}`);
    } else {
      rec('6 redeem prepare', j.error === 'insufficient_balance', `wallet holds 0 CTRA-02 → ${status} ${j.error} (API behaves correctly)`);
    }
  } catch (e) { rec('6 redeem prepare', false, String(e)); }

  // J7 — leverage detail
  try {
    const { status, j } = await get(`/api/leverage/${LEV_POS}`);
    const p = j.position;
    const ok = !!p && typeof p.health_pct === 'number' && typeof p.liquidation_nav === 'number' && p.interest_accrued >= 0;
    rec('7 leverage detail', ok, status === 404 ? 'position not found' : `health=${p?.health_pct?.toFixed?.(1)}% liq=${p?.liquidation_nav?.toFixed?.(4)} interest=${p?.interest_accrued?.toFixed?.(6)}`);
  } catch (e) { rec('7 leverage detail', false, String(e)); }

  // J8 — scanner search world cup
  try {
    const { j } = await get(`/api/scanner/markets?search=world+cup`);
    const rows = j.rows ?? [];
    const france = rows.find((r: any) => /france/i.test(r.question));
    const portugal = rows.find((r: any) => /portugal/i.test(r.question));
    const ok = !!france && france.zone === 2 && !!portugal && (portugal.zone === 1 || portugal.zone === 2);
    rec('8 scanner search', ok, `rows=${rows.length} france=${france ? 'z' + france.zone + ' ' + (france.normalized_p_market ?? france.p_market).toFixed(3) : 'none'} portugal=${portugal ? 'z' + portugal.zone : 'none'}`);
  } catch (e) { rec('8 scanner search', false, String(e)); }

  // J9 — admin baskets
  try {
    const { status, j } = await get(`/api/admin/baskets`, ADMIN ? { 'x-admin-token': ADMIN } : {});
    const ok = status === 200 && Array.isArray(j.baskets) && j.baskets.every((b: any) => 'legs_count' in b && 'current_nav' in b);
    rec('9 admin baskets', ok, `status=${status} baskets=${j?.baskets?.length}`);
  } catch (e) { rec('9 admin baskets', false, String(e)); }

  // Summary
  console.log('\n========== JOURNEY SUMMARY ==========');
  console.log('Journey'.padEnd(22), 'Status', ' Notes');
  for (const r of results) console.log(r.j.padEnd(22), r.status.padEnd(6), r.notes);
  const pass = results.filter((r) => r.status === 'PASS').length;
  console.log(`\n${pass}/${results.length} PASSED`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
