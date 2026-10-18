// api/_refund-cutoff.js, the refund decision a store's cancellation makes (David, 2026-10-18).
//
// THE RULE. The default cancellation policy brands sign says: "Cancel at least 72 hours before your demo for a
// refund. Inside 72 hours the fee is not refunded, because the store has usually already ordered product for
// you." Until this file existed api/booking-action.js refunded every paid booking the store cancelled
// (cancellation_mode null or 'refundable'), and a 14-DAY cutoff applied only to the legacy '14_day_refund'
// value the admin page actually saved. The policy text and the money did not agree. Now they do:
//
//   refundable (the default; null and the legacy '14_day_refund' read as this)
//       the demo is at least REFUND_CUTOFF_HOURS away  -> automatic Stripe refund
//       closer than that (or the start cannot be resolved) -> no automatic refund (pending_manual)
//   non_refundable
//       never an automatic refund (pending_manual)
//   force_refund (the store ticked "Refund the brand anyway" in the cancel dialog)
//       refunds in either mode and at any distance; it is the store's explicit choice, not automatic
//   unpaid bookings, released holds and fee-waived (booking code) bookings never reach a refund
//
// THE INSTANT. "72 hours before the demo" is measured against the demo's START (demo_date + demo_time in the
// store's zone), not local midnight: the policy sentence says "before your demo". The 0074 snapshot
// bookings.start_at is used when present (it is what the calendar and the reminders use); otherwise the start
// is resolved with api/_local-time.js from demo_date + demo_time in bookings.timezone, else the retailer's zone.
// A missing time reads as 11:00 local, like every other reader of legacy rows. The comparison is ELAPSED hours
// between two UTC instants, so a daylight-saving change between the cancellation and the demo is counted
// exactly (a Friday 11:00 cancellation of a Monday 11:00 demo across the fall-back night is 73 hours, across
// the spring-forward night 71). No calendar-day arithmetic anywhere.
//
// Pure and offline. tests/refund_cutoff.test.mjs pins every branch; tests/refund_cutoff_route.test.mjs proves
// the route honours the decision against the test database.
import { resolveDemoStart, safeZone } from './_local-time.js';

export const REFUND_CUTOFF_HOURS = 72;
export const CANCELLATION_MODES = Object.freeze(['refundable', 'non_refundable']);

// The sentence a non-refundable store's brands sign. The refundable sentence is DEFAULT_CANCELLATION_POLICY in
// api/booking.js; the retailer admin writes whichever matches the chosen mode (tests/cancellation_policy_text).
export const NON_REFUNDABLE_CANCELLATION_POLICY = 'Demo fees are not refunded when a demo is cancelled, because the store orders product for you as soon as you book. Please cancel as early as you can so the slot can go to another brand. Reschedules are welcome anytime.';

const HOUR = 3600 * 1000;

// Anything that is not exactly 'non_refundable' refunds under the 72-hour rule: null, '', 'refundable', the
// legacy '14_day_refund' the admin page used to save, and unknown values. Never a silent "never refund".
export function normalizeCancellationMode(mode) {
  return String(mode == null ? '' : mode).trim().toLowerCase() === 'non_refundable' ? 'non_refundable' : 'refundable';
}

export function isCancellationMode(mode) {
  return CANCELLATION_MODES.includes(mode);
}

// The UTC instant the demo starts: { ok: true, date, source: 'snapshot' | 'computed' } or { ok: false, error }.
export function demoStartInstant(booking, retailerTimezone) {
  const b = booking || {};
  if (b.start_at) {
    const d = new Date(b.start_at);
    if (!Number.isNaN(d.getTime())) return { ok: true, date: d, source: 'snapshot' };
  }
  const tz = safeZone(b.timezone || retailerTimezone);
  const r = resolveDemoStart(b.demo_date, b.demo_time, tz, { lenientTime: true });
  return r.ok ? { ok: true, date: r.date, source: 'computed' } : { ok: false, error: r.error };
}

export function hoursBeforeDemo(startAt, now = new Date()) {
  return (startAt.getTime() - now.getTime()) / HOUR;
}

// The decision. `booking` is the bookings row (payment_status, payment_intent_id, fee_waived, start_at,
// timezone, demo_date, demo_time), `retailer` the retailers row (cancellation_mode, timezone).
//   { refund: boolean, status: 'not_paid' | 'pending_manual' | 'auto', reason, mode, cutoff_hours,
//     hours_before_demo: number | null, start_at: ISO | null }
// reason is one of: not_paid | fee_waived | forced | non_refundable | start_unresolvable | inside_cutoff | outside_cutoff
export function refundDecision({ booking, retailer, forceRefund = false, now = new Date() }) {
  const b = booking || {};
  const mode = normalizeCancellationMode(retailer && retailer.cancellation_mode);
  const paid = b.payment_status === 'paid' && !!b.payment_intent_id;
  const out = { refund: false, status: 'not_paid', reason: 'not_paid', mode, cutoff_hours: REFUND_CUTOFF_HOURS, hours_before_demo: null, start_at: null };
  if (!paid) return out;
  if (b.fee_waived === true) return { ...out, reason: 'fee_waived' };
  const start = demoStartInstant(b, retailer && retailer.timezone);
  if (start.ok) {
    out.start_at = start.date.toISOString();
    out.hours_before_demo = Math.round(hoursBeforeDemo(start.date, now) * 100) / 100;
  }
  if (forceRefund === true) return { ...out, refund: true, status: 'auto', reason: 'forced' };
  if (mode === 'non_refundable') return { ...out, refund: false, status: 'pending_manual', reason: 'non_refundable' };
  if (!start.ok) return { ...out, refund: false, status: 'pending_manual', reason: 'start_unresolvable' };
  if (hoursBeforeDemo(start.date, now) >= REFUND_CUTOFF_HOURS) return { ...out, refund: true, status: 'auto', reason: 'outside_cutoff' };
  return { ...out, refund: false, status: 'pending_manual', reason: 'inside_cutoff' };
}
