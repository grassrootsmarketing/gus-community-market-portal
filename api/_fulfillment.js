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
export async function runFulfillment(row, owner, { maxAttempts = 6 } = {}) {
  const bookingId = row.booking_id;
  // Codex C1 (0078): the claim carries the row's GENERATION. A capture re-issues a held row as a
  // new generation and drops the old lease, so a worker that claimed the held stage can no longer
  // record anything on the paid work — complete_fulfillment() fences on owner + generation.
  const generation = Number.isInteger(row.generation) ? row.generation : 1;
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
    let superseded = false, advanced = false;
    if (row.target_status !== 'held') {
      const rows = await sbRpc('booking_transition', { p_booking_id: bookingId, p_retailer_id: ctx.retailer_id, p_action: 'promote_paid', p_fields: { status: row.target_status || 'pending' }, p_demo_fee: null });
      const tr = Array.isArray(rows) ? rows[0] : rows;
      if (!tr) throw new Error('promote_no_result');
      if (tr.ok !== true) {
        if (tr.reason === 'superseded') superseded = true;
        // Codex C3 (0078): the booking was legitimately advanced past this job's target (a manual
        // confirmation landed between the promotion and this retry). Not a conflict, never a
        // downgrade: the promotion is done, the demo exists on the confirmed booking, and the
        // confirmation the retailer's action sent supersedes the pending-stage payment notice.
        else if (tr.reason === 'already_advanced') advanced = true;
        else throw new Error('promote_refused:' + (tr.reason || 'unknown') + ':' + (tr.status_before || ''));
      } else if (row.target_status === 'confirmed' && !tr.demo_id) {
        throw new Error('demo_not_materialised');   // a confirmed booking must have its demo; retry
      }
    } else {
      // Codex C1: held-stage work is only current if the booking is STILL held with a live authorization
      // and the outbox row is still this claim's generation. Otherwise it was captured (the paid work is
      // a NEW generation this lease cannot touch — the completion below is refused) or cancelled/expired
      // (this generation is current and the work is superseded); a "hold placed" notice is wrong either way.
      // The claimed object said 'held'; decide on the CURRENT facts: the booking must still be held with
      // a live authorization AND the outbox row must still be this claim's generation. A capture flips
      // payment_status to 'paid' and re-issues the row before the booking is promoted, so the status
      // alone would still read 'held' — that is exactly the stale notice C1 forbids.
      let genNow = generation;
      try { const g = await sb(`booking_fulfillments?booking_id=eq.${encodeURIComponent(bookingId)}&select=generation`); genNow = (Array.isArray(g) && g[0] && Number.isInteger(g[0].generation)) ? g[0].generation : generation; } catch (_) {}
      if (ctx.status !== 'held' || ctx.payment_status !== 'authorized' || genNow !== generation) superseded = true;
    }
    if (superseded) {
      // No demo to create and no stale notice to send.
      demoOk = true; mailOk = true;
      err = row.target_status === 'held' ? ('superseded:hold_no_longer_active:' + (ctx.status || 'unknown') + ':' + (ctx.payment_status || 'unknown')) : 'superseded:booking_no_longer_active';
    } else if (advanced) {
      demoOk = true; mailOk = true; err = 'already_advanced:confirmed:payment_notice_superseded_by_confirmation';
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
  // Codex R4-01 (0081): ONE transactional record-or-park operation, fenced on lease owner AND
  // generation AND a still-pending row. It completes, records progress, or — when THIS claim's row
  // has reached the retry cap — parks it and opens its deduplicated case, atomically. A stale claim
  // (row re-issued by a capture, or re-leased after expiry) is a no-op: nothing is written, nothing
  // is parked, and the current owner finishes the work. There is no separate "park by booking id".
  let recorded = false, outcome = 'unrecorded', caseId = null;
  try {
    const r = await sbRpc('record_fulfillment', {
      p_booking_id: bookingId, p_owner: owner, p_generation: generation, p_demo: demoOk, p_emails: mailOk,
      p_done: done, p_err: err, p_max_attempts: maxAttempts,
    });
    const j = Array.isArray(r) ? r[0] : r;
    outcome = (j && j.outcome) || 'unrecorded';
    caseId = (j && j.case_id) || null;
    recorded = outcome === 'done' || outcome === 'progress' || outcome === 'exhausted';
    if (outcome === 'stale') err = (err ? err + '; ' : '') + 'record:stale_claim:' + ((j && j.reason) || 'unknown') + ':' + generation;
  } catch (e) {
    err = (err ? err + '; ' : '') + 'record:' + String((e && e.message) || e).slice(0, 120);
  }
  return { done, demo_created: demoOk, emails_sent: mailOk, error: err, recorded, outcome, case_id: caseId };
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
    const r = await runFulfillment(row, owner, { maxAttempts });
    if (r.done && r.recorded) { out.completed++; continue; }
    out.failed++;
    // Codex R4-01: exhaustion is decided INSIDE record_fulfillment on the CURRENT row's attempts and
    // only for a live claim — never from the claimed object's counters, never by booking id.
    if (r.outcome === 'exhausted') out.capped++;
  }
  return out;
}
