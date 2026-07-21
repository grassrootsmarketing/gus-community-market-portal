// /api/stripe-webhook — receives events from Stripe and updates our DB.
//
// Events handled:
//   account.updated                → flips retailers.stripe_charges_enabled / _payouts_enabled
//                                     when Plaid or micro-deposit verification completes.
//   checkout.session.completed     → for subscription mode: mirrors billing_tier and
//                                     stripe_subscription_id onto the retailer row.
//                                     This is how a Pro-tier upgrade actually sticks.
//   customer.subscription.updated  → keeps billing_status + billing_period_end in sync
//                                     (past_due, cancel_at_period_end, renewal, tier changes).
//   customer.subscription.deleted  → reverts retailer to Solo, clears subscription id.
//   invoice.payment_failed         → flips billing_status to past_due.
//   payment_intent.succeeded       → marks the associated booking as paid.
//   payment_intent.payment_failed  → marks the booking as payment-failed.
//   charge.refunded                → marks the booking as refunded.
//
// Env vars required:
//   STRIPE_WEBHOOK_SECRET (whsec_...)   — from Stripe Dashboard → Developers → Webhooks
//   SUPABASE_SERVICE_KEY                — bypasses RLS for DB writes
//
// Important: Vercel serverless needs the raw body for signature verification, so we
// disable the built-in body parser and read the stream manually.

import { createHmac, timingSafeEqual, randomBytes } from 'crypto';

export const config = { api: { bodyParser: false } };

const SUPABASE_URL = 'https://ecapmcyumpjjgjwuokyv.supabase.co';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
// Tolerate up to 5 minutes of clock skew — Stripe's default is 5 min.
const TOLERANCE_SECONDS = 300;

// -----------------------------------------------------------------------------
// Signature verification (Stripe's algorithm, no SDK required)
// -----------------------------------------------------------------------------
function parseSignatureHeader(header) {
  const parts = {};
  for (const seg of (header || '').split(',')) {
    const idx = seg.indexOf('=');
    if (idx < 0) continue;
    const k = seg.slice(0, idx).trim();
    const v = seg.slice(idx + 1).trim();
    if (k === 't') parts.t = v;
    else if (k === 'v1') (parts.v1 = parts.v1 || []).push(v);
  }
  return parts;
}

function verifySignature(rawBody, sigHeader, secret) {
  if (!sigHeader || !secret) return null;
  const parsed = parseSignatureHeader(sigHeader);
  if (!parsed.t || !parsed.v1 || parsed.v1.length === 0) return null;
  const timestamp = parseInt(parsed.t, 10);
  if (!Number.isFinite(timestamp)) return null;
  // Reject if outside tolerance window (prevents replay attacks)
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestamp) > TOLERANCE_SECONDS) return null;

  const signedPayload = `${parsed.t}.${rawBody}`;
  const expected = createHmac('sha256', secret).update(signedPayload).digest('hex');
  const expectedBuf = Buffer.from(expected, 'hex');
  for (const candidate of parsed.v1) {
    const candBuf = Buffer.from(candidate, 'hex');
    if (candBuf.length === expectedBuf.length && timingSafeEqual(candBuf, expectedBuf)) {
      // Signature valid — parse the body as JSON now
      try { return JSON.parse(rawBody); } catch (_) { return null; }
    }
  }
  return null;
}

// -----------------------------------------------------------------------------
// Raw body reader
// -----------------------------------------------------------------------------
function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// -----------------------------------------------------------------------------
// Supabase REST helper (uses service key, bypasses RLS)
// -----------------------------------------------------------------------------
async function sb(path, opts = {}) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...opts,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
      ...(opts.headers || {}),
    },
  });
  const text = await r.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch (_) {}
  if (!r.ok) throw new Error(json?.message || text || `sb HTTP ${r.status}`);
  return json;
}

// -----------------------------------------------------------------------------
// Email helpers (best-effort, never block webhook 200)
// -----------------------------------------------------------------------------
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM_ADDRESS = 'Demohub <bookings@demohubhq.com>';

function htmlEscape(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

async function fetchBookingContext(bookingId) {
  try {
    const rows = await sb(`bookings?id=eq.${encodeURIComponent(bookingId)}&select=*,venues(name),retailers(name,slug)`);
    return Array.isArray(rows) && rows[0] ? rows[0] : null;
  } catch (_) { return null; }
}

async function sendResendEmail({ to, subject, html }) {
  if (!RESEND_API_KEY || !to) return { ok: false, reason: 'not_configured_or_no_to' };
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + RESEND_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: FROM_ADDRESS, to, reply_to: 'david@demohubhq.com', subject, html }),
    });
    return { ok: r.ok };
  } catch (e) { return { ok: false, reason: (e && e.message) || String(e) }; }
}

function _brandHeaderHTML() {
  return '<table cellpadding="0" cellspacing="0"><tr>' +
    '<td style="padding-right:12px;vertical-align:middle;">' +
      '<svg width="40" height="40" viewBox="0 0 72 72" xmlns="http://www.w3.org/2000/svg"><circle cx="36" cy="36" r="36" fill="#0f2c17"/><circle cx="36" cy="40" r="18" fill="#ed682f"/><rect x="34.5" y="14" width="3" height="10" rx="1.2" fill="#fbf3e0"/><path d="M37 17 Q45 14 48 20 Q44 22 38 21 Q35 19 37 17 Z" fill="#87b08e"/></svg>' +
    '</td>' +
    '<td style="font-weight:800;font-size:24px;color:#fbf7f0;letter-spacing:-0.04em;">demohub</td>' +
  '</tr></table>';
}

