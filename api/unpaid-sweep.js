// api/unpaid-sweep.js: releases unpaid reservations whose 24-hour deadline has passed (migration 0123).
// Cron every 15 min behind CRON_SECRET (same auth pattern as refund-worker and provisional-sweep).
//
// The database owns the deadline (bookings.unpaid_expires_at, set on insert, never moved) and every state change.
// This worker only sequences the steps and talks to the payment provider between them:
//
//   booking with no payment group      -> expire_unpaid_booking (one step, under the booking row lock)
//   group that is due or already begun -> 1. begin_unpaid_group_expiry: from here no attempt is created or reused
//                                         2. settle the live attempt with Stripe (below)
//                                         3. finalize_unpaid_group_expiry: only now are the bookings released
//
// Settling a live attempt. Capacity is never released because a timer fired while a session may still charge:
//   open attempt, session open       -> expire the session on Stripe, confirm it reads expired, record it through
//                                       expire_payment_attempt (the path checkout.session.expired uses)
//   open attempt, session expired    -> record it
//   open attempt, session complete   -> NOT touched. The payment wins through the verified payment path; the group
//                                       stays payable for it and finalize yields once it is applied.
//   reserved attempt, no session id  -> an unknown creation outcome is not proof that no session exists. After a grace
//                                       period (no request can still be in flight) Stripe is searched for sessions of
//                                       this group. Open ones are expired first; a complete one blocks the group for
//                                       the operator; only when every session found is expired, or none exists, is the
//                                       reservation recorded as failed.
//   anything unreadable              -> the group stays blocked ('expiring') and the next tick tries again.
//
// Nothing is deleted. Idempotent and safe to rerun: every database step re-checks state under its own locks.

import { getBinding, sendBindingFailure } from './_env.js';

let _b = null;
const CRON_SECRET = process.env.CRON_SECRET;
const STRIPE = process.env.STRIPE_SECRET_KEY;
const BATCH = 25;
const CRON_NAME = 'unpaid-sweep';
// a reservation younger than this may still have its create request in flight (functions time out well before it)
export const RESERVATION_GRACE_MS = 15 * 60 * 1000;
const MAX_LIST_PAGES = 10;

async function rpc(fn, args) {
  const r = await fetch(`${_b.supabaseUrl}/rest/v1/rpc/${fn}`, {
    method: 'POST', headers: { apikey: _b.serviceKey, Authorization: `Bearer ${_b.serviceKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch (_) {}
  if (!r.ok) throw new Error(fn + ': ' + ((j && j.message) || t || ('HTTP ' + r.status)));
  return j;
}
const one = (j) => (Array.isArray(j) ? j[0] : j) || {};

async function heartbeat(outcome, startMs, summary) {
  try {
    if (!_b) return;
    await fetch(`${_b.supabaseUrl}/rest/v1/cron_heartbeat`, {
      method: 'POST', headers: { apikey: _b.serviceKey, Authorization: `Bearer ${_b.serviceKey}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify({ cron_name: CRON_NAME, outcome, duration_ms: Date.now() - startMs, summary }),
    });
  } catch (_) { /* best-effort */ }
}

// ---- Stripe, read and expire only. No session is ever created here. ----
async function stripeCall(method, path) {
  try {
    const r = await fetch('https://api.stripe.com/v1/' + path, { method, headers: { Authorization: `Bearer ${STRIPE}`, ...(method === 'POST' ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) } });
    let j = null; try { j = await r.json(); } catch (_) { j = null; }
    return { ok: r.ok && !!j, status: r.status, json: j };
  } catch (e) { return { ok: false, status: 0, json: null, error: String((e && e.message) || e) }; }
}
// -> 'expired' | 'complete' | 'unknown'. 'expired' is only ever answered from a CURRENT read of the session.
async function settleSession(sid) {
  let cur = await stripeCall('GET', `checkout/sessions/${encodeURIComponent(sid)}`);
  if (!cur.ok || !cur.json.id) return 'unknown';
  const state = (s) => (String(s.status || '') === 'complete' || String(s.payment_status || '') === 'paid') ? 'complete' : String(s.status || '') === 'expired' ? 'expired' : String(s.status || '') === 'open' ? 'open' : 'unknown';
  let st = state(cur.json);
  if (st === 'open') {
    await stripeCall('POST', `checkout/sessions/${encodeURIComponent(sid)}/expire`);   // its answer is not trusted; the read below is
    cur = await stripeCall('GET', `checkout/sessions/${encodeURIComponent(sid)}`);
    if (!cur.ok || !cur.json.id) return 'unknown';
    st = state(cur.json);
  }
  return st === 'expired' || st === 'complete' ? st : 'unknown';
}
// Every Checkout Session created at or after `sinceSec` that names this group. null = could not be read completely.
async function findGroupSessions(gid, sinceSec) {
  const found = []; let after = null;
  for (let page = 0; page < MAX_LIST_PAGES; page++) {
    const q = `checkout/sessions?limit=100&created[gte]=${Math.floor(sinceSec)}` + (after ? `&starting_after=${encodeURIComponent(after)}` : '');
    const r = await stripeCall('GET', q);
    if (!r.ok || !Array.isArray(r.json.data)) return null;
    for (const s of r.json.data) if (s && s.metadata && String(s.metadata.payment_group_id || '') === String(gid)) found.push(s.id);
    if (!r.json.has_more) return found;
    after = r.json.data.length ? r.json.data[r.json.data.length - 1].id : null;
    if (!after) return null;
  }
  return null;   // more pages than this worker reads: unknown, never "none"
}

