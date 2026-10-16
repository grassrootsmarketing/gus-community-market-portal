// api/_booking-moves.js, retailer-initiated demo moves: settlement and the deadline sweep.
// Rewritten for the Codex review (RM-1 .. RM-6, 2026-10-16; migration 0095) and its closure response
// (C1 .. C4; migration 0096).
//
// A decline or a lapse owes the brand a cancellation and a full refund of the affected booking's
// refundable allocation. That obligation is settled here, and ONLY here, through a durable claim:
//
//   settleMove(b, move, { owner })
//     1. claim_move_settlement (database): booking-then-move lock; tenant, status, schedule revision and
//        lease verified. A move whose booking moved on to a valid newer schedule is retired there and
//        never cancels it (RM-1). A lease stops a second worker or the response route from settling the
//        same move at the same time.
//     2. the money step, judged on the CURRENT booking (RM-2 / RM-4 / C1):
//          verified no money     fee-waived, never paid, or already refunded      -> not_paid / already_refunded
//          durable obligation    the ledger reservation (refund_reserve_cas) exists; the request id is
//                                recorded on the move BEFORE anything else; the first attempt submits
//                                ONCE through the shared helper; every later attempt reads the request
//                                and never calls the provider (the leased refund worker owns recovery)
//                                                                                   -> submitted / pending_worker / succeeded
//          nonrecoverable prep   paid but no payment intent / no allocation / not charged / the request
//                                parked or missing: ONE deduplicated operator case ('move_refund:<id>')
//                                that MUST be persisted before the step counts as done; a failed case
//                                write is a retry, never a completion (C1)          -> review_required
//          recoverable failure   reservation RPC outage, malformed reply, state conflict -> not finalised, retried next run
//     3. booking_transition cancel (idempotent). A thrown error or a refused verdict with the booking
//        still active opens one deduplicated settlement case and leaves the move unsettled for the next run.
//     4. finalize_move_settlement (database, ONE transaction): the database re-checks the handoff (the
//        booking is inactive; a submitted / pending status names a refund request of this booking; a
//        review status names the 'move_refund' case; not_paid / already_refunded agree with the payment
//        state), then stamps the move, clears the booking's pending-settlement marker and inserts the
//        brand's 'demo_move_cancelled' event (RM-3). A refusal leaves the move unsettled and retryable.
//
//   sweepMoves(b, { now, limit })   run by the refund worker every 15 minutes:
//     a. lapse_booking_moves claims due pending moves (revision verified per row, clock after the lock);
//     b. unsettled declined/lapsed moves are settled, fewest attempts first; a row at the attempt cap is
//        parked behind one case, counted as parked only once the case is persisted AND linked (C2);
//     c. the notice scan (C2): pending moves are examined one by one, oldest-unchecked first and stamped
//        notice_checked_at so the scan always progresses; a move whose "please confirm" notice is
//        terminally undeliverable (every delivery failed/unknown with no retry scheduled, or skipped,
//        or no delivery two hours after the move) gets ONE operator case, linked on the move.
//     Every claim, read, case or link failure is a failure in the worker's verdict (RM-6 / C2).
// Nothing here sends mail; the outbox does.

import { reserveAndRefund, sbRpc } from './_booking-refund.js';

const enc = encodeURIComponent;
async function sb(b, path, opts = {}) {
  const headers = { apikey: b.serviceKey, Authorization: `Bearer ${b.serviceKey}`, 'Content-Type': 'application/json', Prefer: 'return=representation', ...(opts.headers || {}) };
  const r = await fetch(`${b.supabaseUrl}/rest/v1/${path}`, { ...opts, headers });
  const text = await r.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch (_) {}
  if (!r.ok) throw new Error((json && json.message) || text || `HTTP ${r.status}`);
  return json;
}
const rowsOf = (v, what) => { if (!Array.isArray(v)) throw new Error('malformed_' + what); return v; };
const firstRow = (v) => (Array.isArray(v) ? v[0] : v) || null;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const MOVE_SETTLE_OUTCOMES = ['declined', 'lapsed'];
export const SETTLE_MAX_ATTEMPTS = 8;
export const SETTLE_LEASE_SECONDS = 180;
export const NOTICE_GRACE_MS = 2 * 60 * 60 * 1000;
export const CANCEL_REASON = {
  declined: 'The brand could not make the new time after the store moved this demo.',
  lapsed: 'The brand did not reconfirm the new time after the store moved this demo.',
};
const INACTIVE = ['cancelled', 'declined', 'expired', 'auth_canceled'];
// refund_requests.status -> what the move records. Terminal review states are an operator's.
const REQUEST_STATUS_TO_REFUND = { succeeded: 'succeeded', submitted: 'submitted', pending: 'pending_worker', reserved: 'pending_worker', requires_action: 'pending_worker', failed_retryable: 'pending_worker', requires_review: 'review_required', failed_terminal: 'review_required', failed: 'review_required', canceled: 'review_required' };