function refundConfirmationEmail({ brandName, retailerName, venueName, demoDate, demoTime, amount }) {
  const dateLabel = demoDate ? new Date(demoDate + 'T00:00:00Z').toLocaleDateString('en-US', { weekday:'long', month:'long', day:'numeric', year:'numeric', timeZone:'UTC' }) : '';
  const amountStr = '$' + (Number(amount || 0) / 100).toFixed(2);
  return '<!DOCTYPE html><html><body style="margin:0;padding:24px;background:#fbf7f0;font-family:-apple-system,BlinkMacSystemFont,Roboto,Helvetica,sans-serif;color:#1c1c1a;">' +
'<table align="center" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;background:white;border-radius:16px;overflow:hidden;border:1px solid rgba(15,44,23,0.08);">' +
'<tr><td style="padding:28px 32px;background:#0f2c17;">' + _brandHeaderHTML() + '</td></tr>' +
'<tr><td style="padding:36px 36px 28px;">' +
'<div style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.14em;color:#2a5b32;margin-bottom:14px;">Refund confirmed</div>' +
'<h1 style="font-family:Georgia,serif;font-size:26px;font-weight:500;line-height:1.2;color:#0f2c17;margin:0 0 18px;">Your refund is on the way.</h1>' +
'<p style="font-size:15px;line-height:1.6;color:#3a3a36;margin:0 0 20px;">Stripe just processed a <strong>' + amountStr + '</strong> refund for your demo with <strong>' + htmlEscape(retailerName) + '</strong>. It will appear on the card you paid with in 5&ndash;10 business days.</p>' +
'<table cellpadding="0" cellspacing="0" style="width:100%;background:#f4f7ef;border-radius:10px;margin-bottom:20px;">' +
'<tr><td style="padding:12px 16px;font-size:11px;text-transform:uppercase;letter-spacing:0.08em;color:#6b6a64;font-weight:600;">Brand</td><td style="padding:12px 16px;text-align:right;font-weight:600;color:#0f2c17;font-size:14px;">' + htmlEscape(brandName) + '</td></tr>' +
'<tr><td style="padding:12px 16px;font-size:11px;text-transform:uppercase;letter-spacing:0.08em;color:#6b6a64;font-weight:600;border-top:1px solid #ede3d0;">Store</td><td style="padding:12px 16px;text-align:right;color:#0f2c17;font-size:14px;border-top:1px solid #ede3d0;">' + htmlEscape(venueName) + '</td></tr>' +
'<tr><td style="padding:12px 16px;font-size:11px;text-transform:uppercase;letter-spacing:0.08em;color:#6b6a64;font-weight:600;border-top:1px solid #ede3d0;">Date</td><td style="padding:12px 16px;text-align:right;color:#0f2c17;font-size:14px;border-top:1px solid #ede3d0;">' + htmlEscape(dateLabel) + '</td></tr>' +
'<tr><td style="padding:12px 16px;font-size:11px;text-transform:uppercase;letter-spacing:0.08em;color:#6b6a64;font-weight:600;border-top:1px solid #ede3d0;">Refund amount</td><td style="padding:12px 16px;text-align:right;font-weight:700;color:#2a5b32;font-size:14px;border-top:1px solid #ede3d0;">' + amountStr + '</td></tr>' +
'</table>' +
'<p style="font-size:13px;color:#6b6a64;line-height:1.55;margin:0;">If the refund does not show up in 10 business days, reply to this email and we will help chase it with Stripe.</p>' +
'</td></tr>' +
'<tr><td style="padding:20px 32px;background:#fbf7f0;border-top:1px solid rgba(15,44,23,0.06);font-size:12px;color:#6b6a64;text-align:center;">Powered by <strong style="color:#0f2c17;">Demohub</strong></td></tr>' +
'</table></body></html>';
}

