// api/_refund-cutoff.js, the refund decision a store's cancellation makes (David, 2026-10-18; revised the same
// day after Codex's review, RC-1 to RC-4, and David's three decisions).
//
// THE RULE. The default cancellation policy brands sign says: "Cancel at least 72 hours before your demo for a
// refund. Inside 72 hours the fee is not refunded, because the store has usually already ordered product for
// you." Until this file existed api/booking-action.js refunded every paid booking the store cancelled
// (cancellation_mode null or 'refundable'), and a 14-DAY cutoff applied only to the legacy '14_day_refund'
// value the admin page actually saved. The policy text and the money did not agree. Now they do:
//
//   category = store_caused (the store cannot host the demo; David, RC-1: "always refund")
//       a paid booking is refunded in full, whatever the timing and whatever the mode
//   category = brand_requested (the brand asked the store to cancel)
//       refundable (the default; null and the legacy '14_day_refund' read as this)
//           the demo starts at least REFUND_CUTOFF_HOURS after the request was received -> automatic refund
//           closer than that -> no automatic refund (pending_manual)
//           the start cannot be resolved -> no automatic refund, flagged for review (under_review)
//       non_refundable
//           never an automatic refund (pending_manual)
//       force_refund (the store ticked "Refund the brand anyway", with a recorded reason)
//           refunds in either mode and at any distance; it is the store's explicit choice, not automatic
//   unpaid bookings, released holds and fee-waived (booking code) bookings never reach a refund
//
// THE CLOCK (RC-3, David: "time the brand asked"). The 72 hours are measured from `requestedAt`, the instant the
// store received the brand's request (the store enters it when cancelling; it defaults to now), not from the
// moment staff clicked. The store's CURRENT mode applies to every cancellation (David, RC-2: "current setting
// applies"); the route records the decision once (0104) and reuses it on a retry, so a later mode change or a
// failed provider call cannot change an already-made decision.
//
// THE INSTANT. "72 hours before the demo" is measured against the demo's START (demo_date + demo_time in the
// store's zone), not local midnight: the policy sentence says "before your demo". The 0074 snapshot
// bookings.start_at is used when present and valid (it is what the calendar and the reminders use); otherwise the
// start is resolved with api/_local-time.js from demo_date + demo_time in bookings.timezone, else the retailer's
// zone. STRICT (RC-4): a non-empty time that does not parse, a non-empty zone that is not a real IANA zone, or an
// impossible date is NOT guessed; the start is 'unresolved' and the refund goes to review rather than being
// granted or denied on an invented deadline. The one documented legacy default kept: a row with NO time at all
// reads as 11:00 local (the convention every calendar reader of legacy rows uses), and a row with NO zone at all
// reads as the retailer's zone, else Los Angeles (every store so far is Pacific; the 0074 trigger does the same).
// The comparison is ELAPSED hours between two UTC instants, so a daylight-saving change between the request and
// the demo is counted exactly. No calendar-day arithmetic anywhere. The boundary itself refunds ("at least 72").
//
// Pure and offline. tests/refund_cutoff.test.mjs pins every branch; tests/refund_cutoff_route.test.mjs proves
// the route honours the decision against the test database.
import { resolveDemoStart, isValidZone, DEFAULT_ZONE } from './_local-time.js';

export const REFUND_CUTOFF_HOURS = 72;
export const CANCELLATION_MODES = Object.freeze(['refundable', 'non_refundable']);
export const CANCELLATION_CATEGORIES = Object.freeze(['brand_requested', 'store_caused']);

// The two sentences brands sign, one per mode. The refundable sentence is also DEFAULT_CANCELLATION_POLICY in
// api/booking.js and api/brand-account.js (tests/cancellation_policy_text.test.mjs pins them identical); the admin
// page carries both. api/admin.js writes the sentence for a mode in the same PATCH as the mode (Codex RC-2).
export const REFUNDABLE_CANCELLATION_POLICY = 'Cancel at least 72 hours before your demo for a refund. Inside 72 hours the fee is not refunded, because the store has usually already ordered product for you. Please cancel as early as you can, ideally a week ahead. Reschedules are welcome anytime.';
export const NON_REFUNDABLE_CANCELLATION_POLICY = 'Demo fees are not refunded when a demo is cancelled, because the store orders product for you as soon as you book. Please cancel as early as you can so the slot can go to another brand. Reschedules are welcome anytime.';

const HOUR = 3600 * 1000;

// Anything that is not exactly 'non_refundable' refunds under the 72-hour rule: null, '', 'refundable', the
// legacy '14_day_refund' the admin page used to save, and unknown values. Never a silent "never refund".
export function normalizeCancellationMode(mode) {
  return String(mode == null ? '' : mode).trim().toLowerCase() === 'non_refundable' ? 'non_refundable' : 'refundable';
}
export function isCancellationMode(mode) { return CANCELLATION_MODES.includes(mode); }
export function isCancellationCategory(category) { return CANCELLATION_CATEGORIES.includes(category); }

// The sentence brands sign under a mode. A stored sentence that is empty reads as this (api/booking.js).
export function cancellationPolicyFor(mode) {
  return normalizeCancellationMode(mode) === 'non_refundable' ? NON_REFUNDABLE_CANCELLATION_POLICY : REFUNDABLE_CANCELLATION_POLICY;
}
// Whether a stored sentence is the standard sentence for a mode (empty counts as standard: it reads as the default).
export function cancellationPolicyMatchesMode(text, mode) {
  const t = String(text == null ? '' : text).trim();
  return !t || t === cancellationPolicyFor(mode);
}

