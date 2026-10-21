// tools/rehearse-0093-paste.mjs (2026-10-21, Codex COI work order): rehearses the 0093 paste on the TEST project
// (demohub-rebuild-check) inside ONE outer transaction that is rolled back at the end, so the test database is left
// exactly as found. The test project already carries 0093, so the rehearsal first simulates the production shape
// inside that transaction:
//   0. outer BEGIN; put the 0074 constraint back (without the kind), delete the ledger row 0093, assert no row of the kind
//   1. wrong target: the guard body with identity 'production' is run -> it must refuse (this database is not production)
//   2. SAVEPOINT; the paste body with the ledger INSERT replaced by a forced failure -> error -> ROLLBACK TO SAVEPOINT;
//      prove: the 0074 shape is still in place and 0093 is still absent (nothing partially installed)
//   3. SAVEPOINT; the paste body unmodified -> prove the verify row: constraint admits the kind, decision kinds kept,
//      recipient owner kept, ledger holds 0093 once
//   4. run it again -> the guard refuses (0093 in the ledger) and nothing changes
//   5. outer ROLLBACK; prove the live constraint and ledger are as they were
// Usage (SB_DB_URL = the test project's pooler URL): node tools/rehearse-0093-paste.mjs <paste generated with the test identity>
import pg from 'pg';
import { readFileSync } from 'node:fs';
const url = process.env.SB_DB_URL || '';
if (!/tileejdviuvijumjeplv/.test(url)) { console.error('REFUSING: not demohub-rebuild-check'); process.exit(2); }
const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await c.connect();
const id = (await c.query('select environment from get_deployment_identity()')).rows[0].environment;
if (id === 'production') { console.error('REFUSING: production'); process.exit(2); }
const paste = readFileSync(process.argv[2], 'utf8');
const bodyStart = paste.indexOf('DO $cutover_guard$'), bodyEnd = paste.indexOf('COMMIT;', paste.indexOf("VALUES ('0093', 'coi_expiry_owner_pings');"));
if (bodyStart < 0 || bodyEnd < 0) throw new Error('paste anchors');
const body = paste.slice(bodyStart, bodyEnd);
const verifySql = paste.slice(paste.indexOf("SELECT 'OK 0093 RECORDED'"));
const guardOnly = body.slice(0, body.indexOf('$cutover_guard$;') + '$cutover_guard$;'.length);
let pass = 0, fail = 0;
const ok = (n, cond, extra = '') => { if (cond) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n + (extra ? ' ' + extra : '')); } };
const def = async () => (await c.query(`select pg_get_constraintdef(oid) d from pg_constraint where conname='notification_deliveries_retailer_for_demo' and conrelid='public.notification_deliveries'::regclass`)).rows[0]?.d || null;
const ledger = async () => (await c.query(`select count(*)::int n from supabase_migrations.schema_migrations where version='0093'`)).rows[0].n;
const kindRows = async () => (await c.query(`select count(*)::int n from public.notification_deliveries where kind='coi_expiry_owner'`)).rows[0].n;
const attempt = async (sql) => { try { await c.query(sql); return null; } catch (e) { return String(e.message || e); } };

