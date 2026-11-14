// /api/stripe-connect-webhook, receives CONNECTED-ACCOUNT events from Stripe and keeps each store's payout
// readiness current (Codex connected-checkout release verdict, 2026-11-13, "Connected-account status work order").
//
// Why a second route. Stripe sends account.updated for a connected account only to a webhook destination whose
// scope is "Connected accounts", and that destination has its OWN signing secret. The platform route
// (api/stripe-webhook.js, STRIPE_WEBHOOK_SECRET) carries the money events and is deliberately untouched: this file
// shares no secret, no dispatch and no handler with it. A request here is verified only against
// STRIPE_CONNECT_WEBHOOK_SECRET, and a deployment that does not have that variable refuses every request before it
// reads the body or calls anything (fail closed), which cannot affect the platform route.
//
// What it does with an event, in this order:
//   1. verifies the signature over the RAW body with the connected-accounts secret; nothing in the body is read,
//      and no account id is trusted, before that passes;
//   2. rejects an event whose livemode does not match the mode of the running Stripe key (a test event on a live
//      deployment, or the reverse);
//   3. claims the event in the same durable inbox the platform route uses (claim_stripe_event), so a duplicate
//      delivery of a completed event is acknowledged and changes nothing;
//   4. maps the event's account to the ONE retailer whose stored stripe_account_id equals it. An account no store
//      holds is logged as an alert and acknowledged; no row is modified and Stripe is not asked about it;
//   5. does NOT read readiness from the event. It retrieves the account's CURRENT state from Stripe and applies the
//      shared policy (api/_connect-readiness.js, the same function the admin's connect-status refresh uses). A late
//      or out-of-order event therefore cannot restore a readiness Stripe no longer reports;
//   6. writes only the three readiness columns, only on that retailer, guarded by the account id again;
//   7. answers 500 on any transient failure (Stripe unreachable, a database write refused) so Stripe retries.
//
// Events handled: account.updated and capability.updated (both mean "re-read this account"). Everything else is
// acknowledged and ignored.
//
// Env required:
//   STRIPE_CONNECT_WEBHOOK_SECRET   the signing secret of the "Connected accounts" destination (whsec_...)
//   STRIPE_SECRET_KEY               the platform key, read through the validated binding
// Never used here: STRIPE_WEBHOOK_SECRET (the platform destination's secret).

import { createHmac, timingSafeEqual, randomBytes } from 'crypto';
import { getBinding, sendBindingFailure, supabase } from './_env.js';
import { connectReadiness, readinessPatch, notReadyReadiness } from './_connect-readiness.js';

// The raw body is needed for signature verification, so the built-in parser is off and the stream is read here.
export const config = { api: { bodyParser: false } };

const TOLERANCE_SECONDS = 300;   // Stripe's default replay window
const HANDLED = new Set(['account.updated', 'capability.updated']);
const ACCOUNT_ID_RE = /^acct_[A-Za-z0-9]+$/;