function paymentFailedEmail({ brandName, retailerName, retailerSlug, venueName, demoDate, demoTime, errorMsg }) {
  const dateLabel = demoDate ? new Date(demoDate + 'T00:00:00Z').toLocaleDateString('en-US', { weekday:'long', month:'long', day:'numeric', year:'numeric', timeZone:'UTC' }) : '';
  const retryUrl = 'https://www.demohubhq.com/r/' + encodeURIComponent(retailerSlug || '');
  return '<!DOCTYPE html><html><body style="margin:0;padding:24px;background:#fbf7f0;font-family:-apple-system,BlinkMacSystemFont,Roboto,Helvetica,sans-serif;color:#1c1c1a;">' +
'<table align="center" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;background:white;border-radius:16px;overflow:hidden;border:1px solid rgba(15,44,23,0.08);">' +
'<tr><td style="padding:28px 32px;background:#0f2c17;">' + _brandHeaderHTML() + '</td></tr>' +
'<tr><td style="padding:36px 36px 28px;">' +
'<div style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.14em;color:#a14e2a;margin-bottom:14px;">Payment did not go through</div>' +
'<h1 style="font-family:Georgia,serif;font-size:26px;font-weight:500;line-height:1.2;color:#0f2c17;margin:0 0 18px;">Your card was declined.</h1>' +
'<p style="font-size:15px;line-height:1.6;color:#3a3a36;margin:0 0 18px;">Stripe could not charge your card for the demo at <strong>' + htmlEscape(retailerName) + '</strong>. Your slot is not held yet &mdash; retry with the button below and it will be confirmed once the payment goes through.</p>' +
(errorMsg ? '<p style="font-size:13px;line-height:1.5;color:#a14e2a;background:#fdebe5;padding:10px 14px;border-radius:8px;margin:0 0 20px;">Stripe said: ' + htmlEscape(errorMsg) + '</p>' : '') +
'<table cellpadding="0" cellspacing="0" style="width:100%;background:#f9f7f2;border-radius:10px;margin-bottom:22px;">' +
'<tr><td style="padding:12px 16px;font-size:11px;text-transform:uppercase;letter-spacing:0.08em;color:#6b6a64;font-weight:600;">Brand</td><td style="padding:12px 16px;text-align:right;font-weight:600;color:#0f2c17;font-size:14px;">' + htmlEscape(brandName) + '</td></tr>' +
'<tr><td style="padding:12px 16px;font-size:11px;text-transform:uppercase;letter-spacing:0.08em;color:#6b6a64;font-weight:600;border-top:1px solid #ede3d0;">Store</td><td style="padding:12px 16px;text-align:right;color:#0f2c17;font-size:14px;border-top:1px solid #ede3d0;">' + htmlEscape(venueName) + '</td></tr>' +
'<tr><td style="padding:12px 16px;font-size:11px;text-transform:uppercase;letter-spacing:0.08em;color:#6b6a64;font-weight:600;border-top:1px solid #ede3d0;">Date</td><td style="padding:12px 16px;text-align:right;color:#0f2c17;font-size:14px;border-top:1px solid #ede3d0;">' + htmlEscape(dateLabel) + '</td></tr>' +
'</table>' +
'<div style="text-align:center;margin:22px 0 8px;">' +
'<a href="' + retryUrl + '" style="display:inline-block;background:#0f2c17;color:white;padding:12px 26px;border-radius:10px;font-weight:700;text-decoration:none;font-size:0.95rem;">Retry payment &rarr;</a>' +
'</div>' +
'<p style="font-size:13px;color:#6b6a64;line-height:1.55;margin:14px 0 0;">If the same card keeps failing, try a different one, or reply to this email and we will help.</p>' +
'</td></tr>' +
'<tr><td style="padding:20px 32px;background:#fbf7f0;border-top:1px solid rgba(15,44,23,0.06);font-size:12px;color:#6b6a64;text-align:center;">Powered by <strong style="color:#0f2c17;">Demohub</strong></td></tr>' +
'</table></body></html>';
}

// -----------------------------------------------------------------------------
// Event handlers
// -----------------------------------------------------------------------------

// account.updated: Stripe tells us a connected account's status changed
// (Plaid verified, micro-deposits confirmed, charges/payouts enabled, requirements added, etc.)
async function handleAccountUpdated(event) {
  const account = event.data.object;
  const accountId = account.id;
  if (!accountId) return;

  // Find the retailer that owns this connected account
  const rows = await sb(`retailers?stripe_account_id=eq.${encodeURIComponent(accountId)}&select=id`);
  if (!rows || rows.length === 0) {
    console.warn(`account.updated: no retailer found for stripe_account_id=${accountId}`);
    return;
  }
  const retailerId = rows[0].id;

  const charges = !!account.charges_enabled;
  const payouts = !!account.payouts_enabled;
  const status = charges && payouts
    ? 'active'
    : (account.requirements?.disabled_reason ? 'restricted' : 'pending');

  await sb(`retailers?id=eq.${encodeURIComponent(retailerId)}`, {
    method: 'PATCH',
    body: JSON.stringify({
      stripe_charges_enabled: charges,
      stripe_payouts_enabled: payouts,
      stripe_account_status: status,
    }),
  });
  console.log(`account.updated: retailer ${retailerId} charges=${charges} payouts=${payouts} status=${status}`);
}

// Extract booking id(s) from Stripe metadata.
// Supports both single (booking_id) and multi-booking (booking_ids: CSV) shapes.
function bookingIdsFrom(metadata) {
  if (!metadata) return [];
  if (metadata.booking_ids) {
    return String(metadata.booking_ids).split(',').map(s => s.trim()).filter(Boolean);
  }
  if (metadata.booking_id) return [String(metadata.booking_id).trim()].filter(Boolean);
  return [];
}

// payment_intent.succeeded: brand's card charged successfully. Updates every booking in the batch.
// Magic link so the confirmation email's "Manage your booking" CTA lands the brand
// authenticated. Mirrors createBrandMagicLink in api/booking.js. Best-effort.
async function createBrandMagicLink(brand_id, email) {
  if (!SERVICE_KEY || !brand_id || !email) return null;
  try {
    const token = randomBytes(24).toString('hex');
    const expires = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
    await sb('brand_account_tokens', {
      method: 'POST',
      body: JSON.stringify({ brand_id, email: String(email).toLowerCase(), token, expires_at: expires }),
    });
    return `https://demohubhq.com/brand/signin?token=${token}`;
  } catch (_) { return null; }
}

