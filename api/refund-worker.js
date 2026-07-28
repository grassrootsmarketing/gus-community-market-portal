// api/refund-worker.js — leased refund retry + reconciliation worker (Codex R10-P0-4/P0-7).
//
// Runs on a schedule behind CRON_SECRET. Every Stripe write reuses the refund request's stored
// idempotency key, so a resubmit can only ever return the ORIGINAL refund (never a double refund),
// and past Stripe's 24h idempotency window it refuses to blind-resubmit and reconciles by lookup.
//
// Concurrency-safe: claim_refund_work() leases due rows (SKIP LOCKED + owner + expiry), and
// release_refund_work() only writes if we still hold the lease. Outcomes are applied through the
// verified apply_refund_event() RPC — the worker never mutates ledger balances directly.
//
// Per leased request:
//   A. has a stripe_refund_id  -> GET the refund, apply_refund_event (recovers a lost webhook).
//   B. no id, age <= 24h       -> resubmit with the STORED idempotency key (Stripe returns the
//                                 original if one exists), then apply. NO currency param (Stripe's
//                                 Refund-create API rejects it — that was the R10-P0-4 bug).
//   C. no id, age > 24h        -> paginate the PI's refunds, adopt the one tagged with this request
//                                 id, else park requires_review. Never blind-resubmits.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const CRON_SECRET = process.env.CRON_SECRET;

const IDEMPOTENCY_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_ATTEMPTS = 8;
const BATCH = 25;

async function sbRpc(fn, args) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST', headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch (_) {}
  if (!r.ok) throw new Error((j && j.message) || t || ('HTTP ' + r.status));
  return j;
}
async function sbGet(path) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } });
  const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch (_) {}
  if (!r.ok) throw new Error(t || ('HTTP ' + r.status));
  return j;
}

async function stripeGetRefund(id) {
  const r = await fetch(`https://api.stripe.com/v1/refunds/${encodeURIComponent(id)}`, { headers: { Authorization: 'Bearer ' + STRIPE_SECRET_KEY } });
  const j = await r.json(); return r.ok ? { ok: true, refund: j } : { ok: false, error: (j.error && j.error.message) || ('HTTP ' + r.status) };
}
async function stripeSubmitRefund({ pi, amount, keepsAll, idempotencyKey, requestId, bookingId }) {
  const p = new URLSearchParams();
  p.set('payment_intent', pi);
  if (Number.isFinite(amount) && amount > 0) p.set('amount', String(Math.round(amount)));   // NO currency (Stripe rejects it on create)
  if (!keepsAll) { p.set('refund_application_fee', 'true'); p.set('reverse_transfer', 'true'); }  // exact for a single-allocation charge (multi-allocation connected is gated off)
  p.set('reason', 'requested_by_customer');
  p.set('metadata[refund_request_id]', String(requestId));
  if (bookingId) p.set('metadata[booking_id]', String(bookingId));
  const r = await fetch('https://api.stripe.com/v1/refunds', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + STRIPE_SECRET_KEY, 'Content-Type': 'application/x-www-form-urlencoded', 'Idempotency-Key': String(idempotencyKey).slice(0, 255) },
    body: p.toString(),
  });
  const j = await r.json(); return r.ok ? { ok: true, refund: j } : { ok: false, error: (j.error && j.error.message) || ('HTTP ' + r.status) };
}
async function stripeListRefundsForPI(pi) {
  const out = []; let startingAfter = null;
  for (let page = 0; page < 20; page++) {   // paginate until exhausted (R10-P0-4: not just first 100)
    let url = `https://api.stripe.com/v1/refunds?payment_intent=${encodeURIComponent(pi)}&limit=100`;
    if (startingAfter) url += `&starting_after=${encodeURIComponent(startingAfter)}`;
    const r = await fetch(url, { headers: { Authorization: 'Bearer ' + STRIPE_SECRET_KEY } });
    const j = await r.json(); if (!r.ok) return { ok: false, error: (j.error && j.error.message) || ('HTTP ' + r.status) };
    const data = Array.isArray(j.data) ? j.data : []; out.push(...data);
    if (!j.has_more || data.length === 0) break; startingAfter = data[data.length - 1].id;
  }
  return { ok: true, data: out };
}

async function applyRefundToLedger(row, refund) {
  return sbRpc('apply_refund_event', {
    p_refund_id: refund.id, p_status: refund.status || 'pending', p_amount: refund.amount, p_currency: refund.currency,
    p_pi: refund.payment_intent || null, p_charge: refund.charge || null, p_meta_request_id: row.id, p_event_id: null,
  });
}
function backoff(attempts) { return new Date(Date.now() + Math.min(60, Math.pow(2, Math.max(0, attempts))) * 60 * 1000).toISOString(); }

