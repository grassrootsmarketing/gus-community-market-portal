// api/_fulfillment.js — the ONE implementation of "fulfil a paid booking".
//
// R12-P0-2 (corrected): the webhook and the cron both call runFulfillment() in-process. The earlier
// version had the cron self-call /api/fulfill-booking over HTTP, which fails behind Vercel
// deployment protection (the call gets an auth wall, not the endpoint) and adds a pointless network
// hop. A shared module is what Codex asked for and removes both problems.
//
// Contract: the caller has already claimed the outbox row (claim_fulfillments) and owns its lease.
// This performs the work idempotently and records progress via complete_fulfillment.

import { getBinding } from './_env.js';

async function sb(path, opts = {}) {
  const b = await getBinding();
  const r = await fetch(`${b.supabaseUrl}/rest/v1/${path}`, {
    ...opts,
    headers: { apikey: b.serviceKey, Authorization: `Bearer ${b.serviceKey}`, 'Content-Type': 'application/json', Prefer: 'return=representation', ...(opts.headers || {}) },
  });
  const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch (_) {}
  if (!r.ok) throw new Error((j && j.message) || t || ('HTTP ' + r.status));
  return j;
}
async function sbRpc(fn, args) {
  const b = await getBinding();
  const r = await fetch(`${b.supabaseUrl}/rest/v1/rpc/${fn}`, {
    method: 'POST', headers: { apikey: b.serviceKey, Authorization: `Bearer ${b.serviceKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch (_) {}
  if (!r.ok) throw new Error((j && j.message) || t || ('HTTP ' + r.status));
  return j;   // RAW: claim_fulfillments returns an ARRAY — unwrapping it here silently broke the drain
}

// Perform fulfilment for one claimed outbox row. Returns {done, demo_created, emails_sent, error, recorded}.
export async function runFulfillment(row, owner) {
  const bookingId = row.booking_id;
  let demoOk = !!row.demo_created, mailOk = !!row.emails_sent, err = null;
  try {
    // Codex R2 (2026-09-11): the promotion and (for auto-confirm) the demo projection are ONE
    // database transaction (0077 booking_transition 'promote_paid'), judged on the booking's CURRENT
    // state. Outcomes are explicit: applied (possibly idempotently on a retry), superseded (the
    // booking was cancelled/declined/expired in between — the fulfilment is deliberately skipped and
    // recorded as such, and no stale confirmation mail goes out), or a thrown database failure that
    // leaves the outbox row retryable.
    const wh = await import('./stripe-webhook.js');
    const ctx = await wh.fetchBookingContext(bookingId);
    if (!ctx) throw new Error('no_booking_context');
    ctx.booking_id = bookingId;
    let superseded = false;
    if (row.target_status !== 'held') {
      const rows = await sbRpc('booking_transition', { p_booking_id: bookingId, p_retailer_id: ctx.retailer_id, p_action: 'promote_paid', p_fields: { status: row.target_status || 'pending' }, p_demo_fee: null });
      const tr = Array.isArray(rows) ? rows[0] : rows;
      if (!tr) throw new Error('promote_no_result');
      if (tr.ok !== true) {
        if (tr.reason === 'superseded') superseded = true;
        else throw new Error('promote_refused:' + (tr.reason || 'unknown') + ':' + (tr.status_before || ''));
      } else if (row.target_status === 'confirmed' && !tr.demo_id) {
        throw new Error('demo_not_materialised');   // a confirmed booking must have its demo; retry
      }
    }
    if (superseded) {
      // A cancelled booking has no demo to create and must not receive a confirmation now.
      demoOk = true; mailOk = true; err = 'superseded:booking_no_longer_active';
    } else {
      demoOk = true;   // 'held' has no demo; 'pending' materialises on manual confirm; 'confirmed' was created above
      if (!mailOk) {
        if (!ctx.contact_email) { mailOk = true; }
        else if (row.target_status === 'held') {
          const { sendHoldPlacedEmail } = await import('./_provisional.js');
          await sendHoldPlacedEmail(ctx);   // throws on failure -> outbox retries
          mailOk = true;
        } else {
          await wh.sendPromotionEmails(ctx, bookingId); mailOk = true;
        }
      }
    }
  } catch (e) {
    err = String((e && e.message) || e).slice(0, 300);
  }

  const done = demoOk && mailOk;
  let recorded = false;
  try {
    const r = await sbRpc('complete_fulfillment', {
      p_booking_id: bookingId, p_owner: owner, p_demo: demoOk, p_emails: mailOk, p_done: done, p_err: err,
    });
    recorded = (r === true) || (Array.isArray(r) && r[0] === true);
  } catch (e) {
    err = (err ? err + '; ' : '') + 'record:' + String((e && e.message) || e).slice(0, 120);
  }
  return { done, demo_created: demoOk, emails_sent: mailOk, error: err, recorded };
}

// Claim + drain pending fulfilments. Used by the cron (all groups) and the webhook (one group).
export async function drainFulfillments({ limit = 25, group = null, leaseSeconds = 180, maxAttempts = 6 } = {}) {
  const owner = 'fulfil-' + Math.random().toString(36).slice(2, 10);
  // claim_failed: the claim RPC itself errored (F-03: callers must not report a clean run on it).
  const out = { processed: 0, completed: 0, failed: 0, capped: 0, claim_failed: false };
  let rows = [];
  try {
    const claimed = await sbRpc('claim_fulfillments', { p_owner: owner, p_lease_seconds: leaseSeconds, p_limit: limit, p_group: group });
    rows = Array.isArray(claimed) ? claimed : (claimed ? [claimed] : []);
  } catch (e) { console.error('claim_fulfillments failed:', (e && e.message) || e); out.claim_failed = true; return out; }
  for (const row of rows) {
    out.processed++;
    const r = await runFulfillment(row, owner);
    if (r.done && r.recorded) { out.completed++; continue; }
    out.failed++;
    if ((row.attempts || 0) >= maxAttempts) {
      out.capped++;
      try { await sbRpc('open_fulfillment_case', { p_booking_id: row.booking_id, p_reason: r.error || 'retry_cap_exhausted' }); } catch (_) {}
    }
  }
  return out;
}
