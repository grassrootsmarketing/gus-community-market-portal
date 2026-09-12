// api/_owner-alerts.js — the operator's "a brand actually booked" ping.
//
// David (2026-09-11): one email to the owner only when a booking is REAL — the brand completed
// checkout. That is either a paid booking (funds captured) or an authorized hold (funds held, COI
// pending). It is NOT sent at /api/book time (an abandoned checkout is not a booking) and it is not
// re-sent when a hold is later captured (the owner already heard about that booking as a hold).
//
// Called from the fulfilment outbox worker (api/_fulfillment.js) right after the brand's own notice
// succeeded, so it rides the outbox's retry semantics: a fulfilment that retries because the brand
// mail failed has not yet sent this either. Best-effort — it never throws into the worker.
//
// Codex preview review (2026-09-11):
//   1. Hold instructions follow the retailer's CURRENT confirmation mode (auto_confirm_bookings read
//      at send time): manual-confirm retailers need COI approval AND a confirmation; auto-confirm
//      retailers get an attempted capture on approval (never promised as certain). Unknown mode →
//      neutral instructions. Authorization / capture / release terminology kept distinct.
//   2. (preview generator) the displayed sender line is escaped — tools/render-owner-alert-preview.mjs.
//   3. The occurrence is shown with its timezone and length. Source of truth, in order: the accepted
//      snapshot on the booking row (start_at / end_at / timezone — Release B, 0075+) when present;
//      otherwise the documented legacy fallback: demo_date + demo_time in the retailer's timezone
//      with the retailer's demo-length SETTING (settings.demo_duration, e.g. "3 hours"); a length
//      that cannot be established is reported as "length not recorded", never invented.
import { sendMailQuietly, link } from './_mail.js';
import { getBinding } from './_env.js';

export const OWNER_ALERT_EMAIL = 'david@demohubhq.com';
const FROM_ADDRESS = 'Demohub <bookings@demohubhq.com>';
const DEFAULT_TZ = 'America/Los_Angeles';