export default async function handler(req, res) {
  if (req.method !== 'POST' && req.method !== 'GET') return res.status(405).json({ error: 'POST only' });
  const provided = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!CRON_SECRET || provided !== CRON_SECRET) return res.status(401).json({ error: 'unauthorized' });
  if (!SUPABASE_URL || !SERVICE_KEY || !STRIPE_SECRET_KEY) return res.status(500).json({ error: 'server_not_configured' });

  const owner = 'refund-worker-' + Math.random().toString(36).slice(2, 10);
  const out = { ok: true, claimed: 0, reconciled: 0, resubmitted: 0, adopted: 0, manual: 0, lost_lease: 0, errors: 0 };
  try {
    const leased = await sbRpc('claim_refund_work', { p_owner: owner, p_lease_seconds: 120, p_limit: BATCH });
    const rows = Array.isArray(leased) ? leased : [];
    out.claimed = rows.length;

    for (const row of rows) {
      let nextStatus = row.status, nextAt = null, err = null;
      try {
        // enrich: PI + keeps-all off the allocation's group
        const enr = await sbGet(`payment_allocations?id=eq.${encodeURIComponent(row.payment_allocation_id)}&select=payment_groups!inner(stripe_payment_intent_id,platform_keeps_all)`);
        const grp = (enr && enr[0] && enr[0].payment_groups) || {};
        const pi = grp.stripe_payment_intent_id; const keepsAll = !!grp.platform_keeps_all;
        const ageMs = Date.now() - new Date(row.created_at).getTime();

        if (row.stripe_refund_id) {                                   // ---- A: reconcile from Stripe ----
          const g = await stripeGetRefund(row.stripe_refund_id);
          if (!g.ok) { out.errors++; err = ('get: ' + g.error).slice(0, 200); nextAt = backoff(row.attempts); }
          else { await applyRefundToLedger(row, g.refund); out.reconciled++; nextStatus = mapTerminal(g.refund.status, row.status); nextAt = terminalDue(g.refund.status); }
        } else if (!pi) {
          out.manual++; nextStatus = 'requires_review'; err = 'no_payment_intent';
        } else if (ageMs <= IDEMPOTENCY_WINDOW_MS) {                  // ---- B: safe replay ----
          const s = await stripeSubmitRefund({ pi, amount: row.amount, keepsAll, idempotencyKey: row.stripe_idempotency_key, requestId: row.id, bookingId: row.booking_id });
          if (s.ok) { await applyRefundToLedger(row, s.refund); out.resubmitted++; nextStatus = mapTerminal(s.refund.status, 'submitted'); nextAt = terminalDue(s.refund.status); }
          else { out.errors++; err = ('submit: ' + s.error).slice(0, 200); const capped = (row.attempts + 1) >= MAX_ATTEMPTS; nextStatus = capped ? 'requires_review' : 'failed_retryable'; nextAt = capped ? null : backoff(row.attempts); }
        } else {                                                     // ---- C: window expired, reconcile by lookup ----
          const list = await stripeListRefundsForPI(pi);
          if (!list.ok) { out.errors++; err = ('list: ' + list.error).slice(0, 200); nextAt = backoff(row.attempts); }
          else {
            const m = list.data.find(rf => rf.metadata && String(rf.metadata.refund_request_id) === String(row.id));
            if (m) { await applyRefundToLedger(row, m); out.adopted++; nextStatus = mapTerminal(m.status, 'submitted'); nextAt = terminalDue(m.status); }
            else { out.manual++; nextStatus = 'requires_review'; err = 'idempotency_window_expired_no_refund_found'; }
          }
        }
      } catch (e) { out.errors++; err = String((e && e.message) || e).slice(0, 200); nextAt = backoff(row.attempts); }

      // R11-P0-4: parking for review is ATOMIC — request + parent operation + one deduped
      // reconciliation case, reservation preserved (Stripe may still hold an unadopted refund).
      if (nextStatus === 'requires_review') {
        try { await sbRpc('park_refund_for_review', { p_request_id: row.id, p_owner: owner, p_reason: err || 'retry_cap_exhausted' }); }
        catch (_) { out.errors++; }
      }
      // release the lease (CAS on owner). If we lost it, another worker owns the row now.
      try {
        const held = await sbRpc('release_refund_work', { p_request_id: row.id, p_owner: owner, p_status: nextStatus, p_next_attempt_at: nextAt, p_last_error: err });
        if (held === false || (Array.isArray(held) && held[0] === false)) out.lost_lease++;
      } catch (_) { out.errors++; }
    }
    // R11-P1-4 safety net: report any fulfilment rows still pending. The webhook normally drains
    // these immediately; a row surviving here means every webhook attempt died mid-fulfilment, so it
    // needs operator visibility (the demo/emails for a PAID booking are outstanding).
    try {
      const stuck = await sbGet('booking_fulfillments?status=eq.pending&select=booking_id&limit=100');
      out.fulfillments_pending = Array.isArray(stuck) ? stuck.length : 0;
      if (out.fulfillments_pending > 0) console.warn('FULFILLMENT BACKLOG:', out.fulfillments_pending, 'paid booking(s) not fully fulfilled');
    } catch (_) { /* non-fatal */ }

    return res.status(200).json(out);
  } catch (e) {
    console.error('refund-worker error:', (e && e.message) || e);
    return res.status(500).json({ ok: false, error: 'worker_error' });
  }
}

// map a Stripe refund status to the request status we should persist, and when to look again
function mapTerminal(stripeStatus, fallback) {
  if (stripeStatus === 'succeeded') return 'succeeded';
  if (stripeStatus === 'failed') return 'failed_terminal';
  if (stripeStatus === 'canceled') return 'canceled';
  if (stripeStatus === 'requires_action') return 'requires_action';
  if (stripeStatus === 'pending') return 'pending';
  return fallback;
}
function terminalDue(stripeStatus) {
  // terminal outcomes need no re-poll; pending/requires_action get a modest re-check window
  if (['succeeded', 'failed', 'canceled'].includes(stripeStatus)) return null;
  return new Date(Date.now() + 15 * 60 * 1000).toISOString();
}
