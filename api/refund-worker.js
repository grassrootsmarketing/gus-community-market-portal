import { drainFulfillments } from './_fulfillment.js';
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
// self-call base for the shared fulfilment endpoint (Vercel provides VERCEL_URL per deployment)

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

// ---- R12-P0-5: external alerting for financial exceptions ----
// A durable reconciliation_cases row is necessary but NOT sufficient: a customer can be charged or
// owed a refund while nobody is looking at the database. One email per case id (deduped by the
// case's own alert_status, not per retry), never containing secrets or card data.
const ALERT_TO = process.env.ALERT_EMAIL || 'david@demohubhq.com';
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const ENV_LABEL = process.env.VERCEL_ENV || 'unknown';

function alertHtml(c) {
  const esc = (s) => String(s == null ? '—' : s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  const money = c.amount != null ? `$${(c.amount / 100).toFixed(2)} ${String(c.currency || 'usd').toUpperCase()}` : '—';
  const row = (k, v) => `<tr><td style="padding:6px 10px;color:#6b6a64;font-size:12px;">${esc(k)}</td><td style="padding:6px 10px;font-family:monospace;font-size:12px;">${esc(v)}</td></tr>`;
  return `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#1c1c1a;">
<h2 style="margin:0 0 4px;font-size:18px;">Payment exception: ${esc(c.kind)}</h2>
<p style="margin:0 0 14px;color:#6b6a64;font-size:13px;">Environment <strong>${esc(ENV_LABEL)}</strong> · needs operator review.</p>
<table style="border-collapse:collapse;background:#faf8f4;border:1px solid #ece5d8;border-radius:8px;">
${row('reason', c.reason)}${row('amount', money)}${row('case id', c.id)}
${row('payment group', c.payment_group_id)}${row('refund request', c.refund_request_id)}
${row('checkout session', c.stripe_checkout_session_id)}${row('payment intent', c.stripe_payment_intent_id)}
${row('charge', c.stripe_charge_id)}${row('refund', c.stripe_refund_id)}${row('opened', c.created_at)}
</table>
<p style="margin:14px 0 0;font-size:12px;color:#6b6a64;">No card or customer-sensitive data is included. Investigate via the reconciliation_cases table using the case id above.</p></div>`;
}

async function sendAlertEmail(c) {
  if (!RESEND_API_KEY) return { ok: false, reason: 'resend_not_configured' };
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + RESEND_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'Demohub Alerts <bookings@demohubhq.com>', to: ALERT_TO,
        subject: `[Demohub ${ENV_LABEL}] payment exception: ${c.kind} (${c.reason || 'review'})`,
        html: alertHtml(c),
      }),
    });
    let id = null, reason = null;
    try { const j = await r.json(); id = j && j.id; if (!r.ok) reason = (j && j.message) || ('HTTP ' + r.status); } catch (_) { if (!r.ok) reason = 'HTTP ' + r.status; }
    return { ok: r.ok, id, reason };
  } catch (e) { return { ok: false, reason: (e && e.message) || String(e) }; }
}

// Per-run send cap. A systemic failure can open cases in bulk; emailing every one would bury the
// signal (and can trip provider rate limits). Above the cap we send ONE digest naming the count and
// leave the rest pending for the next run, so nothing is lost and the operator still hears about it.
const ALERT_SEND_CAP = 5;

async function drainCaseAlerts(limit) {
  const owner = 'alert-' + Math.random().toString(36).slice(2, 10);
  const out = { claimed: 0, sent: 0, failed: 0, deferred: 0 };
  let rows = [];
  try { rows = await sbRpc('claim_case_alerts', { p_owner: owner, p_lease_seconds: 120, p_limit: limit }); }
  catch (e) { console.error('claim_case_alerts failed:', (e && e.message) || e); return out; }
  rows = Array.isArray(rows) ? rows : [];
  const send = rows.slice(0, ALERT_SEND_CAP);
  const defer = rows.slice(ALERT_SEND_CAP);

  for (const c of send) {
    out.claimed++;
    const r = await sendAlertEmail(c);
    if (r.ok) out.sent++; else { out.failed++; console.warn('alert send failed for case', c.id, r.reason); }
    try { await sbRpc('mark_case_alert', { p_case_id: c.id, p_owner: owner, p_ok: !!r.ok, p_message_id: r.id || null, p_err: r.reason || null }); }
    catch (_) { /* lease expired; will be retried */ }
  }
  // release the overflow WITHOUT marking sent, so the next run picks them up
  for (const c of defer) {
    out.claimed++; out.deferred++;
    try { await sbRpc('mark_case_alert', { p_case_id: c.id, p_owner: owner, p_ok: false, p_message_id: null, p_err: 'deferred_by_send_cap' }); } catch (_) {}
  }
  if (defer.length) {
    await sendAlertEmail({ id: 'digest', kind: 'alert_backlog', reason: `${defer.length} further exception(s) deferred this run`,
      amount: null, currency: null, created_at: new Date().toISOString(), details: null });
  }
  return out;
}

// R12-P0-2: fulfilment drain now lives in the shared module (no HTTP self-call — that hit
// Vercel deployment protection and added a needless network hop).
const FULFILL_BATCH = 25;

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
    // R12-P0-2: actually DRAIN the fulfilment outbox. Recovery must never depend on Stripe
    // redelivering a webhook — the webhook marks its event complete, so a row left pending after a
    // demo/email failure would otherwise sit unfulfilled forever. This claims rows under the same
    // lease, performs the real work, and completes/retries them.
    try {
      const f = await drainFulfillments({ limit: FULFILL_BATCH });
      out.fulfillments_processed = f.processed;
      out.fulfillments_completed = f.completed;
      out.fulfillments_failed = f.failed;
      const stuck = await sbGet('booking_fulfillments?status=eq.pending&select=booking_id&limit=100');
      out.fulfillments_pending = Array.isArray(stuck) ? stuck.length : 0;
      if (out.fulfillments_pending > 0) console.warn('FULFILLMENT BACKLOG:', out.fulfillments_pending, 'paid booking(s) not fully fulfilled');
    } catch (e) { out.errors++; console.error('fulfilment drain error:', (e && e.message) || e); }

    // R12-P0-5: notify an operator about every open financial exception (deduped per case).
    try {
      const a = await drainCaseAlerts(20);
      out.alerts_claimed = a.claimed; out.alerts_sent = a.sent; out.alerts_failed = a.failed;
    } catch (e) { out.errors++; console.error('alert drain error:', (e && e.message) || e); }

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
