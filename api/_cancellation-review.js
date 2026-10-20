// api/_cancellation-review.js (2026-10-19, Codex refund-cutoff R2-2; reworked for R3-1 / R3-2 / R3-3 and again for
// R4-1 / R4-2 / R4-3): the operator resolution of a cancelled paid booking whose refund was left undecided, and the
// bounded sweeps that keep every unresolved eligibility visible and every started resolution finished.
//
//   resolveCancellation(b, { booking, retailerId, operator, decision, reason })
//     1. CLAIM first (booking_cancellation_claim, 0107): the resolution row is inserted under the booking's lock with
//        state 'claimed' before any provider effect. If a row already exists, the stored decision is returned and the
//        caller's own request issues nothing; the stored operation is CONTINUED only when nobody is working it.
//     2. The steps, each recorded on the row (booking_cancellation_progress, 0108) so a replay or the worker resumes
//        from the durable marks, never from the aggregate state label alone (R4-1):
//        * grant with no request yet: ONE allocation-scoped refund through the shared ledger path (reserveAndRefund,
//          operation 'review_grant'); a mark lost after the provider call is recovered by adopting the operation's
//          existing request;
//        * grant with a linked request but no submitted mark: the request's REAL state decides (submitted, pending,
//          succeeded = submitted; reserved, failed_retryable, requires_action = still in flight, the refund worker's
//          leased retry owns it; requires_review and the terminal states = escalated to an operator case);
//        * the eligibility case is closed inside the mark; the brand notice is handed to the notification outbox as
//          an event (kind refund_resolution), which resolves the live recipients (the brand owner; never a booker, a
//          pending or a revoked member), freezes payload and recipient per delivery and retries under its own key.
//     Every answer derives from the STORED decision and state, never from the losing request's action.
//   Escalation (R4-2): a resolution whose refund request is parked, or that reached the attempt cap, is linked to a
//     deduplicated reconciliation case ('resolution-failed:<booking>', the failed step and the recovery action in its
//     details) and leaves automatic retries only once that link is recorded. A case-write failure keeps it selected.
//   sweepCancellationReviews: cancellation_reviews_outstanding() picks, in the database, under_review decisions with
//     no resolution and no case, oldest-unattempted first, and stamps them; the sweep opens the case.
//   sweepUnfinishedResolutions: cancellation_resolutions_unfinished() picks unescalated unfinished rows past a grace
//     period; the sweep resumes or escalates them.
//   sweepAbandonedCancellations: cancellation_abandoned_outstanding() picks active bookings whose recorded
//     cancellation never landed and have no case yet (stamped, fair); cancellation_abandoned_close() resolves, in
//     batches, the cases whose barrier has since cleared.
import { reserveAndRefund, sbRpc } from './_booking-refund.js';

async function sbGet(b, path) {
  const r = await fetch(`${b.supabaseUrl}/rest/v1/${path}`, { headers: { apikey: b.serviceKey, Authorization: `Bearer ${b.serviceKey}` } });
  const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch (_) {}
  if (!r.ok) throw new Error(t || ('HTTP ' + r.status));
  return j;
}
const first = (x) => (Array.isArray(x) ? x[0] : x);

export const CASE_DEDUPE_PREFIX = 'refund-eligibility:';
export const ABANDONED_DEDUPE_PREFIX = 'cancel-abandoned:';
export const ESCALATION_DEDUPE_PREFIX = 'resolution-failed:';
export const RESOLUTION_ATTEMPT_CAP = 20;
// refund_requests.status, read as the money step's truth
export const REQUEST_SUBMITTED = ['submitted', 'pending', 'succeeded'];
export const REQUEST_IN_FLIGHT = ['reserved', 'failed_retryable', 'requires_action'];
export const REQUEST_TERMINAL = ['requires_review', 'failed', 'failed_terminal', 'canceled', 'superseded'];

export async function openEligibilityCase(b, booking, decision) {
  const r = await sbRpc(b, '_open_case', {
    p_kind: 'refund_requires_review', p_dedupe: CASE_DEDUPE_PREFIX + booking.id, p_reason: 'refund_eligibility_unresolved',
    p_group: null, p_request: null, p_operation: null, p_session: null, p_pi: booking.payment_intent_id || null, p_charge: null, p_refund: null, p_amount: null, p_currency: null,
    p_details: { booking_id: booking.id, category: decision.category || null, requested_at: decision.requested_at || null, start_source: decision.start_source || null,
      demo_date: booking.demo_date, demo_time: booking.demo_time, timezone: decision.timezone || null, opened_by: decision.opened_by || 'cancel_route' },
  });
  return first(r) || null;
}

