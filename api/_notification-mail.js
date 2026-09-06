// api/_notification-mail.js — the emails the notification outbox sends (Codex Release A).
//
// Two audiences, one visual system:
//   * STORE CONTACTS (internal_contacts) — the people at a location who order product and host
//     demos. They do not sign in; they get emails. They hear about a demo when it is CONFIRMED, get
//     reminders before it, and are told when a confirmed demo is cancelled or rescheduled. Never when
//     a brand merely books or pays.
//   * BRANDS — the account recipient(s) of a brand hear the owner's COI decision (approved with the
//     reviewed expiry; rejected with the owner's brand-visible note). Never the certificate itself,
//     never a download link.
//
// This module is PURE: it turns rows into { subject, html }. It performs no I/O and decides nothing
// about who receives what or when — that is api/_notification-outbox.js. Every string that came from
// a user or a row is escaped with H(); the brand_note in particular is owner-typed text rendered as
// text. Subjects are derived from the ACTUAL schedule at send time (a delayed "tomorrow" reminder that
// goes out on the day says "today").
//
// What a store-contact email shows (Codex §5): date; start–end time with the zone abbreviation
// (end_at from the booking, else start + 3h); location name + address; brand; product + SKUs
// (booking.product_skus); "Needs electricity: Yes / No / Not specified" from bookings.needs_electricity
// (per booking — NOT the brand profile); brand rep name + phone; only the booking's operational notes
// (bookings.notes — the text the brand typed on the booking form; owner review notes, COI notes,
// cancel reasons and finance notes live in other columns and are never included).

import { link } from './_mail.js';
import { safeZone, demoStartUtc, dateLabel, timeRangeLabel, timeLabel, relativeDayPhrase } from './_local-time.js';

export const FROM_ADDRESS = 'Demohub <bookings@demohubhq.com>';
export const REPLY_TO = 'david@demohubhq.com';
const DEFAULT_DURATION_MS = 3 * 60 * 60 * 1000;

