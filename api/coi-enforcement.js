// /api/coi-enforcement.js — hourly COI enforcement cron (work order Phase 3).
// Sends reminders + final warnings, and auto-cancels + refunds demos whose brand has no
// current COI by the 72h cutoff. Ships behind COI_ENFORCEMENT_MODE (off by default) so it
// does NOTHING until explicitly enabled after the Phase 1 migration is applied.
//
// Modes: off (default) | dry_run | warn_only | live   (work order Part D rollout ladder)
//
// SAFETY: fail-closed on any COI-status uncertainty (never cancel a demo we're not certain
// lacks coverage). Idempotent: re-running produces zero duplicate emails/cancels/refunds.

import { hasCurrentCoi, coiCutoff, localMidnightUtc } from './_coi-lib.js';

const SUPABASE_URL = 'https://ecapmcyumpjjgjwuokyv.supabase.co';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const FROM_ADDRESS = 'Demohub <bookings@demohubhq.com>';

function html(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function ymd(d) { return d.toISOString().slice(0, 10); }

async function sb(path, opts = {}) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...opts,
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=representation', ...(opts.headers || {}) },
  });
  const text = await r.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch (_) {}
  if (!r.ok) throw new Error(json && json.message ? json.message : (text || `sb HTTP ${r.status}`));
  return json;
}

async function sendEmail({ to, subject, htmlBody }) {
  if (!RESEND_API_KEY || !to) return { ok: false };
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: FROM_ADDRESS, to, reply_to: 'david@demohubhq.com', subject, html: htmlBody }),
    });
    return { ok: r.ok };
  } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
}

