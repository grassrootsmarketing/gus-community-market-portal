// api/_cancellation-review.js (2026-10-19, Codex refund-cutoff rev2 R2-2, reworked for rev3 R3-1 / R3-2 / R3-3): the
// operator resolution of a cancelled paid booking whose refund was left undecided, and the bounded sweeps that keep
// every unresolved eligibility visible and every started resolution finished.
//
//   resolveCancellation(b, { booking, retailerId, operator, decision, reason })
//     1. CLAIM first (booking_cancellation_claim, 0107): the resolution row is inserted under the booking's lock with
//        state 'claimed' before any provider effect. If a row already exists, the stored decision is returned and the
//        caller's own request issues nothing; the stored operation is then CONTINUED if it still owes a step.
//     2. The steps, each recorded on the row (booking_cancellation_progress) so a replay or the worker resumes from
//        the last mark: for a grant, ONE allocation-scoped refund through the shared ledger path (reserveAndRefund,
//        operation 'review_grant', the stored idempotency key on retry; the RPC validates the request belongs to this
//        booking and this retailer's payment group before linking it); the review case closed inside the RPC; the
//        brand told once under the notice key stored on the row (provider idempotency).
//     Every answer derives from the STORED decision and state, never from the losing request's action.
//   resumeResolution(b, booking, row): the same steps for a row that still owes some, used by replays and the worker.
//   sweepCancellationReviews(b, { limit }): cancellation_reviews_outstanding() picks, in the database, under_review
//     decisions with no resolution and no case, oldest-unattempted first, and stamps them; the sweep opens the case.
//     A row whose case open failed rotates behind the rest, so one poison row never starves the others.
//   sweepUnfinishedResolutions(b, { limit }): cancellation_resolutions_unfinished() picks claimed/pending/failed
//     resolutions past a grace period and the sweep resumes them.
//   sweepAbandonedCancellations(b, { limit, minutes }): a booking whose cancellation decision was recorded (the
//     barrier is set) but whose cancellation never landed is made visible as a deduplicated reconciliation case; the
//     operator finishes it by retrying the cancel (the route replays the recorded decision), which closes the case.
import { reserveAndRefund, sbRpc } from './_booking-refund.js';
import { sendMailQuietly, link } from './_mail.js';

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
export const ABANDONED_DEDUPE_PREFIX = 'cancel-abandoned:';

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

// Derived, truthful money wording for a stored resolution.
export function refundStatusOf(row) {
  if (!row) return 'none';
  if (row.decision !== 'refund_granted') return 'none';
  if (row.refund_request_id && row.refund_submitted_at) return 'submitted';
  if (row.refund_request_id) return 'refund_pending';   // parked for the refund worker's leased retry
  return 'pending';   // claimed or failed before the refund step
}

async function progress(b, bookingId, retailerId, mark, extra = {}) {
  const r = first(await sbRpc(b, 'booking_cancellation_progress', { p_booking_id: bookingId, p_retailer_id: retailerId, p_mark: mark, p_refund_request_id: extra.refund_request_id || null, p_error: extra.error || null }));
  if (!r || r.outcome !== 'marked') throw new Error('progress_' + mark + ':' + ((r && r.outcome) || 'no_result'));
  return r.resolution;
}

// The refund request this booking's 'review_grant' operation already created, if any (an attempt whose mark was lost).
async function findGrantRequest(b, bookingId) {
  const op = first(await sbGet(b, 'refund_operations?op_key=eq.' + encodeURIComponent(bookingId + ':review_grant') + '&select=id'));
  if (!op) return null;
  const rq = first(await sbGet(b, 'refund_requests?parent_operation_id=eq.' + encodeURIComponent(op.id) + '&booking_id=eq.' + encodeURIComponent(bookingId) + '&select=id,status&order=attempt_version.desc&limit=1'));
  if (!rq) return null;
  return { id: rq.id, settled: ['submitted', 'pending', 'succeeded'].includes(rq.status) };
}

