// api/demo-reminders.js — reminder emails to STORE CONTACTS before confirmed demos.
//
// Cron every 15 minutes (vercel.json) behind CRON_SECRET, same auth + heartbeat shape as
// refund-worker.js / provisional-sweep.js. Before this route existed the Team form saved reminder
// offsets (days_before / custom_days) and NOTHING read them.
//
// PER RUN. For every CONFIRMED future demo (demos row status='confirmed' with a booking_id whose
// booking is also 'confirmed' — the demos row is the calendar truth for date/time, a reschedule
// moves the demo not the booking), for every store contact of that retailer in scope for that venue
// with a reminder offset selected, compute the send instant in the RETAILER's zone
// (retailers.timezone, default America/Los_Angeles; api/_local-time.js) and send when
//     now >= sendAt  AND  now < sendAt + 24h (catch-up grace after an outage)  AND  now < demo start.
// Offsets: 1w / 3d / 1d / custom N days (all 9:00 local), morning_of (7:00 local), 1h (60 min before).
//
// IDEMPOTENT. Each send is keyed in demo_notifications (0073) as
//     reminder:<kind>@<YYYY-MM-DD>T<HH:MM>      (the demo's CURRENT slot)
// claim-first: the UNIQUE constraint stops two runs (or a redeploy replay) from double-sending; a
// failed send releases the claim so the next tick retries. Because the slot is part of the key, a
// rescheduled demo gets a fresh set of reminders for its new date and the old date's keys are simply
// never due again.
//
// VERDICT. One APPEND-ONLY cron_heartbeat row per run: 'succeeded' only when every due reminder was
// sent (or was already sent / claimed elsewhere); any send or bookkeeping error writes 'failed'
// (summary.partial=true, first_error) and answers 500 so Vercel's cron log agrees (Codex F-03).
//
// TEST HOOK. `?now=<ISO>` overrides the clock ONLY when the CRON_SECRET check has passed AND the
// bound target is not production. Production ignores it with 400 so no caller can replay reminders
// by lying about the time; the route harness (VERCEL_ENV=preview) uses it to walk a fixture demo
// through every offset deterministically.

import { getBinding, sendBindingFailure } from './_env.js';
import { selectedReminders } from './_notification-prefs.js';
import { demoStartUtc, reminderSendAt, reminderIsDue, slotKey } from './_local-time.js';
import { loadStoreContacts, targetsFor, buildContext, reminderMessage, sendClaimed } from './_staff-mail.js';

let _b = null;
const CRON_SECRET = process.env.CRON_SECRET;
const CRON_NAME = 'demo-reminders';
// Reminders reach at most 30 days ahead (custom N <= 30); look one day back so a morning_of / 1h
// reminder for a demo whose local date is already "yesterday" in UTC terms is still considered.
const LOOKBACK_DAYS = 1, LOOKAHEAD_DAYS = 31;
// Per-run send cap keeps a backlog (first run after an outage) inside the function budget; anything
// left is still inside its 24h grace on the next tick.
const SEND_CAP = 200;

async function sb(path) {
  const r = await fetch(`${_b.supabaseUrl}/rest/v1/${path}`, { headers: { apikey: _b.serviceKey, Authorization: `Bearer ${_b.serviceKey}` } });
  const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch (_) {}
  if (!r.ok) throw new Error((j && j.message) || t || ('HTTP ' + r.status));
  return Array.isArray(j) ? j : [];
}
const inList = (ids) => [...new Set(ids.filter(Boolean))].map(encodeURIComponent).join(',');
const ymd = (d) => d.toISOString().slice(0, 10);