// One group, steps 1 to 3. Returns a short word for the summary; throws only on a database error.
async function expireGroup(gid, pNow, nowMs) {
  const begun = one(await rpc('begin_unpaid_group_expiry', { p_group_id: gid, p_now: pNow }));
  if (begun.outcome !== 'expiring') return begun.outcome === 'not_open' ? 'payment_won' : (begun.outcome || 'skipped');
  const live = begun.live_attempt;
  if (live && live.status === 'open') {
    if (!live.session_id) return 'blocked_open_without_session';
    const st = await settleSession(live.session_id);
    if (st === 'complete') return 'blocked_payment_pending';
    if (st !== 'expired') return 'blocked_provider_unknown';
    await rpc('expire_payment_attempt', { p_session_id: live.session_id });
  } else if (live && live.status === 'reserved') {
    const since = Date.parse(live.reserved_at || live.created_at || '');
    if (!Number.isFinite(since) || nowMs - since < RESERVATION_GRACE_MS) return 'blocked_reservation_in_grace';
    const sessions = await findGroupSessions(gid, since / 1000 - 300);
    if (sessions === null) return 'blocked_provider_unknown';
    let recorded = null;
    for (const sid of sessions) {
      const st = await settleSession(sid);
      if (st === 'complete') return 'blocked_unbound_session_complete';   // the verified payment path opens its unknown_session case
      if (st !== 'expired') return 'blocked_provider_unknown';
      recorded = recorded || sid;
    }
    const failed = one(await rpc('fail_payment_attempt', { p_attempt_id: live.attempt_id, p_session_id: recorded, p_error: recorded ? 'unpaid_expired:session_expired' : 'unpaid_expired:no_session_found' }));
    if (failed.outcome !== 'failed') return 'blocked_attempt_moved';   // another path moved it first; the next tick re-reads
  } else if (live) {
    return 'blocked_attempt_' + String(live.status);
  }
  const fin = one(await rpc('finalize_unpaid_group_expiry', { p_group_id: gid, p_now: pNow }));
  if (fin.outcome === 'expired') return 'expired';
  if (fin.outcome === 'payment_won') return 'payment_won';
  if (fin.outcome === 'attempt_live') return 'blocked_attempt_live';
  return fin.outcome || 'skipped';
}

export default async function handler(req, res) {
  if (req.method !== 'POST' && req.method !== 'GET') return res.status(405).json({ error: 'POST only' });
  const provided = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!CRON_SECRET || provided !== CRON_SECRET) return res.status(401).json({ error: 'unauthorized' });
  try { _b = await getBinding(); } catch (e) { return sendBindingFailure(res, e); }

  const startMs = Date.now();
  // controlled clock for the tests only; the scheduled run always uses the database's own now()
  const override = (process.env.DEMOHUB_TEST_HOOKS === '1' && process.env.DEMOHUB_CLOCK_OVERRIDE) ? new Date(process.env.DEMOHUB_CLOCK_OVERRIDE) : null;
  const pNow = override ? override.toISOString() : null;
  const nowMs = override ? override.getTime() : Date.now();
  const out = { ok: true, scanned: 0, expired_bookings: 0, expired_groups: 0, payment_won: 0, blocked: 0, skipped: 0, errors: 0, blocked_reasons: {} };
  let firstError = null;
  try {
    const due = await rpc('unpaid_expiry_due', { p_limit: BATCH, p_now: pNow }) || [];
    out.scanned = due.length;
    for (const d of due) {
      try {
        if (d.payment_group_id) {
          if (!STRIPE) { out.blocked++; out.blocked_reasons.no_provider_key = (out.blocked_reasons.no_provider_key || 0) + 1; continue; }
          const r = await expireGroup(d.payment_group_id, pNow, nowMs);
          if (r === 'expired') out.expired_groups++;
          else if (r === 'payment_won') out.payment_won++;
          else if (/^blocked_/.test(r)) { out.blocked++; out.blocked_reasons[r] = (out.blocked_reasons[r] || 0) + 1; console.warn('unpaid-sweep: group', d.payment_group_id, r); }
          else out.skipped++;
        } else {
          const r = one(await rpc('expire_unpaid_booking', { p_booking_id: d.booking_id, p_now: pNow }));
          if (r.outcome === 'expired') out.expired_bookings++; else out.skipped++;
        }
      } catch (e) {
        out.errors++;
        if (!firstError) firstError = String((e && e.message) || e).slice(0, 200);
        console.error('unpaid-sweep error for', d.payment_group_id || d.booking_id, (e && e.message) || e);
      }
    }
    console.log('unpaid-sweep:', JSON.stringify(out));
    if (out.errors === 0) { await heartbeat('succeeded', startMs, out); return res.status(200).json(out); }
    out.ok = false;
    await heartbeat('failed', startMs, { ...out, partial: true, first_error: firstError });
    return res.status(500).json({ ...out, error: 'partial_failure', first_error: firstError });
  } catch (e) {
    console.error('unpaid-sweep failed:', (e && e.message) || e);
    await heartbeat('failed', startMs, { ...out, ok: false, error: String((e && e.message) || e).slice(0, 500) });
    return res.status(500).json({ ok: false, error: String((e && e.message) || e) });
  }
}
