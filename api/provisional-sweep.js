// api/provisional-sweep.js — the 24h provisional-hold expiry sweep (docs/provisional-holds.md
// phase 4). Cron every 15 min behind CRON_SECRET (same auth pattern as refund-worker).
//
// For each 'held' booking past held_expires_at:
//   - COI now covered            -> SKIP. The brand did their part; resolution belongs to the
//                                   capture paths (retailer confirm, or the COI-approval hook for
//                                   auto-confirm retailers). Never punish an insured brand with an
//                                   expiry. (The Stripe auth itself dies at ~7d worst-case.)
//   - authorized (auth placed)   -> cancel the PI ($0 charged, $0 fee), converge the ledger via
//                                   apply_authorization_canceled, email "hold released".
//   - unpaid, no open attempt    -> never finished checkout: just flip to 'expired' (frees slot).
//   - unpaid, open attempt       -> mid-checkout: skip; Stripe's own 24h Session expiry +
//                                   checkout.session.expired terminalizes the attempt, and the next
//                                   sweep tick expires the booking.
//
// Idempotent + safe to rerun: every mutation is guarded on current state, and a failed Stripe
// cancel leaves the booking held for the next tick.

import { getBinding, sendBindingFailure } from './_env.js';
import { coiCovered } from './_coi-coverage.js';
import { releaseHeldBooking } from './_provisional.js';

let _b = null;
const CRON_SECRET = process.env.CRON_SECRET;
const BATCH = 25;

async function sb(path, opts = {}) {
  const r = await fetch(`${_b.supabaseUrl}/rest/v1/${path}`, {
    ...opts,
    headers: { apikey: _b.serviceKey, Authorization: `Bearer ${_b.serviceKey}`, 'Content-Type': 'application/json', Prefer: 'return=representation', ...(opts.headers || {}) },
  });
  const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch (_) {}
  if (!r.ok) throw new Error((j && j.message) || t || ('HTTP ' + r.status));
  return j;
}

// Phase E: per-job liveness. One APPEND-ONLY cron_heartbeat row per completed run, same write shape
// as brand-account.js's daily cron. The public status route reads the latest 'succeeded' row PER
// cron_name (only when provisional holds are enabled — an intentionally-off feature must not degrade
// production). Best-effort: a heartbeat failure must never fail the sweep itself.
const CRON_NAME = 'provisional-sweep';
async function heartbeat(outcome, startMs, summary) {
  try {
    if (!_b) return;
    await sb('cron_heartbeat', {
      method: 'POST',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ cron_name: CRON_NAME, outcome, duration_ms: Date.now() - startMs, summary }),
    });
  } catch (_) { /* best-effort */ }
}

export default async function handler(req, res) {
  if (req.method !== 'POST' && req.method !== 'GET') return res.status(405).json({ error: 'POST only' });
  const provided = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!CRON_SECRET || provided !== CRON_SECRET) return res.status(401).json({ error: 'unauthorized' });
  try { _b = await getBinding(); } catch (e) { return sendBindingFailure(res, e); }

  const startMs = Date.now();
  const out = { ok: true, scanned: 0, released: 0, expired_unpaid: 0, skipped_covered: 0, skipped_in_checkout: 0, errors: 0 };
  try {
    const now = new Date().toISOString();
    const due = await sb(`bookings?status=eq.held&held_expires_at=lt.${encodeURIComponent(now)}&select=id,status,payment_status,payment_intent_id,brand_id,demo_date,contact_email&order=held_expires_at.asc&limit=${BATCH}`) || [];
    out.scanned = due.length;

    for (const b of due) {
      try {
        // covered brands are never expired by the sweep
        let covered = false;
        try {
          const br = await sb(`brands?id=eq.${encodeURIComponent(b.brand_id)}&select=default_coi_url,default_coi_expires,coi_verification_status`);
          covered = coiCovered((Array.isArray(br) && br[0]) || {}, b.demo_date).covered;
        } catch (_) { /* unreadable brand -> treat as not covered; the guard below still applies */ }
        if (covered) { out.skipped_covered++; continue; }

        if (b.payment_status === 'authorized' && b.payment_intent_id) {
          const r = await releaseHeldBooking(b, { target: 'expired', reason: 'hold_expired_24h', notify: true });
          // P0-1: releaseHeldBooking may discover the hold was captured out from under the sweep (a
          // confirm landed at the same tick). It converges to PAID and reports was_captured — that is
          // NOT an expiry and NOT an error; the booking is correctly paid, so just record and move on.
          if (r.ok && r.was_captured) { out.captured_at_expiry = (out.captured_at_expiry || 0) + 1; }
          else if (r.ok) out.released++;
          else { out.errors++; console.warn('sweep release failed for', b.id, r.error); }
          continue;
        }

        // unpaid: only expire when no open payment attempt (i.e. not mid-checkout)
        const atts = await sb(`payment_allocations?booking_id=eq.${encodeURIComponent(b.id)}&select=payment_group_id`) || [];
        let hasOpenAttempt = false;
        if (atts.length) {
          const gids = [...new Set(atts.map(a => a.payment_group_id))];
          const open = await sb(`payment_attempts?payment_group_id=in.(${gids.map(encodeURIComponent).join(',')})&status=eq.open&select=id&limit=1`) || [];
          hasOpenAttempt = open.length > 0;
        }
        if (hasOpenAttempt) { out.skipped_in_checkout++; continue; }
        await sb(`bookings?id=eq.${encodeURIComponent(b.id)}&status=eq.held`, { method: 'PATCH', body: JSON.stringify({ status: 'expired' }) });
        out.expired_unpaid++;
      } catch (e) {
        out.errors++;
        console.error('sweep error for booking', b.id, (e && e.message) || e);
      }
    }
    console.log('provisional-sweep:', JSON.stringify(out));
    await heartbeat('succeeded', startMs, out);
    return res.status(200).json(out);
  } catch (e) {
    console.error('provisional-sweep failed:', (e && e.message) || e);
    // A SEPARATE 'failed' row — never a rewrite of the last success (rows are append-only).
    await heartbeat('failed', startMs, { ...out, ok: false, error: String((e && e.message) || e).slice(0, 500) });
    return res.status(500).json({ ok: false, error: String((e && e.message) || e) });
  }
}