// The steps a claimed resolution still owes, run in order and each recorded. Returns the row as it stands afterwards.
export async function resumeResolution(b, booking, row, { operator = null } = {}) {
  const bookingId = booking.id, retailerId = booking.retailer_id;
  let cur = row, refund = null, failed = null;
  try {
    if (cur.decision === 'refund_granted' && !cur.refund_request_id) {
      // ONE allocation-scoped refund: this booking's allocation, its remaining entitlement, a stable operation key; a
      // retry after a crash between the provider call and the mark returns the existing reservation and resubmits
      // under the SAME idempotency key, so the ledger obligation is adopted, never doubled.
      refund = await reserveAndRefund(b, booking, operator || cur.operator || null, 'review_grant: ' + String(cur.reason || '').slice(0, 200), 'review_grant');
      if (refund.ok) cur = await progress(b, bookingId, retailerId, 'refund_submitted', { refund_request_id: refund.refund_request_id });
      else if (refund.retrying && refund.refund_request_id) cur = await progress(b, bookingId, retailerId, 'refund_pending', { refund_request_id: refund.refund_request_id });
      else {
        // the ledger may already hold this grant's refund from an attempt whose mark was lost (nothing_refundable or
        // already_refunded on the same operation key): adopt that request instead of failing or refunding twice
        const adopted = ['nothing_refundable', 'already_refunded', 'existing'].includes(String(refund.error || '')) ? await findGrantRequest(b, bookingId) : null;
        if (adopted) { cur = await progress(b, bookingId, retailerId, adopted.settled ? 'refund_submitted' : 'refund_pending', { refund_request_id: adopted.id }); refund = { ok: true, adopted: true, refund_request_id: adopted.id }; }
        else { failed = 'refund:' + (refund.error || 'unknown'); cur = await progress(b, bookingId, retailerId, 'failed', { error: failed }); return { row: cur, refund, failed }; }
      }
    }
    // a grant parked as refund_pending has its request in the ledger; the refund worker's leased retry owns the
    // resubmission, and the row completes once that request is submitted (progress 'refund_submitted' from the retry
    // path below)
    if (cur.decision === 'refund_granted' && cur.state === 'refund_pending' && cur.refund_request_id) {
      const rq = first(await sbGet(b, `refund_requests?id=eq.${encodeURIComponent(cur.refund_request_id)}&select=id,status`));
      if (rq && ['submitted', 'pending', 'succeeded'].includes(rq.status)) cur = await progress(b, bookingId, retailerId, 'refund_submitted', { refund_request_id: cur.refund_request_id });
    }
    if (!cur.case_closed_at) cur = await progress(b, bookingId, retailerId, 'case_closed');
    if (!cur.brand_notified_at) {
      const sent = await notifyBrandOfResolution(b, booking, cur);
      if (sent) cur = await progress(b, bookingId, retailerId, 'brand_notified');
      else { failed = 'notice'; cur = await progress(b, bookingId, retailerId, 'failed', { error: 'brand notice not accepted by the provider' }); }
    }
  } catch (e) {
    failed = String((e && e.message) || e).slice(0, 200);
    try { cur = await progress(b, bookingId, retailerId, 'failed', { error: failed }); } catch (_) { /* the row keeps its last mark; the worker retries */ }
  }
  return { row: cur, refund, failed };
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
  let row = claim.resolution, refund = null, failed = null;
  if (row.state !== 'completed') {
    // the winner runs its steps. A replay (same or opposite request) continues the STORED operation only when it is not
    // being worked right now: a row claimed within the grace window belongs to the request that claimed it (two
    // concurrent grants must not both resubmit), and the refund worker finishes anything left behind after the grace.
    const ageMs = Date.now() - Date.parse(row.updated_at || 0);
    const graceMs = Number(process.env.RESOLUTION_REPLAY_GRACE_SECONDS || 120) * 1000;
    const mayResume = !existing || row.state === 'failed' || row.state === 'refund_pending' || !(ageMs < graceMs);
    if (mayResume) {
      const r = await resumeResolution(b, booking, row, { operator: existing ? null : operator });
      row = r.row; refund = r.refund; failed = r.failed;
    }
  }
  return { ok: true, status: 200, existing, requested: decision, decision_stored: row.decision, state: row.state, resolution: row,
    outcome: row.state === 'completed' ? (existing ? 'existing' : 'resolved') : 'in_progress',
    refund, refund_status: refundStatusOf(row), case_id: row.case_id || null, case_closed: !!row.case_closed_at, brand_notified: !!row.brand_notified_at, failed };
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

export async function sweepUnfinishedResolutions(b, { limit = 25, graceSeconds = 120 } = {}) {
  const out = { checked: 0, completed: 0, still_open: 0, failed: 0, errors: [] };
  let rows;
  try { rows = await sbRpc(b, 'cancellation_resolutions_unfinished', { p_limit: Math.max(1, Math.min(100, limit)), p_grace_seconds: graceSeconds }); }
  catch (e) { out.read_failed = true; out.errors.push('read: ' + ((e && e.message) || e)); return out; }
  rows = Array.isArray(rows) ? rows : (rows ? [rows] : []);
  for (const row of rows) {
    out.checked++;
    try {
      const bk = first(await sbGet(b, `bookings?id=eq.${encodeURIComponent(row.booking_id)}&select=*`));
      if (!bk) { out.failed++; out.errors.push('resume: booking missing ' + row.booking_id); continue; }
      const r = await resumeResolution(b, bk, row, {});
      if (r.row && r.row.state === 'completed') out.completed++; else out.still_open++;
      if (r.failed) out.errors.push('resume: ' + r.failed);
    } catch (e) { out.failed++; out.errors.push('resume: ' + ((e && e.message) || e)); }
  }
  return out;
}

export async function sweepAbandonedCancellations(b, { limit = 25, minutes = 15 } = {}) {
  const out = { checked: 0, cases_opened: 0, cases_resolved: 0, failed: 0, errors: [] };
  try {
    const cutoff = new Date(Date.now() - minutes * 60e3).toISOString();
    const rows = await sbGet(b, `bookings?cancellation_pending_at=lt.${encodeURIComponent(cutoff)}&status=in.(pending,confirmed,held)&select=id,retailer_id,status,payment_status,cancellation_pending_at&order=cancellation_pending_at.asc&limit=${Math.max(1, Math.min(100, limit))}`);
    for (const bk of (Array.isArray(rows) ? rows : [])) {
      out.checked++;
      try {
        const have = first(await sbGet(b, 'reconciliation_cases?dedupe_key=eq.' + encodeURIComponent(ABANDONED_DEDUPE_PREFIX + bk.id) + '&select=id'));
        if (have) continue;   // already visible
        const id = first(await sbRpc(b, '_open_case', {
          p_kind: 'settlement_exception', p_dedupe: ABANDONED_DEDUPE_PREFIX + bk.id, p_reason: 'cancellation_pending_abandoned',
          p_group: null, p_request: null, p_operation: null, p_session: null, p_pi: null, p_charge: null, p_refund: null, p_amount: null, p_currency: null,
          p_details: { booking_id: bk.id, status: bk.status, payment_status: bk.payment_status, pending_since: bk.cancellation_pending_at, next_step: 'retry the cancellation in the store admin; the recorded decision is replayed' },
        }));
        if (id) out.cases_opened++; else { out.failed++; out.errors.push('abandoned: no case id for ' + bk.id); }
      } catch (e) { out.failed++; out.errors.push('abandoned: ' + ((e && e.message) || e)); }
    }
    // cases whose booking's barrier has since cleared (the retry landed) are closed
    const open = await sbGet(b, `reconciliation_cases?dedupe_key=like.${encodeURIComponent(ABANDONED_DEDUPE_PREFIX + '%')}&status=neq.resolved&select=id,dedupe_key&limit=100`);
    const ids = (Array.isArray(open) ? open : []).map(c => String(c.dedupe_key).slice(ABANDONED_DEDUPE_PREFIX.length));
    if (ids.length) {
      const bks = await sbGet(b, `bookings?id=in.(${ids.map(encodeURIComponent).join(',')})&select=id,status,cancellation_pending_at`);
      for (const bk of (Array.isArray(bks) ? bks : [])) {
        if (bk.cancellation_pending_at == null) {
          try { const r = await sbPatch(b, `reconciliation_cases?dedupe_key=eq.${encodeURIComponent(ABANDONED_DEDUPE_PREFIX + bk.id)}&status=neq.resolved`, { status: 'resolved', resolved_by: 'refund-worker', resolved_at: new Date().toISOString() }); out.cases_resolved += r.length; }
          catch (e) { out.failed++; out.errors.push('abandoned resolve: ' + ((e && e.message) || e)); }
        }
      }
    }
  } catch (e) { out.read_failed = true; out.errors.push('read: ' + ((e && e.message) || e)); }
  return out;
}

// ---------------------------------------------------------------------------------------------
// The brand's notice, built from the stored resolution and sent under the row's notice key.
// ---------------------------------------------------------------------------------------------
const FROM_ADDRESS = process.env.FROM_ADDRESS || 'Demohub <bookings@demohubhq.com>';
const H = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export async function notifyBrandOfResolution(b, booking, row) {
  if (!booking.contact_email) return true;   // nobody to tell: the step is complete
  let retailerName = 'The store';
  try { const rt = await sbGet(b, `retailers?id=eq.${encodeURIComponent(booking.retailer_id)}&select=name`); if (Array.isArray(rt) && rt[0] && rt[0].name) retailerName = rt[0].name; } catch (_) {}
  const dateLabel = booking.demo_date ? new Date(booking.demo_date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }) : 'your demo date';
  const granted = row.decision === 'refund_granted';
  const body = granted
    ? (row.state === 'refund_submitted' || row.state === 'completed'
      ? 'Your refund request was submitted. We\'ll email you to confirm once it\'s completed, typically within 5&ndash;10 business days.'
      : 'Your refund is in progress and will be confirmed by email once it completes.')
    : H(retailerName) + ' reviewed the cancellation and the demo fee is not refunded. This is the store\'s final answer on this booking.';
  const subject = granted ? 'Refund approved for your demo on ' + dateLabel : 'Refund decision for your demo on ' + dateLabel;
  const html = '<!DOCTYPE html><html><body style="margin:0;padding:24px;background:#fbf7f0;font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,Helvetica,sans-serif;color:#1c1c1a;">' +
    '<table align="center" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;background:white;border-radius:16px;overflow:hidden;border:1px solid rgba(15,44,23,0.08);">' +
    '<tr><td style="padding:28px 32px;background:#0f2c17;">' + brandHeader() + '</td></tr>' +
    '<tr><td style="padding:36px 36px 28px;">' +
    '<div style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.14em;color:#2a5b32;margin-bottom:14px;">' + (granted ? 'Refund approved' : 'Refund decision') + '</div>' +
    '<h1 style="font-family:Georgia,serif;font-size:28px;font-weight:500;line-height:1.2;color:#0f2c17;margin:0 0 18px;">' + (granted ? 'Your demo fee is being refunded' : 'About the fee for your cancelled demo') + (booking.contact_name ? ', ' + H(booking.contact_name) : '') + '.</h1>' +
    '<p style="font-size:15px;line-height:1.6;color:#3a3a36;margin:0 0 18px;">This is about your cancelled demo for <strong>' + H(booking.brand_name || 'your brand') + '</strong> on ' + H(dateLabel) + (booking.demo_time ? ' at ' + H(booking.demo_time) : '') + ' at ' + H(retailerName) + '.</p>' +
    '<p style="font-size:15px;line-height:1.6;color:#3a3a36;margin:0 0 18px;">' + body + '</p>' +
    '<p style="font-size:14px;line-height:1.5;color:#6b6a64;margin:0;">Questions about this decision go to the store. You\'re welcome to book another date at <a href="' + link(b, '/') + '" style="color:#2a5b32;">demohubhq.com</a>.</p>' +
    '</td></tr>' +
    '<tr><td style="padding:20px 32px;background:#fbf7f0;border-top:1px solid rgba(15,44,23,0.06);font-size:12px;color:#6b6a64;text-align:center;">Powered by <strong style="color:#0f2c17;">Demohub</strong> &middot; demohubhq.com</td></tr>' +
    '</table></body></html>';
  const key = row.notice_key || ('cancellation-resolution:' + booking.id + ':' + row.decision);
  const sent = await sendMailQuietly({ from: FROM_ADDRESS, to: booking.contact_email, replyTo: 'bookings@demohubhq.com', subject, html }, { idempotencyKey: key });
  return !!(sent && (sent.ok || sent.id || sent === true));
}

// The Demohub mark for the resolution notice (the same markup api/booking-action.js draws; never a placeholder).
export function brandHeader() {
  return `<table cellpadding="0" cellspacing="0"><tr>
<td style="padding-right:12px;vertical-align:middle;">
<svg width="40" height="40" viewBox="0 0 72 72" xmlns="http://www.w3.org/2000/svg"><circle cx="36" cy="36" r="36" fill="#0f2c17"/><defs><radialGradient id="dhOrange" cx="0.36" cy="0.30" r="0.78"><stop offset="0" stop-color="#ff9a5c"/><stop offset="0.45" stop-color="#ed682f"/><stop offset="0.85" stop-color="#b8471a"/><stop offset="1" stop-color="#9a3a13"/></radialGradient></defs><circle cx="36" cy="40" r="18" fill="url(#dhOrange)"/><rect x="34.5" y="14" width="3" height="10" rx="1.2" fill="#fbf3e0"/><path d="M37 17 Q45 14 48 20 Q44 22 38 21 Q35 19 37 17 Z" fill="#87b08e"/></svg>
</td><td style="font-weight:800;font-size:24px;color:#fbf7f0;letter-spacing:-0.04em;">demohub</td>
</tr></table>`;
}