// Brand "booking received" email — identical framing to api/booking.js emailBody,
// but sent from the webhook AFTER payment succeeds so unpaid bookings never trigger it.
function bookingConfirmationEmailHtml(ctx, manageBookingUrl, rebookUrl, coiDeadline) {
  const contact_name = ctx.contact_name;
  const brand_name = ctx.brand_name;
  const product = ctx.product;
  // The items actually being sampled. This is the whole point of the feature for the
  // store: they cannot order stock against a category, only against real items.
  const skuList = Array.isArray(ctx.product_skus) ? ctx.product_skus.filter(p => p && p.name) : [];
  const skuRowsHtml = (labelColour) => skuList.length
    ? `<tr><td style="padding:14px 18px;font-size:11px;text-transform:uppercase;letter-spacing:0.08em;color:#6b6a64;font-weight:600;border-top:1px solid #ede3d0;vertical-align:top;">Items</td><td style="padding:14px 18px;text-align:right;color:${labelColour};font-size:14px;border-top:1px solid #ede3d0;">${skuList.map(p => `${H(p.name)}${p.size ? ' <span style="color:#6b6a64;">' + H(p.size) + '</span>' : ''}${p.sku ? ' <span style="color:#6b6a64;">#' + H(p.sku) + '</span>' : ''}`).join('<br>')}</td></tr>`
    : '';
  const venue = (ctx.venues && ctx.venues.name) || '';
  const retailerName = (ctx.retailers && ctx.retailers.name) || '';
  const dateLabel = (() => {
    try { return new Date(ctx.demo_date + 'T00:00:00Z').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' }); }
    catch (_) { return ctx.demo_date; }
  })();
  const H = htmlEscape;
  return `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="margin:0;padding:24px;background:#fbf7f0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,sans-serif;color:#1c1c1a;">
<table align="center" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;background:white;border-radius:16px;overflow:hidden;border:1px solid rgba(15,44,23,0.08);">
<tr><td style="padding:28px 32px;background:#0f2c17;">${_brandHeaderHTML()}</td></tr>
<tr><td style="padding:36px 36px 28px;">
<div style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.14em;color:#a14e2a;margin-bottom:14px;">Demo booking confirmed</div>
<h1 style="font-family:Georgia,serif;font-size:30px;font-weight:500;line-height:1.2;color:#0f2c17;margin:0 0 18px;">You're booked${contact_name ? ', ' + H(contact_name) : ''}!</h1>
<p style="font-size:15px;line-height:1.6;color:#3a3a36;margin:0 0 24px;">Your payment went through and your demo at <strong style="color:#0f2c17;">${H(retailerName)}</strong> is confirmed. The store team will see it on their calendar.</p>
<table cellpadding="0" cellspacing="0" style="width:100%;background:#f4f7ef;border-radius:10px;margin-bottom:24px;">
<tr><td style="padding:14px 18px;font-size:11px;text-transform:uppercase;letter-spacing:0.08em;color:#6b6a64;font-weight:600;">Brand</td><td style="padding:14px 18px;text-align:right;font-weight:600;color:#0f2c17;font-size:14px;">${H(brand_name)}</td></tr>
${product ? `<tr><td style="padding:14px 18px;font-size:11px;text-transform:uppercase;letter-spacing:0.08em;color:#6b6a64;font-weight:600;border-top:1px solid #ede3d0;">Product</td><td style="padding:14px 18px;text-align:right;color:#0f2c17;font-size:14px;border-top:1px solid #ede3d0;">${H(product)}</td></tr>` : ''}
${skuRowsHtml('#0f2c17')}
<tr><td style="padding:14px 18px;font-size:11px;text-transform:uppercase;letter-spacing:0.08em;color:#6b6a64;font-weight:600;border-top:1px solid #ede3d0;">Location</td><td style="padding:14px 18px;text-align:right;color:#0f2c17;font-size:14px;border-top:1px solid #ede3d0;">${H(venue)}</td></tr>
<tr><td style="padding:14px 18px;font-size:11px;text-transform:uppercase;letter-spacing:0.08em;color:#6b6a64;font-weight:600;border-top:1px solid #ede3d0;">Date</td><td style="padding:14px 18px;text-align:right;color:#0f2c17;font-size:14px;border-top:1px solid #ede3d0;">${H(dateLabel)}</td></tr>
<tr><td style="padding:14px 18px;font-size:11px;text-transform:uppercase;letter-spacing:0.08em;color:#6b6a64;font-weight:600;border-top:1px solid #ede3d0;">Time</td><td style="padding:14px 18px;text-align:right;color:#0f2c17;font-size:14px;border-top:1px solid #ede3d0;">${H(ctx.demo_time)}</td></tr>
</table>
${coiDeadline ? `<div style="background:#fff3ed;border:1px solid #ed682f55;border-left:4px solid #ed682f;border-radius:10px;padding:15px 18px;margin:0 0 22px;"><div style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;color:#a14e2a;margin-bottom:6px;">Action required &mdash; Certificate of Insurance</div><div style="font-size:14px;line-height:1.55;color:#a14e2a;">Your demo is <strong>automatically cancelled</strong> unless a current Certificate of Insurance is on file by <strong>${H(coiDeadline)}</strong> &mdash; that is 3 days (72 hours) before your demo, so the store can order product with confidence. Retailers require it to let you perform. <a href="https://demohubhq.com/brand/dashboard" style="color:#a14e2a;font-weight:700;text-decoration:underline;">Upload your COI now &rarr;</a></div></div>` : ''}
<div style="text-align:center;margin:0 0 20px;">
<a href="${manageBookingUrl || 'https://demohubhq.com/brand/signin'}" style="background:#0f2c17;color:white;padding:12px 26px;border-radius:10px;text-decoration:none;font-weight:700;font-size:14px;display:inline-block;">Manage your booking</a>
</div>
<p style="font-size:14px;line-height:1.5;color:#6b6a64;margin:0;">Need to change something? Just reply to this email — it goes straight to the store team.</p>
</td></tr>
<tr><td style="padding:20px 32px;background:#fbf7f0;border-top:1px solid rgba(15,44,23,0.06);font-size:12px;color:#6b6a64;text-align:center;">Powered by <strong style="color:#0f2c17;">Demohub</strong> · demohubhq.com</td></tr>
</table></body></html>`;
}

// Notify assigned store staff after payment. Mirrors the Wave 8 block in api/booking.js.
async function notifyStaffForBooking(ctx) {
  try {
    if (!RESEND_API_KEY || !ctx || !ctx.retailer_id) return;
    const H = htmlEscape;
    // Declared here, not borrowed from the brand-email scope - a bare reference
    // across functions throws and would kill the staff notification entirely.
    const skuList = Array.isArray(ctx.product_skus) ? ctx.product_skus.filter(p => p && p.name) : [];
    const retailerName = (ctx.retailers && ctx.retailers.name) || '';
    const retailerSlug = (ctx.retailers && ctx.retailers.slug) || '';
    const venueName = (ctx.venues && ctx.venues.name) || '';
    const dateLabel = (() => {
      try { return new Date(ctx.demo_date + 'T00:00:00Z').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' }); }
      catch (_) { return ctx.demo_date; }
    })();
    const allStaff = await sb(`internal_contacts?retailer_id=eq.${encodeURIComponent(ctx.retailer_id)}&select=id,name,email,notification_prefs,venue_ids`);
    const targetStaff = (allStaff || []).filter(st => {
      const prefs = st.notification_prefs || {};
      if (!prefs.on_scheduled) return false;
      const scopes = Array.isArray(st.venue_ids) ? st.venue_ids : [];
      if (scopes.length === 0) return true;
      if (ctx.venue_id && scopes.includes(ctx.venue_id)) return true;
      return false;
    }).filter(st => st.email);
    if (targetStaff.length === 0) return;
    const staffSubj = `New demo scheduled: ${ctx.brand_name || 'a brand'} on ${dateLabel}`;
    const staffHtml = `<!DOCTYPE html><html><body style="margin:0;padding:24px;background:#fbf7f0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,sans-serif;color:#1c1c1a;">
<table align="center" cellpadding="0" cellspacing="0" style="max-width:600px;margin:0 auto;background:white;border-radius:16px;overflow:hidden;border:1px solid rgba(15,44,23,0.08);">
<tr><td style="padding:28px 32px;background:#0f2c17;"><div style="font-weight:800;font-size:22px;color:#fbf7f0;letter-spacing:-0.04em;">demohub</div></td></tr>
<tr><td style="padding:32px 36px;">
<div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.12em;color:#a14e2a;margin-bottom:10px;">New demo scheduled</div>
<h1 style="font-family:Georgia,serif;font-size:24px;font-weight:500;line-height:1.25;color:#0f2c17;margin:0 0 12px;">A demo just landed on your calendar.</h1>
<p style="font-size:15px;line-height:1.6;color:#3a3a36;margin:0 0 18px;">Make sure you've got enough product on hand — <strong>${H(ctx.brand_name || 'the brand')}</strong> is coming to demo <strong>${H(ctx.product || 'their product')}</strong>.</p>
${skuList.length ? `<div style="background:#f4f7ef;border:1px solid #2a5b3222;border-left:4px solid #2a5b32;border-radius:10px;padding:15px 18px;margin:0 0 22px;"><div style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;color:#2a5b32;margin-bottom:8px;">Items being sampled</div><div style="font-size:14px;line-height:1.7;color:#1c1c1a;">${skuList.map(p => `&bull; ${H(p.name)}${p.size ? ' <span style="color:#6b6a64;">(' + H(p.size) + ')</span>' : ''}${p.sku ? ' <span style="color:#6b6a64;">SKU ' + H(p.sku) + '</span>' : ''}`).join('<br>')}</div></div>` : ''}
<table cellpadding="0" cellspacing="0" style="width:100%;background:#f9f7f2;border-radius:10px;margin-bottom:22px;">
<tr><td style="padding:12px 16px;font-size:11px;text-transform:uppercase;letter-spacing:0.08em;color:#6b6a64;font-weight:600;">Brand</td><td style="padding:12px 16px;text-align:right;font-weight:600;color:#0f2c17;font-size:14px;">${H(ctx.brand_name || '—')}</td></tr>
<tr><td style="padding:12px 16px;font-size:11px;text-transform:uppercase;letter-spacing:0.08em;color:#6b6a64;font-weight:600;border-top:1px solid #ede3d0;">Product</td><td style="padding:12px 16px;text-align:right;color:#0f2c17;font-size:14px;border-top:1px solid #ede3d0;">${H(ctx.product || '—')}</td></tr>
<tr><td style="padding:12px 16px;font-size:11px;text-transform:uppercase;letter-spacing:0.08em;color:#6b6a64;font-weight:600;border-top:1px solid #ede3d0;">Date</td><td style="padding:12px 16px;text-align:right;font-weight:600;color:#0f2c17;font-size:14px;border-top:1px solid #ede3d0;">${H(dateLabel)}</td></tr>
<tr><td style="padding:12px 16px;font-size:11px;text-transform:uppercase;letter-spacing:0.08em;color:#6b6a64;font-weight:600;border-top:1px solid #ede3d0;">Time</td><td style="padding:12px 16px;text-align:right;color:#0f2c17;font-size:14px;border-top:1px solid #ede3d0;">${H(ctx.demo_time || '—')}</td></tr>
<tr><td style="padding:12px 16px;font-size:11px;text-transform:uppercase;letter-spacing:0.08em;color:#6b6a64;font-weight:600;border-top:1px solid #ede3d0;">Location</td><td style="padding:12px 16px;text-align:right;color:#0f2c17;font-size:14px;border-top:1px solid #ede3d0;">${H(venueName || '—')}</td></tr>
</table>
<p style="font-size:12px;color:#6b6a64;line-height:1.55;margin:0;"><a href="https://demohubhq.com/r/${H(retailerSlug)}/admin" style="color:#2a5b32;">View full booking &rarr;</a></p>
</td></tr>
<tr><td style="padding:20px 32px;background:#fbf7f0;border-top:1px solid rgba(15,44,23,0.06);font-size:12px;color:#6b6a64;text-align:center;">Demohub LLC &middot; This is an automated staff alert. Adjust who gets these in your admin under Team.</td></tr>
</table></body></html>`;
    await Promise.allSettled(targetStaff.map(st => sendResendEmail({ to: st.email, subject: staffSubj, html: staffHtml })));
    console.log(`webhook staff-notify: sent to ${targetStaff.length} staff`);
  } catch (e) { console.warn('webhook staff-notify skipped:', (e && e.message) || e); }
}

async function handlePaymentIntentSucceeded(event) {
  const pi = event.data.object;
  const bookingIds = bookingIdsFrom(pi.metadata);
  if (bookingIds.length === 0) {
    console.warn('payment_intent.succeeded without booking_id(s) metadata', pi.id);
    return;
  }
  const paidAt = new Date().toISOString();
  const amount = pi.amount_received || pi.amount || 0;
  const perBooking = bookingIds.length > 0 ? Math.floor(amount / bookingIds.length) : 0;
  // Promote each booking from pending_payment → confirmed (or pending if retailer manual-vets).
  // Payment is the gate for status transitions: no confirmed state ever without a paid booking.
  await Promise.all(bookingIds.map(async (bookingId) => {
    try {
      const bookingRows = await sb(`bookings?id=eq.${encodeURIComponent(bookingId)}&select=retailer_id,status`);
      const b = Array.isArray(bookingRows) ? bookingRows[0] : null;
      let nextStatus = null;
      if (b && b.status === 'pending_payment') {
        const retailerRows = await sb(`retailers?id=eq.${encodeURIComponent(b.retailer_id)}&select=auto_confirm_bookings`);
        const r = Array.isArray(retailerRows) ? retailerRows[0] : null;
        nextStatus = (r && r.auto_confirm_bookings) ? 'confirmed' : 'pending';
      }
      const patch = {
        payment_status: 'paid',
        payment_intent_id: pi.id,
        paid_at: paidAt,
        amount_paid: perBooking,
      };
      if (nextStatus) patch.status = nextStatus;
      await sb(`bookings?id=eq.${encodeURIComponent(bookingId)}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      });
      // Only email on a real promotion (this booking was pending_payment and just got paid).
      // This is where the brand confirmation + staff alert fire — never at unpaid creation time.
      if (nextStatus) {
        try {
          const ctx = await fetchBookingContext(bookingId);
          if (ctx && ctx.contact_email) {
            const slug = (ctx.retailers && ctx.retailers.slug) || '';
            const magicLink = await createBrandMagicLink(ctx.brand_id, ctx.contact_email);
            const rebookUrl = slug ? `https://demohubhq.com/r/${slug}?prefill=1` : 'https://demohubhq.com';
            // COI: if the brand has no COI on file, the confirmation warns the demo is cancelled
            // unless it's uploaded by the day before the demo.
            let coiDeadline = null;
            try {
              // brand_id can be null on legacy/edge bookings; fall back to contact_email so the
              // COI warning still renders. No brand row found also means no COI on file.
              let _br = null;
              if (ctx.brand_id) {
                _br = await sb(`brands?id=eq.${encodeURIComponent(ctx.brand_id)}&select=default_coi_url`);
              } else if (ctx.contact_email) {
                _br = await sb(`brands?email=eq.${encodeURIComponent(String(ctx.contact_email).toLowerCase())}&select=default_coi_url`);
              }
              {
                const _hasCoi = Array.isArray(_br) && _br[0] && _br[0].default_coi_url;
                if (!_hasCoi && ctx.demo_date) {
                  const _dd = new Date(ctx.demo_date + 'T00:00:00Z');
                  _dd.setUTCDate(_dd.getUTCDate() - 3);
                  coiDeadline = _dd.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' });
                }
              }
            } catch (_) {}
            await sendResendEmail({
              to: ctx.contact_email,
              subject: `Your demo booking at ${(ctx.retailers && ctx.retailers.name) || 'Demohub'}`,
              html: bookingConfirmationEmailHtml(ctx, magicLink, rebookUrl, coiDeadline),
            });
            await notifyStaffForBooking(ctx);
          }
        } catch (mailErr) {
          console.warn('post-payment confirmation email skipped for', bookingId, ':', (mailErr && mailErr.message) || mailErr);
        }
      }
    } catch (e) {
      console.warn('booking', bookingId, 'paid PATCH failed:', (e && e.message) || e);
    }
  }));
  console.log(`payment_intent.succeeded: promoted ${bookingIds.length} booking(s) from pending_payment`);
}