export async function loadCancellation(b, bookingId) {
  const [dec, res, cases] = await Promise.all([
    sbGet(b, `booking_cancellations?booking_id=eq.${encodeURIComponent(bookingId)}&select=*`),
    sbGet(b, `booking_cancellation_resolutions?booking_id=eq.${encodeURIComponent(bookingId)}&select=*`),
    sbGet(b, `reconciliation_cases?dedupe_key=eq.${encodeURIComponent(CASE_DEDUPE_PREFIX + bookingId)}&select=id,status,resolved_by,resolved_at`),
  ]);
  return { decision: first(dec) || null, resolution: first(res) || null, reviewCase: first(cases) || null };
}

// What the operator may do with this cancellation right now (read-only view; the claim RPC is the authority).
export function resolutionState({ booking, decision, resolution }) {
  if (!decision) return { resolvable: false, why: 'no_decision' };
  if (resolution) return { resolvable: false, why: 'resolved', resolution };
  if (!booking || !['cancelled', 'declined'].includes(String(booking.status || ''))) return { resolvable: false, why: 'not_cancelled' };
  if (decision.refund === true) return { resolvable: false, why: 'already_refunding' };
  if (decision.status === 'not_paid' && booking.payment_status !== 'paid') return { resolvable: false, why: 'nothing_to_refund' };
  return { resolvable: true, why: decision.status === 'not_paid' ? 'paid_after_cancellation' : decision.status };   // pending_manual | under_review | paid_after_cancellation
}

// Derived, truthful money wording for a stored resolution (workflow state, never the bank's).
export function refundStatusOf(row) {
  if (!row) return 'none';
  if (row.decision !== 'refund_granted') return 'none';
  if (row.escalated_at && !row.refund_submitted_at) return 'needs_review';
  if (row.refund_request_id && row.refund_submitted_at) return 'submitted';
  if (row.refund_request_id) return 'refund_pending';   // in flight: the refund worker's leased retry owns it
  return 'pending';   // claimed or failed before the refund step
}

async function progress(b, bookingId, retailerId, mark, extra = {}) {
  const r = first(await sbRpc(b, 'booking_cancellation_progress', { p_booking_id: bookingId, p_retailer_id: retailerId, p_mark: mark, p_refund_request_id: extra.refund_request_id || null, p_error: extra.error || null, p_case_id: extra.case_id || null }));
  if (!r || r.outcome !== 'marked') { const e = new Error('progress_' + mark + ':' + ((r && r.outcome) || 'no_result')); e.outcome = r && r.outcome; e.request_status = r && r.request_status; throw e; }
  return r.resolution;
}

// The refund request this booking's 'review_grant' operation already created, if any (an attempt whose mark was lost).
async function findGrantRequest(b, bookingId) {
  const op = first(await sbGet(b, 'refund_operations?op_key=eq.' + encodeURIComponent(bookingId + ':review_grant') + '&select=id'));
  if (!op) return null;
  const rq = first(await sbGet(b, 'refund_requests?parent_operation_id=eq.' + encodeURIComponent(op.id) + '&booking_id=eq.' + encodeURIComponent(bookingId) + '&select=id,status&order=attempt_version.desc&limit=1'));
  return rq || null;
}

// Durable escalation: one deduplicated case per booking naming the failed step and the recovery action; the
// resolution is linked to it (mark 'escalated') and leaves automatic retries only once the link is recorded.
export async function escalateResolution(b, booking, row, step, detail) {
  const id = first(await sbRpc(b, '_open_case', {
    p_kind: 'settlement_exception', p_dedupe: ESCALATION_DEDUPE_PREFIX + booking.id, p_reason: step === 'refund_request_parked' ? 'resolution_refund_request_parked' : 'resolution_retry_exhausted',
    p_group: null, p_request: row.refund_request_id || null, p_operation: null, p_session: null, p_pi: booking.payment_intent_id || null, p_charge: null, p_refund: null, p_amount: null, p_currency: null,
    p_details: { booking_id: booking.id, decision: row.decision, refund_request_id: row.refund_request_id || null, failed_step: step, detail: String(detail || '').slice(0, 300), attempts: row.attempts,
      recovery: row.decision === 'refund_granted'
        ? 'inspect the refund request in refund review (adopt or replace it), then grant again from the store admin to finish this resolution'
        : 'retry the decision from the store admin; if the case closure or the notice keeps failing, finish them by hand and resolve this case' },
  }));
  if (!id) throw new Error('escalation_case_not_created');
  return progress(b, booking.id, booking.retailer_id, 'escalated', { case_id: id, error: step + ': ' + String(detail || '').slice(0, 200) });
}

