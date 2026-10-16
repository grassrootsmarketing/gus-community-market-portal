// api/_booking-moves.js, retailer-initiated demo moves: settlement and the deadline sweep (2026-10-16).
//
// The move itself is one database transaction (0094 move_booking_by_retailer, called by
// api/booking-action.js action 'move'). The brand's answer is one database transaction (0094
// respond_booking_move, called by api/brand-account.js action 'move-respond'). What lives here is the
// money-and-state step that follows a "can't make it" or a missed deadline:
//
//   settleMove(b, move, { outcome })   outcome = 'declined' | 'lapsed'
//     1. refund the brand IN FULL through the shared ledger-backed path (api/_booking-refund.js,
//        operation key 'move_declined' / 'move_lapsed', so a retry can never refund twice);
//     2. cancel the booking through booking_transition (the 0074 trigger writes the store contacts'
//        "demo cancelled" notice from that status change);
//     3. stamp the move settled (settled_at, refund_status), and write the brand's
//        'demo_move_cancelled' event for the outbox (one per move, idempotent on transition_id).
//     A failure between 1 and 2 opens a deduplicated reconciliation case, as the retailer cancel path
//     does, and leaves settled_at NULL so the next worker run retries (every step is idempotent).
//
//   sweepMoves(b, { now, limit })   run by the refund worker every 15 minutes:
//     a. lapse_booking_moves claims pending moves past their deadline (status -> 'lapsed');
//     b. every unsettled declined/lapsed move is settled as above.
//
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

export const MOVE_SETTLE_OUTCOMES = ['declined', 'lapsed'];
export const CANCEL_REASON = {
  declined: 'The brand could not make the new time after the store moved this demo.',
  lapsed: 'The brand did not reconfirm the new time after the store moved this demo.',
};

