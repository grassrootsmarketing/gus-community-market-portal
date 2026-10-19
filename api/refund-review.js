// api/refund-review.js, R12-P0-4: authenticated operator resolution of a stuck refund.
//
// A parked refund holds a reservation because Stripe MIGHT already have issued the refund. Only a
// human who has actually looked can decide. This endpoint does the looking for them (server-side,
// paginated) and then applies one of two atomic outcomes:
//
//   action=inspect  -> report ledger + live Stripe state; no mutation.
//   action=adopt    -> Stripe HAS the refund: attach it and let the normal event path converge.
//   action=replace  -> Stripe conclusively does NOT: release the exact reservation, supersede the
//                      old request, mint version N+1 with a fresh idempotency key.
//
// Codex refund-cutoff R2-2 (2026-10-19), keyed by booking_id instead of op_key: the operator's answer to a
// cancelled paid booking whose refund was left undecided by the 72-hour rule (pending_manual) or by an
// unresolvable start (under_review). There is no refund operation yet, so this is where the FIRST refund of
// such a booking is authorized.
//   action=cancellation   -> report the decision, the resolution (if any) and the review case; no mutation.
//   action=grant          -> one allocation-scoped refund (the booking's own allocation, stable operation
//                            identity, stored idempotency key on retry), a resolution row recorded once, the
//                            review case closed, the brand told. Repeating it returns the recorded resolution.
//   action=deny           -> a documented no-refund resolution, the case closed, the brand told.
//   The initial decision row is never rewritten. See api/_cancellation-review.js.
//
// Authorization is a real retailer-admin session with owner/admin role, and the operation must
// belong to that retailer (the RPCs re-check tenancy too). p_actor text is NEVER authorization.
import { requireRetailerMembership } from './_retailer-auth.js';

import { getBinding, sendBindingFailure } from './_env.js';
import { requireSameOrigin } from './_csrf.js';
import { sendMailQuietly, link } from './_mail.js';
import { brandHeader, loadCancellation, resolutionState, resolveCancellation } from './_cancellation-review.js';
let _b = null;
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;

