// api/_provisional.js — shared provisional-holds (24h escrow) helpers.
// Consumers: stripe-webhook.js (auth/capture/cancel events), booking-action.js (confirm captures,
// decline/cancel releases), provisional-sweep.js (24h expiry), book.js (slot-contention bump).
// See docs/provisional-holds.md. Everything here is inert unless a booking is in the held flow —
// PROVISIONAL_HOLDS_ENABLED gates the creation of held bookings, not this module.

import { getBinding } from './_env.js';
import { sendMailQuietly, link } from './_mail.js';

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const FROM_ADDRESS = 'Demohub <bookings@demohubhq.com>';

// ---------------------------------------------------------------------------
// Stripe: capture / cancel a manual-capture PaymentIntent
// ---------------------------------------------------------------------------
async function stripePost(path, params, idempotencyKey) {
  if (!STRIPE_SECRET_KEY) return { ok: false, error: 'STRIPE_SECRET_KEY not configured' };
  const headers = { Authorization: 'Bearer ' + STRIPE_SECRET_KEY, 'Content-Type': 'application/x-www-form-urlencoded' };
  if (idempotencyKey) headers['Idempotency-Key'] = String(idempotencyKey).slice(0, 255);
  try {
    const r = await fetch('https://api.stripe.com/v1/' + path, { method: 'POST', headers, body: params ? params.toString() : '' });
    const j = await r.json();
    if (!r.ok) return { ok: false, error: (j && j.error && j.error.message) || ('HTTP ' + r.status), code: j && j.error && j.error.code, detail: j };
    return { ok: true, object: j };
  } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
}

// Capture the full authorized amount. Idempotency key is PI-scoped: a retry of the same capture
// returns the original; a PI can only ever be captured once anyway.
export function stripeCapturePaymentIntent(piId) {
  return stripePost(`payment_intents/${encodeURIComponent(piId)}/capture`, null, `cap-${piId}`);
}

// Cancel (release) an uncaptured authorization — $0 charged, $0 Stripe fee.
export function stripeCancelPaymentIntent(piId, reason) {
  const p = new URLSearchParams();
  // Stripe only accepts its own enum here; everything provisional maps to 'abandoned'.
  p.set('cancellation_reason', reason === 'requested_by_customer' ? 'requested_by_customer' : 'abandoned');
  return stripePost(`payment_intents/${encodeURIComponent(piId)}/cancel`, p, `pcx-${piId}`);
}

export async function stripeGetPaymentIntent(piId) {
  if (!STRIPE_SECRET_KEY || !piId) return null;
  const r = await fetch(`https://api.stripe.com/v1/payment_intents/${encodeURIComponent(piId)}?expand[]=latest_charge`, {
    headers: { Authorization: 'Bearer ' + STRIPE_SECRET_KEY },
  });
  if (!r.ok) return null;
  return r.json();
}

// ---------------------------------------------------------------------------
// Supabase helpers (service key)
// ---------------------------------------------------------------------------
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
  return Array.isArray(j) ? j[0] : j;
}

export function applyAuthorizationCanceled(paymentIntentId, targetStatus, reason) {
  return sbRpc('apply_authorization_canceled', {
    p_payment_intent: paymentIntentId, p_target_status: targetStatus, p_reason: reason || null,
  });
}

