// api/_staff-mail.js — every email a STORE CONTACT (internal_contacts) receives about a demo.
//
// Store contacts are the people at a location who order product and host demos. They do not sign
// in; they get emails. Product decision (owner, 2026-09): they are NOT emailed when a brand merely
// books or pays. They hear about a demo when it is CONFIRMED, get reminders before it, and are told
// when a confirmed demo is cancelled or rescheduled. This module is the one implementation of
//   * who is a target (venue scope + notification_prefs, read through _notification-prefs.js),
//   * the brand-neutral staff email (table layout, factored out of the old booking.js "Wave 8"
//     block so every notice looks the same),
//   * the demo_notifications claim -> send -> mark protocol (0073) that makes every send idempotent
//     across retries, replays, concurrent runs and redeploys.
//
// Callers: booking-action.js (confirm, cancel), stripe-webhook.js (auto-confirm on payment via the
// fulfilment outbox), booking.js (free + auto-confirm booking is confirmed at creation),
// coi-enforcement.js (auto-cancel), brand-account.js (reschedule accepted), demo-reminders.js (cron).
// Every lifecycle notifier is best-effort for its caller: it never throws.

import { sendMailQuietly, link } from './_mail.js';
import { normalizePrefs, contactInScope } from './_notification-prefs.js';
import { safeZone, dateLabel, timeLabel, slotKey } from './_local-time.js';

const FROM_ADDRESS = 'Demohub <bookings@demohubhq.com>';
const REPLY_TO = 'david@demohubhq.com';
// A claim left unsent this long is treated as abandoned (crash mid-send) and may be taken over.
export const STALE_CLAIM_MS = 10 * 60 * 1000;