async function sbRpc(fn, args) {
  const r = await fetch(`${_b.supabaseUrl}/rest/v1/rpc/${fn}`, {
    method: 'POST', headers: { apikey: _b.serviceKey, Authorization: `Bearer ${_b.serviceKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch (_) {}
  if (!r.ok) throw new Error((j && j.message) || t || ('HTTP ' + r.status));
  return Array.isArray(j) ? j[0] : j;
}
async function sbGet(path) {
  const r = await fetch(`${_b.supabaseUrl}/rest/v1/${path}`, { headers: { apikey: _b.serviceKey, Authorization: `Bearer ${_b.serviceKey}` } });
  const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch (_) {}
  if (!r.ok) throw new Error(t || ('HTTP ' + r.status));
  return j;
}

// Paginate ALL refunds on the PaymentIntent so "not found" is a conclusion, not a guess.
async function stripeFindRefund(pi, requestId) {
  const seen = []; let startingAfter = null;
  for (let page = 0; page < 20; page++) {
    let url = `https://api.stripe.com/v1/refunds?payment_intent=${encodeURIComponent(pi)}&limit=100`;
    if (startingAfter) url += `&starting_after=${encodeURIComponent(startingAfter)}`;
    const r = await fetch(url, { headers: { Authorization: 'Bearer ' + STRIPE_SECRET_KEY } });
    const j = await r.json();
    if (!r.ok) return { ok: false, error: (j.error && j.error.message) || ('HTTP ' + r.status) };
    const data = Array.isArray(j.data) ? j.data : [];
    for (const rf of data) seen.push({ id: rf.id, status: rf.status, amount: rf.amount, currency: rf.currency, meta_request_id: (rf.metadata || {}).refund_request_id || null });
    if (!j.has_more || data.length === 0) break;
    startingAfter = data[data.length - 1].id;
  }
  const match = seen.find(rf => String(rf.meta_request_id || '') === String(requestId));
  return { ok: true, match: match || null, scanned: seen.length, refunds: seen };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!STRIPE_SECRET_KEY) return res.status(500).json({ error: 'server_not_configured' });
  try { _b = await getBinding(); } catch (e) { return sendBindingFailure(res, e); }
  // Codex finding B, CSRF wiring: adopt/replace resolve a parked refund and can release a reservation or mint a new one.
  // Checked before the session is read. No exemption applies, this route is cookie-authenticated
  // and carries neither a Stripe signature nor a CRON_SECRET.
  if (!requireSameOrigin(req, res, _b)) return;
  let body = {}; try { body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}); } catch (_) {}

  // owner/admin only, a manager or viewer may not move money
  const auth = await requireRetailerMembership(req, body, null, ['owner', 'admin']);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

  const opKey = String(body.op_key || '');
  const action = String(body.action || 'inspect');
  if (['cancellation', 'grant', 'deny'].includes(action)) return handleCancellationResolution(req, res, auth, body, action);
  if (!opKey) return res.status(400).json({ error: 'op_key required' });

  try {
    // load the operation + its allocation/group, and confirm it belongs to THIS retailer
    const rows = await sbGet(`refund_operations?op_key=eq.${encodeURIComponent(opKey)}&select=id,status,amount,currency,booking_id,payment_allocation_id`);
    const op = Array.isArray(rows) ? rows[0] : null;
    if (!op) return res.status(404).json({ error: 'operation_not_found' });

    const allocRows = await sbGet(`payment_allocations?id=eq.${encodeURIComponent(op.payment_allocation_id)}&select=id,customer_amount,refunded_amount,reserved_refund_amount,payment_groups!inner(id,retailer_id,stripe_payment_intent_id)`);
    const alloc = Array.isArray(allocRows) ? allocRows[0] : null;
    const grp = alloc && alloc.payment_groups;
    if (!grp || grp.retailer_id !== auth.retailer_id) return res.status(403).json({ error: 'not_your_operation' });

    const reqRows = await sbGet(`refund_requests?parent_operation_id=eq.${encodeURIComponent(op.id)}&select=id,attempt_version,status,amount,stripe_refund_id,last_error,attempts&order=attempt_version.desc`);
    const latest = Array.isArray(reqRows) ? reqRows[0] : null;

    // always look Stripe up, this is the evidence the decision rests on
    const look = grp.stripe_payment_intent_id && latest
      ? await stripeFindRefund(grp.stripe_payment_intent_id, latest.id)
      : { ok: false, error: 'no_payment_intent_or_request' };

    if (action === 'inspect') {
      return res.status(200).json({ ok: true, operation: op, allocation: { customer_amount: alloc.customer_amount, refunded: alloc.refunded_amount, reserved: alloc.reserved_refund_amount },
        requests: reqRows, stripe: look, recommendation: look.ok ? (look.match ? 'adopt' : 'replace') : 'investigate' });
    }

    const evidence = { checked_at: new Date().toISOString(), payment_intent: grp.stripe_payment_intent_id,
      scanned: look.scanned || 0, match: look.match || null, stripe_error: look.ok ? null : look.error };

    if (action === 'adopt') {
      if (!look.ok) return res.status(502).json({ error: 'stripe_lookup_failed', detail: look.error });
      if (!look.match) return res.status(409).json({ error: 'no_matching_stripe_refund', hint: 'use action=replace' });
      const r = await sbRpc('resolve_refund_adopt', { p_op_key: opKey, p_operator: auth.email, p_retailer_id: auth.retailer_id, p_refund_id: look.match.id, p_evidence: evidence });
      return res.status(r && r.outcome === 'adopted' ? 200 : 409).json(r);
    }

    if (action === 'replace') {
      // refuse unless Stripe conclusively has no matching refund, prevents double-refunding
      if (!look.ok) return res.status(502).json({ error: 'stripe_lookup_failed', detail: look.error });
      if (look.match) return res.status(409).json({ error: 'stripe_refund_exists', stripe_refund_id: look.match.id, hint: 'use action=adopt' });
      const r = await sbRpc('resolve_refund_replace', { p_op_key: opKey, p_operator: auth.email, p_retailer_id: auth.retailer_id, p_evidence: evidence });
      return res.status(r && r.outcome === 'replacement_created' ? 200 : 409).json(r);
    }

    return res.status(400).json({ error: 'unknown action' });
  } catch (e) {
    console.error('refund-review error:', (e && e.message) || e);
    return res.status(500).json({ error: 'refund_review_error' });
  }
}