function dateLabel(dstr) {
  try { return new Date(dstr + 'T00:00:00Z').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' }); }
  catch (_) { return dstr; }
}
function cutoffLabel(cutoffDate, tz) {
  try { return cutoffDate.toLocaleString('en-US', { weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: tz || 'America/Los_Angeles', timeZoneName: 'short' }); }
  catch (_) { return cutoffDate.toISOString(); }
}

// ---- Email templates (Phase 5): plain, specific, one action, no em dashes ----
function shell(inner) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="margin:0;padding:24px;background:#fbf7f0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,sans-serif;color:#1c1c1a;">
<table align="center" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;background:white;border-radius:16px;overflow:hidden;border:1px solid rgba(15,44,23,0.08);">
<tr><td style="padding:26px 32px;background:#0f2c17;"><span style="font-weight:800;font-size:22px;color:#fbf7f0;letter-spacing:-0.04em;">demohub</span></td></tr>
<tr><td style="padding:34px 34px 28px;">${inner}</td></tr>
<tr><td style="padding:20px 32px;background:#fbf7f0;border-top:1px solid rgba(15,44,23,0.06);font-size:12px;color:#6b6a64;text-align:center;">Demohub &middot; demohubhq.com</td></tr>
</table></body></html>`;
}
function reminderEmail({ contact_name, retailerName, venueName, demoDate, cutoffDate, tz }) {
  return shell(`<div style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.12em;color:#a14e2a;margin-bottom:12px;">Certificate of Insurance needed</div>
<h1 style="font-family:Georgia,serif;font-size:26px;font-weight:500;line-height:1.25;color:#0f2c17;margin:0 0 14px;">Upload your COI for your ${html(retailerName)} demo</h1>
<p style="font-size:15px;line-height:1.6;color:#3a3a36;margin:0 0 16px;">Hi${contact_name ? ' ' + html(contact_name) : ''}, your demo at <strong>${html(retailerName)}</strong>${venueName ? ' (' + html(venueName) + ')' : ''} on <strong>${html(dateLabel(demoDate))}</strong> needs a current Certificate of Insurance on file.</p>
<p style="font-size:15px;line-height:1.6;color:#3a3a36;margin:0 0 20px;">Upload it by <strong>${html(cutoffLabel(cutoffDate, tz))}</strong> or this demo is automatically cancelled and refunded. One COI on file covers all of your demos.</p>
<div style="text-align:center;margin:0 0 8px;"><a href="https://demohubhq.com/brand/dashboard" style="background:#0f2c17;color:white;padding:12px 26px;border-radius:10px;text-decoration:none;font-weight:700;font-size:14px;display:inline-block;">Upload your COI</a></div>`);
}
function finalWarningEmail({ contact_name, retailerName, venueName, demoDate, cutoffDate, tz }) {
  return shell(`<div style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.12em;color:#a14e2a;margin-bottom:12px;">Final notice</div>
<h1 style="font-family:Georgia,serif;font-size:26px;font-weight:500;line-height:1.25;color:#0f2c17;margin:0 0 14px;">Your ${html(dateLabel(demoDate))} demo cancels tomorrow</h1>
<p style="font-size:15px;line-height:1.6;color:#3a3a36;margin:0 0 16px;">Hi${contact_name ? ' ' + html(contact_name) : ''}, your demo at <strong>${html(retailerName)}</strong>${venueName ? ' (' + html(venueName) + ')' : ''} still has no Certificate of Insurance on file.</p>
<p style="font-size:15px;line-height:1.6;color:#3a3a36;margin:0 0 20px;">If it is not uploaded by <strong>${html(cutoffLabel(cutoffDate, tz))}</strong>, the demo is automatically cancelled and your payment refunded. The store locks its schedule and product orders 72 hours ahead, which is why the deadline is firm.</p>
<div style="text-align:center;margin:0 0 8px;"><a href="https://demohubhq.com/brand/dashboard" style="background:#a14e2a;color:white;padding:12px 26px;border-radius:10px;text-decoration:none;font-weight:700;font-size:14px;display:inline-block;">Upload your COI now</a></div>`);
}
function cancellationEmail({ contact_name, retailerName, venueName, demoDate, amountCents, retailerSlug }) {
  const amt = amountCents != null ? '$' + (amountCents / 100).toFixed(2) : 'your payment';
  const rebook = retailerSlug ? `https://demohubhq.com/r/${retailerSlug}` : 'https://demohubhq.com';
  return shell(`<div style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.12em;color:#a14e2a;margin-bottom:12px;">Demo cancelled</div>
<h1 style="font-family:Georgia,serif;font-size:26px;font-weight:500;line-height:1.25;color:#0f2c17;margin:0 0 14px;">Your ${html(dateLabel(demoDate))} demo at ${html(retailerName)} was cancelled</h1>
<p style="font-size:15px;line-height:1.6;color:#3a3a36;margin:0 0 16px;">Hi${contact_name ? ' ' + html(contact_name) : ''}, this demo${venueName ? ' at ' + html(venueName) : ''} was cancelled because a current Certificate of Insurance was not on file 72 hours before the demo. Retailers require it to let you perform.</p>
<p style="font-size:15px;line-height:1.6;color:#3a3a36;margin:0 0 18px;">A full refund of <strong>${html(amt)}</strong> has been issued to your original payment method. Refunds take 5 to 10 business days to appear.</p>
<p style="font-size:15px;line-height:1.6;color:#3a3a36;margin:0 0 20px;">Upload a COI and you can re-book right away. One COI on file covers all of your future demos.</p>
<div style="text-align:center;margin:0 0 8px;"><a href="https://demohubhq.com/brand/dashboard" style="background:#0f2c17;color:white;padding:12px 24px;border-radius:10px;text-decoration:none;font-weight:700;font-size:14px;display:inline-block;margin-right:8px;">Upload your COI</a><a href="${rebook}" style="background:white;color:#0f2c17;border:1.5px solid rgba(15,44,23,0.15);padding:12px 22px;border-radius:10px;text-decoration:none;font-weight:600;font-size:14px;display:inline-block;">Re-book</a></div>`);
}
function staffCancelNotice({ brand_name, retailerName, venueName, demoDate, retailerSlug }) {
  return shell(`<div style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.12em;color:#a14e2a;margin-bottom:12px;">Demo removed from the schedule</div>
<h1 style="font-family:Georgia,serif;font-size:24px;font-weight:500;line-height:1.25;color:#0f2c17;margin:0 0 12px;">A demo was auto-cancelled for a missing COI</h1>
<p style="font-size:15px;line-height:1.6;color:#3a3a36;margin:0 0 8px;"><strong>${html(brand_name || 'A brand')}</strong> did not have a current Certificate of Insurance on file, so their demo${venueName ? ' at ' + html(venueName) : ''} on <strong>${html(dateLabel(demoDate))}</strong> was automatically cancelled and refunded. Do not order product or staff for it.</p>
<p style="font-size:12px;color:#6b6a64;line-height:1.55;margin:14px 0 0;"><a href="https://demohubhq.com/r/${html(retailerSlug || '')}/admin" style="color:#2a5b32;">Open your admin &rarr;</a></p>`);
}