export async function loadMove(b, moveId) {
  const rows = await sb(b, `booking_moves?id=eq.${enc(moveId)}&select=*`);
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}
// Opens (or returns) ONE case per dedupe key. Never swallows: { id } on success, { error } otherwise (C1 / C2).
export async function openCase(b, dedupe, reason, details, kind = 'settlement_exception') {
  try {
    const c = await sbRpc(b, '_open_case', {
      p_kind: kind, p_dedupe: dedupe, p_reason: reason,
      p_group: null, p_request: (details && details.refund_request_id) || null, p_operation: null, p_session: null, p_pi: null, p_charge: null, p_refund: null, p_amount: null, p_currency: null,
      p_details: details,
    });
    const id = Array.isArray(c) ? c[0] : c;
    if (typeof id !== 'string' || !UUID_RE.test(id)) return { id: null, error: 'case_malformed' };
    return { id, error: null };
  } catch (e) { return { id: null, error: 'case_failed: ' + String((e && e.message) || e).slice(0, 120) }; }
}

// The money step. Returns { refund_status, refund_request_id, refund_case_id, refund_id, retry, error }.
// A review_required outcome is only returned with a PERSISTED case id (C1); otherwise retry.
async function refundStep(b, move, booking) {
  const out = { refund_status: null, refund_request_id: move.refund_request_id || null, refund_case_id: move.refund_case_id || null, refund_id: null, retry: false, error: null };
  const outcome = move.status;
  const paid = String(booking.payment_status || '');
  const hasPi = !!booking.payment_intent_id;
  const review = async (reason, extra) => {
    const c = await openCase(b, 'move_refund:' + move.id, reason, { booking_id: booking.id, move_id: move.id, payment_status: paid, ...extra });
    if (!c.id) { out.retry = true; out.error = c.error || 'case_failed'; return out; }
    out.refund_case_id = c.id; out.refund_status = 'review_required'; return out;
  };
  // (c) a reservation already exists for this move: read it, never resubmit (RM-4).
  if (out.refund_request_id) {
    const rows = rowsOf(await sb(b, `refund_requests?id=eq.${enc(out.refund_request_id)}&select=id,status,stripe_refund_id,amount,booking_id`), 'refund_request');
    const rq = rows[0];
    if (!rq) return review('move_refund_request_missing', { refund_request_id: out.refund_request_id });
    if (rq.booking_id && rq.booking_id !== booking.id) return review('move_refund_request_foreign', { refund_request_id: rq.id });
    const mapped = REQUEST_STATUS_TO_REFUND[rq.status] || 'pending_worker';
    if (mapped === 'review_required') return review('move_refund_request_' + rq.status, { refund_request_id: rq.id, request_status: rq.status });
    out.refund_status = mapped; return out;
  }
  // (a) verified no money owed.
  if (booking.fee_waived === true || paid === 'waived') { out.refund_status = 'not_paid'; return out; }
  if (paid === 'refunded') { out.refund_status = 'already_refunded'; return out; }
  if (!['paid', 'refund_pending'].includes(paid) && !hasPi) { out.refund_status = 'not_paid'; return out; }
  if (['paid', 'refund_pending'].includes(paid) && !hasPi) return review('move_refund_inconsistent_payment_state', { payment_intent_id: null });
  if (!['paid', 'refund_pending'].includes(paid) && hasPi) return review('move_refund_unexpected_payment_status', {});
  // (b) first and only direct attempt: reserve (durable) and submit once through the shared helper.
  const r = await reserveAndRefund(b, booking, 'system:move_' + outcome, CANCEL_REASON[outcome], 'move_' + outcome, { onExisting: 'defer' });
  if (r.refund_request_id) out.refund_request_id = r.refund_request_id;
  if (r.ok) { out.refund_status = 'submitted'; out.refund_id = r.refund_id || null; return out; }
  if (r.error === 'nothing_refundable') { out.refund_status = 'already_refunded'; return out; }
  if (r.error === 'existing' || r.error === 'refund_failed') { out.refund_status = 'pending_worker'; return out; }   // durable request, the worker owns it
  if (r.error === 'no_allocation' || r.error === 'not_charged') return review('move_refund_' + r.error, {});
  // reserve_failed (RPC outage), reserve_malformed, booking_state_conflict, no_booking: recoverable, retried.
  out.retry = true; out.error = r.error || 'refund_preparation_failed';
  return out;
}

