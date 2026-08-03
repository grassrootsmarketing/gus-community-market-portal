// tests/check_sql_columns.test.mjs
//
// OFFLINE self-tests for tools/check-sql-columns.mjs (Codex C2). No database: `analyze` is a pure
// function of (schema, files), so fixtures pin its behaviour so the checker cannot silently regress.
//
// Proves:
//   * a FINAL function that reads a missing unqualified column fails;
//   * a bad first definition followed by a corrected CREATE OR REPLACE passes;
//   * a bad FINAL replacement fails;
//   * missing columns in UPDATE and INSERT are still detected;
//   * SQL comments and string literals do not create column findings;
//   * the real 0021 -> 0052 -> 0054 sequence resolves to the corrected 0054 body.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { analyze } from '../tools/check-sql-columns.mjs';

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}  ${detail}`); }
};
const S = (obj) => Object.fromEntries(Object.entries(obj).map(([t, cols]) => [t, new Set(cols)]));
const F = (name, sql) => ({ name, sql });
const hits = (problems, re) => problems.some(p => re.test(p));

console.log('\n— check-sql-columns self-tests —');

// 1. FINAL function reads a missing unqualified column -> FAIL (the original settings.billing_tier shape).
{
  const p = analyze(S({ settings: ['id', 'retailer_id'] }), [F('a.sql', `
    create function enforce() returns trigger as $$
    declare v_tier text;
    begin
      select lower(billing_tier) into v_tier from settings where retailer_id = new.retailer_id;
      return new;
    end $$ language plpgsql;`)]);
  check('a final function reading a missing UNQUALIFIED column fails', hits(p, /settings\.billing_tier \(unqualified\)/), JSON.stringify(p));
}

// 2. Bad first definition + corrected CREATE OR REPLACE -> PASS (superseded body is not judged).
{
  const p = analyze(S({ settings: ['id', 'retailer_id'], retailers: ['id', 'billing_tier'] }), [
    F('0001.sql', `create function enforce() returns trigger as $$ declare v text; begin
       select lower(billing_tier) into v from settings; return new; end $$ language plpgsql;`),
    F('0002.sql', `create or replace function enforce() returns trigger as $$ declare v text; begin
       select lower(billing_tier) into v from retailers; return new; end $$ language plpgsql;`),
  ]);
  check('a corrected CREATE OR REPLACE supersedes a bad first definition', p.length === 0, JSON.stringify(p));
}

// 3. Bad FINAL replacement -> FAIL (and the earlier good definition is not what gets judged).
{
  const p = analyze(S({ retailers: ['id', 'name'] }), [
    F('0001.sql', `create function f() returns text as $$ declare v text; begin
       select name into v from retailers; return v; end $$ language plpgsql;`),
    F('0002.sql', `create or replace function f() returns text as $$ declare v text; begin
       select billing_tier into v from retailers; return v; end $$ language plpgsql;`),
  ]);
  check('a bad FINAL replacement fails', hits(p, /retailers\.billing_tier \(unqualified\)/) && !hits(p, /retailers\.name/), JSON.stringify(p));
}

// 4. Missing columns in UPDATE and INSERT remain detected (the refund_id / apply path shape).
{
  const p = analyze(S({ bookings: ['id', 'status'] }), [F('a.sql',
    `update bookings set refund_id = 'x' where id = 1; insert into bookings (id, amount_refunded) values (1, 2);`)]);
  check('a missing UPDATE ... SET column is detected', hits(p, /UPDATE bookings SET refund_id/), JSON.stringify(p));
  check('a missing INSERT column is detected', hits(p, /INSERT INTO bookings \(amount_refunded\)/), JSON.stringify(p));
}

// 5. Comments and string literals never create findings.
{
  const p = analyze(S({ settings: ['id'] }), [F('a.sql', `
    -- settings.billing_tier was legacy precedence; update settings set billing_tier = 1
    /* block: reference settings.billing_tier and update settings set billing_tier = 2 */
    select id from settings where id = 'settings.billing_tier and refund_id';`)]);
  check('comments and string literals do not create column findings', p.length === 0, JSON.stringify(p));
}

// 6. The REAL 0021 -> 0052 -> 0054 sequence resolves to the corrected 0054 body (offline, fixture schema).
{
  const names = ['0021_ws1-venue-limit-trigger-migration.sql', '0052_venue_limit_pro_ceiling.sql', '0054_venue_limit_column_fix.sql'];
  const files = names.map(n => F(n, readFileSync(resolve('supabase/migrations', n), 'utf8')));
  const schema = S({
    settings: ['id', 'retailer_id', 'demo_fee', 'demo_duration', 'advance_booking_days', 'custom', 'created_at', 'updated_at'],
    retailers: ['id', 'slug', 'name', 'billing_email', 'billing_tier', 'billing_status'],
    venues: ['id', 'retailer_id', 'name', 'address'],
  });
  const p = analyze(schema, files);
  check('the real 0021→0052→0054 chain resolves to the corrected 0054 body', p.length === 0, JSON.stringify(p));
}

console.log(`\ncheck-sql-columns self-tests: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