// ---------------------------------------------------------------------------------------------
// Cancellation resolution (R2-2): booking-keyed, retailer owner/admin, same-origin (checked above).
// ---------------------------------------------------------------------------------------------
const isUuid = (v) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(v || ''));
async function handleCancellationResolution(req, res, auth, body, action) {
  const bookingId = String(body.booking_id || '');
  if (!isUuid(bookingId)) return res.status(400).json({ error: 'booking_id required' });
  try {
    const rows = await sbGet(`bookings?id=eq.${encodeURIComponent(bookingId)}&select=*`);
    const booking = Array.isArray(rows) ? rows[0] : null;
    if (!booking) return res.status(404).json({ error: 'booking_not_found' });
    if (booking.retailer_id !== auth.retailer_id) return res.status(403).json({ error: 'not_your_booking' });
    if (action === 'cancellation') {
      const cur = await loadCancellation(_b, bookingId);
      const st = resolutionState({ booking, decision: cur.decision, resolution: cur.resolution });
      return res.status(200).json({ ok: true, booking_id: bookingId, status: booking.status, payment_status: booking.payment_status, decision: cur.decision, resolution: cur.resolution, review_case: cur.reviewCase, resolvable: st.resolvable, why: st.why });
    }
    const decision = action === 'grant' ? 'refund_granted' : 'no_refund';
    const reason = String(body.reason || '').trim();
    if (!reason) return res.status(400).json({ error: 'reason_required', message: 'Say why, in a sentence; it is recorded with your decision.' });
    const r = await resolveCancellation(_b, { booking, retailerId: auth.retailer_id, operator: auth.email, decision, reason });
    if (!r.ok) return res.status(r.status || 409).json({ ok: false, error: r.error, detail: r.detail || undefined, decision: r.decision || undefined });
    let brand_notified = null;
    if (!r.existing) {
      // The brand hears the answer once, when it is first recorded. A replay does not send again.
      try { brand_notified = await notifyBrandOfResolution(booking, decision, r); } catch (_) { brand_notified = false; }
    }
    return res.status(200).json({ ok: true, booking_id: bookingId, outcome: r.outcome, existing: r.existing, decision: r.decision, resolution: r.resolution,
      refund_status: decision === 'refund_granted' ? (r.existing ? 'recorded' : (r.refund && r.refund.ok ? 'submitted' : (r.refund && r.refund.retrying ? 'refund_pending' : 'none'))) : 'none',
      refund_id: (r.refund && r.refund.refund_id) || undefined, refund_request_id: (r.refund && r.refund.refund_request_id) || undefined,
      case_id: r.case_id || null, case_closed: r.case_closed, brand_notified });
  } catch (e) {
    console.error('refund-review cancellation error:', (e && e.message) || e);
    return res.status(500).json({ error: 'refund_review_error' });
  }
}

const FROM_ADDRESS = process.env.FROM_ADDRESS || 'Demohub <bookings@demohubhq.com>';
const H = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
async function notifyBrandOfResolution(booking, decision, r) {
  if (!booking.contact_email) return false;
  let retailerName = 'The store';
  try { const rt = await sbGet(`retailers?id=eq.${encodeURIComponent(booking.retailer_id)}&select=name`); if (Array.isArray(rt) && rt[0] && rt[0].name) retailerName = rt[0].name; } catch (_) {}
  const dateLabel = booking.demo_date ? new Date(booking.demo_date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }) : 'your demo date';
  const granted = decision === 'refund_granted';
  const body = granted
    ? (r.refund && r.refund.ok
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
    '<p style="font-size:14px;line-height:1.5;color:#6b6a64;margin:0;">Questions about this decision go to the store. You\'re welcome to book another date at <a href="' + link(_b, '/') + '" style="color:#2a5b32;">demohubhq.com</a>.</p>' +
    '</td></tr>' +
    '<tr><td style="padding:20px 32px;background:#fbf7f0;border-top:1px solid rgba(15,44,23,0.06);font-size:12px;color:#6b6a64;text-align:center;">Powered by <strong style="color:#0f2c17;">Demohub</strong> &middot; demohubhq.com</td></tr>' +
    '</table></body></html>';
  const sent = await sendMailQuietly({ from: FROM_ADDRESS, to: booking.contact_email, replyTo: 'bookings@demohubhq.com', subject, html }, { idempotencyKey: 'cancellation-resolution:' + booking.id + ':' + decision });
  return !!(sent && (sent.ok || sent.id || sent === true));
}