// A structured, searchable log line for anything an operator should look at. Never carries a secret, a signature
// header or a request body.
function alert(kind, detail) {
  console.error('CONNECT_WEBHOOK_ALERT', JSON.stringify({ kind, ...(detail || {}) }));
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// Stripe's signature scheme (t=<unix>,v1=<hex hmac of "t.rawBody">), verified without the SDK. Returns the parsed
// event only when a v1 signature matches under the given secret inside the tolerance window; otherwise null.
function verifySignature(rawBody, sigHeader, secret) {
  if (!sigHeader || !secret) return null;
  let t = null; const v1 = [];
  for (const seg of String(sigHeader).split(',')) {
    const idx = seg.indexOf('=');
    if (idx < 0) continue;
    const k = seg.slice(0, idx).trim(), v = seg.slice(idx + 1).trim();
    if (k === 't') t = v;
    else if (k === 'v1') v1.push(v);
  }
  if (!t || v1.length === 0) return null;
  const timestamp = parseInt(t, 10);
  if (!Number.isFinite(timestamp)) return null;
  if (Math.abs(Math.floor(Date.now() / 1000) - timestamp) > TOLERANCE_SECONDS) return null;
  const expected = Buffer.from(createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex'), 'hex');
  for (const candidate of v1) {
    const cand = Buffer.from(candidate, 'hex');
    if (cand.length === expected.length && timingSafeEqual(cand, expected)) {
      try { return JSON.parse(rawBody); } catch (_) { return null; }
    }
  }
  return null;
}

// The account's CURRENT state on Stripe. { account } when Stripe returns it; { gone: true } when Stripe says the
// platform has no such account or no access to it any more; a THROW for anything else (unreachable, 5xx, rate
// limited, an unreadable body), which the handler turns into a retryable 500.
async function retrieveAccount(b, accountId) {
  let r;
  try {
    r = await fetch(`https://api.stripe.com/v1/accounts/${encodeURIComponent(accountId)}`, { headers: { Authorization: 'Bearer ' + b.stripeKey } });
  } catch (e) {
    throw new Error('stripe_unreachable');
  }
  let j = null; try { j = await r.json(); } catch (_) { j = null; }
  if (r.ok && j && j.id === accountId) return { account: j };
  const code = j && j.error && j.error.code;
  if (r.status === 404 || (r.status === 403 && code === 'account_invalid')) return { gone: true };
  throw new Error('stripe_account_retrieve_failed:' + r.status);
}

const sameReadiness = (a, b) => a.charges_enabled === b.charges_enabled && a.payouts_enabled === b.payouts_enabled && a.status === b.status;

// Re-read one connected account from Stripe and store its readiness on the one retailer that holds it.
// Exported for the unit tests; the route below is its only production caller.
export async function syncConnectedAccount(b, accountId) {
  const db = supabase(b);
  const rows = await db.json(`retailers?stripe_account_id=eq.${encodeURIComponent(accountId)}&select=id,stripe_account_id`);
  const holders = (Array.isArray(rows) ? rows : []).filter(r => r && r.id && r.stripe_account_id === accountId);
  if (holders.length !== 1) {
    // No store holds this account (or, against the unique index, more than one does): nothing is written anywhere.
    alert(holders.length ? 'ambiguous_account' : 'unknown_account', { account: accountId, holders: holders.length });
    return { outcome: holders.length ? 'ambiguous_account' : 'unknown_account' };
  }
  const retailerId = holders[0].id;

  // Retrieve, write, then retrieve once more. Two deliveries handled at the same moment each read Stripe and each
  // write; the second read lets the one that wrote an older state see the newer one and correct it. At most one
  // correction per event; any later change arrives as its own event.
  let written = null, gone = false;
  for (let pass = 0; pass < 2; pass++) {
    const cur = await retrieveAccount(b, accountId);
    gone = !!cur.gone;
    const readiness = gone ? notReadyReadiness() : connectReadiness(cur.account);
    if (written && sameReadiness(written, readiness)) break;
    const out = await db.json(`retailers?id=eq.${encodeURIComponent(retailerId)}&stripe_account_id=eq.${encodeURIComponent(accountId)}`, {
      method: 'PATCH', body: JSON.stringify(readinessPatch(readiness)),
    });
    if (!Array.isArray(out) || out.length !== 1) {
      // The store let go of this account between the lookup and the write: the guarded PATCH matched nothing.
      alert('account_no_longer_held', { account: accountId, retailer_id: retailerId });
      return { outcome: 'unknown_account' };
    }
    if (written) alert('readiness_corrected_after_write', { account: accountId, retailer_id: retailerId, status: readiness.status });
    written = readiness;
  }
  if (gone) alert('account_unreachable_marked_not_ready', { account: accountId, retailer_id: retailerId });
  console.log(`connect webhook: retailer ${retailerId} charges=${written.charges_enabled} payouts=${written.payouts_enabled} transfers=${written.transfers_active} status=${written.status}`);
  return { outcome: 'synced', retailer_id: retailerId, ready: written.ready, status: written.status };
}

// The connected account an event is about, or null with a reason. A connected-account event carries the account id
// at the top level (event.account); the object inside must not name a different account.
function eventAccount(event) {
  const top = typeof event.account === 'string' ? event.account : '';
  if (!top) return { account: null, reason: 'no_connected_account_on_event' };
  if (!ACCOUNT_ID_RE.test(top)) return { account: null, reason: 'malformed_account_id' };
  const obj = (event.data && event.data.object) || {};
  const named = obj.object === 'account' ? obj.id : (obj.object === 'capability' ? obj.account : null);
  if (named != null && named !== top) return { account: null, reason: 'account_id_mismatch' };
  return { account: top, reason: null };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  // Fail closed, before the body is read and before any outbound call: no connected-accounts secret, no service.
  // The platform secret is never a fallback, and a deployment where the two variables hold the same value is
  // refused as misconfigured (each Stripe destination has its own secret).
  const secret = String(process.env.STRIPE_CONNECT_WEBHOOK_SECRET || '').trim();
  if (!secret) {
    alert('secret_not_configured');
    return res.status(500).json({ error: 'connect_webhook_secret_not_configured' });
  }
  if (secret === String(process.env.STRIPE_WEBHOOK_SECRET || '').trim()) {
    alert('secret_same_as_platform_secret');
    return res.status(500).json({ error: 'connect_webhook_secret_misconfigured' });
  }
  let b;
  try { b = await getBinding(); } catch (e) { return sendBindingFailure(res, e); }
  if (!b.stripeKey || (b.stripeMode !== 'live' && b.stripeMode !== 'test')) {
    return res.status(500).json({ error: 'STRIPE_SECRET_KEY not configured' });
  }

  const rawBody = await readRawBody(req);
  const event = verifySignature(rawBody, req.headers['stripe-signature'], secret);
  if (!event || typeof event.id !== 'string' || !event.id || typeof event.type !== 'string') {
    console.warn('connect webhook: signature invalid or expired');
    return res.status(400).json({ error: 'signature invalid' });
  }

  // Wrong mode or environment: a signed event from the other mode is rejected, never applied.
  if (typeof event.livemode !== 'boolean' || event.livemode !== (b.stripeMode === 'live')) {
    alert('wrong_mode', { event_id: event.id, event_livemode: event.livemode === true, key_mode: b.stripeMode });
    return res.status(400).json({ error: 'wrong_mode' });
  }

  // The same durable inbox as the platform route: only a row already 'completed' is skipped; a 'processing' or
  // 'failed' row is a delivery that did not finish and is processed again. If the inbox cannot be reached nothing
  // is processed without a claim (503, Stripe retries).
  const db = supabase(b);
  const owner = randomBytes(16).toString('hex');
  const first = (r) => (Array.isArray(r.json) ? r.json[0] : r.json);
  const claim = await db.rpc('claim_stripe_event', { p_event_id: event.id, p_event_type: event.type, p_owner: owner, p_lease_seconds: 120 }).catch(() => null);
  if (!claim || !claim.ok) {
    console.error('connect webhook: event inbox claim failed (fail closed)');
    return res.status(503).json({ error: 'inbox_unavailable' });
  }
  const claimVal = first(claim);
  if (claimVal === 'skip') return res.status(200).json({ received: true, duplicate: true });
  if (claimVal === 'busy') return res.status(409).json({ error: 'event_in_progress' });

  try {
    let result = { outcome: 'ignored' };
    if (HANDLED.has(event.type)) {
      const who = eventAccount(event);
      if (!who.account) {
        alert(who.reason, { event_id: event.id, event_type: event.type });
        result = { outcome: 'ignored', reason: who.reason };
      } else {
        result = await syncConnectedAccount(b, who.account);
      }
    } else {
      console.log(`connect webhook: ignored event ${event.type}`);
    }
    const done = await db.rpc('complete_stripe_event', { p_event_id: event.id, p_owner: owner });
    if (!done.ok || first(done) !== true) {
      console.warn('connect webhook: inbox completion not recorded (lease lost?):', event.id);
      return res.status(500).json({ error: 'completion_not_recorded' });
    }
    return res.status(200).json({ received: true, outcome: result.outcome });
  } catch (e) {
    // A transient failure: release the lease so the retry can reclaim the event, and answer 500 so Stripe retries.
    const msg = String((e && e.message) || e).slice(0, 200);
    try { await db.rpc('fail_stripe_event', { p_event_id: event.id, p_owner: owner, p_err: msg }); } catch (_) {}
    console.error(`connect webhook: handler error for ${event.type}:`, msg);
    return res.status(500).json({ error: 'sync_failed' });
  }
}