// The steps a claimed resolution still owes, derived from its durable marks and the refund request's real state.
export async function resumeResolution(b, booking, row, { operator = null } = {}) {
  const bookingId = booking.id, retailerId = booking.retailer_id;
  let cur = row, refund = null, failed = null, escalated = false;
  try {
    if (cur.decision === 'refund_granted' && !cur.refund_request_id) {
      // ONE allocation-scoped refund: this booking's allocation, its remaining entitlement, a stable operation key; a
      // retry after a crash between the provider call and the mark returns the existing reservation and resubmits
      // under the SAME idempotency key, so the ledger obligation is adopted, never doubled.
      refund = await reserveAndRefund(b, booking, operator || cur.operator || null, 'review_grant: ' + String(cur.reason || '').slice(0, 200), 'review_grant');
      if (refund.ok) cur = await progress(b, bookingId, retailerId, 'refund_submitted', { refund_request_id: refund.refund_request_id });
      else if (refund.retrying && refund.refund_request_id) cur = await progress(b, bookingId, retailerId, 'refund_pending', { refund_request_id: refund.refund_request_id });
      else {
        const adopted = ['nothing_refundable', 'already_refunded', 'existing'].includes(String(refund.error || '')) ? await findGrantRequest(b, bookingId) : null;
        if (adopted && REQUEST_TERMINAL.includes(adopted.status)) { cur = await escalateResolution(b, booking, { ...cur, refund_request_id: adopted.id }, 'refund_request_parked', 'request ' + adopted.id + ' is ' + adopted.status); escalated = true; failed = 'refund_request_parked'; return { row: cur, refund, failed, escalated }; }
        if (adopted) { cur = await progress(b, bookingId, retailerId, REQUEST_SUBMITTED.includes(adopted.status) ? 'refund_submitted' : 'refund_pending', { refund_request_id: adopted.id }); refund = { ok: true, adopted: true, refund_request_id: adopted.id }; }
        else { failed = 'refund:' + (refund.error || 'unknown'); cur = await progress(b, bookingId, retailerId, 'failed', { error: failed }); return { row: cur, refund, failed, escalated }; }
      }
    }
    if (cur.decision === 'refund_granted' && cur.refund_request_id && !cur.refund_submitted_at) {
      // R4-1: a linked request without a verified submitted mark is re-read on every resume, whatever the state label
      const rq = first(await sbGet(b, `refund_requests?id=eq.${encodeURIComponent(cur.refund_request_id)}&select=id,status`));
      if (!rq) throw new Error('refund_request_missing');
      if (REQUEST_SUBMITTED.includes(rq.status)) cur = await progress(b, bookingId, retailerId, 'refund_submitted', { refund_request_id: cur.refund_request_id });
      else if (REQUEST_TERMINAL.includes(rq.status)) { cur = await escalateResolution(b, booking, cur, 'refund_request_parked', 'request ' + rq.id + ' is ' + rq.status); escalated = true; failed = 'refund_request_parked'; return { row: cur, refund, failed, escalated }; }
      // in flight: the refund worker's leased retry owns the resubmission; the other steps proceed, completion waits
    }
    if (!cur.case_closed_at) cur = await progress(b, bookingId, retailerId, 'case_closed');
    if (!cur.brand_notified_at) cur = await progress(b, bookingId, retailerId, 'brand_notified');   // handed to the outbox (R4-3)
  } catch (e) {
    failed = String((e && e.message) || e).slice(0, 200);
    try { cur = await progress(b, bookingId, retailerId, 'failed', { error: failed }); } catch (_) { /* the row keeps its last mark; the worker retries */ }
  }
  return { row: cur, refund, failed, escalated };
}

