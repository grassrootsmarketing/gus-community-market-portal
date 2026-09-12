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
import { sendMailQuietly, link } from './_mail.js';
import { getBinding } from './_env.js';

export const OWNER_ALERT_EMAIL = 'david@demohubhq.com';
const FROM_ADDRESS = 'Demohub <bookings@demohubhq.com>';

const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function dateLabel(d) {
  if (!d) return '';
  try { return new Date(d + 'T00:00:00Z').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' }); }
  catch (_) { return String(d); }
}
function deadlineLabel(iso) {
  if (!iso) return 'within 24 hours';
  try { return new Date(iso).toLocaleString('en-US', { weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/Los_Angeles', timeZoneName: 'short' }); }
  catch (_) { return 'within 24 hours'; }
}

// kind: 'paid' (captured; target pending = awaiting retailer confirmation, confirmed = auto-confirmed)
//       'hold' (authorized, not charged; COI to approve within the hold window)
export function ownerBookedEmail(ctx, { kind, targetStatus }, binding) {
  const brand = (ctx.brand_name || ctx.company_name || ctx.contact_email || 'A brand');
  const retailerName = (ctx.retailers && ctx.retailers.name) || 'a retailer';
  const slug = (ctx.retailers && ctx.retailers.slug) || '';
  const venueName = (ctx.venues && ctx.venues.name) || '';
  const fee = ctx.amount_paid != null ? '$' + (Number(ctx.amount_paid) / 100).toFixed(2) : null;
  const status = kind === 'hold'
    ? 'HOLD - the card is authorized, not charged. Approve the COI in /owner by ' + deadlineLabel(ctx.held_expires_at) + ' to capture and confirm; otherwise the hold releases at $0.'
    : (targetStatus === 'confirmed'
        ? 'PAID and CONFIRMED (this retailer auto-confirms). The demo is on the calendar.'
        : 'PAID - awaiting the retailer\'s confirmation in their admin.');
  const row = (k, v) => v ? '<tr><td style="padding:3px 14px 3px 0;color:#6b6a64;vertical-align:top;white-space:nowrap;">' + k + '</td><td style="padding:3px 0;">' + v + '</td></tr>' : '';
  const btn = (href, label, bg) => '<a href="' + href + '" style="display:inline-block;background:' + bg + ';color:#fff;padding:11px 22px;border-radius:9px;text-decoration:none;font-weight:700;font-size:14px;margin-right:8px;">' + label + '</a>';
  const subject = (kind === 'hold' ? 'Hold placed: ' : 'Booked: ') + brand + ' -> ' + retailerName + (venueName ? ' / ' + venueName : '') + ' | ' + (ctx.demo_date || '') + ' ' + (ctx.demo_time || '');
  const html = '<div style="font-family:-apple-system,BlinkMacSystemFont,Roboto,Helvetica,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#1c1c1a;">'
    + '<h2 style="font-size:20px;color:#0f2c17;margin:0 0 14px;">' + (kind === 'hold' ? 'A brand placed a hold' : 'A brand booked a demo') + '</h2>'
    + '<table cellpadding="0" cellspacing="0" style="font-size:14px;line-height:1.6;margin:0 0 18px;">'
    + row('Brand', '<strong>' + esc(brand) + '</strong>' + (ctx.contact_name ? ' &middot; ' + esc(ctx.contact_name) : '') + (ctx.contact_email ? ' &middot; ' + esc(ctx.contact_email) : '') + (ctx.contact_phone ? ' &middot; ' + esc(ctx.contact_phone) : ''))
    + row('Store', esc(retailerName) + (venueName ? ' &middot; ' + esc(venueName) : ''))
    + row('When', esc(dateLabel(ctx.demo_date)) + (ctx.demo_time ? ' at ' + esc(ctx.demo_time) : ''))
    + row('Demo fee', fee ? esc(fee) : '')
    + row('Product', esc(ctx.product || ''))
    + row('Status', esc(status))
    + row('Booking', '<span style="font-family:monospace;font-size:12px;">' + esc(ctx.booking_id || ctx.id || '') + '</span>')
    + '</table>'
    + (slug ? btn(link(binding, '/r/' + encodeURIComponent(slug) + '/admin'), 'Open the retailer admin', '#0f2c17') : '')
    + (kind === 'hold' ? btn(link(binding, '/owner'), 'Review the COI', '#ed682f') : '')
    + '</div>';
  return { from: FROM_ADDRESS, to: OWNER_ALERT_EMAIL, replyTo: OWNER_ALERT_EMAIL, subject, html };
}

export async function notifyOwnerBooked(ctx, opts = {}) {
  try {
    const binding = opts.binding || await getBinding();
    if (!binding || !binding.resendApiKey) return { sent: false, reason: 'no_mail_binding' };
    const r = await sendMailQuietly(ownerBookedEmail(ctx, opts, binding), { binding });
    return { sent: !!(r && r.ok), reason: r && r.ok ? null : ((r && (r.error || r.code)) || 'send_failed') };
  } catch (e) {
    console.warn('owner booked alert skipped:', (e && e.message) || e);
    return { sent: false, reason: String((e && e.message) || e).slice(0, 120) };
  }
}