const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---- time helpers (Intl only; no library) ----
function safeZone(tz) { if (!tz) return null; try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return tz; } catch (_) { return null; } }
function zoneAbbrev(date, tz) {
  try { return (new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' }).formatToParts(date).find(p => p.type === 'timeZoneName') || {}).value || tz; }
  catch (_) { return tz; }
}
function fmtTime(date, tz) { try { return date.toLocaleTimeString('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' }); } catch (_) { return ''; } }
function fmtDate(date, tz) { try { return date.toLocaleDateString('en-US', { timeZone: tz, weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }); } catch (_) { return ''; } }
function fmtInstant(date, tz) {
  try { return date.toLocaleString('en-US', { timeZone: tz, weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' }) + ' ' + zoneAbbrev(date, tz); }
  catch (_) { return date.toISOString(); }
}
function minutesOf(timeStr) {
  const m = String(timeStr == null ? '' : timeStr).trim().match(/^(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?$/i);
  if (!m) return null;
  let h = parseInt(m[1], 10); const min = m[2] ? parseInt(m[2], 10) : 0; const ap = (m[3] || '').toLowerCase().replace(/\./g, '');
  if (min > 59) return null;
  if (ap) { if (h < 1 || h > 12) return null; if (ap === 'pm' && h !== 12) h += 12; if (ap === 'am' && h === 12) h = 0; } else if (h > 23) return null;
  return h * 60 + min;
}
function zoneOffsetMinutes(date, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(date).filter(x => x.type !== 'literal').map(x => [x.type, x.value]));
  return Math.round((Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second) - date.getTime()) / 60000);
}
function localInstant(ymd, minutes, tz) {
  const m = String(ymd || '').match(/^(\d{4})-(\d{2})-(\d{2})$/); if (!m) return null;
  const naive = Date.UTC(+m[1], +m[2] - 1, +m[3], Math.floor(minutes / 60), minutes % 60);
  let off = zoneOffsetMinutes(new Date(naive), tz); let inst = new Date(naive - off * 60000);
  const off2 = zoneOffsetMinutes(inst, tz); if (off2 !== off) inst = new Date(naive - off2 * 60000);
  return inst;
}
// "3 hours" / "2 hour" / "90 minutes" / "1.5 hours" -> hours (number) or null
export function parseDurationHours(text) {
  const s = String(text == null ? '' : text).trim().toLowerCase();
  let m = s.match(/^(\d+(?:\.\d+)?)\s*h/); if (m) { const h = Number(m[1]); return h > 0 && h <= 24 ? h : null; }
  m = s.match(/^(\d+)\s*m/); if (m) { const h = Number(m[1]) / 60; return h > 0 && h <= 24 ? h : null; }
  return null;
}
function fmtHours(h) { return Number.isInteger(h) ? h + (h === 1 ? ' hour' : ' hours') : Math.round(h * 60) + ' minutes'; }

// The occurrence line. Returns { text, source } — text is plain (escaped by the caller).
export function describeOccurrence(ctx, { retailerTimezone = null, settingDuration = null } = {}) {
  // 1. Accepted snapshot (Release B): the instants the booking was accepted at, in the booking's own zone.
  const s = ctx.start_at ? new Date(ctx.start_at) : null, e = ctx.end_at ? new Date(ctx.end_at) : null;
  const snapTz = safeZone(ctx.timezone) || safeZone(retailerTimezone) || DEFAULT_TZ;
  if (s && e && !Number.isNaN(s.getTime()) && !Number.isNaN(e.getTime()) && e > s) {
    const hours = (e.getTime() - s.getTime()) / 3600e3;
    return { source: 'snapshot', text: `${fmtDate(s, snapTz)} · ${fmtTime(s, snapTz)}–${fmtTime(e, snapTz)} ${zoneAbbrev(s, snapTz)} · ${fmtHours(hours)}` };
  }
  // 2. Legacy fallback (pre-Release B rows): the retailer's timezone + the retailer's demo-length setting.
  const tz = safeZone(retailerTimezone) || DEFAULT_TZ;
  const min = minutesOf(ctx.demo_time);
  const start = min != null ? localInstant(ctx.demo_date, min, tz) : null;
  const hours = parseDurationHours(settingDuration);
  if (start && hours != null) {
    const end = new Date(start.getTime() + hours * 3600e3);
    return { source: 'settings', text: `${fmtDate(start, tz)} · ${fmtTime(start, tz)}–${fmtTime(end, tz)} ${zoneAbbrev(start, tz)} · ${fmtHours(hours)} (retailer's demo-length setting)` };
  }
  if (start) return { source: 'partial', text: `${fmtDate(start, tz)} · ${fmtTime(start, tz)} ${zoneAbbrev(start, tz)} · length not recorded` };
  return { source: 'raw', text: `${ctx.demo_date || ''} ${ctx.demo_time || ''} (${tz}) · length not recorded`.trim() };
}

// Hold instructions by the retailer's CURRENT confirmation mode (true / false / null = unknown).
export function holdInstructions(autoConfirm, expiryLabel) {
  const by = expiryLabel ? ` before ${expiryLabel}` : ' before the hold expires';
  if (autoConfirm === true) {
    return `Card authorized — not charged. Review and approve a COI covering this demo date${by}. With auto-confirm enabled, approval triggers an attempt to capture the payment and confirm the booking; check the booking's status to verify it completed. An uncaptured authorization is released after expiry (not refunded — nothing was charged).`;
  }
  if (autoConfirm === false) {
    return `Card authorized — not charged. Review and approve a COI covering this demo date, then confirm the booking in the retailer admin${by}. Approving the COI alone does not capture the payment. An uncaptured authorization is released after expiry (not refunded — nothing was charged).`;
  }
  return `Card authorized — not charged. Review the COI${by}, then check the booking in the retailer admin to see whether its confirmation is still required. An uncaptured authorization is released after expiry (not refunded — nothing was charged).`;
}

// kind: 'paid' (captured; targetStatus pending = awaiting retailer confirmation, confirmed = auto-confirmed)
//       'hold' (authorized, not charged; COI to approve within the hold window)
// facts: { autoConfirm: true|false|null, retailerTimezone, settingDuration } — read at send time.
export function ownerBookedEmail(ctx, { kind, targetStatus, facts = {} }, binding) {
  const brand = (ctx.brand_name || ctx.company_name || ctx.contact_email || 'A brand');
  const retailerName = (ctx.retailers && ctx.retailers.name) || 'a retailer';
  const slug = (ctx.retailers && ctx.retailers.slug) || '';
  const venueName = (ctx.venues && ctx.venues.name) || '';
  const fee = ctx.amount_paid != null ? '$' + (Number(ctx.amount_paid) / 100).toFixed(2) : null;
  const tz = safeZone(facts.retailerTimezone) || safeZone(ctx.timezone) || DEFAULT_TZ;
  const occ = describeOccurrence(ctx, { retailerTimezone: facts.retailerTimezone, settingDuration: facts.settingDuration });
  const expiry = ctx.held_expires_at ? new Date(ctx.held_expires_at) : null;
  const expiryLabel = expiry && !Number.isNaN(expiry.getTime()) ? fmtInstant(expiry, tz) : null;
  const status = kind === 'hold'
    ? holdInstructions(typeof facts.autoConfirm === 'boolean' ? facts.autoConfirm : null, expiryLabel)
    : (targetStatus === 'confirmed'
        ? 'PAID and CONFIRMED (this retailer auto-confirms). The demo is on the calendar.'
        : 'PAID — awaiting the retailer\'s confirmation in their admin.');
  const row = (k, v) => v ? '<tr><td style="padding:3px 14px 3px 0;color:#6b6a64;vertical-align:top;white-space:nowrap;">' + k + '</td><td style="padding:3px 0;">' + v + '</td></tr>' : '';
  const btn = (href, label, bg) => '<a href="' + href + '" style="display:inline-block;background:' + bg + ';color:#fff;padding:11px 22px;border-radius:9px;text-decoration:none;font-weight:700;font-size:14px;margin-right:8px;">' + label + '</a>';
  const subject = (kind === 'hold' ? 'Hold placed: ' : 'Booked: ') + brand + ' -> ' + retailerName + (venueName ? ' / ' + venueName : '') + ' | ' + (ctx.demo_date || '') + ' ' + (ctx.demo_time || '');
  const html = '<div style="font-family:-apple-system,BlinkMacSystemFont,Roboto,Helvetica,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#1c1c1a;">'
    + '<h2 style="font-size:20px;color:#0f2c17;margin:0 0 14px;">' + (kind === 'hold' ? 'A brand placed a hold' : 'A brand booked a demo') + '</h2>'
    + '<table cellpadding="0" cellspacing="0" style="font-size:14px;line-height:1.6;margin:0 0 18px;">'
    + row('Brand', '<strong>' + esc(brand) + '</strong>' + (ctx.contact_name ? ' &middot; ' + esc(ctx.contact_name) : '') + (ctx.contact_email ? ' &middot; ' + esc(ctx.contact_email) : '') + (ctx.contact_phone ? ' &middot; ' + esc(ctx.contact_phone) : ''))
    + row('Store', esc(retailerName) + (venueName ? ' &middot; ' + esc(venueName) : ''))
    + row('Demo time', esc(occ.text))
    + row('Demo fee', fee ? esc(fee) : '')
    + row('Product', esc(ctx.product || ''))
    + (kind === 'hold' && expiryLabel ? row('Hold expires', esc(expiryLabel)) : '')
    + row('Status', esc(status))
    + row('Booking', '<span style="font-family:monospace;font-size:12px;">' + esc(ctx.booking_id || ctx.id || '') + '</span>')
    + '</table>'
    + (slug ? btn(link(binding, '/r/' + encodeURIComponent(slug) + '/admin'), 'Open the retailer admin', '#0f2c17') : '')
    + (kind === 'hold' ? btn(link(binding, '/owner'), 'Review the COI', '#ed682f') : '')
    + '</div>';
  return { from: FROM_ADDRESS, to: OWNER_ALERT_EMAIL, replyTo: OWNER_ALERT_EMAIL, subject, html, occurrence_source: occ.source };
}

// Read the facts the message depends on at SEND time (retailer mode + timezone, demo-length setting).
// Any read failure degrades to "unknown" (neutral hold copy, default zone, length not recorded).
export async function readOwnerAlertFacts(ctx, binding) {
  const facts = { autoConfirm: null, retailerTimezone: null, settingDuration: null };
  if (!ctx || !ctx.retailer_id) return facts;
  const get = async (path) => {
    const r = await fetch(`${binding.supabaseUrl}/rest/v1/${path}`, { headers: { apikey: binding.serviceKey, Authorization: `Bearer ${binding.serviceKey}` } });
    if (!r.ok) return null;
    const j = await r.json(); return Array.isArray(j) ? j[0] || null : null;
  };
  try {
    const rr = await get(`retailers?id=eq.${encodeURIComponent(ctx.retailer_id)}&select=auto_confirm_bookings,timezone`);
    if (rr) { if (typeof rr.auto_confirm_bookings === 'boolean') facts.autoConfirm = rr.auto_confirm_bookings; if (rr.timezone) facts.retailerTimezone = rr.timezone; }
  } catch (_) {}
  try {
    const sr = await get(`settings?retailer_id=eq.${encodeURIComponent(ctx.retailer_id)}&select=demo_duration`);
    if (sr && sr.demo_duration) facts.settingDuration = sr.demo_duration;
  } catch (_) {}
  return facts;
}

export async function notifyOwnerBooked(ctx, opts = {}) {
  try {
    const binding = opts.binding || await getBinding();
    if (!binding || !binding.resendApiKey) return { sent: false, reason: 'no_mail_binding' };
    const facts = opts.facts || await readOwnerAlertFacts(ctx, binding);
    const msg = ownerBookedEmail(ctx, { ...opts, facts }, binding);
    const r = await sendMailQuietly({ from: msg.from, to: msg.to, replyTo: msg.replyTo, subject: msg.subject, html: msg.html }, { binding });
    return { sent: !!(r && r.ok), reason: r && r.ok ? null : ((r && (r.error || r.code)) || 'send_failed'), occurrence_source: msg.occurrence_source };
  } catch (e) {
    console.warn('owner booked alert skipped:', (e && e.message) || e);
    return { sent: false, reason: String((e && e.message) || e).slice(0, 120) };
  }
}
