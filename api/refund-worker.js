import { drainFulfillments } from './_fulfillment.js';
// api/refund-worker.js, leased refund retry + reconciliation worker (Codex R10-P0-4/P0-7).
//
// Runs on a schedule behind CRON_SECRET. Every Stripe write reuses the refund request's stored
// idempotency key, so a resubmit can only ever return the ORIGINAL refund (never a double refund),
// and past Stripe's 24h idempotency window it refuses to blind-resubmit and reconciles by lookup.
//
// Concurrency-safe: claim_refund_work() leases due rows (SKIP LOCKED + owner + expiry), and
// release_refund_work() only writes if we still hold the lease. Outcomes are applied through the
// verified apply_refund_event() RPC, the worker never mutates ledger balances directly.
//
// Per leased request:
//   A. has a stripe_refund_id  -> GET the refund, apply_refund_event (recovers a lost webhook).
//   B. no id, age <= 24h       -> resubmit with the STORED idempotency key (Stripe returns the
//                                 original if one exists), then apply. NO currency param (Stripe's
//                                 Refund-create API rejects it, that was the R10-P0-4 bug).
//   C. no id, age > 24h        -> paginate the PI's refunds, adopt the one tagged with this request
//                                 id, else park requires_review. Never blind-resubmits.

import { getBinding, sendBindingFailure } from './_env.js';
import { sendMailQuietly } from './_mail.js';
import { sweepMoves } from './_booking-moves.js';
import { sweepCancellationReviews, sweepUnfinishedResolutions, sweepAbandonedCancellations } from './_cancellation-review.js';
import { settleConnectRefund, stripeIdOf } from './_booking-refund.js';
let _b = null;
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const CRON_SECRET = process.env.CRON_SECRET;
// self-call base for the shared fulfilment endpoint (Vercel provides VERCEL_URL per deployment)

const IDEMPOTENCY_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_ATTEMPTS = 8;
const BATCH = 25;

async function sbRpc(fn, args) {
  const r = await fetch(`${_b.supabaseUrl}/rest/v1/rpc/${fn}`, {
    method: 'POST', headers: { apikey: _b.serviceKey, Authorization: `Bearer ${_b.serviceKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch (_) {}
  if (!r.ok) throw new Error((j && j.message) || t || ('HTTP ' + r.status));
  return j;
}
async function sbGet(path) {
  const r = await fetch(`${_b.supabaseUrl}/rest/v1/${path}`, { headers: { apikey: _b.serviceKey, Authorization: `Bearer ${_b.serviceKey}` } });
  const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch (_) {}
  if (!r.ok) throw new Error(t || ('HTTP ' + r.status));
  return j;
}

// Phase E: per-job liveness. One APPEND-ONLY cron_heartbeat row per completed run, same write shape
// as brand-account.js's daily cron ({cron_name, outcome, duration_ms, summary}). The public status
// route judges each cron_name by its LATEST completed row: healthy only while that row is a fresh
// 'succeeded'. Codex F-03: a run is 'succeeded' ONLY when every claimed item succeeded, any per-item
// error after claim, any fulfilment failure, or any failed operator alert writes 'failed'
// (summary.partial=true) and returns 500 so Vercel's cron log agrees with the heartbeat.
// Best-effort: a heartbeat failure must never fail (or retry) the job itself.
const CRON_NAME = 'refund-worker';
async function heartbeat(outcome, startMs, summary) {
  try {
    if (!_b) return;
    await fetch(`${_b.supabaseUrl}/rest/v1/cron_heartbeat`, {
      method: 'POST',
      headers: { apikey: _b.serviceKey, Authorization: `Bearer ${_b.serviceKey}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify({ cron_name: CRON_NAME, outcome, duration_ms: Date.now() - startMs, summary }),
    });
  } catch (_) { /* best-effort */ }
}

