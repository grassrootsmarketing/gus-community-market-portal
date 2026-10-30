// tools/rehearse-0116-0117-paste.mjs (2026-10-30, Codex connected-checkout review, bounded condition): rehearses the
// PRODUCTION-SHAPED guarded upgrade on the disposable database chain_parity_check inside demohub-rebuild-check:
//   1. the committed chain is built from empty up to 0115 (production's tail) and the deployment identity is set to
//      'production', so the kits see exactly what demohub-prod will show them;
//   2. the production 0117 kit is refused (0116 missing), the production 0116 kit applies, a second 0116 is refused,
//      the production 0117 kit applies, a second 0117 is refused; every verify row is printed;
//   3. the catalog after the two pastes is snapshotted for the parity diff.
// Refuses any database other than chain_parity_check on demohub-rebuild-check. Nothing here touches public or production.
// Usage: node tools/rehearse-0116-0117-paste.mjs <chain_parity_check url> <0116 production kit> <0117 production kit>
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const [url, kit116Path, kit117Path] = process.argv.slice(2);
if (!url || !/tileejdviuvijumjeplv/.test(url) || !/\/chain_parity_check(\?|$)/.test(url)) { console.error('REFUSING: not chain_parity_check on demohub-rebuild-check'); process.exit(2); }
let pass = 0, fail = 0;
const ok = (n, c, extra = '') => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n + (extra ? ' ' + extra : '')); } };
console.log('1. clean chain up to 0115 into chain_parity_check');
const b = spawnSync(process.execPath, ['tools/clean-chain-build.mjs', 'build', url, '0115'], { encoding: 'utf8' });
console.log(b.stdout.trim().split('\n').slice(-2).join(' | '));
ok('chain 0000..0115 built from empty', b.status === 0, b.stderr.slice(-300));
const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } }); await c.connect();
await c.query("select public.set_deployment_identity('production', 'tileejdviuvijumjeplv', 'paste rehearsal on the disposable database; the ref is the test project, the environment word is what the kits check')");
const id = (await c.query('select environment from get_deployment_identity()')).rows[0];
ok("identity reads 'production' for the rehearsal", id && id.environment === 'production', JSON.stringify(id));
const kit116 = readFileSync(kit116Path, 'utf8').replace(/\r\n/g, '\n'), kit117 = readFileSync(kit117Path, 'utf8').replace(/\r\n/g, '\n');
const splitKit = (k) => { const i = k.indexOf('-- ======================= verify (read-only)'); return { paste: k.slice(0, i), verify: k.slice(i) }; };
const attempt = async (sql) => { try { const r = await c.query(sql); return { ok: true, r }; } catch (e) { try { await c.query('ROLLBACK'); } catch (_) {} return { ok: false, err: String(e.message || e) }; } };
const ledger = async () => (await c.query("select string_agg(version, ',' order by version) v from supabase_migrations.schema_migrations where version >= '0115'")).rows[0].v;
console.log('2. the kits, in order, with their guards');
const k116 = splitKit(kit116), k117 = splitKit(kit117);
const early = await attempt(k117.paste);
ok('0117 before 0116 is refused by its guard (0116 not in the ledger)', !early.ok && /0116 is not in the ledger/.test(early.err), early.err || 'no error');
const a116 = await attempt(k116.paste);
ok('the production 0116 kit applies on the production-shaped database', a116.ok, a116.err || '');
const v116 = a116.ok ? (await c.query(k116.verify)).rows[0] : null;
console.log('   0116 verify row:', JSON.stringify(v116));
ok('0116 verify: recorded, pilot gate gone, routing check and keeps-all refusal present', v116 && v116.result === 'OK 0116 RECORDED' && String(v116.claim_pilot_gate_expect_0) === '0' && v116.apply_routing_check_expect_true === true && v116.apply_keeps_all_refusal_expect_true === true, JSON.stringify(v116));
const again116 = await attempt(k116.paste);
ok('a second 0116 paste is refused (already in the ledger)', !again116.ok && /already in the ledger/.test(again116.err), again116.err || 'no error');
const a117 = await attempt(k117.paste);
ok('the production 0117 kit applies after 0116', a117.ok, a117.err || '');
const v117 = a117.ok ? (await c.query(k117.verify)).rows[0] : null;
console.log('   0117 verify row:', JSON.stringify(v117));
ok('0117 verify: recorded, four settlement columns, four queue functions, six-argument record_settlement_leg, fee id check present', v117 && v117.result === 'OK 0117 RECORDED' && String(v117.settlement_columns_expect_4) === '4' && String(v117.queue_functions_expect_4) === '4' && /p_amount integer, p_currency text$/.test(String(v117.record_settlement_leg_expect_six_arguments)) && v117.apply_fee_id_check_expect_true === true, JSON.stringify(v117));
const again117 = await attempt(k117.paste);
ok('a second 0117 paste is refused (already in the ledger)', !again117.ok && /already in the ledger/.test(again117.err), again117.err || 'no error');
ok('ledger from 0115 reads 0115,0116,0117', (await ledger()) === '0115,0116,0117', await ledger());
await c.end();
console.log(`\npaste rehearsal: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
