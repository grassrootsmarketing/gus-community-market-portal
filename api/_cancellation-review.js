// api/_cancellation-review.js (2026-10-19, Codex refund-cutoff rev2 review R2-2): the operator resolution of a
// cancelled paid booking whose refund was left undecided, and the bounded sweep that makes sure every unresolved
// eligibility has its visible review case.
//
//   resolveCancellation(b, { booking, retailerId, operator, decision, reason })
//     'refund_granted': ONE allocation-scoped refund through the shared ledger path (reserveAndRefund, op
//     'review_grant', the booking's own allocation, the stored idempotency key on retry), then the resolution row
//     (booking_cancellation_resolve, insert-once), then the review case is closed. A retry after a partial run
//     replays each step idempotently: the ledger returns the existing reservation and resubmits under the same key,
//     the resolution RPC returns the existing row, the case update is a no-op.
//     'no_refund': the resolution row and the closed case; no money moves.
//     The initial decision (booking_cancellations) is never changed.
//   sweepCancellationReviews(b, { limit })
//     Every under_review cancellation without a resolution must have an open 'refund_requires_review' case
//     (dedupe 'refund-eligibility:<booking>'). The cancel route opens it; if that call failed, this sweep opens it
//     on the next refund-worker run, so the work item is discovered and not merely stored.
import { reserveAndRefund, sbRpc } from './_booking-refund.js';

async function sbGet(b, path) {
  const r = await fetch(`${b.supabaseUrl}/rest/v1/${path}`, { headers: { apikey: b.serviceKey, Authorization: `Bearer ${b.serviceKey}` } });
  const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch (_) {}
  if (!r.ok) throw new Error(t || ('HTTP ' + r.status));
  return j;
}
async function sbPatch(b, path, body) {
  const r = await fetch(`${b.supabaseUrl}/rest/v1/${path}`, {
    method: 'PATCH', headers: { apikey: b.serviceKey, Authorization: `Bearer ${b.serviceKey}`, 'Content-Type': 'application/json', Prefer: 'return=representation' },
    body: JSON.stringify(body),
  });
  const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch (_) {}
  if (!r.ok) throw new Error(t || ('HTTP ' + r.status));
  return Array.isArray(j) ? j : [];
}
const first = (x) => (Array.isArray(x) ? x[0] : x);

export const CASE_DEDUPE_PREFIX = 'refund-eligibility:';

export async function openEligibilityCase(b, booking, decision) {
  const r = await sbRpc(b, '_open_case', {
    p_kind: 'refund_requires_review', p_dedupe: CASE_DEDUPE_PREFIX + booking.id, p_reason: 'refund_eligibility_unresolved',
    p_group: null, p_request: null, p_operation: null, p_session: null, p_pi: booking.payment_intent_id || null, p_charge: null, p_refund: null, p_amount: null, p_currency: null,
    p_details: { booking_id: booking.id, category: decision.category || null, requested_at: decision.requested_at || null, start_source: decision.start_source || null,
      demo_date: booking.demo_date, demo_time: booking.demo_time, timezone: decision.timezone || null, opened_by: decision.opened_by || 'cancel_route' },
  });
  return first(r) || null;
}

export async function closeEligibilityCase(b, bookingId, operator, note) {
  // the case is closed only by a recorded resolution; the update is idempotent (status filter)
  const rows = await sbPatch(b, `reconciliation_cases?dedupe_key=eq.${encodeURIComponent(CASE_DEDUPE_PREFIX + bookingId)}&status=neq.resolved`,
    { status: 'resolved', resolved_by: operator || null, resolved_at: new Date().toISOString()});
  return rows.map(r => r.id);
}

export async function loadCancellation(b, bookingId) {
  const [dec, res, cases] = await Promise.all([
    sbGet(b, `booking_cancellations?booking_id=eq.${encodeURIComponent(bookingId)}&select=*`),
    sbGet(b, `booking_cancellation_resolutions?booking_id=eq.${encodeURIComponent(bookingId)}&select=*`),
    sbGet(b, `reconciliation_cases?dedupe_key=eq.${encodeURIComponent(CASE_DEDUPE_PREFIX + bookingId)}&select=id,status,resolved_by,resolved_at`),
  ]);
  return { decision: first(dec) || null, resolution: first(res) || null, reviewCase: first(cases) || null };
}

// What the operator may do with this cancellation right now.
export function resolutionState({ booking, decision, resolution }) {
  if (!decision) return { resolvable: false, why: 'no_decision' };
  if (resolution) return { resolvable: false, why: 'resolved', resolution };
  if (!booking || !['cancelled', 'declined'].includes(String(booking.status || ''))) return { resolvable: false, why: 'not_cancelled' };
  if (decision.refund === true) return { resolvable: false, why: 'already_refunding' };
  if (decision.status === 'not_paid') return { resolvable: false, why: 'nothing_to_refund' };
  return { resolvable: true, why: decision.status };   // pending_manual | under_review
}

