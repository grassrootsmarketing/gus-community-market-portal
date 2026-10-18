// tests/refund_cutoff.test.mjs, OFFLINE unit test for api/_refund-cutoff.js (David, 2026-10-18; revised after
// Codex's review RC-1 to RC-4 and David's decisions the same day).
//
// WHY. The cancellation policy brands sign says "Cancel at least 72 hours before your demo for a refund". Until
// this branch api/booking-action.js refunded every paid booking the store cancelled, whatever the timing. This
// file pins the decision the route now makes: who asked (a store-caused cancellation always refunds; a
// brand-requested one follows the 72-hour rule), measured in ELAPSED hours from the instant the brand's request
// was received to the demo's start instant in the store's zone, so a daylight-saving change is counted exactly;
// the boundary itself refunds ("at least 72"); non_refundable never refunds on its own; the store's explicit
// "Refund the brand anyway" does; unpaid, released and fee-waived bookings never reach a refund; and malformed
// scheduling data is never turned into a deadline (strict parsing, review instead). No network, no database.
import {
  refundDecision, normalizeCancellationMode, isCancellationMode, isCancellationCategory, demoStartInstant, hoursBeforeDemo,
  validateRequestedAt, cancellationPolicyFor, cancellationPolicyMatchesMode,
  REFUND_CUTOFF_HOURS, NON_REFUNDABLE_CANCELLATION_POLICY, REFUNDABLE_CANCELLATION_POLICY, CANCELLATION_MODES, CANCELLATION_CATEGORIES,
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
const decide = (hoursBefore, bOver = {}, sOver = {}, force = false, category = 'brand_requested') =>
  refundDecision({ booking: paid(bOver), retailer: store(sOver), category, forceRefund: force, now: at(hoursBefore) });

console.log('\nConstants and vocabulary');
check('the cutoff is 72 hours', REFUND_CUTOFF_HOURS === 72);
check('exactly two modes exist and both validate', CANCELLATION_MODES.length === 2 && isCancellationMode('refundable') && isCancellationMode('non_refundable'));
check('exactly two categories exist and both validate', CANCELLATION_CATEGORIES.length === 2 && isCancellationCategory('brand_requested') && isCancellationCategory('store_caused'));
check('unknown, empty and null categories do not validate', !isCancellationCategory('other') && !isCancellationCategory('') && !isCancellationCategory(null) && !isCancellationCategory(undefined));
check('the legacy 14_day_refund, null, empty and junk are NOT storable modes', !isCancellationMode('14_day_refund') && !isCancellationMode(null) && !isCancellationMode('') && !isCancellationMode('free_for_all'));
check('normalize: null, empty, refundable, legacy 14_day_refund and junk all READ as refundable (never a silent never-refund)',
  ['refundable', null, undefined, '', '14_day_refund', 'free_for_all', ' Refundable '].every(m => normalizeCancellationMode(m) === 'refundable'));
check('normalize: non_refundable reads as non_refundable (case and whitespace tolerant)', normalizeCancellationMode('non_refundable') === 'non_refundable' && normalizeCancellationMode(' NON_REFUNDABLE ') === 'non_refundable');
check('the non-refundable sentence promises no refund and has no em dash; the refundable sentence says 72 hours', /not refunded/.test(NON_REFUNDABLE_CANCELLATION_POLICY) && NON_REFUNDABLE_CANCELLATION_POLICY.indexOf(String.fromCharCode(8212)) < 0 && /72 hours/.test(REFUNDABLE_CANCELLATION_POLICY) && REFUNDABLE_CANCELLATION_POLICY.indexOf(String.fromCharCode(8212)) < 0);
check('cancellationPolicyFor: the sentence follows the mode (null and legacy read as refundable)', cancellationPolicyFor('non_refundable') === NON_REFUNDABLE_CANCELLATION_POLICY && cancellationPolicyFor('refundable') === REFUNDABLE_CANCELLATION_POLICY && cancellationPolicyFor(null) === REFUNDABLE_CANCELLATION_POLICY && cancellationPolicyFor('14_day_refund') === REFUNDABLE_CANCELLATION_POLICY);
check('cancellationPolicyMatchesMode: empty matches (reads as the default), the standard sentence matches, any other text does not',
  cancellationPolicyMatchesMode('', 'refundable') && cancellationPolicyMatchesMode(null, 'non_refundable') && cancellationPolicyMatchesMode(REFUNDABLE_CANCELLATION_POLICY, 'refundable') && cancellationPolicyMatchesMode(NON_REFUNDABLE_CANCELLATION_POLICY, 'non_refundable')
  && !cancellationPolicyMatchesMode(REFUNDABLE_CANCELLATION_POLICY, 'non_refundable') && !cancellationPolicyMatchesMode('Our own wording.', 'refundable'));
let threw = false; try { refundDecision({ booking: paid(), retailer: store(), category: 'whatever', now: at(100) }); } catch (_) { threw = true; }
check('refundDecision refuses an unknown category rather than reading it as the brand\'s fault', threw);

console.log('\nThe start instant (strict, RC-4)');
{
  const s = demoStartInstant({ demo_date: '2026-11-18', demo_time: '11:00 AM' }, LA);
  check('computed: demo_date + demo_time in the store zone (11:00 PST = 19:00Z)', s.ok && s.source === 'computed' && s.date.toISOString() === '2026-11-18T19:00:00.000Z', JSON.stringify(s));
  const snap = demoStartInstant({ demo_date: '2026-11-18', demo_time: '11:00 AM', start_at: '2026-11-18T20:00:00+00:00' }, LA);
  check('the 0074 snapshot bookings.start_at wins when present (the calendar and reminders use it)', snap.ok && snap.source === 'snapshot' && snap.date.toISOString() === '2026-11-18T20:00:00.000Z', JSON.stringify(snap));
  const snapBad = demoStartInstant({ demo_date: '2026-02-30', demo_time: 'noonish', timezone: 'Not/AZone', start_at: '2026-11-18T20:00:00+00:00' }, 'PST');
  check('a valid snapshot is used even when every fallback field is bad', snapBad.ok && snapBad.source === 'snapshot' && snapBad.date.toISOString() === '2026-11-18T20:00:00.000Z', JSON.stringify(snapBad));
  const bz = demoStartInstant({ demo_date: '2026-11-18', demo_time: '11:00', timezone: NY }, LA);
  check('without a snapshot, bookings.timezone outranks the retailer zone (11:00 EST = 16:00Z)', bz.ok && bz.date.toISOString() === '2026-11-18T16:00:00.000Z', JSON.stringify(bz));
  const legacy = demoStartInstant({ demo_date: '2026-11-18', demo_time: null }, LA);
  check('a legacy row with NO time starts at 11:00 local (the documented convention)', legacy.ok && legacy.date.toISOString() === '2026-11-18T19:00:00.000Z', JSON.stringify(legacy));
  const emptyTime = demoStartInstant({ demo_date: '2026-11-18', demo_time: '   ' }, LA);
  check('a blank time is a missing time (11:00 local)', emptyTime.ok && emptyTime.date.toISOString() === '2026-11-18T19:00:00.000Z', JSON.stringify(emptyTime));
  const junkTime = demoStartInstant({ demo_date: '2026-11-18', demo_time: 'noonish' }, LA);
  check('a NON-EMPTY time that does not parse is unresolved, never read as 11:00 (invalid_time)', !junkTime.ok && junkTime.error === 'invalid_time' && junkTime.source === 'unresolved', JSON.stringify(junkTime));
  const junkTime2 = demoStartInstant({ demo_date: '2026-11-18', demo_time: '25:00' }, LA);
  check('an out-of-range time is unresolved', !junkTime2.ok && junkTime2.error === 'invalid_time', JSON.stringify(junkTime2));
  const bad = demoStartInstant({ demo_date: '2026-02-30', demo_time: '11:00' }, LA);
  check('an impossible date is unresolved (invalid_date)', !bad.ok && bad.error === 'invalid_date', JSON.stringify(bad));
  const badSnap = demoStartInstant({ demo_date: '2026-11-18', demo_time: '11:00', start_at: 'garbage' }, LA);
  check('a corrupt snapshot is ignored and the start is computed instead', badSnap.ok && badSnap.source === 'computed', JSON.stringify(badSnap));
  const emptySnap = demoStartInstant({ demo_date: '2026-11-18', demo_time: '11:00', start_at: '' }, LA);
  check('an empty snapshot string is "no snapshot"', emptySnap.ok && emptySnap.source === 'computed', JSON.stringify(emptySnap));
  const badZone = demoStartInstant({ demo_date: '2026-11-18', demo_time: '11:00' }, 'PST');
  check('a NON-EMPTY invalid retailer zone ("PST") is unresolved, never silently Los Angeles (invalid_zone)', !badZone.ok && badZone.error === 'invalid_zone', JSON.stringify(badZone));
  const badBookingZone = demoStartInstant({ demo_date: '2026-11-18', demo_time: '11:00', timezone: 'Mars/Olympus' }, LA);
  check('a NON-EMPTY invalid booking zone is unresolved even when the retailer zone is fine', !badBookingZone.ok && badBookingZone.error === 'invalid_zone', JSON.stringify(badBookingZone));
  const noZone = demoStartInstant({ demo_date: '2026-11-18', demo_time: '11:00' }, null);
  check('no zone anywhere reads as the documented legacy default (Los Angeles)', noZone.ok && noZone.date.toISOString() === '2026-11-18T19:00:00.000Z', JSON.stringify(noZone));
  const blankBookingZone = demoStartInstant({ demo_date: '2026-11-18', demo_time: '11:00', timezone: '  ' }, NY);
  check('a blank booking zone falls back to the retailer zone', blankBookingZone.ok && blankBookingZone.date.toISOString() === '2026-11-18T16:00:00.000Z', JSON.stringify(blankBookingZone));
  const gap = demoStartInstant({ demo_date: '2026-03-08', demo_time: '2:30 AM' }, LA);
  check('a wall time inside the spring-forward gap is unresolved (nonexistent_local_time), not guessed', !gap.ok && gap.error === 'nonexistent_local_time', JSON.stringify(gap));
  const fold = demoStartInstant({ demo_date: '2026-11-01', demo_time: '1:30 AM' }, LA);
  check('a wall time inside the fall-back fold is unresolved (ambiguous_local_time), not guessed', !fold.ok && fold.error === 'ambiguous_local_time', JSON.stringify(fold));
  check('hoursBeforeDemo is elapsed hours (fractional)', hoursBeforeDemo(new Date(START), new Date(START - 1.5 * H)) === 1.5);
}

console.log('\nThe window (brand_requested, refundable mode, paid booking)');
{
  const r73 = decide(73);
  check('73 hours out: automatic refund (outside_cutoff)', r73.refund === true && r73.status === 'auto' && r73.reason === 'outside_cutoff' && r73.hours_before_demo === 73 && r73.mode === 'refundable' && r73.cutoff_hours === 72 && r73.category === 'brand_requested', JSON.stringify(r73));
  const r71 = decide(71);
  check('71 hours out: NO automatic refund, parked for the store (pending_manual, inside_cutoff)', r71.refund === false && r71.status === 'pending_manual' && r71.reason === 'inside_cutoff' && r71.hours_before_demo === 71, JSON.stringify(r71));
  const r72 = decide(72);
  check('exactly 72 hours out refunds ("at least 72 hours before"), no rounding before the decision', r72.refund === true && r72.reason === 'outside_cutoff' && r72.hours_before_demo === 72, JSON.stringify(r72));
  const r72m = decide(72 - 1 / 60);
  check('one minute inside the boundary parks', r72m.refund === false && r72m.reason === 'inside_cutoff', JSON.stringify(r72m));
  const r72s = decide(72 + 1 / 3600);
  check('one second outside the boundary refunds', r72s.refund === true && r72s.reason === 'outside_cutoff', JSON.stringify(r72s));
  const r72ms = decide(72 - 0.001 / 3600);
  check('one millisecond inside the boundary parks (the reported hours round to 72.00 but the decision does not round)', r72ms.refund === false && r72ms.reason === 'inside_cutoff' && r72ms.hours_before_demo === 72, JSON.stringify(r72ms));
  const past = decide(-2);
  check('a demo that already started never refunds automatically', past.refund === false && past.reason === 'inside_cutoff' && past.hours_before_demo === -2, JSON.stringify(past));
  const far = decide(24 * 30);
  check('30 days out refunds (the old 14-day rule is gone; the policy is hours)', far.refund === true && far.reason === 'outside_cutoff', JSON.stringify(far));
  check('the decision reports the start instant, its source and the request time it measured from', r73.start_at === '2026-11-18T19:00:00.000Z' && r73.start_source === 'computed' && r73.requested_at === at(73).toISOString(), JSON.stringify(r73));
}

console.log('\nThe clock starts when the brand asked (RC-3)');
{
  // The brand asked 73 hours before the demo; staff processed it two hours later (71 hours before).
  const r = refundDecision({ booking: paid(), retailer: store(), category: 'brand_requested', requestedAt: at(73), now: at(71) });
  check('request at 73 h, processed at 71 h: refunds (measured from the request), hours_before_demo 73', r.refund === true && r.reason === 'outside_cutoff' && r.hours_before_demo === 73 && r.requested_at === at(73).toISOString(), JSON.stringify(r));
  const r2 = refundDecision({ booking: paid(), retailer: store(), category: 'brand_requested', requestedAt: at(71), now: at(100) });
  check('a request inside the window processed earlier still parks (the request time decides, not the click)', r2.refund === false && r2.reason === 'inside_cutoff' && r2.hours_before_demo === 71, JSON.stringify(r2));
  const r3 = refundDecision({ booking: paid(), retailer: store(), category: 'brand_requested', requestedAt: new Date('garbage'), now: at(73) });
  check('an invalid requestedAt falls back to now (the route validates it before this point)', r3.refund === true && r3.requested_at === at(73).toISOString(), JSON.stringify(r3));
  const v1 = validateRequestedAt(null, { now: at(10) });
  check('validateRequestedAt: empty means now', v1.ok && v1.requested_at.getTime() === at(10).getTime() && v1.backdated_hours === 0, JSON.stringify(v1));
  const v2 = validateRequestedAt(at(12).toISOString(), { now: at(10) });
  check('validateRequestedAt: two hours ago is fine without a note', v2.ok && v2.backdated_hours === 2, JSON.stringify(v2));
  const v3 = validateRequestedAt(at(40).toISOString(), { now: at(10) });
  check('validateRequestedAt: more than a day ago needs a note (backdate_note_required)', !v3.ok && v3.error === 'backdate_note_required', JSON.stringify(v3));
  const v4 = validateRequestedAt(at(40).toISOString(), { now: at(10), backdateNote: 'email from the brand on Monday' });
  check('validateRequestedAt: more than a day ago with a note is accepted and reports 30 backdated hours', v4.ok && v4.backdated_hours === 30, JSON.stringify(v4));
  const v5 = validateRequestedAt(at(9).toISOString(), { now: at(10) });
  check('validateRequestedAt: an hour in the future is refused (requested_at_in_future)', !v5.ok && v5.error === 'requested_at_in_future', JSON.stringify(v5));
  const v6 = validateRequestedAt(new Date(at(10).getTime() + 5 * 60 * 1000).toISOString(), { now: at(10) });
  check('validateRequestedAt: five minutes ahead is clock skew, accepted', v6.ok, JSON.stringify(v6));
  const v7 = validateRequestedAt(at(10 + 24 * 31).toISOString(), { now: at(10), backdateNote: 'old email' });
  check('validateRequestedAt: 31 days ago is refused even with a note (requested_at_too_old)', !v7.ok && v7.error === 'requested_at_too_old', JSON.stringify(v7));
  const v8 = validateRequestedAt('yesterday-ish', { now: at(10) });
  check('validateRequestedAt: junk is refused (invalid_requested_at)', !v8.ok && v8.error === 'invalid_requested_at', JSON.stringify(v8));
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
  const sun11pdt = new Date('2026-03-08T18:00:00Z');   // Sunday 11:00 PDT = exactly 72 elapsed hours
  const d = refundDecision({ booking: paid(springDemo), retailer: store(), now: sun11pdt });
  check('spring forward: Sunday 11:00 PDT -> Wednesday 11:00 PDT is exactly 72 hours (refunds)', d.refund === true && d.hours_before_demo === 72, JSON.stringify(d));
  const e = refundDecision({ booking: paid(springDemo), retailer: store(), now: new Date('2026-03-08T18:30:00Z') });
  check('spring forward: Sunday 11:30 PDT is 71.5 hours (parks)', e.refund === false && e.hours_before_demo === 71.5, JSON.stringify(e));
  const sat11pst = new Date('2026-03-07T19:00:00Z');   // Saturday 11:00 PST, the same wall clock three days before a Tuesday demo
  const f = refundDecision({ booking: paid({ ...springDemo, demo_date: '2026-03-10' }), retailer: store(), now: sat11pst });
  check('spring forward: Saturday 11:00 PST -> Tuesday 11:00 PDT is 71 elapsed hours, the same wall clock three days earlier does NOT refund', f.refund === false && f.hours_before_demo === 71, JSON.stringify(f));
  const g = refundDecision({ booking: paid({ ...fallDemo, start_at: '2026-11-02T19:00:00+00:00' }), retailer: store(), now: fri11pdt });
  check('the snapshot path measures the same 73 hours', g.refund === true && g.hours_before_demo === 73 && g.start_source === 'snapshot', JSON.stringify(g));
  const ny = refundDecision({ booking: paid(fallDemo), retailer: store({ timezone: NY }), now: new Date('2026-10-30T15:00:00Z') });
  check('New York store: Friday 11:00 EDT -> Monday 11:00 EST is 73 hours', ny.refund === true && ny.hours_before_demo === 73 && ny.start_at === '2026-11-02T16:00:00.000Z', JSON.stringify(ny));
}

console.log('\nStore-caused cancellations (RC-1, David: always refund)');
{
  const sc = decide(10, {}, {}, false, 'store_caused');
  check('store cannot host, 10 hours out, paid: full refund (reason store_caused)', sc.refund === true && sc.status === 'auto' && sc.reason === 'store_caused' && sc.category === 'store_caused' && sc.hours_before_demo === 10, JSON.stringify(sc));
  const scNr = decide(10, {}, { cancellation_mode: 'non_refundable' }, false, 'store_caused');
  check('store cannot host under a non-refundable policy: still a full refund', scNr.refund === true && scNr.reason === 'store_caused' && scNr.mode === 'non_refundable', JSON.stringify(scNr));
  const scPast = decide(-1, {}, {}, false, 'store_caused');
  check('store cannot host and the demo already started: still refunds', scPast.refund === true && scPast.reason === 'store_caused', JSON.stringify(scPast));
  const scUnpaid = decide(10, { payment_status: 'unpaid', payment_intent_id: null }, {}, false, 'store_caused');
  check('store cannot host but nothing was paid: not_paid, nothing to refund', scUnpaid.refund === false && scUnpaid.status === 'not_paid' && scUnpaid.reason === 'not_paid', JSON.stringify(scUnpaid));
  const scWaived = decide(10, { fee_waived: true }, {}, false, 'store_caused');
  check('store cannot host a fee-waived demo: fee_waived, nothing to refund', scWaived.refund === false && scWaived.reason === 'fee_waived', JSON.stringify(scWaived));
  const scBadTime = refundDecision({ booking: paid({ demo_time: 'noonish' }), retailer: store(), category: 'store_caused', now: at(10) });
  check('store cannot host and the start cannot be resolved: still refunds (no clock is needed)', scBadTime.refund === true && scBadTime.reason === 'store_caused' && scBadTime.start_source === 'unresolved' && scBadTime.hours_before_demo === null, JSON.stringify(scBadTime));
}

console.log('\nModes, force, unpaid, waived, unresolved');
{
  const nr = decide(24 * 30, {}, { cancellation_mode: 'non_refundable' });
  check('non_refundable never auto-refunds, even 30 days out (pending_manual, non_refundable)', nr.refund === false && nr.status === 'pending_manual' && nr.reason === 'non_refundable' && nr.mode === 'non_refundable', JSON.stringify(nr));
  const nrNear = decide(10, {}, { cancellation_mode: 'non_refundable' });
  check('non_refundable inside the window: still pending_manual with reason non_refundable (the mode, not the clock)', nrNear.refund === false && nrNear.reason === 'non_refundable', JSON.stringify(nrNear));
  const forced = decide(10, {}, {}, true);
  check('force_refund inside the window refunds (reason forced)', forced.refund === true && forced.status === 'auto' && forced.reason === 'forced' && forced.hours_before_demo === 10, JSON.stringify(forced));
  const forcedNr = decide(10, {}, { cancellation_mode: 'non_refundable' }, true);
  check('force_refund under non_refundable refunds too: it is the store\'s explicit, recorded choice, not automatic', forcedNr.refund === true && forcedNr.reason === 'forced', JSON.stringify(forcedNr));
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
  check('an unresolvable start is UNDER REVIEW (never an automatic refund, never an automatic denial)', unresolvable.refund === false && unresolvable.status === 'under_review' && unresolvable.reason === 'start_unresolvable' && unresolvable.hours_before_demo === null && unresolvable.start_source === 'unresolved', JSON.stringify(unresolvable));
  const unresolvableTime = refundDecision({ booking: paid({ demo_time: 'noonish' }), retailer: store(), now: at(100) });
  check('a corrupt non-empty time is under review, not an invented 11:00 deadline', unresolvableTime.status === 'under_review' && unresolvableTime.reason === 'start_unresolvable', JSON.stringify(unresolvableTime));
  const unresolvableZone = refundDecision({ booking: paid(), retailer: store({ timezone: 'PST' }), now: at(100) });
  check('an invalid store zone is under review, not an invented Pacific deadline', unresolvableZone.status === 'under_review' && unresolvableZone.reason === 'start_unresolvable', JSON.stringify(unresolvableZone));
  const unresolvableForced = refundDecision({ booking: paid({ demo_date: '2026-02-30' }), retailer: store(), forceRefund: true, now: new Date('2026-01-01T00:00:00Z') });
  check('force_refund still refunds an unresolvable start (the store asked)', unresolvableForced.refund === true && unresolvableForced.reason === 'forced', JSON.stringify(unresolvableForced));
  const unresolvableNr = refundDecision({ booking: paid({ demo_date: '2026-02-30' }), retailer: store({ cancellation_mode: 'non_refundable' }), now: new Date('2026-01-01T00:00:00Z') });
  check('non_refundable with an unresolvable start is a policy denial, not a review (no clock is needed)', unresolvableNr.status === 'pending_manual' && unresolvableNr.reason === 'non_refundable', JSON.stringify(unresolvableNr));
  const noRetailer = refundDecision({ booking: paid(), retailer: null, now: at(73) });
  check('a missing retailer row reads as refundable in the default zone', noRetailer.refund === true && noRetailer.reason === 'outside_cutoff', JSON.stringify(noRetailer));
  const dflt = refundDecision({ booking: paid(), retailer: store() });
  check('now and category default sensibly (a 2026-11-18 demo is far in the past or future, never an exception)', typeof dflt.refund === 'boolean' && typeof dflt.hours_before_demo === 'number' && dflt.category === 'brand_requested');
}

console.log(`\nrefund cutoff: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