async function handlePaymentIntentFailed(event) {
  const pi = event.data.object;
  const bookingIds = bookingIdsFrom(pi.metadata);
  if (bookingIds.length === 0) return;
  const err = (pi.last_payment_error && pi.last_payment_error.message) || 'payment failed';
  await Promise.all(bookingIds.map(bookingId => sb(`bookings?id=eq.${encodeURIComponent(bookingId)}`, {
    method: 'PATCH',
    body: JSON.stringify({
      payment_status: 'failed',
      payment_intent_id: pi.id,
      payment_error: err,
    }),
  }).catch(e => console.warn('booking', bookingId, 'failed PATCH failed:', (e && e.message) || e))));
  console.log(`payment_intent.payment_failed: ${bookingIds.length} booking(s), ${err}`);
  for (const bookingId of bookingIds) {
    try {
      const b = await fetchBookingContext(bookingId);
      if (b && b.contact_email) {
        await sendResendEmail({
          to: b.contact_email,
          subject: 'Payment failed for your ' + ((b.retailers && b.retailers.name) || 'demo') + ' booking',
          html: paymentFailedEmail({
            brandName: b.brand_name || b.contact_name || 'Brand',
            retailerName: (b.retailers && b.retailers.name) || 'Demohub retailer',
            retailerSlug: (b.retailers && b.retailers.slug) || '',
            venueName: (b.venues && b.venues.name) || 'store',
            demoDate: b.demo_date, demoTime: b.demo_time,
            errorMsg: err,
          }),
        });
      }
    } catch (e) { console.warn('failure email skipped:', (e && e.message) || e); }
  }
}