async function stripeGetRefund(id) {
  const r = await fetch(`https://api.stripe.com/v1/refunds/${encodeURIComponent(id)}`, { headers: { Authorization: 'Bearer ' + STRIPE_SECRET_KEY } });
  const j = await r.json(); return r.ok ? { ok: true, refund: j } : { ok: false, error: (j.error && j.error.message) || ('HTTP ' + r.status) };
}
async function stripeSubmitRefund({ pi, amount, keepsAll, strategy, idempotencyKey, requestId, bookingId }) {
  const p = new URLSearchParams();
  p.set('payment_intent', pi);
  if (Number.isFinite(amount) && amount > 0) p.set('amount', String(Math.round(amount)));   // NO currency (Stripe rejects it on create)
  // Connected (0117, Codex CC-1): reverse the transfer by the refunded amount; the application fee refund is created
  // exactly, per allocation, by settleConnectRefund(). Only a pre-0117 request (strategy 1) keeps the proportional
  // flag, so its payload under its idempotency key never changes.
  if (!keepsAll) { p.set('reverse_transfer', 'true'); if (Number(strategy == null ? 1 : strategy) === 1) p.set('refund_application_fee', 'true'); }
  p.set('reason', 'requested_by_customer');
  p.set('metadata[refund_request_id]', String(requestId));
  if (bookingId) p.set('metadata[booking_id]', String(bookingId));
  const r = await fetch('https://api.stripe.com/v1/refunds', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + STRIPE_SECRET_KEY, 'Content-Type': 'application/x-www-form-urlencoded', 'Idempotency-Key': String(idempotencyKey).slice(0, 255) },
    body: p.toString(),
  });
  const j = await r.json(); return r.ok ? { ok: true, refund: j } : { ok: false, error: (j.error && j.error.message) || ('HTTP ' + r.status), type: (j.error && j.error.type) || null, code: (j.error && j.error.code) || null, status: r.status };
}
// Paginated read of a PaymentIntent's refunds. Codex round 4 (small correction 2, applied to this list as well): a list
// that cannot be proven complete (a malformed page, or the page cap reached with more to come) is a FAILURE, never a
// short list, because a negative answer from it decides whether a refund exists.
async function stripeListRefundsForPI(pi) {
  const out = []; let startingAfter = null; let complete = false;
  for (let page = 0; page < 20; page++) {   // paginate until exhausted (R10-P0-4: not just first 100)
    let url = `https://api.stripe.com/v1/refunds?payment_intent=${encodeURIComponent(pi)}&limit=100`;
    if (startingAfter) url += `&starting_after=${encodeURIComponent(startingAfter)}`;
    const r = await fetch(url, { headers: { Authorization: 'Bearer ' + STRIPE_SECRET_KEY } });
    const j = await r.json(); if (!r.ok) return { ok: false, error: (j.error && j.error.message) || ('HTTP ' + r.status) };
    if (!j || !Array.isArray(j.data)) return { ok: false, error: 'malformed_refund_list' };
    out.push(...j.data);
    if (!j.has_more || j.data.length === 0) { complete = true; break; }
    startingAfter = j.data[j.data.length - 1].id;
  }
  if (!complete) return { ok: false, error: 'incomplete_refund_list' };
  return { ok: true, data: out };
}
// 0118 / Codex R3-3: the stored idempotency key was already used with OTHER parameters (a support tool or an older
// build created the customer refund outside the routes), so a resubmit can never succeed and must never be retried under
// a new key. The request's own refund is looked up READ-ONLY on the PaymentIntent by the metadata every submission
// path stamps, validated (request id, PaymentIntent, charge, amount, currency, a live status) and, only when exactly one
// candidate qualifies, applied through the verified apply_refund_event path, which binds it again at the ledger.
// Zero valid candidates: a controlled retry (the refund may still be settling on Stripe's side). More than one: review.
async function adoptExistingRefund(row, pi, grp) {
  const list = await stripeListRefundsForPI(pi);
  if (!list.ok) return { outcome: 'retry', reason: 'list: ' + list.error };
  let currency = row.currency;
  if (!currency) { try { const rr = await sbGet(`refund_requests?id=eq.${encodeURIComponent(row.id)}&select=currency`); currency = rr && rr[0] && rr[0].currency; } catch (_) { /* validated below */ } }
  if (!currency) return { outcome: 'retry', reason: 'request_currency_unreadable' };
  const candidates = list.data.filter(rf => rf && rf.metadata && String(rf.metadata.refund_request_id) === String(row.id));
  const valid = candidates.filter(rf => rf.amount === row.amount && String(rf.currency || '').toLowerCase() === String(currency).toLowerCase()
    && stripeIdOf(rf.payment_intent) === pi && (!grp.stripe_charge_id || stripeIdOf(rf.charge) === grp.stripe_charge_id)
    && ['succeeded', 'pending', 'requires_action'].includes(String(rf.status || '').toLowerCase()));
  if (valid.length === 0) return { outcome: 'none', reason: candidates.length ? 'refund_for_request_does_not_match' : 'no_refund_for_request_on_pi', candidates: candidates.map(c => c.id) };
  if (valid.length > 1) return { outcome: 'ambiguous', candidates: valid.map(c => c.id) };
  const applied = await applyRefundToLedger(row, valid[0]);
  const val = Array.isArray(applied) ? applied[0] : applied;
  if (!val || !['applied', 'already_terminal', 'pending_persisted'].includes(val.outcome)) return { outcome: 'contradiction', reason: (val && (val.reason || val.outcome)) || 'apply_failed', refund: valid[0].id };
  return { outcome: 'adopted', refund: valid[0] };
}

