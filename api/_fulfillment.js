// api/_fulfillment.js — the ONE implementation of "fulfil a paid booking".
//
// R12-P0-2 (corrected): the webhook and the cron both call runFulfillment() in-process. The earlier
// version had the cron self-call /api/fulfill-booking over HTTP, which fails behind Vercel
// deployment protection (the call gets an auth wall, not the endpoint) and adds a pointless network
// hop. A shared module is what Codex asked for and removes both problems.
//
// Contract: the caller has already claimed the outbox row (claim_fulfillments) and owns its lease.
// This performs the work idempotently and records progress via complete_fulfillment.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

async function sb(path, opts = {}) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...opts,
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=representation', ...(opts.headers || {}) },
  });
  const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch (_) {}
  if (!r.ok) throw new Error((j && j.message) || t || ('HTTP ' + r.status));
  return j;
}
async function sbRpc(fn, args) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST', headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
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
    // 1. status transition (idempotent — only moves a still-pending_payment booking)
    await sb(`bookings?id=eq.${encodeURIComponent(bookingId)}&status=eq.pending_payment`, {
      method: 'PATCH', body: JSON.stringify({ status: row.target_status || 'pending' }),
    });

    // 2. demo + emails via the webhook module's shared helpers
    const wh = await import('./stripe-webhook.js');
    const ctx = await wh.fetchBookingContext(bookingId);
    if (!ctx) throw new Error('no_booking_context');
    ctx.booking_id = bookingId;

    if (!demoOk) {
      if (row.target_status === 'confirmed') { await wh.createDemoForConfirmedBooking(ctx); demoOk = true; }
      else demoOk = true;   // non-auto-confirm retailers materialise the demo on manual confirm
    }
    if (!mailOk) {
      if (ctx.contact_email) { await wh.sendPromotionEmails(ctx, bookingId); mailOk = true; }
      else mailOk = true;
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
  const out = { processed: 0, completed: 0, failed: 0, capped: 0 };
  let rows = [];
  try {
    const claimed = await sbRpc('claim_fulfillments', { p_owner: owner, p_lease_seconds: leaseSeconds, p_limit: limit, p_group: group });
    rows = Array.isArray(claimed) ? claimed : (claimed ? [claimed] : []);
  } catch (e) { console.error('claim_fulfillments failed:', (e && e.message) || e); return out; }
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