const liveDef = await def(), liveLedger = await ledger();
console.log('live before:', { constraint: liveDef, ledger_0093: liveLedger });
await c.query('BEGIN');
try {
  // 0. production shape
  await c.query(`ALTER TABLE public.notification_deliveries DROP CONSTRAINT IF EXISTS notification_deliveries_retailer_for_demo`);
  await c.query(`ALTER TABLE public.notification_deliveries ADD CONSTRAINT notification_deliveries_retailer_for_demo CHECK (retailer_id IS NOT NULL OR kind IN ('coi_approved','coi_rejected'))`);
  await c.query(`DELETE FROM supabase_migrations.schema_migrations WHERE version = '0093'`);
  const n0 = await kindRows();
  ok('0. production shape simulated: 0074 constraint, 0093 absent, zero rows of the kind', !/coi_expiry_owner/.test(await def()) && (await ledger()) === 0 && n0 === 0, String(n0));

  // 1. wrong target
  await c.query('SAVEPOINT s1');
  const e1 = await attempt(guardOnly.replace(/IS DISTINCT FROM '[a-z-]+'/, "IS DISTINCT FROM 'production'").replace(/not [a-z-]+\. STOP/, 'not production. STOP'));
  await c.query('ROLLBACK TO SAVEPOINT s1');
  ok('1. the guard with identity production refuses on this database', !!e1 && /CUTOVER GUARD: this database identifies as/.test(e1), e1 || 'no error');

  // 2. forced failure after the body, before the ledger row
  await c.query('SAVEPOINT s2');
  const broken = body.replace("INSERT INTO supabase_migrations.schema_migrations (version, name) VALUES ('0093', 'coi_expiry_owner_pings');", "SELECT 1/0;");
  const e2 = await attempt(broken);
  await c.query('ROLLBACK TO SAVEPOINT s2');
  ok('2. a failure inside the paste leaves nothing behind: 0074 shape, 0093 absent', !!e2 && /division by zero/.test(e2) && !/coi_expiry_owner/.test(await def()) && (await ledger()) === 0, e2 || 'no error');

  // 3. the paste
  await c.query('SAVEPOINT s3');
  const e3 = await attempt(body);
  ok('3a. the paste body runs clean', e3 === null, e3 || '');
  const v = (await c.query(verifySql)).rows[0];
  ok('3b. verify row: OK 0093 RECORDED, constraint admits the kind, decision kinds kept, recipient owner kept, ledger 0093 once, zero rows', v && v.result === 'OK 0093 RECORDED' && v.rows_0093_expect_1 === '1' && v.deliveries_check_admits_kind_expect_true === true && v.decision_kinds_kept_expect_true === true && v.recipient_owner_kept_expect_true === true && v.coi_expiry_rows_expect_0_until_enabled === '0', JSON.stringify(v));
  // Each probe insert runs under its own savepoint: a refused statement aborts the enclosing transaction otherwise.
  await c.query('SAVEPOINT s3c');
  const ins = await attempt(`INSERT INTO public.notification_deliveries (event_id, retailer_id, booking_id, recipient_kind, recipient_id, recipient_email, kind, offset_key, occurrence_key, dedupe_key, attempts, due_at, expires_at, status, skip_reason) VALUES (NULL, NULL, NULL, 'owner', NULL, 'rehearsal@fixture.test', 'coi_expiry_owner', 'd30', 'rehearsal:2099-01-01', 'coi_expiry_owner:rehearsal:2099-01-01:d30', 0, now(), now(), 'skipped', 'rehearsal')`);
  await c.query('ROLLBACK TO SAVEPOINT s3c');
  ok('3c. after the paste a brand-scoped row of the kind (NULL retailer) is admitted', ins === null, ins || '');
  await c.query('SAVEPOINT s3d');
  const insOther = await attempt(`INSERT INTO public.notification_deliveries (event_id, retailer_id, booking_id, recipient_kind, recipient_id, recipient_email, kind, offset_key, occurrence_key, dedupe_key, attempts, due_at, expires_at, status, skip_reason) VALUES (NULL, NULL, NULL, 'owner', NULL, 'rehearsal@fixture.test', 'reminder', 'd30', 'rehearsal:x', 'reminder:rehearsal:x', 0, now(), now(), 'skipped', 'rehearsal')`);
  await c.query('ROLLBACK TO SAVEPOINT s3d');
  ok('3d. a NULL-retailer row of any other demo kind is still refused by the constraint', !!insOther && /notification_deliveries_retailer_for_demo/.test(insOther), insOther || 'accepted');

  // 4. again
  await c.query('SAVEPOINT s4');
  const e4 = await attempt(body);
  await c.query('ROLLBACK TO SAVEPOINT s4');
  ok('4. a second run refuses at the guard (0093 in the ledger) and the ledger still holds it once', !!e4 && /0093 is already in the ledger/.test(e4) && (await ledger()) === 1 && /coi_expiry_owner/.test(await def()), e4 || 'no error');
} finally {
  await c.query('ROLLBACK');
}
const afterDef = await def(), afterLedger = await ledger();
ok('5. outer rollback: the live constraint and ledger are exactly as before', afterDef === liveDef && afterLedger === liveLedger, JSON.stringify({ afterDef, afterLedger }));
await c.end();
console.log(`\n0093 paste rehearsal (demohub-rebuild-check, rolled back): ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