// charge.refunded: cancellation refund completed. Applies to all bookings in the batch.
async function handleChargeRefunded(event) {
  const charge = event.data.object;
  const bookingIds = bookingIdsFrom(charge.metadata);
  if (bookingIds.length === 0) return;
  const refunded = charge.amount_refunded || 0;
  const fully = refunded >= (charge.amount || 0);
  const refundedAt = new Date().toISOString();
  const perBooking = bookingIds.length > 0 ? Math.floor(refunded / bookingIds.length) : 0;
  await Promise.all(bookingIds.map(bookingId => sb(`bookings?id=eq.${encodeURIComponent(bookingId)}`, {
    method: 'PATCH',
    body: JSON.stringify({
      payment_status: fully ? 'refunded' : 'partial_refund',
      refunded_at: refundedAt,
      amount_refunded: perBooking,
    }),
  }).catch(e => console.warn('booking', bookingId, 'refund PATCH failed:', (e && e.message) || e))));
  console.log(`charge.refunded: ${bookingIds.length} booking(s), total=${refunded} fully=${fully}`);
  for (const bookingId of bookingIds) {
    try {
      const b = await fetchBookingContext(bookingId);
      if (b && b.contact_email) {
        await sendResendEmail({
          to: b.contact_email,
          subject: 'Refund on the way: ' + ((b.retailers && b.retailers.name) || 'your demo'),
          html: refundConfirmationEmail({
            brandName: b.brand_name || b.contact_name || 'Brand',
            retailerName: (b.retailers && b.retailers.name) || 'Demohub retailer',
            venueName: (b.venues && b.venues.name) || 'store',
            demoDate: b.demo_date, demoTime: b.demo_time,
            amount: perBooking,
          }),
        });
      }
    } catch (e) { console.warn('refund email skipped:', (e && e.message) || e); }
  }
}