// Customer-leg recovery only. The Stripe-side settlement legs of a connected refund are the settlement queue's job
// (drainSettlement below), eligible on the customer leg having SUCCEEDED, which this lease never selects.
async function applyRefundToLedger(row, refund) {
  return sbRpc('apply_refund_event', {
    p_refund_id: refund.id, p_status: refund.status || 'pending', p_amount: refund.amount, p_currency: refund.currency,
    p_pi: refund.payment_intent || null, p_charge: refund.charge || null, p_meta_request_id: row.id, p_event_id: null,
  });
}

// ---- Connected settlement queue (0117, Codex CC-2) ----
// claim_settlement_work leases connected refund requests whose customer refund SUCCEEDED but whose settlement is not
// complete (independent of the customer-leg status machine above), with lease expiry and attempts. Each is settled
// through the verified helper; a 'retry' outcome is released with exponential backoff (capped at an hour) and its
// reason persisted; a contradiction has already been marked an exception by the helper (deduplicated case); a request
// still unresolved after STALE_ATTEMPTS gets a deduplicated 'settlement_stale' case (alerted by drainCaseAlerts) while
// retries continue. This path NEVER submits a customer refund.
const SETTLE_BATCH = 25;
const STALE_ATTEMPTS = 8;
const settleBackoff = (attempts) => new Date(Date.now() + Math.min(60, Math.pow(2, Math.max(0, attempts))) * 60 * 1000).toISOString();
async function drainSettlement() {
  const owner = 'settle-' + Math.random().toString(36).slice(2, 10);
  const out = { claimed: 0, completed: 0, retried: 0, exceptions: 0, stale_cases: 0, errors: 0, lost_lease: 0, claim_failed: false, first_error: null };
  let rows = [];
  try { rows = await sbRpc('claim_settlement_work', { p_owner: owner, p_lease_seconds: 120, p_limit: SETTLE_BATCH }); }
  catch (e) { out.claim_failed = true; out.first_error = 'claim: ' + String((e && e.message) || e).slice(0, 160); return out; }
  rows = Array.isArray(rows) ? rows : [];
  for (const row of rows) {
    out.claimed++;
    let s;
    try { s = await settleConnectRefund(_b, row.id); } catch (e) { s = { outcome: 'retry', reason: 'threw', error: String((e && e.message) || e).slice(0, 160) }; }
    if (s.outcome === 'complete' || s.outcome === 'already_complete' || s.outcome === 'not_required') out.completed++;
    else if (s.outcome === 'exception') out.exceptions++;
    else {
      out.retried++;
      // a provider or database error is a run error; provider state that is not there yet is a designed wait
      if (/^(stripe_|db_)|threw/.test(String(s.reason || ''))) { out.errors++; if (!out.first_error) out.first_error = 'settle: ' + s.reason + (s.error ? ' ' + s.error : ''); }
      if (row.settlement_attempts >= STALE_ATTEMPTS) {
        try {
          await sbRpc('_open_case', { p_kind: 'settlement_exception', p_dedupe: 'settlement-stale:' + row.id, p_reason: 'settlement_stale', p_group: null, p_request: row.id, p_operation: null,
            p_session: null, p_pi: null, p_charge: null, p_refund: row.stripe_refund_id || null, p_amount: row.amount, p_currency: row.currency,
            p_details: { attempts: row.settlement_attempts, last_reason: s.reason || null, last_error: s.error || null } });
          out.stale_cases++;
        } catch (e) { out.errors++; if (!out.first_error) out.first_error = 'stale case: ' + String((e && e.message) || e).slice(0, 120); }
      }
    }
    const nextAt = (s.outcome === 'retry') ? settleBackoff(row.settlement_attempts) : null;
    const err = (s.outcome === 'retry') ? String((s.reason || 'retry') + (s.error ? ': ' + s.error : '')).slice(0, 200) : null;
    try {
      const held = await sbRpc('release_settlement_work', { p_request_id: row.id, p_owner: owner, p_next_attempt_at: nextAt, p_last_error: err });
      if (held === false || (Array.isArray(held) && held[0] === false)) out.lost_lease++;
    } catch (e) { out.errors++; if (!out.first_error) out.first_error = 'release: ' + String((e && e.message) || e).slice(0, 120); }
  }
  return out;
}