export function H(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

// ---------------------------------------------------------------------------
// Context: everything a store-contact email needs, assembled from rows the outbox loaded.
// The BOOKING is the schedule of record (0074: start_at/end_at/timezone are its occurrence snapshot;
// legacy rows without a snapshot resolve demo_date + demo_time in the retailer zone).
// ---------------------------------------------------------------------------
// Only the brand's operational text. Older cancel/decline paths appended "Cancelled: …" /
// "Declined: …" owner paragraphs to bookings.notes; those are owner notes and are dropped here.
export function operationalNotes(notes) {
  if (typeof notes !== 'string') return '';
  return notes.split(/\n\s*\n/).map(p => p.trim()).filter(p => p && !/^(Cancelled|Declined):\s/.test(p)).join('\n\n');
}
export function buildContext({ booking, retailer, venue, brand }) {
  const b = booking || {};
  const tz = safeZone(b.timezone || (retailer && retailer.timezone));
  let startAt = b.start_at ? new Date(b.start_at) : null;
  if (!startAt || Number.isNaN(startAt.getTime())) startAt = demoStartUtc(b.demo_date, b.demo_time, tz, { lenientTime: true });
  let endAt = b.end_at ? new Date(b.end_at) : null;
  if (!endAt || Number.isNaN(endAt.getTime()) || (startAt && endAt.getTime() <= startAt.getTime())) endAt = startAt ? new Date(startAt.getTime() + DEFAULT_DURATION_MS) : null;
  const skus = Array.isArray(b.product_skus) ? b.product_skus.filter(p => p && (p.name || p.sku)).slice(0, 40) : [];
  return {
    booking: b, retailer: retailer || {}, venue: venue || {}, brand: brand || null,
    tz, startAt, endAt,
    brand_name: b.brand_name || (brand && brand.company_name) || 'A brand',
    product: b.product || '',
    skus,
    rep_name: b.contact_name || (brand && brand.contact_name) || '',
    rep_phone: b.contact_phone || (brand && brand.phone) || '',
    notes: operationalNotes(b.notes),
    // per-booking, typed. null/undefined = "Not specified" — never guessed from the brand profile.
    needs_electricity: typeof b.needs_electricity === 'boolean' ? b.needs_electricity : null,
  };
}

const venueName = (ctx) => (ctx.venue && ctx.venue.name) || (ctx.retailer && ctx.retailer.name) || 'your store';
const dayOf = (ctx, d = ctx.startAt) => (d ? dateLabel(d, { tz: ctx.tz }) : String(ctx.booking.demo_date || ''));
const dayOfYear = (ctx, d = ctx.startAt) => (d ? dateLabel(d, { year: true, tz: ctx.tz }) : String(ctx.booking.demo_date || ''));
const whenOf = (ctx) => (ctx.startAt ? timeRangeLabel(ctx.startAt, ctx.endAt, ctx.tz) : (ctx.booking.demo_time || 'Time to be confirmed'));

// ---------------------------------------------------------------------------
// Layout. Brand-neutral (no retailer branding), table rows, one visual system for every notice.
// ---------------------------------------------------------------------------
function row(k, v, first) {
  const bt = first ? '' : 'border-top:1px solid #ede3d0;';
  return `<tr><td style="padding:12px 16px;font-size:11px;text-transform:uppercase;letter-spacing:0.08em;color:#6b6a64;font-weight:600;vertical-align:top;${bt}">${H(k)}</td><td style="padding:12px 16px;text-align:right;color:#0f2c17;font-size:14px;${bt}">${v}</td></tr>`;
}

export function electricityLabel(v) {
  return v === true ? '<strong>Yes</strong>' : v === false ? 'No' : 'Not specified';
}

export function demoDetailRows(ctx, { strikeOld = null } = {}) {
  const rows = [];
  if (strikeOld && strikeOld.startAt) {
    rows.push(['Was', `<span style="color:#6b6a64;text-decoration:line-through;">${H(dayOfYear(ctx, strikeOld.startAt))} &middot; ${H(timeRangeLabel(strikeOld.startAt, strikeOld.endAt, ctx.tz))}</span>`]);
    rows.push(['Now', `<strong>${H(dayOfYear(ctx))} &middot; ${H(whenOf(ctx))}</strong>`]);
  } else {
    rows.push(['Date', `<strong>${H(dayOfYear(ctx))}</strong>`]);
    rows.push(['Time', `<strong>${H(whenOf(ctx))}</strong>`]);
  }
  const loc = (ctx.venue && ctx.venue.name)
    ? `<strong>${H(ctx.venue.name)}</strong>${ctx.venue.address ? `<br><span style="color:#6b6a64;font-size:13px;">${H(ctx.venue.address)}</span>` : ''}`
    : '&mdash;';
  rows.push(['Location', loc]);
  rows.push(['Brand', `<strong>${H(ctx.brand_name)}</strong>`]);
  rows.push(['Product', ctx.product ? H(ctx.product) : '&mdash;']);
  rows.push(['Needs electricity', electricityLabel(ctx.needs_electricity)]);
  const rep = [ctx.rep_name, ctx.rep_phone].filter(Boolean).map(H).join(' &middot; ');
  rows.push(['Brand rep', rep || '&mdash;']);
  if (ctx.notes) rows.push(['Notes from the brand', `<span style="white-space:pre-wrap;">${H(ctx.notes)}</span>`]);
  return rows;
}

export function skuBoxHtml(skus) {
  if (!skus || !skus.length) return '';
  const items = skus.map(p => `&bull; ${H(p.name || '')}${p.size ? ' <span style="color:#6b6a64;">(' + H(p.size) + ')</span>' : ''}${p.sku ? ' <span style="color:#6b6a64;">SKU ' + H(p.sku) + '</span>' : ''}`).join('<br>');
  return `<div style="background:#f4f7ef;border:1px solid #2a5b3222;border-left:4px solid #2a5b32;border-radius:10px;padding:15px 18px;margin:0 0 22px;"><div style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;color:#2a5b32;margin-bottom:8px;">SKUs being demoed</div><div style="font-size:14px;line-height:1.7;color:#1c1c1a;">${items}</div></div>`;
}

// tone: 'green' (confirmed/reminder/approved) | 'clay' (cancelled/rescheduled/rejected)
function shell({ eyebrow, heading, intro, body, tone = 'green', footer, cta }) {
  const eyebrowColor = tone === 'clay' ? '#a14e2a' : '#2a5b32';
  return `<!DOCTYPE html><html><body style="margin:0;padding:24px;background:#fbf7f0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,sans-serif;color:#1c1c1a;">
<table align="center" cellpadding="0" cellspacing="0" style="max-width:600px;margin:0 auto;background:white;border-radius:16px;overflow:hidden;border:1px solid rgba(15,44,23,0.08);">
<tr><td style="padding:28px 32px;background:#0f2c17;"><div style="font-weight:800;font-size:22px;color:#fbf7f0;letter-spacing:-0.04em;">demohub</div></td></tr>
<tr><td style="padding:32px 36px;">
<div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.12em;color:${eyebrowColor};margin-bottom:10px;">${H(eyebrow)}</div>
<h1 style="font-family:Georgia,serif;font-size:24px;font-weight:500;line-height:1.25;color:#0f2c17;margin:0 0 12px;">${heading}</h1>
${intro ? `<p style="font-size:15px;line-height:1.6;color:#3a3a36;margin:0 0 18px;">${intro}</p>` : ''}
${body || ''}
${cta ? `<p style="margin:0 0 22px;"><a href="${H(cta.href)}" style="background:#0f2c17;color:white;padding:12px 22px;border-radius:10px;text-decoration:none;font-weight:700;font-size:14px;display:inline-block;">${H(cta.label)} &rarr;</a></p>` : ''}
${footer || ''}
</td></tr>
<tr><td style="padding:20px 32px;background:#fbf7f0;border-top:1px solid rgba(15,44,23,0.06);font-size:12px;color:#6b6a64;text-align:center;">Demohub LLC &middot; Automated notice.</td></tr>
</table></body></html>`;
}

export function staffEmailHtml({ b, ctx, eyebrow, heading, intro, rows, skus, tone = 'green', footerNote }) {
  const retailerName = (ctx.retailer && ctx.retailer.name) || 'Your store';
  const adminUrl = b ? link(b, `/r/${encodeURIComponent((ctx.retailer && ctx.retailer.slug) || 'gus')}/admin`) : '#';
  const table = `<table cellpadding="0" cellspacing="0" style="width:100%;background:#f9f7f2;border-radius:10px;margin-bottom:22px;">${rows.map(([k, v], i) => row(k, v, i === 0)).join('')}</table>`;
  const footer = `${footerNote ? `<p style="font-size:13px;color:#6b6a64;line-height:1.55;margin:0 0 14px;">${footerNote}</p>` : ''}
<p style="font-size:13px;color:#6b6a64;line-height:1.55;margin:0 0 14px;">You're receiving this because <strong style="color:#0f2c17;">${H(retailerName)}</strong> listed you as a store contact for demo notifications at this location. Adjust who gets these in the admin under Team &rarr; Store contacts.</p>
<p style="font-size:12px;color:#6b6a64;line-height:1.55;margin:0;"><a href="${adminUrl}" style="color:#2a5b32;">Open the admin &rarr;</a></p>`;
  return shell({ eyebrow, heading, intro, body: skuBoxHtml(skus) + table, tone, footer });
}

// ---------------------------------------------------------------------------
// Store-contact messages — subject + html for each kind.
// ---------------------------------------------------------------------------
export function confirmedMessage(b, ctx) {
  return {
    subject: `Demo confirmed: ${ctx.brand_name} at ${venueName(ctx)} — ${dayOf(ctx)}`,
    html: staffEmailHtml({
      b, ctx, eyebrow: 'Demo confirmed', tone: 'green',
      heading: `A demo is confirmed at ${H(venueName(ctx))}.`,
      intro: `Make sure you've got enough product on hand &mdash; <strong>${H(ctx.brand_name)}</strong> is coming to demo <strong>${H(ctx.product || 'their product')}</strong>.`,
      rows: demoDetailRows(ctx), skus: ctx.skus,
    }),
  };
}

// The wording comes from how far away the demo ACTUALLY is at send time, not from the offset that
// scheduled the reminder — a 1-day reminder delivered late on the demo day says "today".
export function reminderPhrase(ctx, now) {
  if (!ctx.startAt) return { eyebrow: 'Demo reminder', phrase: 'is coming up' };
  const r = relativeDayPhrase(ctx.startAt, now, ctx.tz);
  if (r.key === 'hour') return { eyebrow: 'Demo in 1 hour', phrase: 'starts in about an hour' };
  if (r.key === 'today' || r.key === 'started') return { eyebrow: 'Demo today', phrase: 'is today' };
  if (r.key === 'tomorrow') return { eyebrow: 'Demo tomorrow', phrase: 'is tomorrow' };
  if (r.days === 7) return { eyebrow: 'Demo in 1 week', phrase: 'is one week away' };
  return { eyebrow: `Demo in ${r.days} days`, phrase: `is in ${r.days} days` };
}
export function reminderMessage(b, ctx, now = new Date()) {
  const { eyebrow, phrase } = reminderPhrase(ctx, now);
  return {
    subject: `${eyebrow}: ${ctx.brand_name} at ${venueName(ctx)} — ${dayOf(ctx)}`,
    html: staffEmailHtml({
      b, ctx, eyebrow, tone: 'green',
      heading: `The ${H(ctx.brand_name)} demo at ${H(venueName(ctx))} ${phrase}.`,
      intro: `Reminder for the store team: <strong>${H(ctx.brand_name)}</strong> is demoing <strong>${H(ctx.product || 'their product')}</strong> on ${H(dayOf(ctx))}, ${H(whenOf(ctx))}.`,
      rows: demoDetailRows(ctx), skus: ctx.skus,
    }),
  };
}

// bookings.cancel_reason is either the retailer's typed reason or a machine code from a worker.
const CANCEL_REASON_TEXT = {
  coi_missing: 'No current Certificate of Insurance was on file 72 hours before the demo (automatic cancellation; the brand was refunded).',
};
export function cancelReasonText(reason) {
  const r = reason == null ? '' : String(reason).trim();
  if (!r) return '';
  return CANCEL_REASON_TEXT[r] || r;
}
export function cancelledMessage(b, ctx, { reason } = {}) {
  reason = cancelReasonText(reason);
  return {
    subject: `Demo cancelled: ${ctx.brand_name} at ${venueName(ctx)} — ${dayOf(ctx)}`,
    html: staffEmailHtml({
      b, ctx, eyebrow: 'Demo cancelled', tone: 'clay',
      heading: `The ${H(ctx.brand_name)} demo at ${H(venueName(ctx))} on ${H(dayOf(ctx))} was cancelled.`,
      intro: `Do not order product or schedule staff for it.${reason ? ` <strong>Reason:</strong> ${H(reason)}` : ''}`,
      rows: demoDetailRows(ctx), skus: [],
    }),
  };
}

// from: { startAt, endAt } — the slot the demo used to be on. ctx already reflects the NEW slot.
export function rescheduledMessage(b, ctx, { from } = {}) {
  const hasFrom = !!(from && from.startAt);
  const wasLine = hasFrom ? `It was on <strong>${H(dayOfYear(ctx, from.startAt))}</strong> at ${H(timeLabel(from.startAt, ctx.tz))}; it` : 'It';
  return {
    subject: `Demo rescheduled: ${ctx.brand_name} at ${venueName(ctx)} — now ${dayOf(ctx)}`,
    html: staffEmailHtml({
      b, ctx, eyebrow: 'Demo rescheduled', tone: 'clay',
      heading: `The ${H(ctx.brand_name)} demo at ${H(venueName(ctx))} has moved.`,
      intro: `${wasLine} is now on <strong>${H(dayOfYear(ctx))}</strong>, ${H(whenOf(ctx))}. Your reminders will follow the new date.`,
      rows: demoDetailRows(ctx, { strikeOld: hasFrom ? from : null }), skus: ctx.skus,
    }),
  };
}

// ---------------------------------------------------------------------------
// Brand messages — COI decisions. Never the certificate, never a download link.
// ---------------------------------------------------------------------------
function brandFooter(brand) {
  return `<p style="font-size:13px;color:#6b6a64;line-height:1.55;margin:0;">Sent to the account contacts of <strong style="color:#0f2c17;">${H((brand && brand.company_name) || 'your brand')}</strong> on Demohub. Questions? Reply to this email.</p>`;
}
function noteBlock(note) {
  if (!note) return '';
  return `<div style="background:#f9f7f2;border-left:4px solid #a14e2a;border-radius:10px;padding:14px 18px;margin:0 0 22px;"><div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;color:#6b6a64;margin-bottom:6px;">Note from the reviewer</div><div style="font-size:14px;line-height:1.6;color:#1c1c1a;white-space:pre-wrap;">${H(note)}</div></div>`;
}

// verification: { policy_expiry | expires_at, brand_note }
export function coiApprovedMessage(b, { brand, verification }) {
  const expiry = (verification && (verification.expires_at || verification.policy_expiry)) || null;
  const expiryLabel = expiry ? dateLabel(String(expiry).slice(0, 10), { year: true }) : null;
  const note = verification && verification.brand_note ? String(verification.brand_note) : '';
  return {
    subject: `Your Certificate of Insurance is approved${expiryLabel ? ` — valid through ${expiryLabel}` : ''}`,
    html: shell({
      eyebrow: 'Certificate of Insurance approved', tone: 'green',
      heading: `Your certificate is approved${expiryLabel ? ` through ${H(expiryLabel)}` : ''}.`,
      intro: expiryLabel
        ? `Demohub reviewed the certificate on file for <strong>${H((brand && brand.company_name) || 'your brand')}</strong>. Coverage is recorded as expiring on <strong>${H(expiryLabel)}</strong> &mdash; you can book demos on any date up to then. We'll remind you before it lapses.`
        : `Demohub reviewed the certificate on file for <strong>${H((brand && brand.company_name) || 'your brand')}</strong> and approved it.`,
      body: noteBlock(note),
      cta: { href: link(b, '/brand/dashboard#compliance'), label: 'View your compliance status' },
      footer: brandFooter(brand),
    }),
  };
}

export function coiRejectedMessage(b, { brand, verification }) {
  const note = verification && verification.brand_note ? String(verification.brand_note) : '';
  return {
    subject: 'Your Certificate of Insurance needs another look',
    html: shell({
      eyebrow: 'Certificate of Insurance not accepted', tone: 'clay',
      heading: 'We could not accept the certificate you uploaded.',
      intro: `Demohub reviewed the certificate on file for <strong>${H((brand && brand.company_name) || 'your brand')}</strong> and could not approve it. Stores require a current, valid certificate before a demo can go ahead, so please upload a corrected one.`,
      body: noteBlock(note) || `<p style="font-size:14px;line-height:1.6;color:#3a3a36;margin:0 0 18px;">The reviewer did not leave a note. Reply to this email if you need help.</p>`,
      cta: { href: link(b, '/brand/dashboard#compliance'), label: 'Upload a corrected certificate' },
      footer: brandFooter(brand),
    }),
  };
}
