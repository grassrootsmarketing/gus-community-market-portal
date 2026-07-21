// Tests for the COI coverage rules. No dependencies — run with:
//     node api/_coi-lib.test.js
//
// These exist because this file decides whether a demo gets auto-cancelled and a
// real payment refunded. A regression here takes money from a customer who did
// nothing wrong, so it should never be changed without running this.

import { coiCoverageState, hasCurrentCoi, coiCutoff, localMidnightUtc } from './_coi-lib.js';

let pass = 0, fail = 0;
function check(name, actual, expected) {
  const a = actual instanceof Date ? actual.toISOString() : String(actual);
  const e = expected instanceof Date ? expected.toISOString() : String(expected);
  if (a === e) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + '\n         expected: ' + e + '\n         actual:   ' + a); }
}

const DEMO = '2026-09-01';

console.log('\ncoiCoverageState — the three states');
check('valid expiry after demo date', coiCoverageState({ default_coi_url: 'u', default_coi_expires: '2027-01-01' }, [], DEMO), 'covered');
check('expiry exactly on demo date',  coiCoverageState({ default_coi_url: 'u', default_coi_expires: DEMO }, [], DEMO), 'covered');
check('expiry day before demo',       coiCoverageState({ default_coi_url: 'u', default_coi_expires: '2026-08-31' }, [], DEMO), 'missing');
check('no certificate at all',        coiCoverageState({}, [], DEMO), 'missing');
check('certificate with NO expiry',   coiCoverageState({ default_coi_url: 'u', default_coi_expires: null }, [], DEMO), 'unknown');
check('no demo date',                 coiCoverageState({ default_coi_url: 'u', default_coi_expires: '2027-01-01' }, [], null), 'missing');

console.log('\ncoiCoverageState — compliance records (retailer-uploaded)');
check('record covers the date',       coiCoverageState({}, [{ doc_type: 'coi', expires_at: '2027-01-01' }], DEMO), 'covered');
check('record expired',               coiCoverageState({}, [{ doc_type: 'coi', expires_at: '2026-01-01' }], DEMO), 'missing');
check('record with no expiry',        coiCoverageState({}, [{ doc_type: 'coi', expires_at: null }], DEMO), 'unknown');
check('non-COI doc type ignored',     coiCoverageState({}, [{ doc_type: 'w9', expires_at: '2027-01-01' }], DEMO), 'missing');
check('alt doc_type accepted',        coiCoverageState({}, [{ doc_type: 'certificate_of_insurance', expires_at: '2027-01-01' }], DEMO), 'covered');
check('undated brand + valid record', coiCoverageState({ default_coi_url: 'u', default_coi_expires: null }, [{ doc_type: 'coi', expires_at: '2027-01-01' }], DEMO), 'covered');
check('undated brand + undated rec',  coiCoverageState({ default_coi_url: 'u', default_coi_expires: null }, [{ doc_type: 'coi', expires_at: null }], DEMO), 'unknown');
check('null entries survived',        coiCoverageState({}, [null, { doc_type: 'coi', expires_at: '2027-01-01' }], DEMO), 'covered');

console.log('\nhasCurrentCoi — strict boolean, unknown is NOT covered');
check('valid -> true',    hasCurrentCoi({ default_coi_url: 'u', default_coi_expires: '2027-01-01' }, [], DEMO), 'true');
check('undated -> false', hasCurrentCoi({ default_coi_url: 'u', default_coi_expires: null }, [], DEMO), 'false');
check('none -> false',    hasCurrentCoi({}, [], DEMO), 'false');

console.log('\ncoiCutoff — 72h before local midnight, across DST');
// Aug 2026: PDT (UTC-7). Local midnight Sep 1 = Sep 1 07:00Z. Minus 72h = Aug 29 07:00Z.
check('PDT (summer)', coiCutoff('2026-09-01', 'America/Los_Angeles'), new Date('2026-08-29T07:00:00.000Z'));
// Nov 2026: PST (UTC-8). Local midnight Dec 1 = Dec 1 08:00Z. Minus 72h = Nov 28 08:00Z.
check('PST (winter)', coiCutoff('2026-12-01', 'America/Los_Angeles'), new Date('2026-11-28T08:00:00.000Z'));
check('New York',     coiCutoff('2026-09-01', 'America/New_York'),    new Date('2026-08-29T04:00:00.000Z'));
check('bad date',     coiCutoff('nonsense', 'America/Los_Angeles'),   'null');
check('local midnight round-trip', localMidnightUtc('2026-09-01', 'America/Los_Angeles'), new Date('2026-09-01T07:00:00.000Z'));

console.log('\nEnd-to-end: does money move? (mirrors the cron decision path)');
function decide(brand, records, demoDate, pastCutoff) {
  let coverage = coiCoverageState(brand, [], demoDate);
  if (coverage === 'covered') return 'skip';
  const withRecords = coiCoverageState(brand, records, demoDate);
  if (withRecords === 'covered') return 'skip';
  coverage = (coverage === 'unknown' || withRecords === 'unknown') ? 'unknown' : 'missing';
  if (!pastCutoff) return 'warn';
  return coverage === 'unknown' ? 'review' : 'refund';
}
check('valid COI past cutoff',       decide({ default_coi_url: 'u', default_coi_expires: '2027-01-01' }, [], DEMO, true), 'skip');
check('no COI past cutoff',          decide({}, [], DEMO, true), 'refund');
check('expired COI past cutoff',     decide({ default_coi_url: 'u', default_coi_expires: '2026-08-01' }, [], DEMO, true), 'refund');
check('UNDATED COI past cutoff',     decide({ default_coi_url: 'u', default_coi_expires: null }, [], DEMO, true), 'review');
check('undated COI before cutoff',   decide({ default_coi_url: 'u', default_coi_expires: null }, [], DEMO, false), 'warn');
check('no COI before cutoff',        decide({}, [], DEMO, false), 'warn');

console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