// The UTC instant the demo starts: { ok: true, date, source: 'snapshot' | 'computed' } or { ok: false, error, source: 'unresolved' }.
//   error: invalid_zone | invalid_date | invalid_time | nonexistent_local_time | ambiguous_local_time
export function demoStartInstant(booking, retailerTimezone) {
  const b = booking || {};
  if (b.start_at != null && String(b.start_at).trim() !== '') {
    const d = new Date(b.start_at);
    if (!Number.isNaN(d.getTime())) return { ok: true, date: d, source: 'snapshot' };
    // a corrupt snapshot is not trusted; fall through to the strict computation
  }
  // Zone: the booking's own, else the retailer's, else the documented legacy default. A NON-EMPTY zone that is not
  // a real IANA zone is refused rather than silently read as Los Angeles.
  const bz = String(b.timezone == null ? '' : b.timezone).trim();
  const rz = String(retailerTimezone == null ? '' : retailerTimezone).trim();
  const tz = bz || rz || DEFAULT_ZONE;
  if (!isValidZone(tz)) return { ok: false, error: 'invalid_zone', source: 'unresolved' };
  const r = resolveDemoStart(b.demo_date, b.demo_time, tz, { lenientTime: false });
  return r.ok ? { ok: true, date: r.date, source: 'computed' } : { ok: false, error: r.error, source: 'unresolved' };
}

export function hoursBeforeDemo(startAt, at = new Date()) {
  return (startAt.getTime() - at.getTime()) / HOUR;
}

// The decision. `booking` is the bookings row (payment_status, payment_intent_id, fee_waived, start_at, timezone,
// demo_date, demo_time), `retailer` the retailers row (cancellation_mode, timezone), `category` one of
// CANCELLATION_CATEGORIES, `requestedAt` the instant the brand's request was received (defaults to now).
//   { refund: boolean, status: 'not_paid' | 'pending_manual' | 'under_review' | 'auto', reason, category, mode,
//     cutoff_hours, requested_at: ISO, hours_before_demo: number | null, start_at: ISO | null, start_source }
// reason: not_paid | fee_waived | store_caused | forced | non_refundable | start_unresolvable | inside_cutoff | outside_cutoff
export function refundDecision({ booking, retailer, category = 'brand_requested', requestedAt = null, forceRefund = false, now = new Date() }) {
  const b = booking || {};
  if (!isCancellationCategory(category)) throw new Error('refundDecision: invalid category ' + String(category));
  const at = requestedAt instanceof Date && !Number.isNaN(requestedAt.getTime()) ? requestedAt : now;
  const mode = normalizeCancellationMode(retailer && retailer.cancellation_mode);
  const paid = b.payment_status === 'paid' && !!b.payment_intent_id;
  const out = {
    refund: false, status: 'not_paid', reason: 'not_paid', category, mode, cutoff_hours: REFUND_CUTOFF_HOURS,
    requested_at: at.toISOString(), hours_before_demo: null, start_at: null, start_source: null,
  };
  if (!paid) return out;
  if (b.fee_waived === true) return { ...out, reason: 'fee_waived' };
  const start = demoStartInstant(b, retailer && retailer.timezone);
  out.start_source = start.source;
  if (start.ok) {
    out.start_at = start.date.toISOString();
    out.hours_before_demo = Math.round(hoursBeforeDemo(start.date, at) * 100) / 100;
  }
  if (category === 'store_caused') return { ...out, refund: true, status: 'auto', reason: 'store_caused' };
  if (forceRefund === true) return { ...out, refund: true, status: 'auto', reason: 'forced' };
  if (mode === 'non_refundable') return { ...out, refund: false, status: 'pending_manual', reason: 'non_refundable' };
  if (!start.ok) return { ...out, refund: false, status: 'under_review', reason: 'start_unresolvable' };
  if (hoursBeforeDemo(start.date, at) >= REFUND_CUTOFF_HOURS) return { ...out, refund: true, status: 'auto', reason: 'outside_cutoff' };
  return { ...out, refund: false, status: 'pending_manual', reason: 'inside_cutoff' };
}

// The request-time inputs a cancel carries (RC-3): the received-at instant, bounded and justified when backdated.
//   { ok: true, requested_at: Date, backdated_hours } | { ok: false, error, message }
export const REQUESTED_AT_MAX_FUTURE_MS = 10 * 60 * 1000;      // clock skew allowance
export const REQUESTED_AT_MAX_PAST_MS = 30 * 24 * HOUR;        // a request older than this is not a cancellation, it is history
export const BACKDATE_NOTE_AFTER_MS = 24 * HOUR;                // older than a day needs a written justification
export function validateRequestedAt(raw, { backdateNote = '', now = new Date() } = {}) {
  if (raw == null || String(raw).trim() === '') return { ok: true, requested_at: now, backdated_hours: 0 };
  const d = new Date(String(raw));
  if (Number.isNaN(d.getTime())) return { ok: false, error: 'invalid_requested_at', message: 'requested_at must be a date and time (ISO 8601).' };
  const delta = now.getTime() - d.getTime();
  if (delta < -REQUESTED_AT_MAX_FUTURE_MS) return { ok: false, error: 'requested_at_in_future', message: 'The time the brand asked cannot be in the future.' };
  if (delta > REQUESTED_AT_MAX_PAST_MS) return { ok: false, error: 'requested_at_too_old', message: 'The time the brand asked is more than 30 days ago. Check the date.' };
  if (delta > BACKDATE_NOTE_AFTER_MS && String(backdateNote || '').trim().length < 5) {
    return { ok: false, error: 'backdate_note_required', message: 'The brand asked more than a day ago. Say how you know when they asked (an email, a call) so the refund decision can be checked.' };
  }
  return { ok: true, requested_at: d, backdated_hours: Math.round(Math.max(0, delta) / HOUR * 100) / 100 };
}