// ---------------------------------------------------------------------------
// Release one held booking end-to-end. Used by the expiry sweep ('expired'),
// the slot-contention bump ('expired' + bumped copy) and retailer decline/cancel
// ('declined'/'cancelled'; those send their own emails, pass notify:false).
// A held booking has either payment_status='authorized' (auth placed → cancel the PI, converge via
// RPC) or 'unpaid' (never finished checkout → just flip the row; any open Checkout Session dies on
// its own 24h expiry and its attempt is terminalized by checkout.session.expired).
// ---------------------------------------------------------------------------
export async function releaseHeldBooking(booking, { target = 'expired', reason = 'hold_expired', notify = true, bumped = false } = {}) {
  if (!booking || booking.status !== 'held') return { ok: false, error: 'not_held' };
  if (booking.payment_status === 'authorized' && booking.payment_intent_id) {
    const c = await stripeCancelPaymentIntent(booking.payment_intent_id, 'abandoned');
    // 'payment_intent_unexpected_state' = already canceled (or captured). Canceled is converged by
    // the RPC below; captured would surface there as a contradiction case. Anything else is a real
    // failure — leave the booking held so the next sweep tick retries.
    if (!c.ok && c.code !== 'payment_intent_unexpected_state') {
      return { ok: false, error: 'stripe_cancel_failed: ' + c.error };
    }
    const applied = await applyAuthorizationCanceled(booking.payment_intent_id, target, reason);
    if (!applied || !['applied', 'idempotent', 'attempt_canceled'].includes(applied.outcome)) {
      return { ok: false, error: 'apply_canceled_' + ((applied && applied.outcome) || 'failed') };
    }
  } else {
    await sb(`bookings?id=eq.${encodeURIComponent(booking.id)}&status=eq.held`, {
      method: 'PATCH', body: JSON.stringify({ status: target }),
    });
  }
  if (notify && booking.contact_email) {
    try { await sendHoldReleasedEmail(booking, { bumped }); }
    catch (e) { console.warn('hold-released email failed for', booking.id, (e && e.message) || e); }
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Capture one held booking end-to-end: Stripe capture -> apply_verified_payment (sync; the
// payment_intent.succeeded webhook replay is idempotent) -> outbox drain (held -> pending/confirmed
// + payment email). Callers: booking-action.js (retailer confirm) and admin-auth.js (COI approval
// on an auto-confirm retailer). COI coverage is the CALLER's check — this only moves money.
// Returns { ok, stage, error, outcome?, case_id?, payment_group_id? }.
// ---------------------------------------------------------------------------
export async function captureHeldBooking(booking) {
  if (!booking || booking.status !== 'held' || booking.payment_status !== 'authorized' || !booking.payment_intent_id) {
    return { ok: false, stage: 'precondition', error: 'hold_not_authorized' };
  }
  const cap = await stripeCapturePaymentIntent(booking.payment_intent_id);
  // 'payment_intent_unexpected_state' usually means an earlier capture already succeeded — the
  // verify step below settles it either way.
  if (!cap.ok && cap.code !== 'payment_intent_unexpected_state') {
    return { ok: false, stage: 'capture', error: cap.error };
  }
  const fullPi = await stripeGetPaymentIntent(booking.payment_intent_id);
  if (!fullPi) return { ok: false, stage: 'verify', error: 'cannot_retrieve_pi' };
  if (fullPi.status !== 'succeeded') return { ok: false, stage: 'verify', error: 'pi_state_' + fullPi.status };

  const attRows = await sb(`payment_attempts?stripe_payment_intent_id=eq.${encodeURIComponent(booking.payment_intent_id)}&select=stripe_checkout_session_id,payment_group_id&order=created_at.desc&limit=1`);
  const att = Array.isArray(attRows) ? attRows[0] : null;
  if (!att || !att.stripe_checkout_session_id) return { ok: false, stage: 'apply', error: 'attempt_not_found' };
  const charge = (fullPi.latest_charge && typeof fullPi.latest_charge === 'object') ? fullPi.latest_charge : null;
  const applied = await sbRpc('apply_verified_payment', {
    p_session_id: att.stripe_checkout_session_id, p_payment_intent: fullPi.id,
    p_charge: charge ? charge.id : (typeof fullPi.latest_charge === 'string' ? fullPi.latest_charge : null),
    p_amount: fullPi.amount_received != null ? fullPi.amount_received : fullPi.amount,
    p_currency: fullPi.currency,
    p_connect_dest: null, p_on_behalf_of: null, p_application_fee: null, p_transfer_id: null, p_fee_id: null,
  });
  const outcome = applied && applied.outcome;
  if (outcome !== 'applied' && outcome !== 'idempotent') {
    return { ok: false, stage: 'apply', error: 'apply_' + (outcome || 'failed'), outcome, case_id: applied && applied.case_id };
  }
  try {
    const { drainFulfillments } = await import('./_fulfillment.js');
    await drainFulfillments({ limit: 10, group: applied.payment_group_id });
  } catch (e) { console.warn('post-capture fulfilment drain failed (cron will finish):', (e && e.message) || e); }
  return { ok: true, payment_group_id: applied.payment_group_id, outcome };
}

// ---------------------------------------------------------------------------
// Emails — same visual system as stripe-webhook.js / booking-action.js.
// ---------------------------------------------------------------------------
function H(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function brandHeaderHTML() {
  return '<table cellpadding="0" cellspacing="0"><tr>' +
    '<td style="padding-right:12px;vertical-align:middle;">' +
    '<svg width="40" height="40" viewBox="0 0 72 72" xmlns="http://www.w3.org/2000/svg"><circle cx="36" cy="36" r="36" fill="#0f2c17"/><circle cx="36" cy="40" r="18" fill="#ed682f"/><rect x="34.5" y="14" width="3" height="10" rx="1.2" fill="#fbf3e0"/><path d="M37 17 Q45 14 48 20 Q44 22 38 21 Q35 19 37 17 Z" fill="#87b08e"/></svg>' +
    '</td>' +
    '<td style="font-weight:800;font-size:24px;color:#fbf7f0;letter-spacing:-0.04em;">demohub</td>' +
    '</tr></table>';
}
function dateLabelOf(d) {
  if (!d) return '';
  try { return new Date(d + 'T00:00:00Z').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' }); }
  catch (_) { return d; }
}
function deadlineLabelOf(iso) {
  if (!iso) return 'within 24 hours';
  try { return new Date(iso).toLocaleString('en-US', { weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/Los_Angeles', timeZoneName: 'short' }); }
  catch (_) { return 'within 24 hours'; }
}
function shell(inner) {
  return '<!DOCTYPE html><html><body style="margin:0;padding:24px;background:#fbf7f0;font-family:-apple-system,BlinkMacSystemFont,Roboto,Helvetica,sans-serif;color:#1c1c1a;">' +
    '<table align="center" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;background:white;border-radius:16px;overflow:hidden;border:1px solid rgba(15,44,23,0.08);">' +
    '<tr><td style="padding:28px 32px;background:#0f2c17;">' + brandHeaderHTML() + '</td></tr>' +
    '<tr><td style="padding:36px 36px 28px;">' + inner + '</td></tr>' +
    '<tr><td style="padding:20px 32px;background:#fbf7f0;border-top:1px solid rgba(15,44,23,0.06);font-size:12px;color:#6b6a64;text-align:center;">Powered by <strong style="color:#0f2c17;">Demohub</strong> &middot; demohubhq.com</td></tr>' +
    '</table></body></html>';
}
function detailsTable(rows) {
  return '<table cellpadding="0" cellspacing="0" style="width:100%;background:#f4f7ef;border-radius:10px;margin-bottom:22px;">' +
    rows.filter(([, v]) => v).map(([k, v], i) =>
      `<tr><td style="padding:12px 16px;font-size:11px;text-transform:uppercase;letter-spacing:0.08em;color:#6b6a64;font-weight:600;${i ? 'border-top:1px solid #ede3d0;' : ''}">${H(k)}</td><td style="padding:12px 16px;text-align:right;font-weight:600;color:#0f2c17;font-size:14px;${i ? 'border-top:1px solid #ede3d0;' : ''}">${H(v)}</td></tr>`
    ).join('') + '</table>';
}

// ctx: a bookings row with venues(name), retailers(name) embedded (fetchBookingContext shape).
// amountCents: the AUTHORIZED amount from the ledger allocation (venue fee + platform fee) — the
// bookings.amount_paid column is the venue fee only and would understate the hold.
export function holdPlacedEmailHtml(ctx, binding, amountCents) {
  const amountStr = amountCents != null ? '$' + (Number(amountCents) / 100).toFixed(2) : null;
  const deadline = deadlineLabelOf(ctx.held_expires_at);
  return shell(
    '<div style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.14em;color:#a14e2a;margin-bottom:14px;">Slot held &mdash; action needed</div>' +
    `<h1 style="font-family:Georgia,serif;font-size:28px;font-weight:500;line-height:1.2;color:#0f2c17;margin:0 0 18px;">Your demo slot is held${ctx.contact_name ? ', ' + H(ctx.contact_name) : ''}.</h1>` +
    `<p style="font-size:15px;line-height:1.6;color:#3a3a36;margin:0 0 20px;">We placed a hold on your card${amountStr ? ' for <strong>' + amountStr + '</strong>' : ''} &mdash; <strong>you have not been charged</strong>. Your slot at <strong>${H((ctx.retailers && ctx.retailers.name) || 'the store')}</strong> is reserved while we verify your Certificate of Insurance.</p>` +
    detailsTable([
      ['Brand', ctx.brand_name],
      ['Store', ctx.venues && ctx.venues.name],
      ['Date', dateLabelOf(ctx.demo_date)],
      ['Time', ctx.demo_time],
    ]) +
    `<div style="background:#fff3ed;border:1px solid #ed682f55;border-left:4px solid #ed682f;border-radius:10px;padding:15px 18px;margin:0 0 22px;"><div style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;color:#a14e2a;margin-bottom:6px;">Upload your COI by ${H(deadline)}</div><div style="font-size:14px;line-height:1.55;color:#a14e2a;">If your Certificate of Insurance isn't on file and approved by then, the hold is released, your card is <strong>not charged</strong>, and the slot opens back up. Brands with an approved COI can also take a held slot in the meantime.</div></div>` +
    `<div style="text-align:center;margin:0 0 18px;"><a href="${link(binding, '/brand/dashboard')}" style="background:#0f2c17;color:white;padding:12px 26px;border-radius:10px;text-decoration:none;font-weight:700;font-size:14px;display:inline-block;">Upload your COI now &rarr;</a></div>` +
    '<p style="font-size:13px;color:#6b6a64;line-height:1.55;margin:0;">Once your COI is approved and the store confirms, the card is charged and the demo is locked in. Questions? Just reply.</p>'
  );
}

export function holdReleasedEmailHtml(ctx, binding, { bumped = false } = {}) {
  const slug = (ctx.retailers && ctx.retailers.slug) || 'gus';
  const headline = bumped ? 'Your held slot was taken by an insured brand.' : 'Your 24-hour hold expired.';
  const why = bumped
    ? 'A brand with an approved Certificate of Insurance booked this slot, which takes priority over a provisional hold.'
    : 'We didn’t receive an approved Certificate of Insurance within the 24-hour window.';
  return shell(
    '<div style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.14em;color:#a14e2a;margin-bottom:14px;">Hold released &mdash; you were not charged</div>' +
    `<h1 style="font-family:Georgia,serif;font-size:28px;font-weight:500;line-height:1.2;color:#0f2c17;margin:0 0 18px;">${H(headline)}</h1>` +
    `<p style="font-size:15px;line-height:1.6;color:#3a3a36;margin:0 0 18px;">${why} The hold on your card has been released &mdash; <strong>no charge was made</strong>. Holds can take a few business days to drop off your statement depending on your bank.</p>` +
    detailsTable([
      ['Brand', ctx.brand_name],
      ['Store', ctx.venues && ctx.venues.name],
      ['Date', dateLabelOf(ctx.demo_date)],
      ['Time', ctx.demo_time],
    ]) +
    `<p style="font-size:15px;line-height:1.6;color:#3a3a36;margin:0 0 22px;">Upload your COI first and your next booking confirms without a waiting period.</p>` +
    `<div style="text-align:center;margin:0 0 18px;"><a href="${link(binding, '/brand/dashboard')}" style="background:#0f2c17;color:white;padding:12px 26px;border-radius:10px;text-decoration:none;font-weight:700;font-size:14px;display:inline-block;">Upload your COI</a>&nbsp;&nbsp;<a href="${link(binding, '/r/' + encodeURIComponent(slug))}" style="display:inline-block;padding:12px 26px;border-radius:10px;border:1px solid #0f2c17;color:#0f2c17;text-decoration:none;font-weight:700;font-size:14px;">Rebook a slot</a></div>` +
    '<p style="font-size:13px;color:#6b6a64;line-height:1.55;margin:0;">Questions about the released hold? Just reply to this email.</p>'
  );
}

async function bookingCtx(bookingId) {
  try {
    const rows = await sb(`bookings?id=eq.${encodeURIComponent(bookingId)}&select=*,venues(name),retailers(name,slug)`);
    return Array.isArray(rows) && rows[0] ? rows[0] : null;
  } catch (_) { return null; }
}

// THROWS on send failure so the fulfilment outbox records emails_sent=false and retries.
export async function sendHoldPlacedEmail(ctxOrId) {
  const b = await getBinding();
  const ctx = typeof ctxOrId === 'string' ? await bookingCtx(ctxOrId) : ctxOrId;
  if (!ctx || !ctx.contact_email) return { ok: false, reason: 'no_recipient' };
  let amountCents = null;
  try {
    const allocs = await sb(`payment_allocations?booking_id=eq.${encodeURIComponent(ctx.id || ctx.booking_id)}&select=customer_amount&limit=1`);
    amountCents = Array.isArray(allocs) && allocs[0] ? allocs[0].customer_amount : null;
  } catch (_) { /* amount is decorative — the email still reads correctly without it */ }
  const r = await sendMailQuietly({
    from: FROM_ADDRESS, to: ctx.contact_email, replyTo: 'david@demohubhq.com',
    subject: `Your slot is held — upload your COI within 24 hours`,
    html: holdPlacedEmailHtml(ctx, b, amountCents),
  }, { binding: b });
  if (!r.ok) throw new Error('email_failed:hold_placed:' + (r.code || 'unknown'));
  return { ok: true };
}

export async function sendHoldReleasedEmail(ctxOrId, { bumped = false } = {}) {
  const b = await getBinding();
  const ctx = (typeof ctxOrId === 'string' || !ctxOrId.venues) ? await bookingCtx(typeof ctxOrId === 'string' ? ctxOrId : ctxOrId.id) : ctxOrId;
  if (!ctx || !ctx.contact_email) return { ok: false, reason: 'no_recipient' };
  const r = await sendMailQuietly({
    from: FROM_ADDRESS, to: ctx.contact_email, replyTo: 'david@demohubhq.com',
    subject: bumped ? 'Your held demo slot was released — you were not charged' : 'Your 24-hour hold expired — you were not charged',
    html: holdReleasedEmailHtml(ctx, b, { bumped }),
  }, { binding: b });
  if (!r.ok) return { ok: false, reason: r.code || 'send_failed' };
  return { ok: true };
}
