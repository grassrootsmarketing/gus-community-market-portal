// tests/refund_cutoff.test.mjs, OFFLINE unit test for api/_refund-cutoff.js (David, 2026-10-18).
//
// WHY. The cancellation policy brands sign says "Cancel at least 72 hours before your demo for a refund". Until
// this branch api/booking-action.js refunded every paid booking the store cancelled, whatever the timing, and the
// only cutoff in the code (14 DAYS) applied to a mode the admin page saved but the policy never mentioned. This
// file pins the decision the route now makes: measured in ELAPSED hours to the demo's start instant in the
// store's zone, so a daylight-saving change is counted exactly; the boundary itself refunds ("at least 72");
// non_refundable never refunds on its own; the store's explicit "Refund the brand anyway" (force_refund) does;
// unpaid, released and fee-waived bookings never reach a refund. No network, no database.
import {
  refundDecision, normalizeCancellationMode, isCancellationMode, demoStartInstant, hoursBeforeDemo,
  REFUND_CUTOFF_HOURS, NON_REFUNDABLE_CANCELLATION_POLICY, CANCELLATION_MODES,
} from '../api/_refund-cutoff.js';

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}  ${detail}`); }
};
const LA = 'America/Los_Angeles', NY = 'America/New_York';
const H = 3600 * 1000;
const paid = (over = {}) => ({ payment_status: 'paid', payment_intent_id: 'pi_test', fee_waived: false, demo_date: '2026-11-18', demo_time: '11:00 AM', ...over });
const store = (over = {}) => ({ cancellation_mode: 'refundable', timezone: LA, ...over });
// 2026-11-18 11:00 PST = 19:00Z (standard time, no transition within three days).
const START = Date.parse('2026-11-18T19:00:00Z');
const at = (hoursBefore) => new Date(START - hoursBefore * H);
const decide = (hoursBefore, bOver = {}, sOver = {}, force = false) => refundDecision({ booking: paid(bOver), retailer: store(sOver), forceRefund: force, now: at(hoursBefore) });

console.log('\nConstants and mode vocabulary');
check('the cutoff is 72 hours', REFUND_CUTOFF_HOURS === 72);
check('exactly two modes exist and both validate', CANCELLATION_MODES.length === 2 && isCancellationMode('refundable') && isCancellationMode('non_refundable'));
check('the legacy 14_day_refund, null, empty and junk are NOT storable modes', !isCancellationMode('14_day_refund') && !isCancellationMode(null) && !isCancellationMode('') && !isCancellationMode('free_for_all'));
check('normalize: null, empty, refundable, legacy 14_day_refund and junk all READ as refundable (never a silent never-refund)',
  ['refundable', null, undefined, '', '14_day_refund', 'free_for_all', ' Refundable '].every(m => normalizeCancellationMode(m) === 'refundable'));
check('normalize: non_refundable reads as non_refundable (case and whitespace tolerant)', normalizeCancellationMode('non_refundable') === 'non_refundable' && normalizeCancellationMode(' NON_REFUNDABLE ') === 'non_refundable');
check('the non-refundable sentence exists, mentions no refund, has no em dash', /not refunded/.test(NON_REFUNDABLE_CANCELLATION_POLICY) && !/2014/.test(NON_REFUNDABLE_CANCELLATION_POLICY));

console.log('\nThe start instant');
{
  const s = demoStartInstant({ demo_date: '2026-11-18', demo_time: '11:00 AM' }, LA);
  check('computed: demo_date + demo_time in the store zone (11:00 PST = 19:00Z)', s.ok && s.source === 'computed' && s.date.toISOString() === '2026-11-18T19:00:00.000Z', JSON.stringify(s));
  const snap = demoStartInstant({ demo_date: '2026-11-18', demo_time: '11:00 AM', start_at: '2026-11-18T20:00:00+00:00' }, LA);
  check('the 0074 snapshot bookings.start_at wins when present (the calendar and reminders use it)', snap.ok && snap.source === 'snapshot' && snap.date.toISOString() === '2026-11-18T20:00:00.000Z', JSON.stringify(snap));
  const bz = demoStartInstant({ demo_date: '2026-11-18', demo_time: '11:00', timezone: NY }, LA);
  check('without a snapshot, bookings.timezone outranks the retailer zone (11:00 EST = 16:00Z)', bz.ok && bz.date.toISOString() === '2026-11-18T16:00:00.000Z', JSON.stringify(bz));
  const legacy = demoStartInstant({ demo_date: '2026-11-18', demo_time: null }, LA);
  check('a legacy row with no time starts at 11:00 local', legacy.ok && legacy.date.toISOString() === '2026-11-18T19:00:00.000Z', JSON.stringify(legacy));
  const junkTime = demoStartInstant({ demo_date: '2026-11-18', demo_time: 'noonish' }, LA);
  check('an unparseable time falls back to 11:00 local (lenient, like the calendar feed)', junkTime.ok && junkTime.date.toISOString() === '2026-11-18T19:00:00.000Z', JSON.stringify(junkTime));
  const bad = demoStartInstant({ demo_date: '2026-02-30', demo_time: '11:00' }, LA);
  check('an impossible date cannot be resolved', !bad.ok && bad.error === 'invalid_date', JSON.stringify(bad));
  const badSnap = demoStartInstant({ demo_date: '2026-11-18', demo_time: '11:00', start_at: 'garbage' }, LA);
  check('a corrupt snapshot is ignored and the start is computed instead', badSnap.ok && badSnap.source === 'computed', JSON.stringify(badSnap));
  check('hoursBeforeDemo is elapsed hours (fractional)', hoursBeforeDemo(new Date(START), new Date(START - 1.5 * H)) === 1.5);
}

console.log('\nThe window (refundable mode, paid booking)');
{
  const r73 = decide(73);
  check('73 hours out: automatic refund (outside_cutoff)', r73.refund === true && r73.status === 'auto' && r73.reason === 'outside_cutoff' && r73.hours_before_demo === 73 && r73.mode === 'refundable' && r73.cutoff_hours === 72, JSON.stringify(r73));
  const r71 = decide(71);
  check('71 hours out: NO automatic refund, parked for the store (pending_manual, inside_cutoff)', r71.refund === false && r71.status === 'pending_manual' && r71.reason === 'inside_cutoff' && r71.hours_before_demo === 71, JSON.stringify(r71));
  const r72 = decide(72);
  check('exactly 72 hours out refunds ("at least 72 hours before")', r72.refund === true && r72.reason === 'outside_cutoff' && r72.hours_before_demo === 72, JSON.stringify(r72));
  const r72m = decide(72 - 1 / 60);
  check('one minute inside the boundary parks', r72m.refund === false && r72m.reason === 'inside_cutoff', JSON.stringify(r72m));
  const r72s = decide(72 + 1 / 3600);
  check('one second outside the boundary refunds', r72s.refund === true && r72s.reason === 'outside_cutoff', JSON.stringify(r72s));
  const past = decide(-2);
  check('a demo that already started never refunds automatically', past.refund === false && past.reason === 'inside_cutoff' && past.hours_before_demo === -2, JSON.stringify(past));
  const far = decide(24 * 30);
  check('30 days out refunds (the old 14-day rule is gone; the policy is hours)', far.refund === true && far.reason === 'outside_cutoff', JSON.stringify(far));
  const start = decide(73);
  check('the decision reports the start instant it measured against', start.start_at === '2026-11-18T19:00:00.000Z', JSON.stringify(start));
}

console.log('\nDaylight saving (elapsed hours, never calendar days)');
{
  // Fall back: Sunday 2026-11-01 02:00 PDT -> 01:00 PST. Demo Monday 2026-11-02 11:00 PST = 19:00Z.
  const fallDemo = { demo_date: '2026-11-02', demo_time: '11:00 AM' };
  const fri11pdt = new Date('2026-10-30T18:00:00Z');   // Friday 11:00 PDT, same wall clock three days earlier
  const a = refundDecision({ booking: paid(fallDemo), retailer: store(), now: fri11pdt });
  check('fall back: Friday 11:00 PDT -> Monday 11:00 PST is 73 elapsed hours (refunds, hours_before_demo 73)', a.refund === true && a.hours_before_demo === 73, JSON.stringify(a));
  const fri12pdt = new Date('2026-10-30T19:00:00Z');   // Friday 12:00 PDT = exactly 72 elapsed hours
  const b = refundDecision({ booking: paid(fallDemo), retailer: store(), now: fri12pdt });
  check('fall back: Friday 12:00 PDT is exactly 72 hours (refunds)', b.refund === true && b.hours_before_demo === 72, JSON.stringify(b));
  const c = refundDecision({ booking: paid(fallDemo), retailer: store(), now: new Date(fri12pdt.getTime() + 60 * 1000) });
  check('fall back: Friday 12:01 PDT is 71.98 hours (parks)', c.refund === false && c.reason === 'inside_cutoff' && c.hours_before_demo < 72, JSON.stringify(c));
  // Spring forward: Sunday 2026-03-08 02:00 PST -> 03:00 PDT. Demo Wednesday 2026-03-11 11:00 PDT = 18:00Z.
  const springDemo = { demo_date: '2026-03-11', demo_time: '11:00 AM' };
  const sat11pst = new Date('2026-03-07T19:00:00Z');   // Saturday 11:00 PST (used below against a Tuesday demo: same wall clock three days earlier)
  const sun11pdt = new Date('2026-03-08T18:00:00Z');   // Sunday 11:00 PDT = exactly 72 elapsed hours
  const d = refundDecision({ booking: paid(springDemo), retailer: store(), now: sun11pdt });
  check('spring forward: Sunday 11:00 PDT -> Wednesday 11:00 PDT is exactly 72 hours (refunds)', d.refund === true && d.hours_before_demo === 72, JSON.stringify(d));
  const e = refundDecision({ booking: paid(springDemo), retailer: store(), now: new Date('2026-03-08T18:30:00Z') });
  check('spring forward: Sunday 11:30 PDT is 71.5 hours (parks)', e.refund === false && e.hours_before_demo === 71.5, JSON.stringify(e));
  const f = refundDecision({ booking: paid({ ...springDemo, demo_date: '2026-03-10' }), retailer: store(), now: sat11pst });
  check('spring forward: Saturday 11:00 PST -> Tuesday 11:00 PDT is 71 elapsed hours, the same wall clock three days earlier does NOT refund', f.refund === false && f.hours_before_demo === 71, JSON.stringify(f));
  // The snapshot path across the same transition.
  const g = refundDecision({ booking: paid({ ...fallDemo, start_at: '2026-11-02T19:00:00+00:00' }), retailer: store(), now: fri11pdt });
  check('the snapshot path measures the same 73 hours', g.refund === true && g.hours_before_demo === 73, JSON.stringify(g));
  // A different zone: the retailer in New York, the same calendar inputs.
  const ny = refundDecision({ booking: paid(fallDemo), retailer: store({ timezone: NY }), now: new Date('2026-10-30T15:00:00Z') });
  check('New York store: Friday 11:00 EDT -> Monday 11:00 EST is 73 hours', ny.refund === true && ny.hours_before_demo === 73 && ny.start_at === '2026-11-02T16:00:00.000Z', JSON.stringify(ny));
}

console.log('\nModes, force, unpaid, waived');
{
  const nr = decide(24 * 30, {}, { cancellation_mode: 'non_refundable' });
  check('non_refundable never auto-refunds, even 30 days out (pending_manual, non_refundable)', nr.refund === false && nr.status === 'pending_manual' && nr.reason === 'non_refundable' && nr.mode === 'non_refundable', JSON.stringify(nr));
  const nrNear = decide(10, {}, { cancellation_mode: 'non_refundable' });
  check('non_refundable inside the window: still pending_manual with reason non_refundable (the mode, not the clock)', nrNear.refund === false && nrNear.reason === 'non_refundable', JSON.stringify(nrNear));
  const forced = decide(10, {}, {}, true);
  check('force_refund inside the window refunds (reason forced)', forced.refund === true && forced.status === 'auto' && forced.reason === 'forced' && forced.hours_before_demo === 10, JSON.stringify(forced));
  const forcedNr = decide(10, {}, { cancellation_mode: 'non_refundable' }, true);
  check('force_refund under non_refundable refunds too: it is the store\'s explicit choice, not automatic', forcedNr.refund === true && forcedNr.reason === 'forced', JSON.stringify(forcedNr));
  const forcedPast = decide(-5, {}, {}, true);
  check('force_refund after the demo started still refunds (the store asked)', forcedPast.refund === true && forcedPast.reason === 'forced', JSON.stringify(forcedPast));
  const unpaid = decide(24 * 30, { payment_status: 'unpaid', payment_intent_id: null });
  check('an unpaid booking is untouched: no refund, status not_paid, no hours computed', unpaid.refund === false && unpaid.status === 'not_paid' && unpaid.reason === 'not_paid' && unpaid.hours_before_demo === null, JSON.stringify(unpaid));
  const unpaidForced = decide(24 * 30, { payment_status: 'unpaid', payment_intent_id: null }, {}, true);
  check('force_refund cannot refund an unpaid booking', unpaidForced.refund === false && unpaidForced.reason === 'not_paid', JSON.stringify(unpaidForced));
  const authorized = decide(24 * 30, { payment_status: 'authorized' });
  check('an authorized (held) booking is not "paid" here (the route releases the hold instead)', authorized.refund === false && authorized.reason === 'not_paid', JSON.stringify(authorized));
  const noPi = decide(24 * 30, { payment_intent_id: null });
  check('paid without a payment intent is not refundable here (nothing to refund against)', noPi.refund === false && noPi.reason === 'not_paid', JSON.stringify(noPi));
  const waived = decide(24 * 30, { payment_status: 'waived', payment_intent_id: null, fee_waived: true });
  check('a fee-waived (booking code) booking never refunds', waived.refund === false && waived.status === 'not_paid' && waived.reason === 'not_paid', JSON.stringify(waived));
  const waivedPaid = decide(24 * 30, { fee_waived: true });
  check('a fee-waived booking that somehow reads as paid still never refunds (reason fee_waived)', waivedPaid.refund === false && waivedPaid.status === 'not_paid' && waivedPaid.reason === 'fee_waived', JSON.stringify(waivedPaid));
  const waivedForced = decide(24 * 30, { fee_waived: true }, {}, true);
  check('force_refund cannot refund a fee-waived booking', waivedForced.refund === false && waivedForced.reason === 'fee_waived', JSON.stringify(waivedForced));
  const legacy = decide(24 * 5, {}, { cancellation_mode: '14_day_refund' });
  check('legacy 14_day_refund 5 days out refunds under the 72-hour rule (the old 14-day rule would have parked it)', legacy.refund === true && legacy.reason === 'outside_cutoff' && legacy.mode === 'refundable', JSON.stringify(legacy));
  const nul = decide(73, {}, { cancellation_mode: null });
  check('a null mode (Gus today) is the 72-hour rule, not refund-always: 73 hours refunds', nul.refund === true && nul.reason === 'outside_cutoff', JSON.stringify(nul));
  const nulNear = decide(71, {}, { cancellation_mode: null });
  check('a null mode 71 hours out parks (this is the behaviour change for the pilot store)', nulNear.refund === false && nulNear.reason === 'inside_cutoff', JSON.stringify(nulNear));
  const unresolvable = refundDecision({ booking: paid({ demo_date: '2026-02-30' }), retailer: store(), now: new Date('2026-01-01T00:00:00Z') });
  check('an unresolvable start never refunds automatically (pending_manual, start_unresolvable); force still can', unresolvable.refund === false && unresolvable.reason === 'start_unresolvable' && unresolvable.hours_before_demo === null
    && refundDecision({ booking: paid({ demo_date: '2026-02-30' }), retailer: store(), forceRefund: true, now: new Date('2026-01-01T00:00:00Z') }).reason === 'forced', JSON.stringify(unresolvable));
  const noRetailer = refundDecision({ booking: paid(), retailer: null, now: at(73) });
  check('a missing retailer row reads as refundable in the default zone', noRetailer.refund === true && noRetailer.reason === 'outside_cutoff', JSON.stringify(noRetailer));
  const dflt = refundDecision({ booking: paid(), retailer: store() });
  check('now defaults to the wall clock (a 2026-11-18 demo is far in the past or future, never an exception)', typeof dflt.refund === 'boolean' && typeof dflt.hours_before_demo === 'number');
}

console.log(`\nrefund cutoff: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
