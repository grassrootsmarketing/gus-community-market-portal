// api/fulfill-booking.js — R12-P0-2: the single shared fulfilment worker step.
//
// Both the webhook (immediately after payment) and the cron (recovery) drive fulfilment through
// this one endpoint, so there is exactly ONE implementation of "create the demo + send the emails".
// Recovery therefore never depends on Stripe redelivering a webhook.
//
// Contract: caller has already claimed the outbox row (claim_fulfillments) and passes its owner
// lease. This performs the work idempotently, then records progress via complete_fulfillment.
// Internal-only: requires CRON_SECRET.

import { getBinding, sendBindingFailure } from './_env.js';
let _b = null;
const CRON_SECRET = process.env.CRON_SECRET;

async function sb(path, opts = {}) {
  const r = await fetch(`${_b.supabaseUrl}/rest/v1/${path}`, {
    ...opts,
    headers: { apikey: _b.serviceKey, Authorization: `Bearer ${_b.serviceKey}`, 'Content-Type': 'application/json', Prefer: 'return=representation', ...(opts.headers || {}) },
  });
  const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch (_) {}
  if (!r.ok) throw new Error((j && j.message) || t || ('HTTP ' + r.status));
  return j;
}
async function sbRpc(fn, args) {
  const r = await fetch(`${_b.supabaseUrl}/rest/v1/rpc/${fn}`, {
    method: 'POST', headers: { apikey: _b.serviceKey, Authorization: `Bearer ${_b.serviceKey}`, 'Content-Type': 'application/json' },
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
  try { _b = await getBinding(); } catch (e) { return sendBindingFailure(res, e); }

  let body = {}; try { body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}); } catch (_) {}
  const { booking_id, owner, target_status } = body;
  if (!booking_id || !owner) return res.status(400).json({ error: 'booking_id and owner required' });

  const { runFulfillment } = await import('./_fulfillment.js');
  const r = await runFulfillment({ booking_id, target_status, demo_created: body.demo_created, emails_sent: body.emails_sent }, owner);
  const { done, demo_created: demoOk, emails_sent: mailOk, error: err, recorded } = r;

  // lease lost (another worker owns it) -> report not-done so the caller doesn't count a success
  if (!recorded) return res.status(409).json({ done: false, error: 'lease_lost_or_not_recorded', detail: err });
  return res.status(done ? 200 : 500).json({ done, demo_created: demoOk, emails_sent: mailOk, error: err });
}