// Settle one declined/lapsed move. Idempotent per step; every exit is explicit.
export async function settleMove(b, moveIn, { owner = 'settle-' + Math.random().toString(36).slice(2, 10), now = new Date() } = {}) {
  const out = { ok: false, move_id: moveIn && moveIn.id, booking_id: moveIn && moveIn.booking_id, outcome: null, refund_status: null, refund_request_id: null, refund_case_id: null, cancelled: false, case_id: null, retry: false, error: null };
  if (!moveIn || !moveIn.id) { out.error = 'invalid_move'; return out; }
  let claim;
  try { claim = firstRow(await sbRpc(b, 'claim_move_settlement', { p_move_id: moveIn.id, p_owner: owner, p_lease_seconds: SETTLE_LEASE_SECONDS })); }
  catch (e) { out.error = 'claim_failed'; out.retry = true; return out; }
  if (!claim || claim.ok !== true) { out.error = (claim && claim.reason) || 'claim_refused'; out.retry = out.error === 'lease_held'; return out; }
  const move = claim.move, booking = claim.booking;
  out.outcome = move.status; out.booking_id = booking.id; out.case_id = move.reconciliation_case_id || null; out.refund_case_id = move.refund_case_id || null;
  if (!MOVE_SETTLE_OUTCOMES.includes(move.status)) { out.error = 'move_' + move.status; return out; }
  const fail = async (error) => {
    out.error = error; out.retry = true;
    try { await sbRpc(b, 'finalize_move_settlement', { p_move_id: move.id, p_owner: owner, p_settled: false, p_refund_status: out.refund_status, p_refund_request_id: out.refund_request_id, p_case_id: out.case_id, p_refund_case_id: out.refund_case_id, p_error: String(error).slice(0, 300), p_event_payload: null }); } catch (_) {}
    return out;
  };
  if (booking.status === 'held') {
    const c = await openCase(b, 'move_settle:' + move.id, 'move_settle_booking_held', { booking_id: booking.id, move_id: move.id });
    if (c.id) out.case_id = c.id;
    return fail(c.id ? 'booking_held' : 'booking_held; ' + c.error);
  }

  // 1. Money.
  let money;
  try { money = await refundStep(b, move, booking); }
  catch (e) { return fail('refund_step_' + String((e && e.message) || e).slice(0, 80)); }
  out.refund_status = money.refund_status; out.refund_request_id = money.refund_request_id; out.refund_case_id = money.refund_case_id;
  if (money.retry) return fail(money.error || 'refund_preparation_failed');
  // The request id (and the refund case) are durable on the move BEFORE the transition.
  if ((out.refund_request_id && out.refund_request_id !== move.refund_request_id) || (out.refund_case_id && out.refund_case_id !== move.refund_case_id)) {
    try { await sb(b, `booking_moves?id=eq.${enc(move.id)}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ refund_request_id: out.refund_request_id, refund_case_id: out.refund_case_id, refund_status: out.refund_status, updated_at: now.toISOString() }) }); }
    catch (e) { return fail('record_request_failed'); }
  }

  // 2. The booking transition (idempotent: 'already_applied' when cancelled already).
  const patch = { cancelled_at: now.toISOString(), cancel_reason: CANCEL_REASON[move.status] };
  if (money.refund_id) patch.refund_id = money.refund_id;
  if (out.refund_status === 'pending_worker' || out.refund_status === 'review_required') patch.payment_status = booking.payment_status === 'paid' ? 'refund_pending' : booking.payment_status;
  let tr = null;
  try { tr = firstRow(await sbRpc(b, 'booking_transition', { p_booking_id: booking.id, p_retailer_id: move.retailer_id, p_action: 'cancel', p_fields: patch, p_demo_fee: null })); }
  catch (e) {
    const c = await openCase(b, 'move_settle:' + move.id, 'booking_transition_failed_after_refund_step', { booking_id: booking.id, move_id: move.id, outcome: move.status, refund_status: out.refund_status, refund_request_id: out.refund_request_id, error: String((e && e.message) || e).slice(0, 300) });
    if (c.id) out.case_id = c.id;
    return fail(c.id ? 'transition_failed' : 'transition_failed; ' + c.error);
  }
  if (!tr || tr.ok !== true) {
    if (!INACTIVE.includes(String(booking.status || ''))) {
      const c = await openCase(b, 'move_settle:' + move.id, 'booking_transition_refused_' + ((tr && tr.reason) || 'unknown'), { booking_id: booking.id, move_id: move.id, outcome: move.status, refund_status: out.refund_status, refund_request_id: out.refund_request_id });
      if (c.id) out.case_id = c.id;
      return fail('transition_' + ((tr && tr.reason) || 'refused') + (c.id ? '' : '; ' + c.error));
    }
  }
  out.cancelled = true;

  // 3. Finalise: the database re-checks the handoff, then stamps and writes the brand's event in one transaction.
  let fin;
  try { fin = firstRow(await sbRpc(b, 'finalize_move_settlement', { p_move_id: move.id, p_owner: owner, p_settled: true, p_refund_status: out.refund_status, p_refund_request_id: out.refund_request_id, p_case_id: out.case_id, p_refund_case_id: out.refund_case_id, p_error: null, p_event_payload: { cancelled_at: patch.cancelled_at } })); }
  catch (e) { out.error = 'finalize_failed'; out.retry = true; return out; }
  if (!fin || fin.ok !== true) {
    const reason = (fin && fin.reason) || 'finalize_refused';
    if (reason === 'lease_lost' || reason === 'already_settled') { out.error = reason; out.retry = reason === 'lease_lost'; return out; }
    return fail('finalize_' + reason);
  }
  out.ok = true;
  return out;
}

// Is this move's "please confirm" notice terminally undeliverable? Judged on its deliveries (RM-8 / C2).
export function noticeUndeliverable(deliveries, movedAtMs, nowMs) {
  if (!Array.isArray(deliveries)) return false;
  if (!deliveries.length) return nowMs - movedAtMs >= NOTICE_GRACE_MS;   // never even queued
  const live = (d) => d.status === 'accepted' || d.status === 'pending' || d.status === 'claimed' || ((d.status === 'failed' || d.status === 'unknown') && d.next_attempt_at);
  return !deliveries.some(live);
}

// The worker step. Every failure is a failure (RM-6 / C2): flags for the claim, the read and the notice scan,
// counts per item; parked only once the case is persisted AND linked.
export async function sweepMoves(b, { now = new Date(), limit = 25, owner = 'sweep-' + Math.random().toString(36).slice(2, 10) } = {}) {
  const out = { lapsed: 0, settled: 0, failed: 0, parked: 0, retired: 0, notice_checked: 0, notice_cases: 0, claim_failed: false, read_failed: false, notice_failed: false, errors: [] };
  try { out.lapsed = rowsOf(await sbRpc(b, 'lapse_booking_moves', { p_limit: limit }), 'lapse_reply').length; }
  catch (e) { out.claim_failed = true; out.errors.push('lapse: ' + String((e && e.message) || e).slice(0, 160)); }
  let unsettled = [];
  try {
    unsettled = rowsOf(await sb(b, `booking_moves?status=in.(declined,lapsed)&settled_at=is.null&settle_attempts=lt.${SETTLE_MAX_ATTEMPTS}&select=*&order=settle_attempts.asc,updated_at.asc&limit=${limit}`), 'unsettled_reply');
  } catch (e) { out.read_failed = true; out.errors.push('read: ' + String((e && e.message) || e).slice(0, 160)); }
  for (const m of unsettled) {
    try {
      const r = await settleMove(b, m, { owner, now });
      if (r.ok) out.settled++;
      else if (r.error === 'lease_held' || r.error === 'already_settled') { /* another worker's */ }
      else if (r.error === 'revision_mismatch') out.retired++;
      else { out.failed++; out.errors.push(`settle ${m.id}: ${r.error || 'failed'}`); }
    } catch (e) { out.failed++; out.errors.push(`settle ${m.id}: ${String((e && e.message) || e).slice(0, 160)}`); }
  }
  // Rows at the attempt cap are parked behind one operator case each and leave the batch to the rest.
  try {
    const stuck = rowsOf(await sb(b, `booking_moves?status=in.(declined,lapsed)&settled_at=is.null&settle_attempts=gte.${SETTLE_MAX_ATTEMPTS}&reconciliation_case_id=is.null&select=id,booking_id,status,settle_last_error&limit=${limit}`), 'stuck_reply');
    for (const m of stuck) {
      const c = await openCase(b, 'move_settle:' + m.id, 'move_settlement_attempts_exhausted', { booking_id: m.booking_id, move_id: m.id, outcome: m.status, last_error: m.settle_last_error || null });
      if (!c.id) { out.failed++; out.errors.push(`park ${m.id}: ${c.error}`); continue; }
      try { await sb(b, `booking_moves?id=eq.${enc(m.id)}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ reconciliation_case_id: c.id, updated_at: now.toISOString() }) }); out.parked++; }
      catch (e) { out.failed++; out.errors.push(`park ${m.id}: link_failed`); }
    }
  } catch (e) { out.read_failed = true; out.errors.push('stuck: ' + String((e && e.message) || e).slice(0, 160)); }
  // C2: the notice scan, one examination per pending move, oldest-unchecked first, always stamped.
  try {
    const cutoff = new Date(now.getTime() - NOTICE_GRACE_MS).toISOString();
    const pend = rowsOf(await sb(b, `booking_moves?status=eq.pending&notice_case_id=is.null&moved_at=lte.${enc(cutoff)}&select=id,booking_id,moved_at,notice_checked_at&order=notice_checked_at.asc.nullsfirst,moved_at.asc&limit=${limit}`), 'notice_moves_reply');
    for (const m of pend) {
      out.notice_checked++;
      const dl = rowsOf(await sb(b, `notification_deliveries?kind=eq.demo_moved&occurrence_key=eq.${enc(m.id)}&select=id,status,next_attempt_at,skip_reason&limit=50`), 'notice_deliveries_reply');
      const patch = { notice_checked_at: now.toISOString(), updated_at: now.toISOString() };
      if (noticeUndeliverable(dl, new Date(m.moved_at).getTime(), now.getTime())) {
        const c = await openCase(b, 'move_notice:' + m.id, 'move_notice_undeliverable', { booking_id: m.booking_id, move_id: m.id, deliveries: dl.map(d => ({ id: d.id, status: d.status, skip_reason: d.skip_reason || null })) });
        if (!c.id) { out.notice_failed = true; out.errors.push(`notice ${m.id}: ${c.error}`); await sb(b, `booking_moves?id=eq.${enc(m.id)}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(patch) }).catch(() => {}); continue; }
        patch.notice_case_id = c.id;
        try { await sb(b, `booking_moves?id=eq.${enc(m.id)}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(patch) }); out.notice_cases++; }
        catch (e) { out.notice_failed = true; out.errors.push(`notice ${m.id}: link_failed`); }
        continue;
      }
      try { await sb(b, `booking_moves?id=eq.${enc(m.id)}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(patch) }); }
      catch (e) { out.notice_failed = true; out.errors.push(`notice ${m.id}: stamp_failed`); }
    }
  } catch (e) { out.notice_failed = true; out.errors.push('notice: ' + String((e && e.message) || e).slice(0, 160)); }
  return out;
}