// ---- Refund (keeps-all branch), idempotent via Idempotency-Key ----
async function refundBooking(booking, keepsAll) {
  if (!STRIPE_SECRET_KEY) return { ok: false, error: 'STRIPE_SECRET_KEY not configured' };
  if (!booking.payment_intent_id) return { ok: false, error: 'no payment_intent_id' };
  const params = new URLSearchParams();
  params.set('payment_intent', booking.payment_intent_id);
  if (!keepsAll) { params.set('reverse_transfer', 'true'); params.set('refund_application_fee', 'true'); }
  params.set('metadata[reason]', 'coi_missing_autocancel');
  params.set('metadata[booking_id]', String(booking.id));
  try {
    const r = await fetch('https://api.stripe.com/v1/refunds', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + STRIPE_SECRET_KEY, 'Content-Type': 'application/x-www-form-urlencoded', 'Idempotency-Key': 'coi-autocancel-' + booking.id },
      body: params.toString(),
    });
    const json = await r.json();
    if (!r.ok) return { ok: false, error: (json && json.error && json.error.message) || ('HTTP ' + r.status) };
    return { ok: true, refund_id: json.id, amount: json.amount };
  } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
}

// Fetch COI compliance records for a brand (linked via brand_contacts.email). Returns
// { ok, records }. ok=false means the source was unreadable (caller must fail-safe).
async function fetchComplianceCoi(brandEmail) {
  try {
    const rows = await sb(`compliance_records?select=doc_type,expires_at,brand_contacts(email)&doc_type=in.(coi,certificate_of_insurance,insurance)`);
    const email = String(brandEmail || '').toLowerCase();
    const records = (rows || []).filter(r => ((r.brand_contacts && r.brand_contacts.email) || '').toLowerCase() === email);
    return { ok: true, records };
  } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
}

async function notifyStaff(booking) {
  try {
    if (!RESEND_API_KEY || !booking.retailer_id) return;
    const staff = await sb(`internal_contacts?retailer_id=eq.${encodeURIComponent(booking.retailer_id)}&select=email,notification_prefs,venue_ids`);
    const targets = (staff || []).filter(s => {
      const p = s.notification_prefs || {};
      if (!p.on_scheduled) return false;
      const scopes = Array.isArray(s.venue_ids) ? s.venue_ids : [];
      if (scopes.length === 0) return true;
      return booking.venue_id && scopes.includes(booking.venue_id);
    }).filter(s => s.email);
    const r = booking.retailers || {};
    const v = booking.venues || {};
    const htmlBody = staffCancelNotice({ brand_name: booking.brand_name, retailerName: r.name, venueName: v.name, demoDate: booking.demo_date, retailerSlug: r.slug });
    await Promise.allSettled(targets.map(s => sendEmail({ to: s.email, subject: `Demo cancelled (no COI): ${booking.brand_name || 'a brand'} on ${dateLabel(booking.demo_date)}`, htmlBody })));
  } catch (_) {}
}

