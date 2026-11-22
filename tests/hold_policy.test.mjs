// tests/hold_policy.test.mjs (Codex brand-walk order item 1, 2026-11-21): a provisional hold is only allowed where
// Demohub collects the payment. Offline: the decision matrix, plus the wiring in api/book.js that makes the refusal
// happen before any write on every creation path (plain insert, code RPC, member RPC).
import { readFileSync } from 'node:fs';
import { holdDecision, STORE_REQUIRES_INSURANCE } from '../api/_hold-policy.js';
import { coiCovered } from '../api/_coi-coverage.js';
let pass = 0, fail = 0;
const ok = (n, c, d) => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n + (d ? ' ' + d : '')); } };

// 1. the matrix: holds on/off x keeps-all/split x covered/not
const M = [
  [true, true, true, 'book'], [true, false, true, 'book'], [false, true, true, 'book'], [false, false, true, 'book'],
  [true, true, false, 'hold'], [true, false, false, 'refuse_store'],
  [false, true, false, 'refuse_coi'], [false, false, false, 'refuse_coi'],
];
for (const [holdsEnabled, keepsAll, covered, want] of M) ok(`1. holds ${holdsEnabled ? 'on' : 'off'}, ${keepsAll ? 'keeps-all' : 'split'}, ${covered ? 'covered' : 'not covered'} -> ${want}`, holdDecision({ holdsEnabled, keepsAll, covered }) === want);

// 2. nothing truthy-but-not-true widens the rule (a missing column, a string from a body, null)
for (const v of [undefined, null, 'true', 1, {}]) {
  ok(`2a. keepsAll ${JSON.stringify(v)} is not keeps-all`, holdDecision({ holdsEnabled: true, keepsAll: v, covered: false }) === 'refuse_store');
  ok(`2b. holdsEnabled ${JSON.stringify(v)} is not on`, holdDecision({ holdsEnabled: v, keepsAll: true, covered: false }) === 'refuse_coi');
  ok(`2c. covered ${JSON.stringify(v)} is not covered`, holdDecision({ holdsEnabled: true, keepsAll: false, covered: v }) === 'refuse_store');
}

// 3. certificate states at a split store: only an approved certificate that covers the demo date books
const date = '2026-12-15';
const states = {
  missing: { default_coi_url: null, coi_verification_status: null, default_coi_expires: null },
  pending: { default_coi_url: 'x', coi_verification_status: 'pending', default_coi_expires: '2027-06-30' },
  rejected: { default_coi_url: 'x', coi_verification_status: 'rejected', default_coi_expires: '2027-06-30' },
  'expired before the demo': { default_coi_url: 'x', coi_verification_status: 'approved', default_coi_expires: '2026-12-01' },
  'approved and covering': { default_coi_url: 'x', coi_verification_status: 'approved', default_coi_expires: '2027-06-30' },
};
for (const [name, brand] of Object.entries(states)) {
  const covered = coiCovered(brand, date).covered === true;
  const want = name === 'approved and covering' ? 'book' : 'refuse_store';
  ok(`3. split store, certificate ${name} -> ${want}`, holdDecision({ holdsEnabled: true, keepsAll: false, covered }) === want);
  ok(`3. keeps-all store, certificate ${name} -> ${name === 'approved and covering' ? 'book' : 'hold'}`, holdDecision({ holdsEnabled: true, keepsAll: true, covered }) === (name === 'approved and covering' ? 'book' : 'hold'));
}

// 4. wiring in api/book.js
const book = readFileSync('api/book.js', 'utf8');
ok('4a. the retailer row is read by the server with platform_keeps_all', /retailers\?slug=eq\.[^`]*select=[^`]*platform_keeps_all/.test(book));
ok('4b. the decision uses server-read values only', /holdDecision\(\{ holdsEnabled: FLAGS\.provisionalHolds === true, keepsAll: retailer\.platform_keeps_all === true, covered: cov\.covered === true \}\)/.test(book));
ok('4c. nothing in the request body can name the store type', !/body\.platform_keeps_all|body\.keeps_all/.test(book));
const at = book.indexOf("decision === 'refuse_store'");
const firstWrites = ["rest('bookings'", 'rpc/booking_create_with_code', 'rpc/booking_create_as_member', 'releaseHeldBooking'].map((s) => book.indexOf(s));
ok('4d. the refusal returns before the insert, both creation RPCs and the slot bump', at > 0 && firstWrites.every((i) => i > at), JSON.stringify({ at, firstWrites }));
ok('4e. the refusal is a 409 with the shared body', /if \(decision === 'refuse_store'\) return res\.status\(409\)\.json\(\{ \.\.\.STORE_REQUIRES_INSURANCE/.test(book));
ok('4f. held status follows the decision, nothing else', /const provisional = decision === 'hold';/.test(book) && !/const provisional = FLAGS\.provisionalHolds/.test(book));
ok('4g. the refusal matches what checkout says for the same case', readFileSync('api/checkout.js', 'utf8').includes(STORE_REQUIRES_INSURANCE.message) && STORE_REQUIRES_INSURANCE.error === 'store_requires_insurance_on_file');

console.log(`\nhold policy: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
