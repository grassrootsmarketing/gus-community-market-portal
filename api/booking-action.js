import { requireRetailerMembership } from './_retailer-auth.js';
// /api/booking-action — Admin confirms, declines, or cancels a booking.
// On confirm: flips bookings.status to 'confirmed', creates a demos row, emails the brand.
// On decline: flips bookings.status to 'declined', emails the brand.
// On cancel: flips bookings.status to 'cancelled', refunds via Stripe if paid,
//            respecting the retailer's cancellation_mode (refundable | non_refundable).
// Uses service_role; must be called from a Cloudflare-Access-gated admin page.

// build-bust: 2026-07-09-phase-b
import { getBinding, sendBindingFailure } from './_env.js';
import { requireSameOrigin } from './_csrf.js';
import { sendMailQuietly, link } from './_mail.js';
import { coiCovered } from './_coi-coverage.js';
import { captureHeldBooking, releaseHeldBooking } from './_provisional.js';
let _b = null;
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const FROM_ADDRESS = 'Demohub <bookings@demohubhq.com>';

const REFUND_CUTOFF_DAYS = 14;

async function refundPaymentIntent(paymentIntentId, opts = {}) {
  if (!STRIPE_SECRET_KEY) return { ok: false, error: 'STRIPE_SECRET_KEY not configured' };
  if (!paymentIntentId) return { ok: false, error: 'payment_intent_id required' };
  const params = new URLSearchParams();
  params.set('payment_intent', paymentIntentId);
  // DH-04: when several bookings share one PaymentIntent (batch checkout), refund only this
  // booking's share. Omitted -> Stripe does a full refund (correct for single-booking PIs).
  if (opts.amountCents != null && Number.isFinite(opts.amountCents) && opts.amountCents > 0) {
    params.set('amount', String(Math.round(opts.amountCents)));
  }
  // Keeps-all retailers (e.g. Gus) take a plain platform charge: no transfer, no application
  // fee. Sending reverse_transfer / refund_application_fee on those charges makes Stripe reject
  // the refund outright, so only send them for connected (destination-charge) retailers.
  if (!opts.keepsAll) {
    params.set('refund_application_fee', 'true');
    params.set('reverse_transfer', 'true');
  }
  if (opts.reason) params.set('reason', opts.reason);
  if (opts.metadata) {
    for (const [k, v] of Object.entries(opts.metadata)) params.set('metadata[' + k + ']', String(v));
  }
  try {
    const _headers = {
      Authorization: 'Bearer ' + STRIPE_SECRET_KEY,
      'Content-Type': 'application/x-www-form-urlencoded',
    };
    // R2-03: idempotency key so two concurrent decline/cancel requests can't double-refund the
    // same booking. Keyed on the booking + operation, stable across Stripe/our own retries.
    if (opts.idempotencyKey) _headers['Idempotency-Key'] = String(opts.idempotencyKey).slice(0, 255);
    const r = await fetch('https://api.stripe.com/v1/refunds', {
      method: 'POST',
      headers: _headers,
      body: params.toString(),
    });
    const json = await r.json();
    if (!r.ok) return { ok: false, error: (json && json.error && json.error.message) || ('HTTP ' + r.status), detail: json };
    return { ok: true, refund_id: json.id, amount: json.amount, refund: json };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

// DH-01: viewer-role staff accounts are read-only. Fail-open on lookup error so a transient DB
// blip never locks out the primary owner (who has no retailer_admins row).
// (dead auth helper removed — all authorization goes through _retailer-auth.js)

// (R10-P1-8) The legacy bookingRefundCents() amount-or-full-refund helper was removed: refund
// amounts now come exclusively from the immutable allocation via refund_reserve_cas, so no code
// path can ever fall back to an unscoped full-PaymentIntent refund.

function daysUntilDemo(demo_date) {
  if (!demo_date) return 0;
  const demo = new Date(demo_date + 'T00:00:00Z').getTime();
  const now = Date.now();
  return Math.floor((demo - now) / (24 * 60 * 60 * 1000));
}

function html(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

// UUID format guard — prevents Postgres "invalid input syntax for type uuid" errors
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(s) { return typeof s === 'string' && UUID_RE.test(s); }

function brandHeader() {
  return `<table cellpadding="0" cellspacing="0"><tr>
<td style="padding-right:12px;vertical-align:middle;">
<svg width="40" height="40" viewBox="0 0 72 72" xmlns="http://www.w3.org/2000/svg"><circle cx="36" cy="36" r="36" fill="#0f2c17"/><circle cx="36" cy="40" r="18" fill="#ed682f"/><rect x="34.5" y="14" width="3" height="10" rx="1.2" fill="#fbf3e0"/><path d="M37 17 Q45 14 48 20 Q44 22 38 21 Q35 19 37 17 Z" fill="#87b08e"/></svg>
</td><td style="font-weight:800;font-size:24px;color:#fbf7f0;letter-spacing:-0.04em;">demohub</td>
</tr></table>`;
}

function confirmedEmail({ contact_name, brand_name, retailerName, venueName, dateLabel, demo_time, product }) {
  return `<!DOCTYPE html><html><body style="margin:0;padding:24px;background:#fbf7f0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,sans-serif;color:#1c1c1a;">
<table align="center" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;background:white;border-radius:16px;overflow:hidden;border:1px solid rgba(15,44,23,0.08);">
<tr><td style="padding:28px 32px;background:#0f2c17;">${brandHeader()}</td></tr>
<tr><td style="padding:36px 36px 28px;">
<div style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.14em;color:#2a5b32;margin-bottom:14px;">Demo confirmed</div>
<h1 style="font-family:Georgia,serif;font-size:30px;font-weight:500;line-height:1.2;color:#0f2c17;margin:0 0 18px;">You're on${contact_name ? ', ' + html(contact_name) : ''} &#10003;</h1>
<p style="font-size:15px;line-height:1.6;color:#3a3a36;margin:0 0 24px;">${html(retailerName)} has confirmed your demo. Here are the details:</p>
<table cellpadding="0" cellspacing="0" style="width:100%;background:#f4f7ef;border-radius:10px;margin-bottom:24px;">
<tr><td style="padding:14px 18px;font-size:11px;text-transform:uppercase;letter-spacing:0.08em;color:#6b6a64;font-weight:600;">Brand</td><td style="padding:14px 18px;text-align:right;font-weight:600;color:#0f2c17;font-size:14px;">${html(brand_name)}</td></tr>
${product ? `<tr><td style="padding:14px 18px;font-size:11px;text-transform:uppercase;letter-spacing:0.08em;color:#6b6a64;font-weight:600;border-top:1px solid #ede3d0;">Product</td><td style="padding:14px 18px;text-align:right;color:#0f2c17;font-size:14px;border-top:1px solid #ede3d0;">${html(product)}</td></tr>` : ''}
<tr><td style="padding:14px 18px;font-size:11px;text-transform:uppercase;letter-spacing:0.08em;color:#6b6a64;font-weight:600;border-top:1px solid #ede3d0;">Store</td><td style="padding:14px 18px;text-align:right;color:#0f2c17;font-size:14px;border-top:1px solid #ede3d0;">${html(venueName)}</td></tr>
<tr><td style="padding:14px 18px;font-size:11px;text-transform:uppercase;letter-spacing:0.08em;color:#6b6a64;font-weight:600;border-top:1px solid #ede3d0;">Date</td><td style="padding:14px 18px;text-align:right;color:#0f2c17;font-size:14px;border-top:1px solid #ede3d0;">${html(dateLabel)}</td></tr>
<tr><td style="padding:14px 18px;font-size:11px;text-transform:uppercase;letter-spacing:0.08em;color:#6b6a64;font-weight:600;border-top:1px solid #ede3d0;">Time</td><td style="padding:14px 18px;text-align:right;color:#0f2c17;font-size:14px;border-top:1px solid #ede3d0;">${html(demo_time)}</td></tr>
</table>
<p style="font-size:14px;line-height:1.5;color:#6b6a64;margin:0;">Reply to this email if anything changes.</p>
</td></tr>
<tr><td style="padding:20px 32px;background:#fbf7f0;border-top:1px solid rgba(15,44,23,0.06);font-size:12px;color:#6b6a64;text-align:center;">Powered by <strong style="color:#0f2c17;">Demohub</strong> &middot; demohubhq.com</td></tr>
</table></body></html>`;
}

function declinedEmail({ contact_name, brand_name, retailerName, venueName, dateLabel, demo_time, reason, refundStatus }) {
  return `<!DOCTYPE html><html><body style="margin:0;padding:24px;background:#fbf7f0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,sans-serif;color:#1c1c1a;">
<table align="center" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;background:white;border-radius:16px;overflow:hidden;border:1px solid rgba(15,44,23,0.08);">
<tr><td style="padding:28px 32px;background:#0f2c17;">${brandHeader()}</td></tr>
<tr><td style="padding:36px 36px 28px;">
<div style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.14em;color:#a14e2a;margin-bottom:14px;">Demo not available</div>
<h1 style="font-family:Georgia,serif;font-size:30px;font-weight:500;line-height:1.2;color:#0f2c17;margin:0 0 18px;">Hi${contact_name ? ' ' + html(contact_name) : ''},</h1>
<p style="font-size:15px;line-height:1.6;color:#3a3a36;margin:0 0 18px;">Unfortunately ${html(retailerName)} can't host your demo for <strong>${html(brand_name)}</strong> on ${html(dateLabel)} at ${html(demo_time)} (${html(venueName)}).</p>
${reason ? `<p style="font-size:15px;line-height:1.6;color:#3a3a36;margin:0 0 18px;"><strong>Note from the store:</strong> ${html(reason)}</p>` : ''}
${(refundStatus === 'issued' || refundStatus === 'submitted') ? `<p style="font-size:15px;line-height:1.6;color:#2a5b32;margin:0 0 18px;"><strong>Your refund request was submitted.</strong> We'll email you to confirm once it's completed &mdash; typically within 5&ndash;10 business days.</p>` : refundStatus === 'auth_released' ? `<p style="font-size:15px;line-height:1.6;color:#2a5b32;margin:0 0 18px;"><strong>Your card was never charged.</strong> The temporary hold has been released &mdash; depending on your bank it can take a few business days to drop off your statement.</p>` : refundStatus === 'refund_failed' ? `<p style="font-size:15px;line-height:1.6;color:#a14e2a;margin:0 0 18px;">We hit a snag issuing your refund automatically &mdash; we're on it and will make sure your card is credited. Questions? Just reply.</p>` : ''}
<p style="font-size:14px;line-height:1.5;color:#6b6a64;margin:0;">You're welcome to pick a different date &mdash; just head back to <a href="${link(_b, '/r/gus')}" style="color:#2a5b32;">demohubhq.com/r/gus</a>.</p>
</td></tr>
<tr><td style="padding:20px 32px;background:#fbf7f0;border-top:1px solid rgba(15,44,23,0.06);font-size:12px;color:#6b6a64;text-align:center;">Powered by <strong style="color:#0f2c17;">Demohub</strong> &middot; demohubhq.com</td></tr>
</table></body></html>`;
}


function cancelledEmail({ contact_name, brand_name, retailerName, venueName, dateLabel, demo_time, reason, refundStatus }) {
  const refundLine = (refundStatus === 'issued' || refundStatus === 'submitted')
    ? '<p style="font-size:15px;line-height:1.6;color:#3a3a36;margin:0 0 18px;">Your refund request was submitted. We\'ll email you to confirm once it\'s completed &mdash; typically within 5&ndash;10 business days.</p>'
    : refundStatus === 'auth_released'
    ? '<p style="font-size:15px;line-height:1.6;color:#3a3a36;margin:0 0 18px;">Your card was never charged &mdash; the temporary hold has been released. Depending on your bank it can take a few business days to drop off your statement.</p>'
    : refundStatus === 'pending_manual'
    ? '<p style="font-size:15px;line-height:1.6;color:#3a3a36;margin:0 0 18px;">' + html(retailerName) + ' will follow up with you about the refund directly, per their cancellation policy.</p>'
    : refundStatus === 'not_paid'
    ? '<p style="font-size:15px;line-height:1.6;color:#3a3a36;margin:0 0 18px;">No charge was captured for this booking, so nothing needs to be refunded.</p>'
    : '<p style="font-size:15px;line-height:1.6;color:#3a3a36;margin:0 0 18px;">If your card was charged, ' + html(retailerName) + ' will follow up about the refund per their cancellation policy.</p>';
  return '<!DOCTYPE html><html><body style="margin:0;padding:24px;background:#fbf7f0;font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,Helvetica,sans-serif;color:#1c1c1a;">' +
'<table align="center" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;background:white;border-radius:16px;overflow:hidden;border:1px solid rgba(15,44,23,0.08);">' +
'<tr><td style="padding:28px 32px;background:#0f2c17;">' + brandHeader() + '</td></tr>' +
'<tr><td style="padding:36px 36px 28px;">' +
'<div style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.14em;color:#a14e2a;margin-bottom:14px;">Demo cancelled</div>' +
'<h1 style="font-family:Georgia,serif;font-size:28px;font-weight:500;line-height:1.2;color:#0f2c17;margin:0 0 18px;">Your demo has been cancelled' + (contact_name ? ', ' + html(contact_name) : '') + '.</h1>' +
'<p style="font-size:15px;line-height:1.6;color:#3a3a36;margin:0 0 18px;">' + html(retailerName) + ' cancelled your demo for <strong>' + html(brand_name || 'your brand') + '</strong> on ' + html(dateLabel) + ' at ' + html(demo_time) + ' (' + html(venueName) + ').</p>' +
(reason ? '<p style="font-size:15px;line-height:1.6;color:#3a3a36;margin:0 0 18px;"><strong>Note from the store:</strong> ' + html(reason) + '</p>' : '') +
refundLine +
'<p style="font-size:14px;line-height:1.5;color:#6b6a64;margin:0;">To pick a different date, head back to <a href="' + link(_b, '/brand/dashboard') + '" style="color:#2a5b32;">your Demohub dashboard</a>.</p>' +
'</td></tr>' +
'<tr><td style="padding:20px 32px;background:#fbf7f0;border-top:1px solid rgba(15,44,23,0.06);font-size:12px;color:#6b6a64;text-align:center;">Powered by <strong style="color:#0f2c17;">Demohub</strong> &middot; demohubhq.com</td></tr>' +
'</table></body></html>';
}

async function sb(path, opts = {}) {
  const headers = { apikey: _b.serviceKey, Authorization: `Bearer ${_b.serviceKey}`, 'Content-Type': 'application/json', Prefer: 'return=representation', ...(opts.headers || {}) };
  const r = await fetch(`${_b.supabaseUrl}/rest/v1/${path}`, { ...opts, headers });
  const text = await r.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch(_) {}
  if (!r.ok) throw new Error(json?.message || text || `HTTP ${r.status}`);
  return json;
}

// P0-2 (Codex 2026-08-20): the slot-capacity check must run BEFORE any Stripe capture, never after.
// One authoritative model: venue.max_demos_per_slot vs the count of demos already CONFIRMED/COMPLETED
// in that exact slot. Returns { full, taken, cap }. Callers charge only when !full.
//
// NOTE (holds-ON hardening still owed): a pre-capture JS count is not fully race-proof — two
// simultaneous confirms can both read taken<cap and both proceed. The eval asks for this reservation
// to move into a locking DB RPC (see docs/provisional-holds.md → "capacity lease"). That is required
// before provisional holds are enabled; with the flag OFF no held capture path runs. This reorder
// still closes the money defect (a captured card on a full slot) for every path today.
async function slotCapacityStatus(booking) {
  const cap = await sb(`venues?id=eq.${encodeURIComponent(booking.venue_id)}&select=max_demos_per_slot`);
  const venueCap = (Array.isArray(cap) && cap[0]) ? Math.max(1, parseInt(cap[0].max_demos_per_slot, 10) || 1) : 1;
  const dupRows = await sb(`demos?retailer_id=eq.${encodeURIComponent(booking.retailer_id)}&venue_id=eq.${encodeURIComponent(booking.venue_id)}&demo_date=eq.${encodeURIComponent(booking.demo_date)}&demo_time=eq.${encodeURIComponent(booking.demo_time)}&status=in.(confirmed,completed)&select=id`);
  const taken = Array.isArray(dupRows) ? dupRows.length : 0;
  return { full: taken >= venueCap, taken, cap: venueCap };
}

// -----------------------------------------------------------------------------
// Codex finding B: this file's third hand-rolled copy of the cookie helpers is deleted outright
// rather than re-pointed at api/_cookies.js. getSessionIdFromReq() here had no call site at all —
// authorization already runs through _retailer-auth.js, which now reads the cookie itself — so the
// only live remnant was the opportunistic set-cookie in the handler, and that is meaningless once
// the cookie is the only place a session can have come from. Nothing left to keep a name for.
// -----------------------------------------------------------------------------

// Retailer proposes moving a confirmed demo to a new date. Sets the proposal on the
// demo and emails the brand to accept/decline. Resilient if the reschedule migration
// has not run (reports that plainly instead of 500ing).
async function handleReschedulePropose(req, res, body) {
  const { demo_id, new_date, new_time } = body || {};
  if (!demo_id || !isUuid(demo_id)) return res.status(400).json({ error: 'Invalid demo_id' });
  if (!new_date || !/^\d{4}-\d{2}-\d{2}$/.test(new_date)) return res.status(400).json({ error: 'new_date (YYYY-MM-DD) required' });
  if (new_date < new Date().toISOString().slice(0, 10)) return res.status(400).json({ error: 'The new date must be in the future.' });

  const _auth = await requireRetailerMembership(req, body, null, ['owner', 'admin', 'manager']);
  if (!_auth.ok) return res.status(_auth.status).json({ error: _auth.error });
  const sess = { retailer_id: _auth.retailer_id, email: _auth.email };

  let demo;
  try { const rows = await sb(`demos?id=eq.${encodeURIComponent(demo_id)}&select=*,retailers(name,slug),venues(name)`); demo = Array.isArray(rows) ? rows[0] : null; }
  catch (_) { return res.status(404).json({ error: 'Demo not found' }); }
  if (!demo) return res.status(404).json({ error: 'Demo not found' });
  if (demo.retailer_id !== sess.retailer_id) return res.status(403).json({ error: 'Not allowed for this retailer' });
  if (demo.status !== 'confirmed') return res.status(409).json({ error: 'Only a confirmed demo can be rescheduled.' });

  try {
    await sb(`demos?id=eq.${encodeURIComponent(demo_id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ reschedule_to_date: new_date, reschedule_to_time: new_time || demo.demo_time, reschedule_requested_at: new Date().toISOString() }),
    });
  } catch (e) {
    return res.status(503).json({ error: 'reschedule_unavailable', message: 'Reschedule storage is not set up yet. Run demos-reschedule-migration.sql, then try again.' });
  }

  // Email the brand to accept/decline.
  let brandEmail = demo.contact_email || null;
  if (!brandEmail && demo.brand_id) {
    try { const b = await sb(`brands?id=eq.${encodeURIComponent(demo.brand_id)}&select=email`); brandEmail = (Array.isArray(b) && b[0]) ? b[0].email : null; } catch (_) {}
  }
  if (brandEmail && _b.resendApiKey) {
    const retailerName = (demo.retailers && demo.retailers.name) || 'The store';
    const fromLabel = dateLabelOf(demo.demo_date) + (demo.demo_time ? ' at ' + demo.demo_time : '');
    const toLabel = dateLabelOf(new_date) + ((new_time || demo.demo_time) ? ' at ' + (new_time || demo.demo_time) : '');
    await sendMailQuietly({
      from: FROM_ADDRESS, to: brandEmail, replyTo: 'david@demohubhq.com',
      subject: `${retailerName} proposed a new date for your demo`,
      html: rescheduleEmail({ contact_name: demo.contact_name, brand_name: demo.company_name, retailerName, venueName: (demo.venues && demo.venues.name) || '', fromLabel, toLabel }),
    }, { binding: _b });
  }
  return res.status(200).json({ ok: true, demo_id, new_date, new_time: new_time || demo.demo_time });
}