export default async function handler(req, res) {
  // ---- auth ----
  const secret = process.env.CRON_SECRET;
  const authOk = secret
    ? (req.headers['authorization'] || '') === 'Bearer ' + secret
    : !!req.headers['x-vercel-cron'];
  if (!authOk) return res.status(401).json({ error: 'unauthorized' });

  const mode = String(process.env.COI_ENFORCEMENT_MODE || 'off').toLowerCase();
  if (mode === 'off') return res.status(200).json({ ok: true, mode: 'off', note: 'COI enforcement disabled' });
  if (!SERVICE_KEY) return res.status(500).json({ error: 'SUPABASE_SERVICE_KEY not configured' });

  const canWrite = mode === 'warn_only' || mode === 'live';   // markers + emails
  const canCancel = mode === 'live';                          // cancel + refund
  const now = new Date();
  const log = { mode, checked: 0, reminders: 0, finalWarns: 0, cancels: 0, refunds: 0, refundRetries: 0, skipped: 0, covered: 0, decisions: [], errors: [] };

  try {
    const todayStr = ymd(now);
    const maxStr = ymd(new Date(now.getTime() + 10 * 86400000));
    const bookings = await sb(`bookings?select=*,retailers(id,platform_keeps_all,timezone,slug,name),venues(id,name)&status=in.(confirmed,pending)&payment_status=eq.paid&coi_waived_at=is.null&demo_date=gte.${todayStr}&demo_date=lte.${maxStr}`);

    for (const b of (bookings || [])) {
      log.checked++;
      try {
        if (!b.brand_id) { log.skipped++; log.errors.push({ booking: b.id, reason: 'no brand_id' }); continue; }
        const brandRows = await sb(`brands?id=eq.${encodeURIComponent(b.brand_id)}&select=id,email,company_name,contact_name,default_coi_url,default_coi_expires`);
        const brand = brandRows && brandRows[0];
        if (!brand) { log.skipped++; log.errors.push({ booking: b.id, reason: 'brand not found' }); continue; }

        // Covered by brand-level default COI? (certain source)
        if (hasCurrentCoi(brand, [], b.demo_date)) { log.covered++; continue; }

        // Not covered at brand level: check compliance_records. Fail-safe: if unreadable, skip.
        const comp = await fetchComplianceCoi(brand.email);
        if (!comp.ok) { log.skipped++; log.errors.push({ booking: b.id, reason: 'compliance read failed, fail-safe skip' }); continue; }
        if (hasCurrentCoi(brand, comp.records, b.demo_date)) { log.covered++; continue; }

        // NOT covered by any source -> reminder / final / cancel
        const tz = (b.retailers && b.retailers.timezone) || 'America/Los_Angeles';
        const cutoff = coiCutoff(b.demo_date, tz);
        if (!cutoff) { log.skipped++; log.errors.push({ booking: b.id, reason: 'bad cutoff' }); continue; }
        const lm = localMidnightUtc(b.demo_date, tz);
        const reminderTime = new Date(lm.getTime() - 7 * 86400000);
        const created = new Date(b.created_at);

        let action = 'none';
        if (now >= cutoff) action = 'cancel';
        else if (now >= new Date(cutoff.getTime() - 24 * 3600000) && !b.coi_final_warn_sent_at) action = 'final';
        else if (created <= reminderTime && now >= reminderTime && now < cutoff && !b.coi_reminder_sent_at) action = 'reminder';

        log.decisions.push({ booking: b.id, brand: brand.company_name, demo_date: b.demo_date, cutoff: cutoff.toISOString(), action });
        if (action === 'none') continue;

        const r = b.retailers || {}; const v = b.venues || {};

        if (action === 'reminder') {
          if (canWrite) {
            await sendEmail({ to: brand.email, subject: `COI needed for your demo at ${r.name || 'the store'} on ${dateLabel(b.demo_date)}`, htmlBody: reminderEmail({ contact_name: brand.contact_name, retailerName: r.name, venueName: v.name, demoDate: b.demo_date, cutoffDate: cutoff, tz }) });
            await sb(`bookings?id=eq.${encodeURIComponent(b.id)}`, { method: 'PATCH', body: JSON.stringify({ coi_reminder_sent_at: now.toISOString() }) });
          }
          log.reminders++;
        } else if (action === 'final') {
          if (canWrite) {
            await sendEmail({ to: brand.email, subject: `Final notice: your ${dateLabel(b.demo_date)} demo at ${r.name || 'the store'} cancels tomorrow`, htmlBody: finalWarningEmail({ contact_name: brand.contact_name, retailerName: r.name, venueName: v.name, demoDate: b.demo_date, cutoffDate: cutoff, tz }) });
            await sb(`bookings?id=eq.${encodeURIComponent(b.id)}`, { method: 'PATCH', body: JSON.stringify({ coi_final_warn_sent_at: now.toISOString() }) });
          }
          log.finalWarns++;
        } else if (action === 'cancel') {
          if (!canCancel) { log.decisions[log.decisions.length - 1].note = 'cancel suppressed (mode ' + mode + ')'; continue; }
          // idempotency guard: re-read
          const freshRows = await sb(`bookings?id=eq.${encodeURIComponent(b.id)}&select=id,status,payment_status,payment_intent_id`);
          const fresh = freshRows && freshRows[0];
          if (!fresh || fresh.status === 'cancelled' || fresh.payment_status === 'refunded' || fresh.payment_status === 'partial_refund') continue;
          // 1) write the cancel FIRST (a crash after this is recoverable via retry path)
          await sb(`bookings?id=eq.${encodeURIComponent(b.id)}`, { method: 'PATCH', body: JSON.stringify({ status: 'cancelled', cancelled_at: now.toISOString(), cancel_reason: 'coi_missing' }) });
          log.cancels++;
          // 2) refund (idempotency-keyed; keeps-all branch). Let charge.refunded webhook set payment_status/refunded_at.
          const keepsAll = !!(r.platform_keeps_all);
          const rf = await refundBooking(b, keepsAll);
          if (rf.ok) {
            log.refunds++;
            // 3) brand cancellation email + staff notice
            await sendEmail({ to: brand.email, subject: `Your ${dateLabel(b.demo_date)} demo at ${r.name || 'the store'} was cancelled`, htmlBody: cancellationEmail({ contact_name: brand.contact_name, retailerName: r.name, venueName: v.name, demoDate: b.demo_date, amountCents: b.amount_paid, retailerSlug: r.slug }) });
            await notifyStaff(b);
          } else {
            log.errors.push({ booking: b.id, reason: 'refund failed', detail: rf.error });
            // do NOT revert the cancel; next run retries via the retry path below.
          }
        }
      } catch (perErr) {
        log.skipped++;
        log.errors.push({ booking: b.id, reason: 'exception, fail-safe skip', detail: String((perErr && perErr.message) || perErr) });
      }
    }

    // ---- Retry path: cancelled-for-coi but not yet refunded ----
    if (canCancel) {
      try {
        const stuck = await sb(`bookings?select=*,retailers(platform_keeps_all,slug,name),venues(id,name)&status=eq.cancelled&cancel_reason=eq.coi_missing&payment_status=eq.paid&refunded_at=is.null`);
        for (const b of (stuck || [])) {
          const r = b.retailers || {};
          const rf = await refundBooking(b, !!r.platform_keeps_all);   // same idempotency key = safe no-op if already refunded
          if (rf.ok) { log.refundRetries++; }
          else { log.errors.push({ booking: b.id, reason: 'refund retry failed', detail: rf.error }); }
        }
      } catch (e) { log.errors.push({ reason: 'retry-path query failed', detail: String((e && e.message) || e) }); }
    }

    console.log('coi-enforcement run', JSON.stringify(log));
    return res.status(200).json({ ok: true, ...log });
  } catch (e) {
    console.error('coi-enforcement fatal', e);
    return res.status(500).json({ error: String((e && e.message) || e), ...log });
  }
}