export async function resolveCancellation(b, { booking, retailerId, operator, decision, reason, caseId = null }) {
  if (!['refund_granted', 'no_refund'].includes(decision)) return { ok: false, status: 400, error: 'invalid_decision' };
  const why = String(reason || '').trim();
  if (!why) return { ok: false, status: 400, error: 'reason_required' };
  const cur = await loadCancellation(b, booking.id);
  if (cur.resolution) {
    // a replay: nothing is done again, the recorded answer is returned
    return { ok: true, status: 200, outcome: 'existing', existing: true, resolution: cur.resolution, decision: cur.decision, case_id: cur.reviewCase && cur.reviewCase.id, refund: null };
  }
  const st = resolutionState({ booking, decision: cur.decision, resolution: null });
  if (!st.resolvable) return { ok: false, status: 409, error: st.why, decision: cur.decision };
  let refund = null;
  if (decision === 'refund_granted') {
    // ONE allocation-scoped refund: this booking's allocation, its remaining entitlement, stable op key, stored
    // idempotency key on retry. Never an unscoped PaymentIntent refund.
    refund = await reserveAndRefund(b, booking, operator || null, 'review_grant: ' + why.slice(0, 200), 'review_grant');
    if (!refund.ok && !refund.retrying) {
      return { ok: false, status: 409, error: 'refund_not_possible', detail: refund.error, decision: cur.decision };
    }
  }
  const caseIdNow = caseId || (cur.reviewCase && cur.reviewCase.id) || null;
  const rr = first(await sbRpc(b, 'booking_cancellation_resolve', {
    p_booking_id: booking.id, p_retailer_id: retailerId, p_decision: decision, p_operator: operator || null, p_reason: why.slice(0, 500),
    p_refund_request_id: (refund && refund.refund_request_id) || null, p_case_id: caseIdNow,
  }));
  if (!rr || !['resolved', 'existing'].includes(rr.outcome)) {
    return { ok: false, status: 409, error: (rr && rr.outcome) || 'resolution_not_recorded', decision: cur.decision, refund };
  }
  let closed = [];
  try { closed = await closeEligibilityCase(b, booking.id, operator, decision); } catch (e) { closed = null; }
  return { ok: true, status: 200, outcome: rr.outcome, existing: rr.outcome === 'existing', resolution: rr.resolution, decision: rr.decision || cur.decision,
    refund, case_id: caseIdNow, case_closed: Array.isArray(closed) ? closed.length > 0 : null, case_close_failed: closed === null };
}

export async function sweepCancellationReviews(b, { limit = 25 } = {}) {
  const out = { checked: 0, opened: 0, already: 0, failed: 0, errors: [] };
  let rows;
  try { rows = await sbGet(b, `booking_cancellations?status=eq.under_review&select=booking_id,retailer_id,category,requested_at,start_source&order=decided_at.asc&limit=${Math.max(1, Math.min(100, limit))}`); }
  catch (e) { out.read_failed = true; out.errors.push('read: ' + ((e && e.message) || e)); return out; }
  rows = Array.isArray(rows) ? rows : [];
  if (!rows.length) return out;
  const ids = rows.map(r => r.booking_id);
  let resolved = [], cases = [], bookings = [];
  try {
    const inList = ids.map(encodeURIComponent).join(',');
    [resolved, cases, bookings] = await Promise.all([
      sbGet(b, `booking_cancellation_resolutions?booking_id=in.(${inList})&select=booking_id`),
      sbGet(b, `reconciliation_cases?dedupe_key=in.(${ids.map(id => '"' + CASE_DEDUPE_PREFIX + id + '"').join(',')})&select=dedupe_key`),
      sbGet(b, `bookings?id=in.(${inList})&select=id,payment_intent_id,demo_date,demo_time,status`),
    ]);
  } catch (e) { out.read_failed = true; out.errors.push('read: ' + ((e && e.message) || e)); return out; }
  const hasRes = new Set((resolved || []).map(r => r.booking_id));
  const hasCase = new Set((cases || []).map(c => String(c.dedupe_key).slice(CASE_DEDUPE_PREFIX.length)));
  const bk = new Map((bookings || []).map(x => [x.id, x]));
  for (const r of rows) {
    out.checked++;
    if (hasRes.has(r.booking_id)) continue;            // answered already: no case is owed
    if (hasCase.has(r.booking_id)) { out.already++; continue; }
    const booking = bk.get(r.booking_id);
    if (!booking) continue;
    try {
      const id = await openEligibilityCase(b, booking, { ...r, opened_by: 'refund_worker_sweep' });
      if (id) out.opened++; else { out.failed++; out.errors.push('open: no case id for ' + r.booking_id); }
    } catch (e) { out.failed++; out.errors.push('open: ' + ((e && e.message) || e)); }
  }
  return out;
}

// The Demohub mark for the resolution notice (the same markup api/booking-action.js draws; never a placeholder).
export function brandHeader() {
  return `<table cellpadding="0" cellspacing="0"><tr>
<td style="padding-right:12px;vertical-align:middle;">
<svg width="40" height="40" viewBox="0 0 72 72" xmlns="http://www.w3.org/2000/svg"><circle cx="36" cy="36" r="36" fill="#0f2c17"/><defs><radialGradient id="dhOrange" cx="0.36" cy="0.30" r="0.78"><stop offset="0" stop-color="#ff9a5c"/><stop offset="0.45" stop-color="#ed682f"/><stop offset="0.85" stop-color="#b8471a"/><stop offset="1" stop-color="#9a3a13"/></radialGradient></defs><circle cx="36" cy="40" r="18" fill="url(#dhOrange)"/><rect x="34.5" y="14" width="3" height="10" rx="1.2" fill="#fbf3e0"/><path d="M37 17 Q45 14 48 20 Q44 22 38 21 Q35 19 37 17 Z" fill="#87b08e"/></svg>
</td><td style="font-weight:800;font-size:24px;color:#fbf7f0;letter-spacing:-0.04em;">demohub</td>
</tr></table>`;
}