export async function resolveCancellation(b, { booking, retailerId, operator, decision, reason }) {
  if (!['refund_granted', 'no_refund'].includes(decision)) return { ok: false, status: 400, error: 'invalid_decision' };
  const why = String(reason || '').trim();
  if (!why) return { ok: false, status: 400, error: 'reason_required' };
  let priorRow = null;
  try { priorRow = first(await sbGet(b, 'booking_cancellation_resolutions?booking_id=eq.' + encodeURIComponent(booking.id) + '&select=booking_id,state')); } catch (_) { priorRow = null; }
  if (decision === 'refund_granted' && !priorRow) {
    // A grant is claimed only for a booking the ledger can refund: without an allocation or with nothing left to refund
    // there is no operation to claim, and refusing here records nothing (the operator can still record a denial).
    let alloc = null;
    try { alloc = first(await sbGet(b, 'payment_allocations?booking_id=eq.' + encodeURIComponent(booking.id) + '&select=customer_amount,refunded_amount,reserved_refund_amount')); }
    catch (e) { return { ok: false, status: 503, error: 'ledger_unavailable' }; }
    if (!alloc) return { ok: false, status: 409, error: 'refund_not_possible', detail: 'no_allocation' };
    if (Number(alloc.refunded_amount || 0) + Number(alloc.reserved_refund_amount || 0) >= Number(alloc.customer_amount || 0)) return { ok: false, status: 409, error: 'refund_not_possible', detail: 'nothing_refundable' };
  }
  const claim = first(await sbRpc(b, 'booking_cancellation_claim', { p_booking_id: booking.id, p_retailer_id: retailerId, p_decision: decision, p_operator: operator || null, p_reason: why.slice(0, 500) }));
  if (!claim || !['claimed', 'existing'].includes(claim.outcome)) {
    return { ok: false, status: ['invalid_decision', 'reason_required'].includes(claim && claim.outcome) ? 400 : 409, error: (claim && claim.outcome) || 'claim_failed', decision: claim && claim.decision };
  }
  const existing = claim.outcome === 'existing';
  let row = claim.resolution, refund = null, failed = null, escalated = false;
  if (row.state !== 'completed') {
    // the winner runs its steps. A replay (same or opposite request) continues the STORED operation only when it is not
    // being worked right now: a row claimed within the grace window belongs to the request that claimed it (two
    // concurrent grants must not both resubmit), and the refund worker finishes anything left behind after the grace.
    const ageMs = Date.now() - Date.parse(row.updated_at || 0);
    const graceMs = Number(process.env.RESOLUTION_REPLAY_GRACE_SECONDS || 120) * 1000;
    const mayResume = !existing || row.state === 'failed' || row.state === 'refund_pending' || !!row.escalated_at || !(ageMs < graceMs);   // an escalated row is finished by the operator's own replay
    if (mayResume) {
      const r = await resumeResolution(b, booking, row, { operator: existing ? null : operator });
      row = r.row; refund = r.refund; failed = r.failed; escalated = r.escalated;
    }
  }
  return { ok: true, status: 200, existing, requested: decision, decision_stored: row.decision, state: row.state, resolution: row,
    outcome: row.state === 'completed' ? (existing ? 'existing' : 'resolved') : (row.escalated_at ? 'needs_review' : 'in_progress'),
    refund, refund_status: refundStatusOf(row), case_id: row.case_id || null, case_closed: !!row.case_closed_at, brand_notified: !!row.brand_notified_at,
    escalated_case_id: row.escalated_case_id || null, failed };
}

export async function sweepCancellationReviews(b, { limit = 25 } = {}) {
  const out = { checked: 0, opened: 0, failed: 0, errors: [] };
  let rows;
  try { rows = await sbRpc(b, 'cancellation_reviews_outstanding', { p_limit: Math.max(1, Math.min(100, limit)) }); }
  catch (e) { out.read_failed = true; out.errors.push('read: ' + ((e && e.message) || e)); return out; }
  rows = Array.isArray(rows) ? rows : (rows ? [rows] : []);
  for (const r of rows) {
    out.checked++;
    try {
      const id = await openEligibilityCase(b, { id: r.booking_id, payment_intent_id: r.payment_intent_id, demo_date: r.demo_date, demo_time: r.demo_time }, { ...r, opened_by: 'refund_worker_sweep' });
      if (id) out.opened++; else { out.failed++; out.errors.push('open: no case id for ' + r.booking_id); }
    } catch (e) { out.failed++; out.errors.push('open: ' + ((e && e.message) || e)); }
  }
  return out;
}

