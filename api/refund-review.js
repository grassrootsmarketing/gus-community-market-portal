// api/refund-review.js — R12-P0-4: authenticated operator resolution of a stuck refund.
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
// Authorization is a real retailer-admin session with owner/admin role, and the operation must
// belong to that retailer (the RPCs re-check tenancy too). p_actor text is NEVER authorization.
import { requireRetailerMembership } from './_retailer-auth.js';

import { getBinding, sendBindingFailure } from './_env.js';
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
  let body = {}; try { body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}); } catch (_) {}

  // owner/admin only — a manager or viewer may not move money
  const auth = await requireRetailerMembership(req, body, null, ['owner', 'admin']);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

  const opKey = String(body.op_key || '');
  const action = String(body.action || 'inspect');
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

    // always look Stripe up — this is the evidence the decision rests on
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
      // refuse unless Stripe conclusively has no matching refund — prevents double-refunding
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