export function H(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

async function sb(b, path, opts = {}) {
  const r = await fetch(`${b.supabaseUrl}/rest/v1/${path}`, {
    ...opts,
    headers: { apikey: b.serviceKey, Authorization: `Bearer ${b.serviceKey}`, 'Content-Type': 'application/json', Prefer: 'return=representation', ...(opts.headers || {}) },
  });
  const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch (_) {}
  if (!r.ok) throw new Error((j && j.message) || t || ('HTTP ' + r.status));
  return j;
}

// ---------------------------------------------------------------------------
// Targets
// ---------------------------------------------------------------------------
export async function loadStoreContacts(b, retailerId) {
  if (!retailerId) return [];
  const rows = await sb(b, `internal_contacts?retailer_id=eq.${encodeURIComponent(retailerId)}&select=id,retailer_id,name,email,venue_ids,notification_prefs`);
  return (Array.isArray(rows) ? rows : []).filter(c => c && c.email).map(c => ({ ...c, prefs: normalizePrefs(c.notification_prefs) }));
}

// Contacts in scope for a venue whose normalized prefs have `prefKey` on.
export function targetsFor(contacts, venueId, prefKey) {
  return (contacts || []).filter(c => contactInScope(c, venueId) && (!prefKey || c.prefs[prefKey] === true));
}

// ---------------------------------------------------------------------------
// demo_notifications claim protocol (0073). insert-first; the UNIQUE (booking, contact, kind)
// constraint is the lock. Returns { claimed, id } — claimed:false means "already sent or another
// run holds it", and the caller MUST NOT send.
// ---------------------------------------------------------------------------
export async function claimNotification(b, { booking_id, contact_id, kind }) {
  const inserted = await sb(b, 'demo_notifications?on_conflict=booking_id,contact_id,kind', {
    method: 'POST',
    headers: { Prefer: 'return=representation,resolution=ignore-duplicates' },
    body: JSON.stringify({ booking_id, contact_id, kind }),
  });
  const row = Array.isArray(inserted) ? inserted[0] : null;
  if (row && row.id) return { claimed: true, id: row.id };
  // Conflict: someone already has this key. Only an ABANDONED claim (never marked sent, older than
  // the stale window) may be taken over — a compare-and-set PATCH on the filters, so two runs racing
  // for the same stale claim cannot both win.
  const cutoff = new Date(Date.now() - STALE_CLAIM_MS).toISOString();
  const taken = await sb(b, `demo_notifications?booking_id=eq.${encodeURIComponent(booking_id)}&contact_id=eq.${encodeURIComponent(contact_id)}&kind=eq.${encodeURIComponent(kind)}&sent_at=is.null&claimed_at=lt.${encodeURIComponent(cutoff)}`, {
    method: 'PATCH', body: JSON.stringify({ claimed_at: new Date().toISOString() }),
  });
  const t = Array.isArray(taken) ? taken[0] : null;
  return t && t.id ? { claimed: true, id: t.id, takeover: true } : { claimed: false, id: null };
}
export async function markNotificationSent(b, id) {
  await sb(b, `demo_notifications?id=eq.${encodeURIComponent(id)}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ sent_at: new Date().toISOString() }) });
}
// A failed send releases the claim so the next run retries. Only an UNSENT row is ever deleted.
export async function releaseNotification(b, id) {
  await sb(b, `demo_notifications?id=eq.${encodeURIComponent(id)}&sent_at=is.null`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
}

// Claim, send through the ONLY mail path (_mail.js containment applies), mark or release.
// Returns 'sent' | 'skipped' | 'failed'. Throws only if the claim itself cannot be recorded.
export async function sendClaimed(b, { booking_id, contact, kind, subject, html }) {
  const claim = await claimNotification(b, { booking_id, contact_id: contact.id, kind });
  if (!claim.claimed) return 'skipped';
  const r = await sendMailQuietly({ from: FROM_ADDRESS, to: contact.email, replyTo: REPLY_TO, subject, html }, { binding: b });
  if (r && r.ok) {
    try { await markNotificationSent(b, claim.id); }
    catch (e) { console.warn('demo_notifications mark failed (email was sent):', (e && e.message) || e); }
    return 'sent';
  }
  try { await releaseNotification(b, claim.id); } catch (_) { /* stale-claim takeover recovers it later */ }
  return 'failed';
}

// ---------------------------------------------------------------------------
// Context: everything a staff email needs, from the booking id. The demos row (when one exists) is
// the calendar truth for date/time — a reschedule moves the demo, not the booking.
// ---------------------------------------------------------------------------
export async function loadNoticeContext(b, bookingId) {
  const rows = await sb(b, `bookings?id=eq.${encodeURIComponent(bookingId)}&select=*`);
  const booking = Array.isArray(rows) ? rows[0] : null;
  if (!booking) return null;
  const [demoRows, retailerRows, venueRows, brandRows, contacts] = await Promise.all([
    sb(b, `demos?booking_id=eq.${encodeURIComponent(bookingId)}&select=id,status,demo_date,demo_time,product,product_skus,contact_name,contact_phone,notes&limit=1`).catch(() => []),
    sb(b, `retailers?id=eq.${encodeURIComponent(booking.retailer_id)}&select=id,name,slug,timezone`),
    booking.venue_id ? sb(b, `venues?id=eq.${encodeURIComponent(booking.venue_id)}&select=id,name,address`) : Promise.resolve([]),
    booking.brand_id ? sb(b, `brands?id=eq.${encodeURIComponent(booking.brand_id)}&select=id,company_name,contact_name,phone,needs_electricity`).catch(() => []) : Promise.resolve([]),
    loadStoreContacts(b, booking.retailer_id),
  ]);
  return buildContext({ booking, demo: demoRows && demoRows[0], retailer: retailerRows && retailerRows[0], venue: venueRows && venueRows[0], brand: brandRows && brandRows[0], contacts });
}

// Pure assembly (the cron loads rows in bulk and calls this directly).
export function buildContext({ booking, demo, retailer, venue, brand, contacts }) {
  const d = demo || {};
  const tz = safeZone(retailer && retailer.timezone);
  const demo_date = d.demo_date || booking.demo_date;
  const demo_time = d.demo_time || booking.demo_time;
  const skus = Array.isArray(d.product_skus) && d.product_skus.length ? d.product_skus : (Array.isArray(booking.product_skus) ? booking.product_skus : []);
  return {
    booking, demo: demo || null, retailer: retailer || {}, venue: venue || {}, brand: brand || null,
    contacts: contacts || [],
    tz, demo_date, demo_time,
    brand_name: booking.brand_name || (brand && brand.company_name) || 'A brand',
    product: d.product || booking.product || '',
    skus: skus.filter(p => p && (p.name || p.sku)).slice(0, 40),
    rep_name: d.contact_name || booking.contact_name || (brand && brand.contact_name) || '',
    rep_phone: d.contact_phone || booking.contact_phone || (brand && brand.phone) || '',
    notes: d.notes || booking.notes || '',
    needs_electricity: brand ? !!brand.needs_electricity : null,
  };
}

// ---------------------------------------------------------------------------
// The email. Brand-neutral (no retailer branding), table layout, one visual system for every notice.
// ---------------------------------------------------------------------------
function row(k, v, first) {
  const bt = first ? '' : 'border-top:1px solid #ede3d0;';
  return `<tr><td style="padding:12px 16px;font-size:11px;text-transform:uppercase;letter-spacing:0.08em;color:#6b6a64;font-weight:600;vertical-align:top;${bt}">${H(k)}</td><td style="padding:12px 16px;text-align:right;color:#0f2c17;font-size:14px;${bt}">${v}</td></tr>`;
}

export function demoDetailRows(ctx, { strikeOld = null } = {}) {
  const rows = [];
  if (strikeOld) {
    rows.push(['Was', `<span style="color:#6b6a64;text-decoration:line-through;">${H(dateLabel(strikeOld.date, { year: true }))} &middot; ${H(timeLabel(strikeOld.date, strikeOld.time, ctx.tz))}</span>`]);
    rows.push(['Now', `<strong>${H(dateLabel(ctx.demo_date, { year: true }))} &middot; ${H(timeLabel(ctx.demo_date, ctx.demo_time, ctx.tz))}</strong>`]);
  } else {
    rows.push(['Date', `<strong>${H(dateLabel(ctx.demo_date, { year: true }))}</strong>`]);
    rows.push(['Time', `<strong>${H(timeLabel(ctx.demo_date, ctx.demo_time, ctx.tz))}</strong>`]);
  }
  const loc = (ctx.venue && ctx.venue.name) ? `<strong>${H(ctx.venue.name)}</strong>${ctx.venue.address ? `<br><span style="color:#6b6a64;font-size:13px;">${H(ctx.venue.address)}</span>` : ''}` : '&mdash;';
  rows.push(['Location', loc]);
  rows.push(['Brand', `<strong>${H(ctx.brand_name)}</strong>`]);
  rows.push(['Product', ctx.product ? H(ctx.product) : '&mdash;']);
  rows.push(['Needs electricity', ctx.needs_electricity === null ? 'Not specified' : (ctx.needs_electricity ? '<strong>Yes</strong>' : 'No')]);
  const rep = [ctx.rep_name, ctx.rep_phone].filter(Boolean).map(H).join(' &middot; ');
  rows.push(['Brand rep', rep || '&mdash;']);
  if (ctx.notes) rows.push(['Notes', `<span style="white-space:pre-wrap;">${H(ctx.notes)}</span>`]);
  return rows;
}

export function skuBoxHtml(skus) {
  if (!skus || !skus.length) return '';
  const items = skus.map(p => `&bull; ${H(p.name || '')}${p.size ? ' <span style="color:#6b6a64;">(' + H(p.size) + ')</span>' : ''}${p.sku ? ' <span style="color:#6b6a64;">SKU ' + H(p.sku) + '</span>' : ''}`).join('<br>');
  return `<div style="background:#f4f7ef;border:1px solid #2a5b3222;border-left:4px solid #2a5b32;border-radius:10px;padding:15px 18px;margin:0 0 22px;"><div style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;color:#2a5b32;margin-bottom:8px;">SKUs being demoed</div><div style="font-size:14px;line-height:1.7;color:#1c1c1a;">${items}</div></div>`;
}

// tone: 'green' (confirmed/reminder) | 'clay' (cancelled/rescheduled)
export function staffEmailHtml({ b, ctx, eyebrow, heading, intro, rows, skus, tone = 'green', footerNote }) {
  const eyebrowColor = tone === 'clay' ? '#a14e2a' : '#2a5b32';
  const retailerName = (ctx.retailer && ctx.retailer.name) || 'Your store';
  const adminUrl = b ? link(b, `/r/${encodeURIComponent((ctx.retailer && ctx.retailer.slug) || 'gus')}/admin`) : '#';
  const table = `<table cellpadding="0" cellspacing="0" style="width:100%;background:#f9f7f2;border-radius:10px;margin-bottom:22px;">${rows.map(([k, v], i) => row(k, v, i === 0)).join('')}</table>`;
  return `<!DOCTYPE html><html><body style="margin:0;padding:24px;background:#fbf7f0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,sans-serif;color:#1c1c1a;">
<table align="center" cellpadding="0" cellspacing="0" style="max-width:600px;margin:0 auto;background:white;border-radius:16px;overflow:hidden;border:1px solid rgba(15,44,23,0.08);">
<tr><td style="padding:28px 32px;background:#0f2c17;"><div style="font-weight:800;font-size:22px;color:#fbf7f0;letter-spacing:-0.04em;">demohub</div></td></tr>
<tr><td style="padding:32px 36px;">
<div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.12em;color:${eyebrowColor};margin-bottom:10px;">${H(eyebrow)}</div>
<h1 style="font-family:Georgia,serif;font-size:24px;font-weight:500;line-height:1.25;color:#0f2c17;margin:0 0 12px;">${heading}</h1>
${intro ? `<p style="font-size:15px;line-height:1.6;color:#3a3a36;margin:0 0 18px;">${intro}</p>` : ''}
${skuBoxHtml(skus)}
${table}
${footerNote ? `<p style="font-size:13px;color:#6b6a64;line-height:1.55;margin:0 0 14px;">${footerNote}</p>` : ''}
<p style="font-size:13px;color:#6b6a64;line-height:1.55;margin:0 0 14px;">You're receiving this because <strong style="color:#0f2c17;">${H(retailerName)}</strong> listed you as a store contact for demo notifications at this location.</p>
<p style="font-size:12px;color:#6b6a64;line-height:1.55;margin:0;"><a href="${adminUrl}" style="color:#2a5b32;">Open the admin &rarr;</a></p>
</td></tr>
<tr><td style="padding:20px 32px;background:#fbf7f0;border-top:1px solid rgba(15,44,23,0.06);font-size:12px;color:#6b6a64;text-align:center;">Demohub LLC &middot; Automated store-contact notice. Adjust who gets these in your admin under Team &rarr; Store contacts.</td></tr>
</table></body></html>`;
}

const venueName = (ctx) => (ctx.venue && ctx.venue.name) || (ctx.retailer && ctx.retailer.name) || 'your store';

// ---------------------------------------------------------------------------
// Message builders — subject + html for each kind. Exported so the cron reuses them.
// ---------------------------------------------------------------------------
export function confirmedMessage(b, ctx) {
  return {
    subject: `Demo confirmed: ${ctx.brand_name} at ${venueName(ctx)} — ${dateLabel(ctx.demo_date)}`,
    html: staffEmailHtml({
      b, ctx, eyebrow: 'Demo confirmed', tone: 'green',
      heading: `A demo is confirmed at ${H(venueName(ctx))}.`,
      intro: `Make sure you've got enough product on hand &mdash; <strong>${H(ctx.brand_name)}</strong> is coming to demo <strong>${H(ctx.product || 'their product')}</strong>.`,
      rows: demoDetailRows(ctx), skus: ctx.skus,
    }),
  };
}

const WHEN = {
  '1w': ['Demo in 1 week', 'is one week away'],
  '3d': ['Demo in 3 days', 'is in 3 days'],
  '1d': ['Demo tomorrow', 'is tomorrow'],
  morning_of: ['Demo today', 'is today'],
  '1h': ['Demo in 1 hour', 'starts in about an hour'],
};
export function reminderMessage(b, ctx, kind, customDays) {
  const [eyebrow, phrase] = WHEN[kind] || [`Demo in ${customDays} days`, `is in ${customDays} days`];
  return {
    subject: `${eyebrow}: ${ctx.brand_name} at ${venueName(ctx)} — ${dateLabel(ctx.demo_date)}`,
    html: staffEmailHtml({
      b, ctx, eyebrow, tone: 'green',
      heading: `The ${H(ctx.brand_name)} demo at ${H(venueName(ctx))} ${phrase}.`,
      intro: `Reminder for the store team: <strong>${H(ctx.brand_name)}</strong> is demoing <strong>${H(ctx.product || 'their product')}</strong> on ${H(dateLabel(ctx.demo_date))} at ${H(timeLabel(ctx.demo_date, ctx.demo_time, ctx.tz))}.`,
      rows: demoDetailRows(ctx), skus: ctx.skus,
    }),
  };
}

export function cancelledMessage(b, ctx, { reason } = {}) {
  return {
    subject: `Demo cancelled: ${ctx.brand_name} at ${venueName(ctx)} — ${dateLabel(ctx.demo_date)}`,
    html: staffEmailHtml({
      b, ctx, eyebrow: 'Demo cancelled', tone: 'clay',
      heading: `The ${H(ctx.brand_name)} demo at ${H(venueName(ctx))} on ${H(dateLabel(ctx.demo_date))} was cancelled.`,
      intro: `Do not order product or schedule staff for it.${reason ? ` <strong>Reason:</strong> ${H(reason)}` : ''}`,
      rows: demoDetailRows(ctx), skus: [],
    }),
  };
}

export function rescheduledMessage(b, ctx, { from }) {
  return {
    subject: `Demo rescheduled: ${ctx.brand_name} at ${venueName(ctx)} — now ${dateLabel(ctx.demo_date)}`,
    html: staffEmailHtml({
      b, ctx, eyebrow: 'Demo rescheduled', tone: 'clay',
      heading: `The ${H(ctx.brand_name)} demo at ${H(venueName(ctx))} has moved.`,
      intro: `It was on <strong>${H(dateLabel(from.date, { year: true }))}</strong> at ${H(timeLabel(from.date, from.time, ctx.tz))}; it is now on <strong>${H(dateLabel(ctx.demo_date, { year: true }))}</strong> at ${H(timeLabel(ctx.demo_date, ctx.demo_time, ctx.tz))}. Your reminders will follow the new date.`,
      rows: demoDetailRows(ctx, { strikeOld: from }), skus: ctx.skus,
    }),
  };
}

// ---------------------------------------------------------------------------
// Lifecycle notifiers. Best-effort: resolve to a tally, never throw into the caller's flow.
// ---------------------------------------------------------------------------
async function notify(b, bookingId, { prefKey, kind, build, requireBookingStatus }) {
  const out = { targeted: 0, sent: 0, skipped: 0, failed: 0 };
  try {
    if (!b || !bookingId) return out;
    const ctx = await loadNoticeContext(b, bookingId);
    if (!ctx) return out;
    // Safety net: a "confirmed" notice for a booking that is not actually confirmed must never leave.
    if (requireBookingStatus && ctx.booking.status !== requireBookingStatus) return out;
    const targets = targetsFor(ctx.contacts, ctx.booking.venue_id, prefKey);
    out.targeted = targets.length;
    if (!targets.length) return out;
    const { subject, html } = build(ctx);
    for (const c of targets) {
      try {
        const r = await sendClaimed(b, { booking_id: bookingId, contact: c, kind: typeof kind === 'function' ? kind(ctx) : kind, subject, html });
        out[r === 'sent' ? 'sent' : r === 'skipped' ? 'skipped' : 'failed']++;
      } catch (e) { out.failed++; console.warn('store-contact notice failed:', (e && e.message) || e); }
    }
  } catch (e) { console.warn('store-contact notice skipped:', (e && e.message) || e); }
  return out;
}

export function notifyStoreContactsConfirmed(b, bookingId) {
  return notify(b, bookingId, { prefKey: 'on_confirmed', kind: 'confirmed', requireBookingStatus: 'confirmed', build: (ctx) => confirmedMessage(b, ctx) });
}
export function notifyStoreContactsCancelled(b, bookingId, { reason } = {}) {
  return notify(b, bookingId, { prefKey: 'on_cancelled', kind: 'cancelled', build: (ctx) => cancelledMessage(b, ctx, { reason }) });
}
// from: { date, time } the demo used to be on. The context already reflects the NEW slot.
export function notifyStoreContactsRescheduled(b, bookingId, { from }) {
  return notify(b, bookingId, {
    prefKey: 'on_rescheduled',
    kind: (ctx) => `rescheduled@${slotKey(ctx.demo_date, ctx.demo_time)}`,
    build: (ctx) => rescheduledMessage(b, ctx, { from }),
  });
}