export async function loadMove(b, moveId) {
  const rows = await sb(b, `booking_moves?id=eq.${enc(moveId)}&select=*`);
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

// Settle one declined/lapsed move: refund in full, cancel, stamp. Idempotent per step.
export async function settleMove(b, move, { outcome, actor = 'system', now = new Date() } = {}) {
  if (!move || !MOVE_SETTLE_OUTCOMES.includes(outcome)) return { ok: false, error: 'invalid_outcome' };
  const out = { ok: false, move_id: move.id, booking_id: move.booking_id, outcome, refund_status: 'not_paid', cancelled: false, case_id: null };
  const bookings = await sb(b, `bookings?id=eq.${enc(move.booking_id)}&select=*`);
  const booking = Array.isArray(bookings) ? bookings[0] : null;
  if (!booking) { out.error = 'booking_missing'; return out; }
  if (booking.retailer_id !== move.retailer_id) { out.error = 'tenant_mismatch'; return out; }

  // 1. Money first (as the retailer cancel path does). A held authorization is released, not refunded,
  //    by the existing provisional path; a move is only possible on pending/confirmed bookings, so a
  //    'held' row here means the state changed underneath and the step is left to an operator.
  const wasPaid = booking.payment_status === 'paid' && booking.payment_intent_id;
  const alreadyInactive = ['cancelled', 'declined', 'expired', 'auth_canceled'].includes(String(booking.status || ''));
  if (booking.status === 'held') { out.error = 'booking_held'; return out; }
  let refundInfo = null;
  if (!wasPaid) {
    out.refund_status = booking.payment_status === 'refunded' ? 'already_refunded' : 'not_paid';
  } else {
    refundInfo = await reserveAndRefund(b, booking, actor, CANCEL_REASON[outcome], 'move_' + outcome);
    if (refundInfo.ok) out.refund_status = 'submitted';
    else if (refundInfo.error === 'nothing_refundable') out.refund_status = 'already_refunded';
    else out.refund_status = 'refund_failed';
  }

  // 2. The booking transition (idempotent: 'already_applied' when it is cancelled already).
  const patch = { cancelled_at: now.toISOString(), cancel_reason: CANCEL_REASON[outcome] };
  if (refundInfo && refundInfo.ok && refundInfo.refund_id) patch.refund_id = refundInfo.refund_id;
  if (wasPaid && out.refund_status === 'refund_failed') patch.payment_status = 'refund_pending';
  let tr = null;
  try {
    const rows = await sbRpc(b, 'booking_transition', { p_booking_id: booking.id, p_retailer_id: move.retailer_id, p_action: 'cancel', p_fields: patch, p_demo_fee: null });
    tr = Array.isArray(rows) ? rows[0] : rows;
  } catch (e) {
    // Money may have moved; record it once and leave the move unsettled for the next run.
    try {
      const c = await sbRpc(b, '_open_case', {
        p_kind: 'settlement_exception', p_dedupe: 'move_settle:' + move.id,
        p_reason: 'booking_transition_failed_after_refund_step',
        p_group: null, p_request: null, p_operation: null, p_session: null, p_pi: null, p_charge: null, p_refund: null, p_amount: null, p_currency: null,
        p_details: { booking_id: booking.id, move_id: move.id, outcome, refund_status: out.refund_status, error: String((e && e.message) || e).slice(0, 300) },
      });
      out.case_id = Array.isArray(c) ? c[0] : c;
      await sb(b, `booking_moves?id=eq.${enc(move.id)}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ reconciliation_case_id: out.case_id || null, refund_status: out.refund_status, updated_at: now.toISOString() }) }).catch(() => {});
    } catch (_) { /* recorded below as an error; the next run retries */ }
    out.error = 'transition_failed';
    return out;
  }
  if (!tr || tr.ok !== true) {
    if (!alreadyInactive) { out.error = 'transition_' + ((tr && tr.reason) || 'refused'); return out; }
  }
  out.cancelled = true;

  // 3. Stamp the move and write the brand's cancellation notice (idempotent on transition_id).
  await sb(b, `booking_moves?id=eq.${enc(move.id)}&settled_at=is.null`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ settled_at: now.toISOString(), refund_status: out.refund_status, updated_at: now.toISOString() }) });
  await sb(b, 'notification_events?on_conflict=kind,transition_id', {
    method: 'POST', headers: { Prefer: 'return=minimal,resolution=ignore-duplicates' },
    body: JSON.stringify([{ retailer_id: move.retailer_id, booking_id: move.booking_id, brand_id: move.brand_id || booking.brand_id || null, kind: 'demo_move_cancelled', transition_id: move.id + ':cancelled',
      payload: { move_id: move.id, outcome, refund_status: out.refund_status, to_date: move.to_date, to_time: move.to_time, from_date: move.from_date, from_time: move.from_time, note: move.note || null } }]),
  });
  out.ok = true;
  return out;
}

// The worker step. Returns counts and the first error (operator-safe prose only).
export async function sweepMoves(b, { now = new Date(), limit = 25 } = {}) {
  const out = { lapsed: 0, settled: 0, failed: 0, errors: [] };
  let claimed = [];
  try { claimed = await sbRpc(b, 'lapse_booking_moves', { p_limit: limit }); }
  catch (e) { out.errors.push('lapse: ' + String((e && e.message) || e).slice(0, 160)); return out; }
  out.lapsed = Array.isArray(claimed) ? claimed.length : 0;
  let unsettled = [];
  try { unsettled = await sb(b, `booking_moves?status=in.(declined,lapsed)&settled_at=is.null&select=*&order=updated_at.asc&limit=${limit}`); }
  catch (e) { out.errors.push('read: ' + String((e && e.message) || e).slice(0, 160)); return out; }
  for (const m of (Array.isArray(unsettled) ? unsettled : [])) {
    try {
      const r = await settleMove(b, m, { outcome: m.status, now });
      if (r.ok) out.settled++; else { out.failed++; out.errors.push(`settle ${m.id}: ${r.error || 'failed'}`); }
    } catch (e) { out.failed++; out.errors.push(`settle ${m.id}: ${String((e && e.message) || e).slice(0, 160)}`); }
  }
  return out;
}
