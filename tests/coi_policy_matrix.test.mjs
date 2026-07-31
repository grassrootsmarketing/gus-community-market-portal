// tests/coi_policy_matrix.test.mjs — Codex v6: "add a policy-matrix test that feeds the same
// certificate states through all consumers and proves they return the same decision."
//
// This exists because Demohub had TWO definitions of a valid certificate and live routes
// consumed both. A rejected document counted as coverage in one path and was refused in
// another. The bug was never in either function; it was in there being two.
//
// So this suite does not test a function. It tests AGREEMENT: the same certificate state is
// pushed through every consumer, and any divergence fails.
import { coiDecision, coiCovered, coiDisplayState, isApprovedStatus } from '../api/_coi-policy.js';
import { coiCovered as coverageCovered } from '../api/_coi-coverage.js';
import { coiCoverageState, hasCurrentCoi, brandVerifiedState } from '../api/_coi-lib.js';

let pass = 0, fail = 0; const fails = [];
const ok = (n, c, x = '') => c ? pass++ : (fail++, fails.push(`${n} ${x}`));

const DEMO = '2026-09-01';
const doc = (status, expires) => ({
  default_coi_url: 'https://storage.invalid/coi.pdf',
  default_coi_expires: expires,
  coi_verification_status: status,
  // Profile fields, so brandVerifiedState's other requirements are satisfied and the ONLY
  // thing that can move its verdict is the certificate.
  company_name: 'Fixture Co', contact_name: 'A Tester', email: 'sink@fixture.test',
  phone: '555-0100', website: 'https://fixture.test', logo_url: 'https://x/logo.png',
});

// state, brand, and whether the canonical rule says this may be booked / shown as insured
const MATRIX = [
  ['approved + future expiry',  doc('approved', '2026-12-31'), true],
  ['passed + future expiry',    doc('passed',   '2026-12-31'), true],
  ['pending + future expiry',   doc('pending',  '2026-12-31'), false],
  ['flagged + future expiry',   doc('flagged',  '2026-12-31'), false],
  ['rejected + future expiry',  doc('rejected', '2026-12-31'), false],
  ['unknown status',            doc('weird',    '2026-12-31'), false],
  ['no status at all',          doc(undefined,  '2026-12-31'), false],
  ['approved but expired',      doc('approved', '2026-01-01'), false],
  ['approved, no expiry',       doc('approved', null),         false],
  ['no certificate on file',    { ...doc('approved', '2026-12-31'), default_coi_url: null }, false],
];

console.log('\n— the canonical decision —');
for (const [name, brand, expected] of MATRIX) {
  const d = coiDecision(brand, [], DEMO);
  ok(`policy: ${name} -> ${expected ? 'covered' : 'refused'}`, d.covered === expected,
     `${d.state}/${d.reason}`);
}

console.log('\n— every consumer must agree with it —');
for (const [name, brand, expected] of MATRIX) {
  const canonical = coiCovered(brand, [], DEMO);

  ok(`_coi-coverage agrees: ${name}`, coverageCovered(brand, DEMO).covered === canonical,
     `${coverageCovered(brand, DEMO).covered} vs ${canonical}`);

  ok(`_coi-lib hasCurrentCoi agrees: ${name}`, hasCurrentCoi(brand, [], DEMO) === canonical,
     `${hasCurrentCoi(brand, [], DEMO)} vs ${canonical}`);

  // The display path is where a rejected document used to render as "verified".
  const shown = brandVerifiedState(brand, DEMO).verified;
  ok(`brandVerifiedState agrees: ${name}`, shown === canonical, `${shown} vs ${canonical}`);
}

console.log('\n— the specific regressions Codex named —');
{
  const rejected = doc('rejected', '2026-12-31');
  ok('a REJECTED certificate is never covered', coiCovered(rejected, [], DEMO) === false);
  ok('a REJECTED certificate never displays as verified', brandVerifiedState(rejected, DEMO).verified === false);
  ok('a REJECTED certificate is not reported as merely expired',
     coiDisplayState(rejected, [], DEMO) === 'not_verified', coiDisplayState(rejected, [], DEMO));

  const pending = doc('pending', '2026-12-31');
  ok('a PENDING certificate is never covered', coiCovered(pending, [], DEMO) === false);
  ok('a PENDING certificate never displays as verified', brandVerifiedState(pending, DEMO).verified === false);

  // Status is checked BEFORE expiry on purpose: a rejected document with a valid date must
  // say it was rejected, not that it expired.
  const rejectedExpired = doc('rejected', '2026-01-01');
  ok('rejected outranks expired in the reported state',
     coiDisplayState(rejectedExpired, [], DEMO) === 'not_verified', coiDisplayState(rejectedExpired, [], DEMO));

  ok('only passed/approved are approved statuses',
     isApprovedStatus('passed') && isApprovedStatus('approved') &&
     !isApprovedStatus('pending') && !isApprovedStatus('rejected') &&
     !isApprovedStatus('flagged') && !isApprovedStatus('') && !isApprovedStatus(null));

  ok('status matching is case- and whitespace-insensitive',
     coiCovered(doc('  APPROVED ', '2026-12-31'), [], DEMO) === true);
}

console.log('\n— an unreadable expiry warns, it does not cancel —');
{
  const undated = doc('approved', null);
  ok('unknown is not covered', coiCovered(undated, [], DEMO) === false);
  ok('unknown is distinguishable from missing',
     coiDisplayState(undated, [], DEMO) === 'unknown', coiDisplayState(undated, [], DEMO));
  ok('_coi-lib preserves the unknown state for callers that must not cancel',
     coiCoverageState(undated, [], DEMO) === 'unknown', coiCoverageState(undated, [], DEMO));
}

console.log('\n— an explicit audited waiver is the ONE override —');
{
  const nothing = { ...doc('rejected', '2026-01-01'), default_coi_url: null };
  ok('a waiver covers even an absent certificate', coiCovered(nothing, [], DEMO, { waived: true }) === true);
  ok('the waiver is reported as a waiver, not as verification',
     coiDisplayState(nothing, [], DEMO, { waived: true }) === 'waived');
  ok('a waiver must be explicitly true, not merely truthy',
     coiCovered(nothing, [], DEMO, { waived: 'yes' }) === false);
}

console.log(`\ncoi policy matrix: ${pass} passed, ${fail} failed`);
if (fail) { console.log('FAILURES:'); fails.forEach(f => console.log('  x ' + f)); }
process.exit(fail === 0 ? 0 : 1);