// ---- Delayed transfer / application fee ids on connected payment groups (0117, Codex CC-2) ----
// Stripe fills charge.transfer and charge.application_fee shortly after capture; the webhook's bounded re-read usually
// sees them, but recovery cannot rest on that. Every connected paid group still missing an id is read back from the
// charge, validated against the group (PaymentIntent, destination, application fee amount) and filled through
// apply_verified_payment's idempotent branch (which refuses a different id as a contradiction). A group still missing
// its ids a day after payment gets a deduplicated case.
const GROUP_IDS_STALE_MS = 24 * 60 * 60 * 1000;
async function fillGroupSettlementIds() {
  const out = { checked: 0, filled: 0, waiting: 0, stale_cases: 0, errors: 0, read_failed: false, first_error: null };
  let groups = [];
  try { groups = await sbGet('payment_groups?platform_keeps_all=eq.false&status=in.(paid,partially_refunded,refunded)&or=(stripe_transfer_id.is.null,stripe_application_fee_id.is.null)&stripe_charge_id=not.is.null&select=id,stripe_checkout_session_id,stripe_payment_intent_id,stripe_charge_id,stripe_transfer_id,stripe_application_fee_id,connect_account_id,total_customer_amount,currency,updated_at&order=updated_at.asc&limit=25'); }
  catch (e) { out.read_failed = true; out.first_error = 'read: ' + String((e && e.message) || e).slice(0, 160); return out; }
  for (const g of (Array.isArray(groups) ? groups : [])) {
    out.checked++;
    try {
      const r = await fetch(`https://api.stripe.com/v1/charges/${encodeURIComponent(g.stripe_charge_id)}`, { headers: { Authorization: 'Bearer ' + STRIPE_SECRET_KEY } });
      const ch = await r.json();
      if (!r.ok) throw new Error('charge read: ' + ((ch.error && ch.error.message) || r.status));
      const sums = await sbGet(`payment_allocations?payment_group_id=eq.${encodeURIComponent(g.id)}&select=platform_fee_amount`);
      const feeSum = (Array.isArray(sums) ? sums : []).reduce((s, a) => s + (a.platform_fee_amount || 0), 0);
      // 0118 (Codex round 4, small correction 1): a zero-fee destination charge has no application fee object at all;
      // such a group is complete with its transfer id alone, and a missing fee amount on the charge is a zero fee.
      if (feeSum === 0 && g.stripe_transfer_id && !g.stripe_application_fee_id) { out.zero_fee = (out.zero_fee || 0) + 1; continue; }
      const dest = stripeIdOf(ch.destination) || (ch.transfer_data && stripeIdOf(ch.transfer_data.destination)) || null;
      if (stripeIdOf(ch.payment_intent) !== g.stripe_payment_intent_id || dest !== g.connect_account_id || (ch.application_fee_amount == null ? 0 : ch.application_fee_amount) !== feeSum) {
        await sbRpc('_open_case', { p_kind: 'payment_contradiction', p_dedupe: 'group-charge-mismatch:' + g.id, p_reason: 'group_charge_mismatch', p_group: g.id, p_request: null, p_operation: null,
          p_session: g.stripe_checkout_session_id, p_pi: g.stripe_payment_intent_id, p_charge: g.stripe_charge_id, p_refund: null, p_amount: g.total_customer_amount, p_currency: g.currency,
          p_details: { charge_pi: stripeIdOf(ch.payment_intent), destination: dest, application_fee_amount: ch.application_fee_amount, expected_destination: g.connect_account_id, expected_fee: feeSum } });
        out.stale_cases++; continue;
      }
      const trId = stripeIdOf(ch.transfer), feeId = stripeIdOf(ch.application_fee);
      if (!trId || (!feeId && feeSum > 0)) {
        if (Date.now() - new Date(g.updated_at).getTime() > GROUP_IDS_STALE_MS) {
          await sbRpc('_open_case', { p_kind: 'payment_contradiction', p_dedupe: 'group-ids-missing:' + g.id, p_reason: 'group_settlement_ids_missing', p_group: g.id, p_request: null, p_operation: null,
            p_session: g.stripe_checkout_session_id, p_pi: g.stripe_payment_intent_id, p_charge: g.stripe_charge_id, p_refund: null, p_amount: g.total_customer_amount, p_currency: g.currency, p_details: { transfer: trId, application_fee: feeId } });
          out.stale_cases++;
        } else out.waiting++;
        continue;
      }
      const applied = await sbRpc('apply_verified_payment', {
        p_session_id: g.stripe_checkout_session_id, p_payment_intent: g.stripe_payment_intent_id, p_charge: ch.id, p_amount: g.total_customer_amount, p_currency: g.currency,
        p_connect_dest: dest, p_on_behalf_of: stripeIdOf(ch.on_behalf_of) || dest, p_application_fee: ch.application_fee_amount == null ? 0 : ch.application_fee_amount, p_transfer_id: trId, p_fee_id: feeId || null,
      });
      const val = Array.isArray(applied) ? applied[0] : applied;
      if (val && val.outcome === 'idempotent') out.filled++;
      else { out.errors++; if (!out.first_error) out.first_error = 'fill: ' + ((val && (val.reason || val.outcome)) || 'no result'); }
    } catch (e) { out.errors++; if (!out.first_error) out.first_error = 'group ' + g.id + ': ' + String((e && e.message) || e).slice(0, 120); }
  }
  return out;
}
function backoff(attempts) { return new Date(Date.now() + Math.min(60, Math.pow(2, Math.max(0, attempts))) * 60 * 1000).toISOString(); }

