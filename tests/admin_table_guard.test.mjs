// tests/admin_table_guard.test.mjs
//
// P0-3 (Codex 2026-08-20) regression lock. The generic service-role proxy api/admin.js must NOT let
// a retailer session mutate bookings/demos, because those writes bypass the payment- and
// compliance-state machines:
//   * PATCH ?table=bookings {"status":"cancelled"}  → the provisional sweep stops selecting the row
//     while the Stripe authorization + card hold stay live (authorization-release bypass);
//   * PATCH ?table=bookings {"coi_waived_at":..,"coi_waived_by":..} → a manager forges a COI-waiver
//     decision + actor that only owner/admin may make (privilege bypass).
// The fix removes both tables from the writable allowlist and adds a per-table operation allowlist.
// This is an OFFLINE source-contract test (no DB) so it runs in `npm test` and CI on every commit;
// the live proof that a real manager/admin session is rejected lives in tests/route_flows.test.mjs.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}  ${detail}`); }
};

const admin = readFileSync(resolve('api/admin.js'), 'utf8');

console.log('\n— admin generic-proxy table guard (P0-3) —');

// Isolate the ALLOWED_TABLES set literal so a mention of 'bookings' in a comment can't pass the test.
const setStart = admin.indexOf('const ALLOWED_TABLES = new Set([');
const setEnd = admin.indexOf(']);', setStart);
check('ALLOWED_TABLES literal is present', setStart >= 0 && setEnd > setStart);
const allowedLiteral = setStart >= 0 ? admin.slice(setStart, setEnd) : '';

check('bookings is NOT in ALLOWED_TABLES (write/proxy path)', !/['"]bookings['"]/.test(allowedLiteral),
  'bookings must not be writable through the generic proxy');
check('demos is NOT in ALLOWED_TABLES (write/proxy path)', !/['"]demos['"]/.test(allowedLiteral),
  'demos must not be writable through the generic proxy');

// The tables the UI legitimately writes must still be allowed, or the admin app breaks.
for (const t of ['brand_contacts', 'internal_contacts', 'compliance_records', 'settings', 'venues', 'retailers']) {
  check(`${t} is still in ALLOWED_TABLES`, new RegExp(`['"]${t}['"]`).test(allowedLiteral), `${t} write path was dropped`);
}

// Per-operation allowlist exists and is enforced with a rejection, not a fall-through.
check('a per-table operation allowlist (TABLE_WRITE_OPS) is defined', /const\s+TABLE_WRITE_OPS\s*=/.test(admin));
check('write methods are checked against the per-table allowlist',
  /TABLE_WRITE_OPS\[table\]/.test(admin) && /operation_not_allowed/.test(admin),
  'no enforcement of TABLE_WRITE_OPS on the write path');
check('settings is PATCH-only in the operation allowlist',
  /settings:\s*new Set\(\[\s*'PATCH'\s*\]\)/.test(admin), 'settings should not be POST/DELETE-able via the proxy');

// The shipped frontend must not depend on a bookings/demos proxy write — if it did, this fix would
// have broken the app. (These are the helper call sites; a match here is a real regression.)
for (const [file, path] of [['r/gus/admin/index.html', 'r/gus/admin/index.html'], ['r/gus/index.html', 'r/gus/index.html']]) {
  const html = readFileSync(resolve(path), 'utf8');
  const bad = /admin(Insert|Update|Delete)\(\s*['"](bookings|demos)['"]/.test(html) || /table=(bookings|demos)\b/.test(html);
  check(`${file} does not write bookings/demos through /api/admin`, !bad, 'frontend still routes a booking/demo write through the generic proxy');
}

console.log(`\nadmin table guard: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
