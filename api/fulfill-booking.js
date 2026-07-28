// api/fulfill-booking.js — R12-P0-2: the single shared fulfilment worker step.
//
// Both the webhook (immediately after payment) and the cron (recovery) drive fulfilment through
// this one endpoint, so there is exactly ONE implementation of "create the demo + send the emails".
// Recovery therefore never depends on Stripe redelivering a webhook.
//
// Contract: caller has already claimed the outbox row (claim_fulfillments) and passes its owner
// lease. This performs the work idempotently, then records progress via complete_fulfillment.
// Internal-only: requires CRON_SECRET.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const CRON_SECRET = process.env.CRON_SECRET;

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
  return j;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const provided = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!CRON_SECRET || provided !== CRON_SECRET) return res.status(401).json({ error: 'unauthorized' });
  if (!SUPABASE_URL || !SERVICE_KEY) return res.status(500).json({ error: 'server_not_configured' });

  let body = {}; try { body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}); } catch (_) {}
  const { booking_id, owner, target_status } = body;
  if (!booking_id || !owner) return res.status(400).json({ error: 'booking_id and owner required' });

  let demoOk = !!body.demo_created, mailOk = !!body.emails_sent, err = null;
  try {
    // 1. status transition (idempotent — only moves a still-pending_payment booking)
    await sb(`bookings?id=eq.${encodeURIComponent(booking_id)}&status=eq.pending_payment`, {
      method: 'PATCH', body: JSON.stringify({ status: target_status || 'pending' }),
    });

    // 2. demo + emails via the webhook module's shared helpers
    const wh = await import('./stripe-webhook.js');
    const ctx = await wh.fetchBookingContext(booking_id);
    if (!ctx) throw new Error('no_booking_context');
    ctx.booking_id = booking_id;

    if (!demoOk) {
      if (target_status === 'confirmed') { await wh.createDemoForConfirmedBooking(ctx); demoOk = true; }
      else demoOk = true;   // non-auto-confirm retailers materialise the demo on manual confirm
    }
    if (!mailOk) {
      if (ctx.contact_email) { await wh.sendPromotionEmails(ctx, booking_id); mailOk = true; }
      else mailOk = true;   // nothing to send
    }
  } catch (e) {
    err = String((e && e.message) || e).slice(0, 300);
  }

  const done = demoOk && mailOk;
  let recorded = false;
  try {
    const r = await sbRpc('complete_fulfillment', {
      p_booking_id: booking_id, p_owner: owner, p_demo: demoOk, p_emails: mailOk, p_done: done, p_err: err,
    });
    recorded = (Array.isArray(r) ? r[0] : r) === true;
  } catch (e) { err = (err ? err + '; ' : '') + 'record:' + ((e && e.message) || e); }

  // lease lost (another worker owns it) -> report not-done so the caller doesn't count a success
  if (!recorded) return res.status(409).json({ done: false, error: 'lease_lost_or_not_recorded', detail: err });
  return res.status(done ? 200 : 500).json({ done, demo_created: demoOk, emails_sent: mailOk, error: err });
}