// ---- R12-P0-5: external alerting for financial exceptions ----
// A durable reconciliation_cases row is necessary but NOT sufficient: a customer can be charged or
// owed a refund while nobody is looking at the database. One email per case id (deduped by the
// case's own alert_status, not per retry), never containing secrets or card data.
const ALERT_TO = process.env.ALERT_EMAIL || 'david@demohubhq.com';
const ENV_LABEL = process.env.VERCEL_ENV || 'unknown';

function alertHtml(c) {
  const esc = (s) => String(s == null ? 'n/a' : s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  const money = c.amount != null ? `$${(c.amount / 100).toFixed(2)} ${String(c.currency || 'usd').toUpperCase()}` : 'n/a';
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
  if (!_b.resendApiKey) return { ok: false, reason: 'resend_not_configured' };
  const r = await sendMailQuietly({
    from: 'Demohub Alerts <bookings@demohubhq.com>', to: ALERT_TO,
    subject: `[Demohub ${ENV_LABEL}] payment exception: ${c.kind} (${c.reason || 'review'})`,
    html: alertHtml(c),
  }, { binding: _b });
  // _mail.js does not surface the provider message id; the send outcome is still recorded.
  return { ok: !!r.ok, id: null, reason: r.ok ? null : (r.code || null) };
}

// Per-run send cap. A systemic failure can open cases in bulk; emailing every one would bury the
// signal (and can trip provider rate limits). Above the cap we send ONE digest naming the count and
// leave the rest pending for the next run, so nothing is lost and the operator still hears about it.
const ALERT_SEND_CAP = 5;

async function drainCaseAlerts(limit) {
  const owner = 'alert-' + Math.random().toString(36).slice(2, 10);
  const out = { claimed: 0, sent: 0, failed: 0, deferred: 0, claim_failed: false };
  let rows = [];
  try { rows = await sbRpc('claim_case_alerts', { p_owner: owner, p_lease_seconds: 120, p_limit: limit }); }
  catch (e) { console.error('claim_case_alerts failed:', (e && e.message) || e); out.claim_failed = true; return out; }
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

// R12-P0-2: fulfilment drain now lives in the shared module (no HTTP self-call, that hit
// Vercel deployment protection and added a needless network hop).
const FULFILL_BATCH = 25;

export default async function handler(req, res) {
  if (req.method !== 'POST' && req.method !== 'GET') return res.status(405).json({ error: 'POST only' });
  const provided = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!CRON_SECRET || provided !== CRON_SECRET) return res.status(401).json({ error: 'unauthorized' });
  if (!STRIPE_SECRET_KEY) return res.status(500).json({ error: 'server_not_configured' });
  try { _b = await getBinding(); } catch (e) { return sendBindingFailure(res, e); }

  const startMs = Date.now();
  const owner = 'refund-worker-' + Math.random().toString(36).slice(2, 10);
  const out = { ok: true, claimed: 0, reconciled: 0, resubmitted: 0, adopted: 0, manual: 0, lost_lease: 0, errors: 0 };
  // F-03: the first per-item / drain error, for the failed heartbeat's summary. Already truncated
  // and never carries a Stripe key or card data (Stripe error messages are operator-safe prose).
  let firstError = null;
  const noteError = (msg) => { if (!firstError) firstError = String(msg || 'unknown_error').slice(0, 200); };
  try {
    const leased = await sbRpc('claim_refund_work', { p_owner: owner, p_lease_seconds: 120, p_limit: BATCH });
    const rows = Array.isArray(leased) ? leased : [];
    out.claimed = rows.length;

    for (const row of rows) {
      let nextStatus = row.status, nextAt = null, err = null;
      const errorsBefore = out.errors;
      try {
        // enrich: PI + keeps-all off the allocation's group
        const enr = await sbGet(`payment_allocations?id=eq.${encodeURIComponent(row.payment_allocation_id)}&select=payment_groups!inner(stripe_payment_intent_id,stripe_charge_id,platform_keeps_all)`);
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
          const s = await stripeSubmitRefund({ pi, amount: row.amount, keepsAll, strategy: row.settlement_strategy, idempotencyKey: row.stripe_idempotency_key, requestId: row.id, bookingId: row.booking_id });
          if (s.ok) { await applyRefundToLedger(row, s.refund); out.resubmitted++; nextStatus = mapTerminal(s.refund.status, 'submitted'); nextAt = terminalDue(s.refund.status); }
          else if (s.type === 'idempotency_error') {                 // ---- B2 (0118, Codex R3-3): adopt, never resubmit ----
            const a = await adoptExistingRefund(row, pi, grp);
            if (a.outcome === 'adopted') { out.adopted++; nextStatus = mapTerminal(a.refund.status, 'submitted'); nextAt = terminalDue(a.refund.status); }
            else if (a.outcome === 'ambiguous' || a.outcome === 'contradiction') { out.manual++; nextStatus = 'requires_review'; err = ('idempotency_conflict_' + a.outcome + ': ' + (a.reason || (a.candidates || []).join(','))).slice(0, 200); }
            else { out.errors++; err = ('idempotency_conflict: ' + a.reason).slice(0, 200); const capped = (row.attempts + 1) >= MAX_ATTEMPTS; nextStatus = capped ? 'requires_review' : 'failed_retryable'; nextAt = capped ? null : backoff(row.attempts); }
          }
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
      if (out.errors > errorsBefore) noteError(err);

      // R11-P0-4: parking for review is ATOMIC, request + parent operation + one deduped
      // reconciliation case, reservation preserved (Stripe may still hold an unadopted refund).
      if (nextStatus === 'requires_review') {
        try { await sbRpc('park_refund_for_review', { p_request_id: row.id, p_owner: owner, p_reason: err || 'retry_cap_exhausted' }); }
        catch (e) { out.errors++; noteError('park: ' + ((e && e.message) || e)); }
      }
      // release the lease (CAS on owner). If we lost it, another worker owns the row now.
      try {
        const held = await sbRpc('release_refund_work', { p_request_id: row.id, p_owner: owner, p_status: nextStatus, p_next_attempt_at: nextAt, p_last_error: err });
        if (held === false || (Array.isArray(held) && held[0] === false)) out.lost_lease++;
      } catch (e) { out.errors++; noteError('release: ' + ((e && e.message) || e)); }
    }
    // R12-P0-2: actually DRAIN the fulfilment outbox. Recovery must never depend on Stripe
    // redelivering a webhook, the webhook marks its event complete, so a row left pending after a
    // demo/email failure would otherwise sit unfulfilled forever. This claims rows under the same
    // lease, performs the real work, and completes/retries them.
    try {
      const f = await drainFulfillments({ limit: FULFILL_BATCH });
      out.fulfillments_processed = f.processed;
      out.fulfillments_completed = f.completed;
      out.fulfillments_failed = f.failed;
      out.fulfillments_claim_failed = !!f.claim_failed;
      if (f.claim_failed) noteError('fulfilment: claim_fulfillments failed');
      else if (f.failed > 0) noteError(`fulfilment: ${f.failed} row(s) failed`);
      const stuck = await sbGet('booking_fulfillments?status=eq.pending&select=booking_id&limit=100');
      out.fulfillments_pending = Array.isArray(stuck) ? stuck.length : 0;
      if (out.fulfillments_pending > 0) console.warn('FULFILLMENT BACKLOG:', out.fulfillments_pending, 'paid booking(s) not fully fulfilled');
    } catch (e) { out.errors++; noteError('fulfilment: ' + ((e && e.message) || e)); console.error('fulfilment drain error:', (e && e.message) || e); }

    // 0117 (Codex CC-2): connected settlement legs and delayed group ids, recovered without webhooks.
    try {
      const st = await drainSettlement();
      out.settlement_claimed = st.claimed; out.settlement_completed = st.completed; out.settlement_retried = st.retried; out.settlement_exceptions = st.exceptions; out.settlement_stale_cases = st.stale_cases; out.settlement_lost_lease = st.lost_lease; out.settlement_claim_failed = !!st.claim_failed;
      if (st.claim_failed) noteError('settlement: claim_settlement_work failed');
      else if (st.errors > 0) noteError(st.first_error || 'settlement: error');
      if (st.errors > 0) out.errors += st.errors;
    } catch (e) { out.errors++; noteError('settlement: ' + ((e && e.message) || e)); console.error('settlement drain error:', (e && e.message) || e); }
    try {
      const gi = await fillGroupSettlementIds();
      out.group_ids_checked = gi.checked; out.group_ids_filled = gi.filled; out.group_ids_waiting = gi.waiting; out.group_ids_cases = gi.stale_cases; out.group_ids_read_failed = !!gi.read_failed;
      if (gi.read_failed) noteError(gi.first_error || 'group ids: read failed');
      else if (gi.errors > 0) noteError(gi.first_error || 'group ids: error');
      if (gi.errors > 0) out.errors += gi.errors;
    } catch (e) { out.errors++; noteError('group ids: ' + ((e && e.message) || e)); console.error('group id fill error:', (e && e.message) || e); }

    // R12-P0-5: notify an operator about every open financial exception (deduped per case).
    try {
      const a = await drainCaseAlerts(20);
      out.alerts_claimed = a.claimed; out.alerts_sent = a.sent; out.alerts_failed = a.failed;
      out.alerts_claim_failed = !!a.claim_failed;
      if (a.claim_failed) noteError('alerts: claim_case_alerts failed');
      else if (a.failed > 0) noteError(`alerts: ${a.failed} operator alert(s) failed to send`);
    } catch (e) { out.errors++; noteError('alerts: ' + ((e && e.message) || e)); console.error('alert drain error:', (e && e.message) || e); }

    // 0094 (2026-10-16): retailer-initiated demo moves whose reconfirmation deadline passed are lapsed,
    // and every unsettled declined/lapsed move is settled (full refund through the shared ledger path,
    // then booking_transition cancel). Idempotent per step; a failure stays unsettled for the next run.
    try {
      const mv = await sweepMoves(_b, { now: new Date(), limit: 25 });
      out.moves_lapsed = mv.lapsed; out.moves_settled = mv.settled; out.moves_failed = mv.failed; out.moves_parked = mv.parked; out.moves_retired = mv.retired; out.moves_notice_cases = mv.notice_cases;
      out.moves_claim_failed = !!mv.claim_failed; out.moves_read_failed = !!mv.read_failed; out.moves_notice_failed = !!mv.notice_failed; out.moves_notice_checked = mv.notice_checked;
      if (mv.errors.length) noteError('moves: ' + mv.errors[0]);
    } catch (e) { out.errors++; noteError('moves: ' + ((e && e.message) || e)); console.error('move sweep error:', (e && e.message) || e); }

    if (process.env.CANCELLATION_RESOLUTION_QUIESCE === 'true') {
      // R5-3 (rollback procedure): no resolution work is produced or resumed while quiesced; the outbox keeps draining.
      out.cancellation_sweeps_quiesced = true;
    } else {
    // Codex refund-cutoff R2-2 (2026-10-19): every under_review cancellation without an operator resolution must
    // have its open review case. The cancel route opens it; if that call failed, this bounded sweep opens it here,
    // so an unresolved refund eligibility is a discoverable work item, never only a stored row.
    try {
      const cr = await sweepCancellationReviews(_b, { limit: 25 });
      out.cancellation_reviews_checked = cr.checked; out.cancellation_cases_opened = cr.opened; out.cancellation_cases_failed = cr.failed; out.cancellation_reviews_read_failed = !!cr.read_failed;
      if (cr.errors.length) noteError('cancellation reviews: ' + cr.errors[0]);
    } catch (e) { out.errors++; noteError('cancellation reviews: ' + ((e && e.message) || e)); console.error('cancellation review sweep error:', (e && e.message) || e); }
    // Codex R3-3: a claimed resolution that still owes a step (refund, case closure, brand notice) is finished here.
    try {
      const ur = await sweepUnfinishedResolutions(_b, { limit: 25, graceSeconds: Number(process.env.RESOLUTION_RESUME_GRACE_SECONDS || 120) });
      out.resolutions_checked = ur.checked; out.resolutions_completed = ur.completed; out.resolutions_relinked = ur.relinked || 0; out.resolutions_still_open = ur.still_open; out.resolutions_escalated = ur.escalated; out.resolutions_step_failed = ur.step_failed; out.resolutions_failed = ur.failed; out.resolutions_read_failed = !!ur.read_failed;
      if (ur.errors.length) noteError('resolutions: ' + ur.errors[0]);
    } catch (e) { out.errors++; noteError('resolutions: ' + ((e && e.message) || e)); console.error('resolution resume error:', (e && e.message) || e); }
    // Codex R3-4: a recorded cancellation whose cancellation never landed is made visible (deduplicated case) and the
    // case is closed once the retry lands. The operator finishes it by cancelling again; the route replays the decision.
    try {
      const ab = await sweepAbandonedCancellations(_b, { limit: 25, minutes: Number(process.env.CANCELLATION_ABANDONED_MINUTES || 15) });
      out.abandoned_cancellations = ab.checked; out.abandoned_cases_opened = ab.cases_opened; out.abandoned_cases_resolved = ab.cases_resolved; out.abandoned_failed = ab.failed; out.abandoned_read_failed = !!ab.read_failed;
      if (ab.errors.length) noteError('abandoned cancellations: ' + ab.errors[0]);
    } catch (e) { out.errors++; noteError('abandoned cancellations: ' + ((e && e.message) || e)); console.error('abandoned cancellation sweep error:', (e && e.message) || e); }
    }

    // F-03 run verdict. 'succeeded' means EVERY claimed item succeeded: no per-item error after
    // claim (Stripe submit/get/list, ledger apply, park, lease release), no fulfilment row failed
    // and the fulfilment claim itself worked, no operator alert failed to send and the alert claim
    // worked. Anything else is a partial failure: a SEPARATE 'failed' row (summary.partial=true,
    // counts + first error) and a 500 so Vercel's cron log records the run as failed. Parked
    // (requires_review) and lost-lease rows are designed outcomes, not run failures.
    const fulfilmentFailed = (out.fulfillments_failed || 0) > 0 || out.fulfillments_claim_failed === true;
    const alertsFailed = (out.alerts_failed || 0) > 0 || out.alerts_claim_failed === true;
    // Codex RM-6: a failed move scan (claim or read), a malformed reply or any per-item failure is a failed run.
    const movesFailed = (out.moves_failed || 0) > 0 || out.moves_claim_failed === true || out.moves_read_failed === true || out.moves_notice_failed === true;
    const reviewsFailed = (out.cancellation_cases_failed || 0) > 0 || out.cancellation_reviews_read_failed === true
      || (out.resolutions_failed || 0) > 0 || (out.resolutions_step_failed || 0) > 0 || (out.resolutions_escalated || 0) > 0 || out.resolutions_read_failed === true || (out.abandoned_failed || 0) > 0 || out.abandoned_read_failed === true;   // Codex R4-2: a caught resume failure or an escalation is never an unqualified success
    const settlementFailed = out.settlement_claim_failed === true || out.group_ids_read_failed === true;   // 0117: a failed settlement claim or group read is a failed run
    const runOk = out.errors === 0 && !fulfilmentFailed && !alertsFailed && !movesFailed && !reviewsFailed && !settlementFailed;
    if (runOk) {
      await heartbeat('succeeded', startMs, out);
      return res.status(200).json(out);
    }
    out.ok = false;
    await heartbeat('failed', startMs, { ...out, partial: true, first_error: firstError });
    return res.status(500).json({ ...out, error: 'partial_failure', first_error: firstError });
  } catch (e) {
    console.error('refund-worker error:', (e && e.message) || e);
    // A SEPARATE 'failed' row, never a rewrite of the last success. The status route keys health off
    // the latest completed row, so this flips the job unhealthy until a later clean run recovers it.
    await heartbeat('failed', startMs, { ...out, ok: false, error: String((e && e.message) || e).slice(0, 500) });
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
