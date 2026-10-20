// tools/rehearse-0104-0108-paste.mjs (2026-10-19, Codex R2-4; 0107 for rev3, 0108 for rev4): rehearses the 0104+0105+0106+0107+0108 paste on the TEST project
// (demohub-rebuild-check) inside ONE outer transaction that is rolled back at the end, so the test database is left
// exactly as found. The test project already carries the cutoff objects, so the rehearsal first simulates the
// production shape (pre-0104) inside that transaction:
//   0. outer BEGIN; drop the 0104/0105/0106 objects, put back the 0078 booking_transition and the 0095 move functions
//      (verbatim from the shipped kits), restore the pre-0104 column default ('14_day_refund'), give one retailer the
//      legacy mode and one non-refundable retailer an empty sentence, delete the ledger rows
//   1. wrong target: the guard body with identity 'production' is run -> it must refuse (this database is 'staging')
//   2. SAVEPOINT; the paste body with the ledger INSERT replaced by a forced failure -> error -> ROLLBACK TO SAVEPOINT;
//      prove: no cutoff tables / column / functions, the old default, no ledger rows (nothing partially installed)
//   3. SAVEPOINT; the paste body unmodified -> prove the verify row: tables, column, functions and arities, barriers in
//      the function bodies, privileges (service_role yes; anon/authenticated no), default 'refundable', the legacy
//      retailer backfilled and backed up, the blank non-refundable sentence filled, ledger 0104..0106, previous default
//      recorded in the backup table's comment
//   4. run it again -> the guard refuses (objects exist) and nothing changes
//   5. outer ROLLBACK; prove the live objects are as they were
// Usage (SB_DB_URL = the test project's pooler URL): node tools/rehearse-0104-0106-paste.mjs <paste generated with identity staging>
import pg from 'pg';
import { readFileSync } from 'node:fs';
const url = process.env.SB_DB_URL || '';
if (!/tileejdviuvijumjeplv/.test(url)) { console.error('REFUSING: not demohub-rebuild-check'); process.exit(2); }
const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await c.connect();
const id = (await c.query('select environment from get_deployment_identity()')).rows[0].environment;
if (id === 'production') { console.error('REFUSING: production'); process.exit(2); }
const paste = readFileSync(process.argv[2], 'utf8');
const bodyStart = paste.indexOf('DO $cutover_guard$'), bodyEnd = paste.indexOf('COMMIT;', paste.indexOf("VALUES ('0108', 'cancellation_resolution_recovery');"));
if (bodyStart < 0 || bodyEnd < 0) throw new Error('paste anchors');
let body = paste.slice(bodyStart, bodyEnd);
const cutMod = await import('file:///C:/Users/David/demohub-refund-72h/api/_refund-cutoff.js');
const lit = (x) => "'" + x.replace(/'/g, "''") + "'";
const sentenceLiterals = lit(cutMod.REFUNDABLE_CANCELLATION_POLICY) + ', ' + lit(cutMod.NON_REFUNDABLE_CANCELLATION_POLICY);
const verifyStart = paste.indexOf("SELECT 'OK 0104+0105+0106+0107+0108 RECORDED'");
const verifySql = paste.slice(verifyStart);
const guardOnly = body.slice(0, body.indexOf('$cutover_guard$;') + '$cutover_guard$;'.length);
const kit95 = readFileSync('C:/Users/David/demohub-refund-72h/tools/sources/0095_move_functions_as_shipped.sql', 'utf8').split('\n');
const slice = (a, b) => kit95.slice(a - 1, b).join('\n');
const bt78 = readFileSync('C:/Users/David/demohub-refund-72h/tools/sources/booking_transition_0078.sql', 'utf8');
let pass = 0, fail = 0;
const ok = (n, cond, extra = '') => { if (cond) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n + (extra ? ' ' + extra : '')); } };
const state = async () => {
  const q = async (sql) => (await c.query(sql)).rows[0];
  return {
    tables: Number((await q("select count(*)::int n from information_schema.tables where table_schema='public' and table_name in ('booking_cancellations','booking_cancellation_resolutions','retailers_cancellation_policy_backup_0104')")).n),
    column: Number((await q("select count(*)::int n from information_schema.columns where table_name='bookings' and column_name='cancellation_pending_at'")).n),
    fns: Number((await q("select count(*)::int n from pg_proc p join pg_namespace s on s.oid=p.pronamespace where s.nspname='public' and p.proname in ('booking_cancellation_record','booking_cancellation_claim','booking_cancellation_progress','cancellation_reviews_outstanding','cancellation_resolutions_unfinished','cancellation_abandoned_outstanding','cancellation_abandoned_close')")).n),
    record4: (await q("select to_regprocedure('public.booking_cancellation_record(uuid, uuid, jsonb, jsonb)') is not null as v")).v,
    record3: (await q("select to_regprocedure('public.booking_cancellation_record(uuid, uuid, jsonb)') is not null as v")).v,
    ledger: (await q("select string_agg(version, ',' order by version) as v from supabase_migrations.schema_migrations where version in ('0104','0105','0106','0107','0108')")).v,
    def: (await q("select pg_get_expr(d.adbin, d.adrelid) as v from pg_attrdef d join pg_attribute a on a.attrelid=d.adrelid and a.attnum=d.adnum where d.adrelid='public.retailers'::regclass and a.attname='cancellation_mode'")).v,
    transitionBarrier: (await q("select position('cancellation_pending' in pg_get_functiondef('public.booking_transition(uuid, uuid, text, jsonb, numeric)'::regprocedure)) > 0 as v")).v,
    moveBarrier: (await q("select position('cancellation_pending_at' in pg_get_functiondef('public.move_booking_by_retailer(uuid, uuid, date, text, text, text, integer)'::regprocedure)) > 0 as v")).v,
  };
};
const live0 = await state();
console.log('live before', JSON.stringify(live0));
try {
  await c.query('BEGIN');
  // 0. the production shape, pre-0104
  await c.query('DROP FUNCTION IF EXISTS public.booking_cancellation_record(uuid, uuid, jsonb, jsonb); DROP FUNCTION IF EXISTS public.booking_cancellation_record(uuid, uuid, jsonb); DROP FUNCTION IF EXISTS public.booking_cancellation_resolve(uuid, uuid, text, text, text, uuid, uuid); DROP FUNCTION IF EXISTS public.booking_cancellation_claim(uuid, uuid, text, text, text); DROP FUNCTION IF EXISTS public.booking_cancellation_progress(uuid, uuid, text, uuid, text); DROP FUNCTION IF EXISTS public.cancellation_reviews_outstanding(integer); DROP FUNCTION IF EXISTS public.cancellation_resolutions_unfinished(integer, integer); DROP FUNCTION IF EXISTS public.booking_cancellation_progress(uuid, uuid, text, uuid, text, uuid); DROP FUNCTION IF EXISTS public.cancellation_abandoned_outstanding(integer, integer); DROP FUNCTION IF EXISTS public.cancellation_abandoned_close(integer);');
  await c.query('DROP TABLE IF EXISTS public.booking_cancellation_resolutions; DROP TABLE IF EXISTS public.booking_cancellations; DROP TABLE IF EXISTS public.retailers_cancellation_policy_backup_0104;');
  await c.query('ALTER TABLE public.bookings DROP COLUMN IF EXISTS cancellation_pending_at; ALTER TABLE public.bookings DROP COLUMN IF EXISTS abandoned_sweep_checked_at;');
  await c.query("ALTER TABLE public.notification_events DROP CONSTRAINT IF EXISTS notification_events_kind_check; ALTER TABLE public.notification_events ADD CONSTRAINT notification_events_kind_check CHECK (kind IN ('demo_confirmed','demo_cancelled','demo_rescheduled','coi_approved','coi_rejected','owner_booking_created','payment_receipt','demo_moved','demo_move_cancelled'));");
  await c.query("ALTER TABLE public.retailers ALTER COLUMN cancellation_mode SET DEFAULT '14_day_refund';");
  await c.query(bt78);
  await c.query(slice(2, 131)); await c.query(slice(133, 180)); await c.query(slice(182, 277));
  await c.query("DELETE FROM supabase_migrations.schema_migrations WHERE version IN ('0104','0105','0106','0107','0108');");
  const legacy = (await c.query("select id from retailers order by created_at limit 1")).rows[0];
  await c.query("update retailers set cancellation_mode = '14_day_refund', cancellation_policy = null where id = $1", [legacy.id]);
  const nonref = (await c.query("select id from retailers where id <> $1 order by created_at limit 1", [legacy.id])).rows[0];
  if (nonref) await c.query("update retailers set cancellation_mode = 'non_refundable', cancellation_policy = '' where id = $1", [nonref.id]);
  const pre = await state();
  // the guard's reviewed custom-sentence count is measured AFTER the simulation (the two seeded rows changed it): the
  // generated kit carries the live count; the rehearsal body carries the simulated one, the check itself is unchanged
  const customNow = Number((await c.query("select count(*)::int n from retailers where coalesce(btrim(cancellation_policy), '') <> '' and cancellation_policy not in (" + sentenceLiterals + ")")).rows[0].n);
  { const k = /reviewed count (\d+)\)/.exec(body); if (!k) throw new Error('guard count'); body = body.split('IF n <> ' + k[1] + ' THEN').join('IF n <> ' + customNow + ' THEN').split('reviewed count ' + k[1] + ')').join('reviewed count ' + customNow + ')'); }
  console.log('  note custom sentences after the simulation: ' + customNow);
  ok('0. pre-0104 shape simulated: no tables, no column, no functions, old default, no ledger rows, no barriers', pre.tables === 0 && pre.column === 0 && pre.fns === 0 && pre.ledger == null && /14_day_refund/.test(pre.def || '') && !pre.transitionBarrier && !pre.moveBarrier, JSON.stringify(pre));

  // 1. wrong target
  await c.query('SAVEPOINT s1');
  let refused = null;
  try { await c.query(guardOnly.replace(/IS DISTINCT FROM 'staging'/g, "IS DISTINCT FROM 'production'").replace(/not staging/g, 'not production')); } catch (e) { refused = e.message; }
  await c.query('ROLLBACK TO SAVEPOINT s1');
  ok('1. wrong target: the guard refuses before any write (identity)', /CUTOVER GUARD: this database identifies as/.test(refused || ''), refused);

  // 2. forced failure after the bodies: nothing partially installed
  await c.query('SAVEPOINT s2');
  let err2 = null;
  try { await c.query(body.replace("INSERT INTO supabase_migrations.schema_migrations (version, name) VALUES ('0106', 'cancellation_decision_binding');", "SELECT 1/0;")); } catch (e) { err2 = e.message; }
  await c.query('ROLLBACK TO SAVEPOINT s2');
  const after2 = await state();
  ok('2. a failure after the bodies rolls everything back: nothing installed, old default, no ledger rows', /division by zero/.test(err2 || '') && after2.tables === 0 && after2.column === 0 && after2.fns === 0 && after2.ledger == null && /14_day_refund/.test(after2.def || ''), JSON.stringify({ err2, after2 }));

  // 3. the paste
  await c.query('SAVEPOINT s3');
  await c.query(body);
  const v = (await c.query(verifySql)).rows[0];
  const after3 = await state();
  ok('3. the paste installs everything: three tables, the column, the 4-arg record function (3-arg gone), claim/progress/sweep functions, barriers, ledger 0104..0108', after3.tables === 3 && after3.column === 1 && after3.fns === 7 && after3.record4 && !after3.record3 && after3.transitionBarrier && after3.moveBarrier && after3.ledger === '0104,0105,0106,0107,0108', JSON.stringify(after3));
  ok('3. verify row: default refundable, no unread modes, barrier count 0, record/resolve/transition executable by service_role, not by anon/authenticated', /refundable/.test(v.mode_default_expect_refundable) && !/14_day/.test(v.mode_default_expect_refundable) && Number(v.retailers_with_unread_mode_expect_0) === 0 && Number(v.bookings_with_barrier_expect_0) === 0 && v.record_fn_4args_expect_true && v.record_fn_3args_gone_expect_true && v.resolve_fn_0106_gone_expect_true && v.claim_progress_sweep_fns_expect_true && v.event_kind_refund_resolution_expect_true && v.transition_barrier_expect_true && v.move_barriers_expect_true && v.service_role_record_expect_true && v.service_role_claim_progress_sweeps_expect_true && v.service_role_transition_expect_true && v.anon_or_authenticated_record_expect_false === false && v.anon_or_authenticated_claim_progress_expect_false === false && v.anon_or_authenticated_read_decisions_expect_false === false, JSON.stringify(v));
  const leg = (await c.query("select cancellation_mode, cancellation_policy from retailers where id = $1", [legacy.id])).rows[0];
  const bk = (await c.query("select cancellation_mode, cancellation_policy from retailers_cancellation_policy_backup_0104 where retailer_id = $1", [legacy.id])).rows[0];
  ok('3. the legacy retailer is now refundable with no sentence; its previous row (14_day_refund) is in the backup table', leg.cancellation_mode === 'refundable' && leg.cancellation_policy == null && bk && bk.cancellation_mode === '14_day_refund', JSON.stringify({ leg, bk }));
  if (nonref) {
    const nr = (await c.query("select cancellation_mode, cancellation_policy from retailers where id = $1", [nonref.id])).rows[0];
    const nb = (await c.query("select cancellation_policy from retailers_cancellation_policy_backup_0104 where retailer_id = $1", [nonref.id])).rows[0];
    ok('3. the non-refundable retailer with a blank sentence got the non-refundable sentence; the blank was backed up', nr.cancellation_mode === 'non_refundable' && /not refunded/.test(nr.cancellation_policy || '') && nb && (nb.cancellation_policy || '') === '', JSON.stringify({ nr, nb }));
  }
  ok('3. the backup table comment records the previous default', /14_day_refund/.test(v.backup_note_with_previous_default || ''), String(v.backup_note_with_previous_default));
  ok('3. rows backed up by 0104 = the rows that changed (at least the two seeded)', Number(v.rows_backed_up_by_0104) >= (nonref ? 2 : 1), String(v.rows_backed_up_by_0104));

  // 4. again: the guard refuses, nothing changes
  await c.query('SAVEPOINT s4');
  let err4 = null;
  try { await c.query(body); } catch (e) { err4 = e.message; }
  await c.query('ROLLBACK TO SAVEPOINT s4');
  const after4 = await state();
  ok('4. a second run is refused by the guard (already in the ledger) and changes nothing', /CUTOVER GUARD/.test(err4 || '') && JSON.stringify(after4) === JSON.stringify(after3), JSON.stringify({ err4, same: JSON.stringify(after4) === JSON.stringify(after3) }));
} catch (e) {
  ok('rehearsal ran without an unexpected error', false, String((e && e.stack) || e).slice(0, 600));
} finally {
  await c.query('ROLLBACK');
  const live1 = await state();
  ok('5. outer ROLLBACK: the test project is exactly as found', JSON.stringify(live1) === JSON.stringify(live0), JSON.stringify({ live0, live1 }));
  await c.end();
}
console.log(`\nrehearsal 0104+0105+0106+0107+0108: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
