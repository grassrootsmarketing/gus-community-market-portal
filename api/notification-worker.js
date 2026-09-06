// api/notification-worker.js — the notification outbox worker (Codex Release A).
//
// Cron every 15 minutes (vercel.json) behind CRON_SECRET, same auth + heartbeat shape as
// refund-worker.js / provisional-sweep.js. Replaces the draft api/demo-reminders.js.
//
// PER RUN (api/_notification-outbox.js runWorker):
//   1. fan out notification_events written by the 0074 triggers (booking confirmed / cancelled /
//      rescheduled, COI approved / rejected) into notification_deliveries — one row per recipient;
//   2. schedule reminder deliveries for confirmed future bookings from each store contact's
//      normalized reminder offsets (due_at in the store's zone; already-due rows are recorded as
//      skipped, never sent as a backlog);
//   3. claim due rows (atomic filtered UPDATE + claim_token + 5-minute lease), recheck each against
//      the CURRENT booking/contact/verification, freeze the payload and idempotency key before the
//      first attempt, send through api/_mail.js (Idempotency-Key, 10s deadline), record the outcome
//      with a compare-and-set on the token;
//   4. report backlog / oldest pending age / failed / unknown counts.
//
// FEATURE FLAG. NOTIFICATION_WORKER_ENABLED must be exactly "true" (api/_flags.js). Off: 200
// {ok:true, disabled:true}, the outbox is never touched, NO heartbeat, and api/find-retailer.js does
// not require the job. (The binding is still validated first, so an invalid deployment answers 503
// like every other route.) Turn on after 0074 is applied and RESEND_API_KEY is bound.
//
// VERDICT. One APPEND-ONLY cron_heartbeat row per run: 'succeeded' only when every step ran clean and
// every attempted send was accepted (or skipped by design); a failed/unknown send, a lost lease, an
// enqueue/read failure, a failed completion record, or a missing mail credential writes 'failed'
// (summary.partial=true, first_error) and answers 500 so Vercel's cron log agrees (Codex F-03).
// The summary carries counts only — no addresses, subjects or bodies.
//
// NO CLOCK OVERRIDE. The route never accepts a `now`; tests drive the internals with injected clocks.

import { getBinding, sendBindingFailure } from './_env.js';
import { FLAGS } from './_flags.js';
import { runWorker } from './_notification-outbox.js';

let _b = null;
const CRON_SECRET = process.env.CRON_SECRET;
export const CRON_NAME = 'notification-worker';

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

export default async function handler(req, res) {
  if (req.method !== 'POST' && req.method !== 'GET') return res.status(405).json({ error: 'POST only' });
  const provided = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!CRON_SECRET || provided !== CRON_SECRET) return res.status(401).json({ error: 'unauthorized' });
  // Binding first: a deployment whose binding is invalid fails closed (503) whatever the flag says.
  try { _b = await getBinding(); } catch (e) { return sendBindingFailure(res, e); }
  if (!FLAGS.notificationWorker) return res.status(200).json({ ok: true, disabled: true, job: CRON_NAME });

  const startMs = Date.now();
  // Missing provider credentials are a visible failure, not a clean empty run: nothing could have
  // been sent, and pretending otherwise is how a dead mail path hides behind a green heartbeat.
  if (!_b.resendApiKey) {
    const summary = { ok: false, error: 'mail_provider_not_configured' };
    await heartbeat('failed', startMs, summary);
    return res.status(500).json(summary);
  }
  try {
    const summary = await runWorker(_b, {});
    if (summary.ok) {
      await heartbeat('succeeded', startMs, summary);
      return res.status(200).json(summary);
    }
    await heartbeat('failed', startMs, { ...summary, partial: true });
    return res.status(500).json({ ...summary, error: 'partial_failure' });
  } catch (e) {
    console.error('notification-worker error:', (e && e.message) || e);
    await heartbeat('failed', startMs, { ok: false, error: String((e && e.code) || (e && e.message) || e).slice(0, 200) });
    return res.status(500).json({ ok: false, error: 'worker_error' });
  }
}