// Phase E liveness — mirrors refund-worker.js heartbeat(): append-only, best-effort.
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
  try { _b = await getBinding(); } catch (e) { return sendBindingFailure(res, e); }

  // Clock override: authenticated, non-production only.
  let now = new Date();
  const nowParam = req.query && req.query.now;
  if (nowParam != null && String(nowParam) !== '') {
    if (_b.targetName === 'production') return res.status(400).json({ error: 'now_override_not_permitted' });
    const parsed = new Date(String(nowParam));
    if (Number.isNaN(parsed.getTime())) return res.status(400).json({ error: 'invalid_now' });
    now = parsed;
  }

  const startMs = Date.now();
  const out = { ok: true, now: now.toISOString(), demos: 0, contacts: 0, due: 0, sent: 0, skipped: 0, failed: 0, deferred: 0, errors: 0 };
  let firstError = null;
  const noteError = (msg) => { out.errors++; if (!firstError) firstError = String(msg || 'unknown_error').slice(0, 200); };

  try {
    const from = ymd(new Date(now.getTime() - LOOKBACK_DAYS * 86400000));
    const to = ymd(new Date(now.getTime() + LOOKAHEAD_DAYS * 86400000));
    const demos = await sb(`demos?status=eq.confirmed&booking_id=not.is.null&demo_date=gte.${from}&demo_date=lte.${to}&select=id,booking_id,retailer_id,venue_id,brand_id,company_name,product,product_skus,contact_name,contact_phone,notes,demo_date,demo_time&order=demo_date.asc`);
    out.demos = demos.length;
    if (!demos.length) { await heartbeat('succeeded', startMs, out); return res.status(200).json(out); }

    const bookings = await sb(`bookings?id=in.(${inList(demos.map(d => d.booking_id))})&status=eq.confirmed&select=id,retailer_id,venue_id,brand_id,brand_name,contact_name,contact_phone,product,product_skus,notes,demo_date,demo_time,status`);
    const bookingById = new Map(bookings.map(b => [b.id, b]));
    const live = demos.filter(d => bookingById.has(d.booking_id));

    const retailerIds = [...new Set(live.map(d => d.retailer_id))];
    const [retailers, venues, brands] = await Promise.all([
      retailerIds.length ? sb(`retailers?id=in.(${inList(retailerIds)})&select=id,name,slug,timezone`) : [],
      live.some(d => d.venue_id) ? sb(`venues?id=in.(${inList(live.map(d => d.venue_id))})&select=id,name,address`) : [],
      live.some(d => d.brand_id || bookingById.get(d.booking_id).brand_id)
        ? sb(`brands?id=in.(${inList(live.map(d => d.brand_id || bookingById.get(d.booking_id).brand_id))})&select=id,company_name,contact_name,phone,needs_electricity`) : [],
    ]);
    const byId = (rows) => new Map(rows.map(r => [r.id, r]));
    const retailerById = byId(retailers), venueById = byId(venues), brandById = byId(brands);
    const contactsByRetailer = new Map();
    for (const rid of retailerIds) {
      try { contactsByRetailer.set(rid, await loadStoreContacts(_b, rid)); }
      catch (e) { contactsByRetailer.set(rid, []); noteError('contacts: ' + ((e && e.message) || e)); }
    }
    out.contacts = [...contactsByRetailer.values()].reduce((n, l) => n + l.length, 0);

    let sends = 0;
    for (const d of live) {
      const booking = bookingById.get(d.booking_id);
      const retailer = retailerById.get(d.retailer_id) || {};
      const ctx = buildContext({ booking, demo: d, retailer, venue: venueById.get(d.venue_id), brand: brandById.get(d.brand_id || booking.brand_id), contacts: contactsByRetailer.get(d.retailer_id) || [] });
      const startAt = demoStartUtc(ctx.demo_date, ctx.demo_time, ctx.tz);
      if (!startAt || startAt.getTime() <= now.getTime()) continue;   // never remind about a demo that has started
      const slot = slotKey(ctx.demo_date, ctx.demo_time);
      const contacts = targetsFor(ctx.contacts, d.venue_id, null);
      for (const c of contacts) {
        for (const [kind, customDays] of selectedReminders(c.prefs)) {
          const sendAt = reminderSendAt(kind, ctx.demo_date, ctx.demo_time, ctx.tz, customDays);
          if (!reminderIsDue(sendAt, startAt, now)) continue;
          out.due++;
          if (sends >= SEND_CAP) { out.deferred++; continue; }
          try {
            const { subject, html } = reminderMessage(_b, ctx, kind, customDays);
            const r = await sendClaimed(_b, { booking_id: d.booking_id, contact: c, kind: `reminder:${kind}@${slot}`, subject, html });
            if (r === 'sent') { out.sent++; sends++; }
            else if (r === 'skipped') out.skipped++;
            else { out.failed++; noteError(`send: ${kind} for booking ${d.booking_id}`); }
          } catch (e) { out.failed++; noteError('claim: ' + ((e && e.message) || e)); }
        }
      }
    }

    if (out.errors === 0 && out.failed === 0) {
      await heartbeat('succeeded', startMs, out);
      return res.status(200).json(out);
    }
    out.ok = false;
    await heartbeat('failed', startMs, { ...out, partial: true, first_error: firstError });
    return res.status(500).json({ ...out, error: 'partial_failure', first_error: firstError });
  } catch (e) {
    console.error('demo-reminders error:', (e && e.message) || e);
    await heartbeat('failed', startMs, { ...out, ok: false, error: String((e && e.message) || e).slice(0, 500) });
    return res.status(500).json({ ok: false, error: 'worker_error' });
  }
}
