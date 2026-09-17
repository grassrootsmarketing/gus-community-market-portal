// tests/coi_capture_summary.test.mjs — Codex follow-up F-2 (2026-09-17). Pure, offline.
// The COI approval's payment summary derives every sentence from the actual per-booking results:
// it never promises a reconciliation case that was not recorded and never implies one exists for
// an entry the sweep did not process.
import { coiCaptureSummary } from '../api/_coi-capture-summary.js';

let passed = 0, failed = 0; const failures = [];
function ok(name, cond, extra = '') { if (cond) { passed++; console.log('  ok   ' + name); } else { failed++; failures.push(name + ' ' + extra); console.log('  FAIL ' + name + ' ' + extra); } }

const applied = (id) => ({ booking_id: id, outcome: 'captured', applied: true, case_id: null, case_recorded: false });
const unapplied = (id, rec) => ({ booking_id: id, outcome: 'captured', applied: false, case_id: rec ? 'case-' + id : null, case_recorded: !!rec, error: 'attempt_lookup_failed' });
const unknown = (id, rec) => ({ booking_id: id, outcome: 'uncertain', case_id: rec ? 'case-' + id : null, case_recorded: !!rec, error: 'cannot_retrieve_pi' });
const errored = (id) => ({ booking_id: id, outcome: 'error', case_id: null, case_recorded: false, error: 'boom' });
const notAttempted = (id) => ({ booking_id: id, outcome: 'not_attempted', case_id: null, case_recorded: false, error: 'hold_not_authorized' });
const notCaptured = (id) => ({ booking_id: id, outcome: 'not_captured', case_id: null, case_recorded: false, error: 'pi_state_requires_capture' });

console.log('\n— COI capture summary (Codex F-2): wording derived from actual results —');
{
  const s = coiCaptureSummary([applied('a'), notCaptured('b')]);
  ok('clean sweep (applied + not captured): no attention, no message', s.attention === false && s.message === undefined, JSON.stringify(s));
  ok('empty / missing input: no attention', coiCaptureSummary([]).attention === false && coiCaptureSummary(null).attention === false && coiCaptureSummary(undefined).message === undefined);
}
{
  const s = coiCaptureSummary([errored('e1'), errored('e2')]);
  ok('ERROR-ONLY: attention, names the unprocessed count, says NO case exists, never "a reconciliation case tracks"', s.attention === true && /2 held booking\(s\) could not be processed/.test(s.message) && /No reconciliation case exists for the 2 unprocessed/.test(s.message) && !/case tracks/.test(s.message) && !/Do not charge again/.test(s.message), s.message);
}
{
  const s = coiCaptureSummary([notAttempted('n1')]);
  ok('NOT-ATTEMPTED-ONLY: no case promised; says nothing about payment history', /No reconciliation case exists for the 1 unprocessed/.test(s.message) && /says nothing about whether their payment was ever captured/.test(s.message) && !/case tracks/.test(s.message), s.message);
}
{
  const s = coiCaptureSummary([unapplied('u1', true), unknown('k1', true), applied('a1')]);
  ok('all flagged entries have RECORDED cases: "tracks each of those", "Do not charge again"', /1 held booking\(s\) WERE charged/.test(s.message) && /1 held booking\(s\) have an UNKNOWN/.test(s.message) && /Do not charge again/.test(s.message) && /A reconciliation case tracks each of those\./.test(s.message) && !/could NOT/.test(s.message), s.message);
  const one = coiCaptureSummary([unapplied('u1', true)]);
  ok('single flagged entry with a recorded case: "tracks it"', /A reconciliation case tracks it\./.test(one.message), one.message);
}
{
  const s = coiCaptureSummary([unapplied('u1', true), unknown('k1', false)]);
  ok('PARTIAL case recording: exact counts recorded / NOT recorded', /recorded for 1 of them and could NOT be recorded for 1/.test(s.message) && !/tracks each/.test(s.message), s.message);
  const none = coiCaptureSummary([unapplied('u1', false), unknown('k1', false)]);
  ok('NO case recorded for any flagged entry: says so for all', /could NOT be recorded for any of them/.test(none.message) && !/tracks/.test(none.message), none.message);
}
{
  const s = coiCaptureSummary([unapplied('u1', true), errored('e1'), notAttempted('n1'), applied('a1')]);
  ok('MIXED (charged-unapplied with case + two unprocessed): the case sentence covers only the charged entry; the unprocessed get their own "no case exists" sentence', /A reconciliation case tracks it\./.test(s.message) && /No reconciliation case exists for the 2 unprocessed/.test(s.message) && /2 held booking\(s\) could not be processed/.test(s.message), s.message);
  const m2 = coiCaptureSummary([unknown('k1', false), errored('e1')]);
  ok('MIXED (unknown WITHOUT a case + one unprocessed): "could NOT be recorded for it" AND "no case exists for the 1 unprocessed"', /could NOT be recorded for it/.test(m2.message) && /No reconciliation case exists for the 1 unprocessed/.test(m2.message) && !/tracks/.test(m2.message), m2.message);
  const bogus = coiCaptureSummary([{ booking_id: 'x', outcome: 'uncertain', case_recorded: true, case_id: null }]);
  ok('case_recorded:true without a case_id is NOT treated as a recorded case (no invented id)', /could NOT be recorded for it/.test(bogus.message), bogus.message);
}
console.log(`\ncoi capture summary (Codex F-2): ${passed} passed, ${failed} failed`);
if (failures.length) { console.log('FAILURES:'); for (const x of failures) console.log('  x ' + x); }
process.exit(failed ? 1 : 0);