function dateLabelOf(d) {
  if (!d) return '';
  try { return new Date(d + 'T00:00:00Z').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' }); }
  catch (_) { return d; }
}

function rescheduleEmail({ contact_name, brand_name, retailerName, venueName, fromLabel, toLabel }) {
  return `<!DOCTYPE html><html><body style="margin:0;padding:24px;background:#fbf7f0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,sans-serif;color:#1c1c1a;">
<table align="center" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;background:white;border-radius:16px;overflow:hidden;border:1px solid rgba(15,44,23,0.08);">
<tr><td style="padding:28px 32px;background:#0f2c17;">${brandHeader()}</td></tr>
<tr><td style="padding:36px 36px 28px;">
<div style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.14em;color:#a14e2a;margin-bottom:14px;">New date proposed</div>
<h1 style="font-family:Georgia,serif;font-size:28px;font-weight:500;line-height:1.2;color:#0f2c17;margin:0 0 18px;">Hi${contact_name ? ' ' + html(contact_name) : ''},</h1>
<p style="font-size:15px;line-height:1.6;color:#3a3a36;margin:0 0 16px;">${html(retailerName)} would like to move your demo for <strong>${html(brand_name)}</strong>${venueName ? ' at ' + html(venueName) : ''} to a new date.</p>
<table cellpadding="0" cellspacing="0" style="width:100%;background:#f9f7f2;border-radius:10px;margin:0 0 20px;">
<tr><td style="padding:12px 16px;font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:#6b6a64;">From</td><td style="padding:12px 16px;text-align:right;color:#6b6a64;text-decoration:line-through;">${html(fromLabel)}</td></tr>
<tr><td style="padding:12px 16px;font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:#2a5b32;border-top:1px solid #ede3d0;">To</td><td style="padding:12px 16px;text-align:right;color:#0f2c17;font-weight:700;border-top:1px solid #ede3d0;">${html(toLabel)}</td></tr>
</table>
<p style="font-size:15px;line-height:1.6;color:#3a3a36;margin:0 0 22px;">Your booking and payment stay exactly as they are &mdash; only the date changes if you accept.</p>
<a href="${link(_b, '/brand/dashboard')}" style="display:inline-block;background:#0f2c17;color:white;padding:13px 26px;border-radius:10px;text-decoration:none;font-weight:700;font-size:15px;">Review and respond &rarr;</a>
<p style="font-size:13px;line-height:1.5;color:#6b6a64;margin:18px 0 0;">Accept or decline from your dashboard. Decline and the demo stays on its original date.</p>
</td></tr>
<tr><td style="padding:20px 32px;background:#fbf7f0;border-top:1px solid rgba(15,44,23,0.06);font-size:12px;color:#6b6a64;text-align:center;">Powered by <strong style="color:#0f2c17;">Demohub</strong> &middot; demohubhq.com</td></tr>
</table></body></html>`;
}

async function sbRpc(fn, args) {
  const r = await fetch(`${_b.supabaseUrl}/rest/v1/rpc/${fn}`, {
    method: 'POST', headers: { apikey: _b.serviceKey, Authorization: `Bearer ${_b.serviceKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  const text = await r.text();
  if (!r.ok) throw new Error('rpc ' + fn + ' ' + r.status + ' ' + text.slice(0, 200));
  try { return text ? JSON.parse(text) : null; } catch (_) { return null; }
}

// Ledger-backed refund: refund_reserve_cas reserves the exact amount against the booking's immutable
// allocation and returns a canonical request; we submit the Stripe refund with the durable
// idempotency key and converge via apply_refund_event(). Booking payment_status is flipped only by
// verified success (webhook/worker), never optimistically here. No allocation -> requires_review.
async function reserveAndRefund(booking, retailer, actor, reason, opName) {
  // R10-P1-2/P0-4: one idempotent CAS command. refund_reserve_cas creates-or-RETURNS the operation
  // for this (booking, opName), reserves the exact allocation amount, and hands back everything
  // needed to submit a canonical Stripe request. A retry returns the existing request (never
  // "nothing_refundable"). Missing allocation / uncharged group -> requires_review, ZERO Stripe calls.
  const opKey = booking.id + ':' + opName;
  let rr;
  try { rr = await sbRpc('refund_reserve_cas', { p_booking_id: booking.id, p_op_key: opKey, p_actor: actor || null, p_reason: reason || null }); }
  catch (e) { return { ok: false, error: 'reserve_failed', requires_review: true }; }
  const row = Array.isArray(rr) ? rr[0] : rr;
  const outcome = row && row.outcome;
  if (outcome === 'no_allocation' || outcome === 'not_charged') return { ok: false, error: outcome, requires_review: true };
  if (outcome === 'nothing_refundable') return { ok: false, error: 'nothing_refundable' };
  if (outcome === 'no_booking' || outcome === 'booking_state_conflict') return { ok: false, error: outcome };

  const r = await refundPaymentIntent(row.payment_intent, {
    keepsAll: !!row.keeps_all, amountCents: row.amount, idempotencyKey: row.idempotency_key,
    reason: 'requested_by_customer', metadata: { refund_request_id: row.refund_request_id, booking_id: booking.id },
  });
  if (r.ok) {
    // Converge the ledger now via the VERIFIED apply RPC (idempotent with the later charge.refunded
    // webhook + the worker). Never flips the booking to 'refunded' here — only a verified success does.
    try {
      await sbRpc('apply_refund_event', {
        p_refund_id: r.refund_id, p_status: (r.refund && r.refund.status) || 'pending',
        p_amount: row.amount, p_currency: (r.refund && r.refund.currency) || 'usd',
        p_pi: row.payment_intent, p_charge: (r.refund && r.refund.charge) || row.charge_id || null,
        p_meta_request_id: row.refund_request_id, p_event_id: null,
      });
    } catch (_) { /* webhook/worker will still converge */ }
    return { ok: true, ledger: true, submitted: true };
  }
  // Submit failed: leave the reservation for the LEASED worker to retry with the same key.
  await sb(`refund_requests?id=eq.${encodeURIComponent(row.refund_request_id)}`, { method: 'PATCH', body: JSON.stringify({ status: 'failed_retryable', last_error: String(r.error || 'stripe refund failed').slice(0, 200) }) }).catch(() => {});
  return { ok: false, error: 'refund_failed', requires_review: true, retrying: true };
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(204).end();
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try { _b = await getBinding(); } catch (e) { return sendBindingFailure(res, e); }

  // Codex finding B: confirm / decline / cancel / reschedule all mutate a booking, and cancel can
  // move money out via Stripe. Checked once here, before the body is parsed and before any action
  // dispatch. No exemption applies: this route has no webhook and no cron path — the refund events
  // it depends on arrive at api/stripe-webhook.js, which is exempt on its own signature check.
  if (!requireSameOrigin(req, res, _b)) return;

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    // ===== Reschedule proposal (retailer proposes a new date for a CONFIRMED demo) =====
    // Distinct from cancel: no money moves. The brand accepts/declines from their dashboard.
    if (body && body.action === 'reschedule') {
      return await handleReschedulePropose(req, res, body);
    }
    const { booking_id, action, reason, demo_fee, force_refund } = body || {};
    if (!booking_id || !['confirm', 'decline', 'cancel'].includes(action)) {
      return res.status(400).json({ error: 'booking_id and action=confirm|decline|cancel required' });
    }
    if (!isUuid(booking_id)) return res.status(400).json({ error: 'Invalid booking_id' });

    // === Session check — cookie only, via the shared retailer guard ===
    const _auth = await requireRetailerMembership(req, body, null, ['owner', 'admin', 'manager']);
    if (!_auth.ok) return res.status(_auth.status).json({ error: _auth.error });
    const session = { retailer_id: _auth.retailer_id, email: _auth.email };

    // Fetch booking + retailer + venue
    let bookings;
    try {
      bookings = await sb(`bookings?id=eq.${encodeURIComponent(booking_id)}&select=*`);
    } catch (_) { return res.status(404).json({ error: 'Booking not found' }); }
    const booking = Array.isArray(bookings) ? bookings[0] : null;
    if (!booking) return res.status(404).json({ error: 'Booking not found' });
    // Provisional holds: a 'held' booking (auth placed, not captured) can be confirmed (captures
    // the payment — COI must be approved first), declined, or cancelled (releases the hold, $0).
    if (action === 'cancel') {
      if (!['pending', 'confirmed', 'held'].includes(booking.status)) {
        return res.status(409).json({ error: 'Booking already ' + booking.status });
      }
    } else if (!['pending', 'held'].includes(booking.status)) {
      return res.status(409).json({ error: 'Booking already ' + booking.status });
    }
    if (booking.retailer_id !== session.retailer_id) return res.status(403).json({ error: 'Not allowed for this retailer' });

    // ===== Confirming a HELD booking = capture the authorization first =====
    // Requires the auth to exist AND the brand's COI to be approved — capture is the moment the
    // brand is actually charged, and the whole point of the hold is "no charge until insured".
    // Capture -> apply_verified_payment (sync; the webhook replay is idempotent) -> outbox drain
    // promotes held -> 'pending' + sends the payment email; the normal confirm flow below then
    // finishes pending -> 'confirmed' with demo + confirmation email, exactly like a paid booking.
    if (action === 'confirm' && booking.status === 'held') {
      if (booking.payment_status !== 'authorized' || !booking.payment_intent_id) {
        return res.status(409).json({ error: 'hold_not_authorized', message: 'The brand has not completed checkout for this hold yet — there is nothing to charge. Ask them to finish payment, or decline to free the slot.' });
      }
      let brandRow = null;
      try {
        const br = await sb(`brands?id=eq.${encodeURIComponent(booking.brand_id)}&select=default_coi_url,default_coi_expires,coi_verification_status`);
        brandRow = Array.isArray(br) ? br[0] : null;
      } catch (_) {}
      const cov = coiCovered(brandRow || {}, booking.demo_date);
      if (!cov.covered) {
        return res.status(409).json({ error: 'coi_pending', reason: cov.reason, message: 'This brand\'s Certificate of Insurance is not approved yet. Approve their COI first (or decline the booking) — confirming is what charges their card.' });
      }
      // P0-2: verify slot capacity BEFORE capturing. Capturing first (as this route used to) meant a
      // full slot produced a charged card with no confirmed demo. If it is full now, refuse without
      // charging — the retailer declines and the brand rebooks; the 24h sweep releases the hold.
      const preCap = await slotCapacityStatus(booking);
      if (preCap.full) {
        return res.status(409).json({ error: 'slot_at_capacity', message: `Slot is at capacity (${preCap.taken}/${preCap.cap}). Nothing was charged — decline this booking and ask the brand to pick another slot.` });
      }
      const capd = await captureHeldBooking(booking);
      if (!capd.ok) {
        console.error('held-capture failed:', capd.stage, capd.error, booking_id);
        if (capd.stage === 'capture' || capd.stage === 'verify') {
          return res.status(502).json({ error: 'capture_failed', message: 'Stripe could not capture the held payment (' + capd.error + '). The authorization may have expired — nothing was charged.' });
        }
        return res.status(500).json({ error: 'capture_apply_failed', detail: capd.error, case_id: capd.case_id });
      }
      // fall through to the normal confirm flow with the promoted state
      booking.status = 'pending';
      booking.payment_status = 'paid';
    }

    // Race check at confirmation. For a held booking this ran AFTER capture above (harmless now —
    // capacity was already verified pre-capture); for a normal paid confirm this is the only check.
    if (action === 'confirm') {
      const capStatus = await slotCapacityStatus(booking);
      if (capStatus.full) {
        return res.status(409).json({ error: `Slot is at capacity (${capStatus.taken}/${capStatus.cap}). Cannot confirm — decline this booking and ask the brand to pick another slot.` });
      }
    }

    const venues = await sb(`venues?id=eq.${encodeURIComponent(booking.venue_id)}&select=name,demo_fee`);
    const venue = Array.isArray(venues) ? venues[0] : null;
    const retailers = await sb(`retailers?id=eq.${encodeURIComponent(booking.retailer_id)}&select=name,slug,cancellation_mode,platform_keeps_all`);
    const retailer = Array.isArray(retailers) ? retailers[0] : null;

    let newStatus;
    if (action === 'confirm') newStatus = 'confirmed';
    else if (action === 'decline') newStatus = 'declined';
    else newStatus = 'cancelled';

    let refundStatus = 'not_paid';
    let refundInfo = null;
    let demoCancelConverged = null;   // cancel path only: did the calendar demo actually get cancelled?
    let demoCancelCaseId = null;      // reconciliation case id if the demo cancel did NOT converge
    const wasPaid = booking.payment_status === 'paid' && booking.payment_intent_id;
    // Provisional holds: declining/cancelling a held booking with a live authorization RELEASES the
    // hold (cancel the PI — $0 charged, $0 Stripe fee), never refunds. The RPC inside flips the
    // booking to declined/cancelled; the email below carries the "never charged" copy.
    const wasAuthorized = booking.status === 'held' && booking.payment_status === 'authorized' && booking.payment_intent_id;
    if ((action === 'decline' || action === 'cancel') && wasAuthorized) {
      const rel = await releaseHeldBooking(booking, {
        target: action === 'decline' ? 'declined' : 'cancelled',
        reason: 'retailer_' + action, notify: false,
      });
      if (!rel.ok) {
        return res.status(502).json({ error: 'auth_release_failed', message: 'Could not release the payment hold: ' + rel.error + '. The booking was left as-is — retry in a moment.' });
      }
      if (rel.was_captured) {
        // P0-1 interleave: the hold was CAPTURED (a concurrent confirm / COI auto-confirm) at the same
        // instant as this decline/cancel. releaseHeldBooking converged the ledger to PAID rather than
        // expiring a charged booking. Refuse this action instead of marking a paid booking
        // declined/cancelled — the retailer can CANCEL it to refund through the tested paid-cancel path.
        return res.status(409).json({
          error: 'hold_captured',
          message: 'This hold was just captured — the brand has been charged and the demo is confirming. Refresh the page; if you still want to reverse it, cancel the booking to refund per your policy.',
        });
      }
      refundStatus = 'auth_released';
    } else if (action === 'decline') {
      // Declining an un-hosted demo ALWAYS refunds in full. The retailer chose not to host
      // it; the brand did nothing wrong, so we never keep their money. (Distinct from cancel,
      // which can respect a cancellation policy / cutoff.)
      if (!wasPaid) {
        refundStatus = 'not_paid';
      } else {
        const r = await reserveAndRefund(booking, retailer, (session && session.email) || null, reason || 'declined', 'decline');
        refundInfo = r;
        refundStatus = r.ok ? 'submitted' : 'refund_failed';
        if (!r.ok) console.warn('Decline refund failed for booking', booking_id, '-', r.error);
      }
    } else if (action === 'cancel') {
      const mode = (retailer && retailer.cancellation_mode) || 'refundable';
      const daysOut = daysUntilDemo(booking.demo_date);
      const shouldRefund = wasPaid && (
        force_refund === true
        || mode === 'refundable'
        || (mode !== 'non_refundable' && daysOut >= REFUND_CUTOFF_DAYS)
      );
      if (!wasPaid) {
        refundStatus = 'not_paid';
      } else if (shouldRefund) {
        const r = await reserveAndRefund(booking, retailer, (session && session.email) || null, reason || 'cancelled', 'cancel');
        refundInfo = r;
        refundStatus = r.ok ? 'submitted' : 'refund_failed';
        if (!r.ok) console.warn('Refund failed for booking', booking_id, '-', r.error);
      } else {
        refundStatus = 'pending_manual';
      }
    }

    // 1) Update booking row
    const patch = { status: newStatus };
    if (action === 'decline') {
      if (reason) patch.notes = (booking.notes ? booking.notes + '\n\n' : '') + 'Declined: ' + reason;
      if (refundInfo && refundInfo.refund_id) patch.refund_id = refundInfo.refund_id;
    }
    if (action === 'cancel') {
      patch.cancelled_at = new Date().toISOString();
      if (reason) patch.notes = (booking.notes ? booking.notes + '\n\n' : '') + 'Cancelled: ' + reason;
      if (refundInfo && refundInfo.refund_id) patch.refund_id = refundInfo.refund_id;
    }
    // P0-5: never show a terminal "refunded/cancelled-and-settled" state unless Stripe actually
    // refunded. On refund failure, mark payment_status=refund_pending (durable + retryable).
    if (wasPaid && (action === 'decline' || action === 'cancel')) {
      if (refundInfo && refundInfo.ok) {
        if (refundInfo.refund_id) patch.refund_id = refundInfo.refund_id;
        // authoritative 'refunded' flip happens in the charge.refunded webhook
      } else if (refundStatus === 'refund_failed') {
        patch.payment_status = 'refund_pending';
      }
    }
    await sb(`bookings?id=eq.${encodeURIComponent(booking_id)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    });
    // 2) Cancel the demo on the calendar. `demos` has no cancelled_at column — the cancellation
    //    audit timestamp lives on bookings.cancelled_at (set above) — so patch only the existing
    //    `status` column. This MUST converge: a refunded/cancelled booking that leaves a live
    //    'confirmed' demo on the retailer calendar is a real inconsistency. The refund may already
    //    be in flight, so a failure is NOT swallowed into a clean success — it is recorded as a
    //    durable reconciliation case and surfaced in the response (demo_cancelled:false).
    if (action === 'cancel' && booking.status === 'confirmed') {
      try {
        await sb(`demos?booking_id=eq.${encodeURIComponent(booking_id)}&status=in.(confirmed,scheduled)`, {
          method: 'PATCH',
          body: JSON.stringify({ status: 'cancelled' }),
        });
        demoCancelConverged = true;
      } catch (e) {
        demoCancelConverged = false;
        console.error('demo cancel did NOT converge for booking', booking_id, '-', (e && e.message) || e);
        // Durable AND deduplicated: open the reconciliation case through the shared _open_case RPC with a
        // stable per-booking key, so a retry (or the charge.refunded replay) cannot pile up duplicate
        // cases. The RPC returns the case id (existing or newly created).
        try {
          const _c = await sbRpc('_open_case', {
            p_kind: 'settlement_exception', p_dedupe: 'demo-cancel:' + booking_id,
            p_reason: 'demo_not_cancelled_after_booking_cancel',
            p_group: null, p_request: null, p_operation: null,
            p_session: null, p_pi: null, p_charge: null, p_refund: null, p_amount: null, p_currency: null,
            p_details: { booking_id, refund_status: refundStatus, error: String((e && e.message) || e).slice(0, 300) },
          });
          demoCancelCaseId = Array.isArray(_c) ? _c[0] : _c;   // RETURNS uuid
        } catch (caseErr) {
          demoCancelCaseId = null;
          console.error('reconciliation case NOT recorded for booking', booking_id, '-', (caseErr && caseErr.message) || caseErr);
        }
      }
    }

    let demoId = null;
    if (action === 'confirm') {
      const fee = demo_fee != null ? Number(demo_fee) : (venue?.demo_fee != null ? Number(venue.demo_fee) : null);
      if (fee == null || Number.isNaN(fee) || fee < 0) return res.status(400).json({ error: 'venue_missing_fee', message: 'This venue has no demo fee configured. Set one in the admin before confirming this booking.' });
      const brandId = booking.brand_id || null;

      // Build demo payload — include confirmed_at so the welcome-series cron can find
      // brands 24h after their first confirmed demo. If the column doesn't exist yet
      // (migration not run), retry without it.
      const demoPayload = {
        retailer_id: booking.retailer_id,
        venue_id: booking.venue_id,
        company_name: booking.brand_name || 'Unknown',
        contact_name: booking.contact_name || null,
        contact_email: booking.contact_email || null,
        contact_phone: booking.contact_phone || null,
        product: booking.product || null,
        product_skus: (Array.isArray(booking.product_skus) && booking.product_skus.length) ? booking.product_skus : null,
        demo_date: booking.demo_date,
        demo_time: booking.demo_time,
        duration_hours: 3,
        status: 'confirmed',
        confirmed_at: new Date().toISOString(),
        demo_fee: fee,
        notes: booking.notes || null,
        brand_id: brandId,
        booking_id: booking.id,  // DH-08: link demo->booking so a unique index enforces one demo per booking
      };
      let created = null;
      try {
        created = await sb(`demos`, { method: 'POST', body: JSON.stringify(demoPayload) });
      } catch (e) {
        const msg = String(e?.message || e);
        if (/duplicate key|already exists|23505|demos_one_per_booking/i.test(msg)) {
          // DH-08: a demo for this booking already exists (concurrent double-confirm). Reuse it
          // instead of creating a second row. The DB unique index is the real guard; this makes
          // confirm idempotent under a race.
          console.warn('demos insert hit unique guard, reusing existing demo for booking', booking_id);
          try {
            const existing = await sb(`demos?booking_id=eq.${encodeURIComponent(booking_id)}&select=id&limit=1`);
            demoId = (Array.isArray(existing) && existing[0]) ? existing[0].id : null;
          } catch (_) {}
        } else {
          // A confirmation must never fail because an OPTIONAL column is missing (migration
          // not run yet — including booking_id itself). Retry with only the core columns.
          console.warn('demos insert failed on full payload, retrying core-only:', msg.slice(0, 200));
          const { confirmed_at, product_skus, contact_email, contact_phone, booking_id: _bid, ...core } = demoPayload;
          created = await sb(`demos`, { method: 'POST', body: JSON.stringify(core) });
        }
      }
      if (created) demoId = Array.isArray(created) ? created[0]?.id : null;

      // Ensure a brand_contacts row exists for this (retailer, email).
      if (booking.contact_email) {
        try {
          const existing = await sb(`brand_contacts?retailer_id=eq.${encodeURIComponent(booking.retailer_id)}&email=eq.${encodeURIComponent(booking.contact_email)}&select=id,brand_id`);
          const row = Array.isArray(existing) ? existing[0] : null;
          if (!row) {
            await sb(`brand_contacts`, {
              method: 'POST',
              body: JSON.stringify({
                retailer_id: booking.retailer_id,
                name: booking.contact_name || booking.brand_name || '',
                company: booking.brand_name || '',
                email: booking.contact_email,
                phone: booking.contact_phone || null,
                brand_id: brandId,
              }),
            });
          } else if (!row.brand_id && brandId) {
            await sb(`brand_contacts?id=eq.${encodeURIComponent(row.id)}`, {
              method: 'PATCH',
              body: JSON.stringify({ brand_id: brandId }),
            });
          }
        } catch (e) { console.warn('brand_contacts upsert failed:', e); }
      }
    }

    // 3) Send email (best-effort)
    let emailOk = false;
    if (_b.resendApiKey && booking.contact_email) {
      const dateLabel = booking.demo_date ? new Date(booking.demo_date + 'T00:00:00Z').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : '';
      let subject, htmlBody;
      if (action === 'confirm') {
        subject = `Your ${retailer?.name || 'demo'} is confirmed`;
        htmlBody = confirmedEmail({ contact_name: booking.contact_name, brand_name: booking.brand_name, retailerName: retailer?.name || '', venueName: venue?.name || '', dateLabel, demo_time: booking.demo_time, product: booking.product });
      } else if (action === 'decline') {
        subject = `Update on your ${retailer?.name || 'demo'} request`;
        htmlBody = declinedEmail({ contact_name: booking.contact_name, brand_name: booking.brand_name, retailerName: retailer?.name || '', venueName: venue?.name || '', dateLabel, demo_time: booking.demo_time, reason, refundStatus });
      } else {
        subject = `Your ${retailer?.name || 'demo'} was cancelled`;
        htmlBody = cancelledEmail({ contact_name: booking.contact_name, brand_name: booking.brand_name, retailerName: retailer?.name || '', venueName: venue?.name || '', dateLabel, demo_time: booking.demo_time, reason, refundStatus });
      }
      const r = await sendMailQuietly({ from: FROM_ADDRESS, to: booking.contact_email, replyTo: 'david@demohubhq.com', subject, html: htmlBody }, { binding: _b });
      emailOk = r.ok;
    }

    // The demo failed to cancel AND its durable reconciliation case could not be recorded. Do NOT
    // report success: the booking was cancelled and any refund may already be submitted, but the
    // calendar demo is still live and the divergence is unrecorded. Tell the caller explicitly.
    if (action === 'cancel' && demoCancelConverged === false && !demoCancelCaseId) {
      return res.status(500).json({
        ok: false,
        action,
        booking_id,
        demo_cancelled: false,
        reconciliation_recorded: false,
        refund_status: refundStatus,
        message: 'The booking was cancelled and any refund may already be submitted, but the demo could not be cancelled and the exception could not be recorded. Reconcile the demo manually.',
      });
    }

    return res.status(200).json({
      ok: true,
      action,
      booking_id,
      demo_id: demoId,
      email_sent: emailOk,
      refund_status: action === 'cancel' ? refundStatus : undefined,
      refund_id: (refundInfo && refundInfo.refund_id) || undefined,
      // false ⇒ the demo did not cancel; a durable reconciliation case (reconciliation_case_id) was
      // opened. The caller must NOT treat the cancellation as fully complete.
      demo_cancelled: action === 'cancel' ? demoCancelConverged : undefined,
      reconciliation_case_id: (action === 'cancel' && demoCancelConverged === false) ? (demoCancelCaseId || undefined) : undefined,
    });
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
}