export async function sweepUnfinishedResolutions(b, { limit = 25, graceSeconds = 120, attemptCap = RESOLUTION_ATTEMPT_CAP } = {}) {
  const out = { checked: 0, completed: 0, still_open: 0, escalated: 0, step_failed: 0, failed: 0, errors: [] };
  let rows;
  try { rows = await sbRpc(b, 'cancellation_resolutions_unfinished', { p_limit: Math.max(1, Math.min(100, limit)), p_grace_seconds: graceSeconds }); }
  catch (e) { out.read_failed = true; out.errors.push('read: ' + ((e && e.message) || e)); return out; }
  rows = Array.isArray(rows) ? rows : (rows ? [rows] : []);
  for (const row of rows) {
    out.checked++;
    try {
      const bk = first(await sbGet(b, `bookings?id=eq.${encodeURIComponent(row.booking_id)}&select=*`));
      if (!bk) { out.failed++; out.errors.push('resume: booking missing ' + row.booking_id); continue; }
      if (Number(row.attempts || 0) > attemptCap) {
        // R4-2: at the cap the work leaves automatic retries only through a recorded, deduplicated operator case
        await escalateResolution(b, bk, row, 'retry_exhausted', 'last error: ' + String(row.last_error || 'none'));
        out.escalated++; out.errors.push('escalated: ' + row.booking_id + ' after ' + row.attempts + ' attempts');
        continue;
      }
      const r = await resumeResolution(b, bk, row, {});
      if (r.escalated) out.escalated++;
      else if (r.row && r.row.state === 'completed') out.completed++;
      else out.still_open++;
      if (r.failed && !r.escalated) { out.step_failed++; out.errors.push('resume: ' + r.failed); }
      if (r.escalated) out.errors.push('escalated: ' + row.booking_id + ' ' + r.failed);
    } catch (e) { out.failed++; out.errors.push('resume: ' + ((e && e.message) || e)); }
  }
  return out;
}

export async function sweepAbandonedCancellations(b, { limit = 25, minutes = 15, closeBatches = 4 } = {}) {
  const out = { checked: 0, cases_opened: 0, cases_resolved: 0, failed: 0, errors: [] };
  let rows;
  try { rows = await sbRpc(b, 'cancellation_abandoned_outstanding', { p_limit: Math.max(1, Math.min(100, limit)), p_minutes: minutes }); }
  catch (e) { out.read_failed = true; out.errors.push('read: ' + ((e && e.message) || e)); return out; }
  rows = Array.isArray(rows) ? rows : (rows ? [rows] : []);
  for (const bk of rows) {
    out.checked++;
    try {
      const id = first(await sbRpc(b, '_open_case', {
        p_kind: 'settlement_exception', p_dedupe: ABANDONED_DEDUPE_PREFIX + bk.booking_id, p_reason: 'cancellation_pending_abandoned',
        p_group: null, p_request: null, p_operation: null, p_session: null, p_pi: null, p_charge: null, p_refund: null, p_amount: null, p_currency: null,
        p_details: { booking_id: bk.booking_id, status: bk.status, payment_status: bk.payment_status, pending_since: bk.cancellation_pending_at, next_step: 'retry the cancellation in the store admin; the recorded decision is replayed' },
      }));
      if (id) out.cases_opened++; else { out.failed++; out.errors.push('abandoned: no case id for ' + bk.booking_id); }
    } catch (e) { out.failed++; out.errors.push('abandoned: ' + ((e && e.message) || e)); }
  }
  // cases whose booking's barrier has since cleared (the retry landed) are closed, in bounded batches
  try {
    for (let i = 0; i < closeBatches; i++) {
      const n = Number(first(await sbRpc(b, 'cancellation_abandoned_close', { p_limit: Math.max(1, Math.min(100, limit)) })) || 0);
      out.cases_resolved += n;
      if (n < Math.max(1, Math.min(100, limit))) break;
    }
  } catch (e) { out.failed++; out.errors.push('abandoned close: ' + ((e && e.message) || e)); }
  return out;
}