// -----------------------------------------------------------------------------
// Subscription lifecycle handlers
// -----------------------------------------------------------------------------

// checkout.session.completed: fires when the brand/retailer finishes any Checkout Session.
// For mode=subscription, this is the moment a Pro upgrade completes. We mirror everything
// into the retailer row so the admin UI immediately shows Pro on next page load, without
// waiting on customer.subscription.created (which lands a beat later).
async function handleCheckoutSessionCompleted(event) {
  const session = event.data.object || {};
  const mode = session.mode;
  const meta = session.metadata || {};
  const retailerId = meta.retailer_id;
  const tier = (meta.tier || '').toLowerCase();

  // Only handle subscription-mode checkouts here. Payment-mode is per-booking, already
  // handled via payment_intent.succeeded on individual bookings.
  if (mode !== 'subscription') return;
  if (!retailerId) {
    console.warn('checkout.session.completed subscription without retailer_id metadata:', session.id);
    return;
  }

  const subscriptionId = session.subscription || null;
  const customerId = session.customer || null;

  const patch = {
    stripe_customer_id: customerId,
    stripe_subscription_id: subscriptionId,
    billing_tier: (tier === 'pro' || tier === 'starter' || tier === 'growth') ? tier : 'pro',
    billing_status: 'active',
  };

  await sb(`retailers?id=eq.${encodeURIComponent(retailerId)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
  console.log(`checkout.session.completed: retailer ${retailerId} upgraded to ${patch.billing_tier}`);
}

// customer.subscription.updated: fires on plan changes, status changes, cancel_at_period_end
// toggles, renewals. Keep billing_status + billing_period_end fresh.
async function handleSubscriptionUpdated(event) {
  const sub = event.data.object || {};
  const meta = sub.metadata || {};
  let retailerId = meta.retailer_id;

  // Fallback: look up by stripe_subscription_id if metadata is missing.
  if (!retailerId && sub.id) {
    const rows = await sb(`retailers?stripe_subscription_id=eq.${encodeURIComponent(sub.id)}&select=id`);
    if (Array.isArray(rows) && rows.length) retailerId = rows[0].id;
  }
  if (!retailerId) {
    console.warn('customer.subscription.updated: no retailer for sub', sub.id);
    return;
  }

  const status = sub.status || null; // active | past_due | canceled | unpaid | incomplete | trialing
  const periodEnd = sub.current_period_end ? new Date(sub.current_period_end * 1000).toISOString() : null;
  const cancelAt = sub.cancel_at ? new Date(sub.cancel_at * 1000).toISOString() : null;

  const patch = {
    billing_status: status,
    billing_period_end: periodEnd,
    billing_cancel_at: cancelAt,
  };

  await sb(`retailers?id=eq.${encodeURIComponent(retailerId)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
  console.log(`customer.subscription.updated: retailer ${retailerId} status=${status}`);
}

// customer.subscription.deleted: subscription has fully ended (past cancel_at, or hard-canceled).
// Revert the retailer to Solo. They can still resubscribe from Billing.
async function handleSubscriptionDeleted(event) {
  const sub = event.data.object || {};
  let retailerId = (sub.metadata || {}).retailer_id;
  if (!retailerId && sub.id) {
    const rows = await sb(`retailers?stripe_subscription_id=eq.${encodeURIComponent(sub.id)}&select=id`);
    if (Array.isArray(rows) && rows.length) retailerId = rows[0].id;
  }
  if (!retailerId) return;

  await sb(`retailers?id=eq.${encodeURIComponent(retailerId)}`, {
    method: 'PATCH',
    body: JSON.stringify({
      billing_tier: 'solo',
      billing_status: 'canceled',
      stripe_subscription_id: null,
      billing_cancel_at: null,
    }),
  });
  console.log(`customer.subscription.deleted: retailer ${retailerId} reverted to solo`);
}

// invoice.payment_failed: retailer's card failed for a subscription invoice. Flag past_due so
// the admin UI can prompt them to update their payment method via the Stripe portal.
async function handleInvoicePaymentFailed(event) {
  const invoice = event.data.object || {};
  const subscriptionId = invoice.subscription || null;
  if (!subscriptionId) return;
  const rows = await sb(`retailers?stripe_subscription_id=eq.${encodeURIComponent(subscriptionId)}&select=id`);
  const retailerId = Array.isArray(rows) && rows.length ? rows[0].id : null;
  if (!retailerId) return;
  await sb(`retailers?id=eq.${encodeURIComponent(retailerId)}`, {
    method: 'PATCH',
    body: JSON.stringify({ billing_status: 'past_due' }),
  });
  console.log(`invoice.payment_failed: retailer ${retailerId} flagged past_due`);
}

// invoice.paid: monthly renewal succeeded. Refresh billing_period_end + set active.
async function handleInvoicePaid(event) {
  const invoice = event.data.object || {};
  const subscriptionId = invoice.subscription || null;
  if (!subscriptionId) return;
  const rows = await sb(`retailers?stripe_subscription_id=eq.${encodeURIComponent(subscriptionId)}&select=id`);
  const retailerId = Array.isArray(rows) && rows.length ? rows[0].id : null;
  if (!retailerId) return;
  const periodEnd = invoice.lines?.data?.[0]?.period?.end
    ? new Date(invoice.lines.data[0].period.end * 1000).toISOString()
    : null;
  const patch = { billing_status: 'active' };
  if (periodEnd) patch.billing_period_end = periodEnd;
  await sb(`retailers?id=eq.${encodeURIComponent(retailerId)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
  console.log(`invoice.paid: retailer ${retailerId} renewed`);
}

// -----------------------------------------------------------------------------
// Handler entrypoint
// -----------------------------------------------------------------------------
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!WEBHOOK_SECRET) {
    console.error('STRIPE_WEBHOOK_SECRET not configured');
    return res.status(500).json({ error: 'webhook secret not configured' });
  }
  if (!SERVICE_KEY) {
    console.error('SUPABASE_SERVICE_KEY not configured');
    return res.status(500).json({ error: 'db key not configured' });
  }

  const rawBody = await readRawBody(req);
  const sig = req.headers['stripe-signature'];
  const event = verifySignature(rawBody, sig, WEBHOOK_SECRET);
  if (!event) {
    console.warn('webhook signature invalid or expired');
    return res.status(400).json({ error: 'signature invalid' });
  }

  try {
    switch (event.type) {
      case 'account.updated':
        await handleAccountUpdated(event); break;
      case 'checkout.session.completed':
        await handleCheckoutSessionCompleted(event); break;
      case 'customer.subscription.updated':
      case 'customer.subscription.created':
        await handleSubscriptionUpdated(event); break;
      case 'customer.subscription.deleted':
        await handleSubscriptionDeleted(event); break;
      case 'invoice.payment_failed':
        await handleInvoicePaymentFailed(event); break;
      case 'invoice.paid':
      case 'invoice.payment_succeeded':
        await handleInvoicePaid(event); break;
      case 'payment_intent.succeeded':
        await handlePaymentIntentSucceeded(event); break;
      case 'payment_intent.payment_failed':
        await handlePaymentIntentFailed(event); break;
      case 'charge.refunded':
        await handleChargeRefunded(event); break;
      default:
        // Other events subscribed but not handled — log and 200 so Stripe doesn't retry
        console.log(`ignored event: ${event.type}`);
    }
    return res.status(200).json({ received: true });
  } catch (e) {
    // Return 500 so Stripe will retry — but log so we can diagnose
    console.error(`webhook handler error for ${event.type}:`, e.message);
    return res.status(500).json({ error: e.message });
  }
}
