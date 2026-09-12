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
import { resolveRequestedSlot, SLOT_REFUSAL_MESSAGES } from './_slots.js';
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

// Retailer proposes moving a confirmed demo to a new date. Writes the proposal on the demo and
// bumps the booking's proposal version in one RPC (0074 propose_reschedule), then emails the brand
// to accept/decline. Reports plainly (503) if the migration has not run instead of 500ing.
async function handleReschedulePropose(req, res, body) {
  const { demo_id, new_date, new_time } = body || {};
  if (!demo_id || !isUuid(demo_id)) return res.status(400).json({ error: 'Invalid demo_id' });
  if (!new_date || !/^\d{4}-\d{2}-\d{2}$/.test(new_date)) return res.status(400).json({ error: 'new_date (YYYY-MM-DD) required' });
  if (new_date < new Date().toISOString().slice(0, 10)) return res.status(400).json({ error: 'The new date must be in the future.' });

  const _auth = await requireRetailerMembership(req, body, null, ['owner', 'admin', 'manager']);
  if (!_auth.ok) return res.status(_auth.status).json({ error: _auth.error });
  const sess = { retailer_id: _auth.retailer_id, email: _auth.email };

  let demo;
  try { const rows = await sb(`demos?id=eq.${encodeURIComponent(demo_id)}&select=*,retailers(name,slug,timezone),venues(name)`); demo = Array.isArray(rows) ? rows[0] : null; }
  catch (_) { return res.status(404).json({ error: 'Demo not found' }); }
  if (!demo) return res.status(404).json({ error: 'Demo not found' });
  if (demo.retailer_id !== sess.retailer_id) return res.status(403).json({ error: 'Not allowed for this retailer' });
  if (demo.status !== 'confirmed') return res.status(409).json({ error: 'Only a confirmed demo can be rescheduled.' });

  // Release B: the proposed destination must be a slot the venue OFFERS on that date (configured
  // slots, weekday hours, blackouts). The canonical spelling is what the proposal stores; the
  // database re-checks at acceptance under the venue lock (accept_reschedule -> 0075 trigger).
  let proposedTime = null;
  {
    let venueRow = null;
    try { const vr = await sb(`venues?id=eq.${encodeURIComponent(demo.venue_id)}&retailer_id=eq.${encodeURIComponent(sess.retailer_id)}&select=id,availability`); venueRow = Array.isArray(vr) ? vr[0] : null; }
    catch (_) { venueRow = null; }
    if (!venueRow) return res.status(409).json({ error: 'no_venue', message: 'This demo has no location on file, so it cannot be moved from here.' });
    const requested = (typeof new_time === 'string' && new_time.trim()) ? new_time.trim() : (demo.demo_time || '');
    const slotRes = resolveRequestedSlot(venueRow.availability, new_date, requested, demo.retailers && demo.retailers.timezone);
    if (!slotRes.ok) {
      const code = slotRes.reason === 'invalid_time' ? 'invalid_new_time' : slotRes.reason;
      return res.status(slotRes.reason === 'slot_config_invalid' ? 503 : 400).json({ error: code, message: SLOT_REFUSAL_MESSAGES[slotRes.reason] || 'That time is not available at this location.' });
    }
    proposedTime = slotRes.time;
  }

  // 0074: the proposal is written on demos (reschedule_to_*) AND versioned on the booking
  // (bookings.reschedule_proposal_version += 1) in ONE transaction. The brand's accept/decline must
  // quote the version returned here; a stale tab or a superseded proposal is refused by the RPC.
  // A demo with no booking (legacy row) cannot be versioned and cannot be moved atomically — refused.
  let proposal;
  try {
    const rows = await sbRpc('propose_reschedule', { p_demo_id: demo_id, p_retailer_id: sess.retailer_id, p_new_date: new_date, p_new_time: proposedTime });
    proposal = Array.isArray(rows) ? rows[0] : rows;
  } catch (e) {
    console.error('propose_reschedule failed:', (e && e.message) || e);
    return res.status(503).json({ error: 'reschedule_unavailable', message: 'Reschedule storage is not set up yet (migration 0074). Try again after it is applied.' });
  }
  if (!proposal || proposal.ok !== true) {
    const reason = (proposal && proposal.reason) || 'reschedule_failed';
    if (reason === 'not_found') return res.status(404).json({ error: 'Demo not found' });
    if (reason === 'date_in_past') return res.status(400).json({ error: 'The new date must be in the future.' });
    if (reason === 'no_booking') return res.status(409).json({ error: 'no_booking', message: 'This demo has no linked booking, so it cannot be rescheduled from here. Cancel and rebook instead.' });
    return res.status(409).json({ error: reason, message: 'Only a confirmed demo with an active booking can be rescheduled.' });
  }
  const proposalVersion = proposal.proposal_version;

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
  return res.status(200).json({ ok: true, demo_id, booking_id: proposal.booking_id, new_date, new_time: proposal.new_time || new_time || demo.demo_time, proposal_version: proposalVersion });
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

  // Codex R4-02: the payment-outcome context lives OUTSIDE the main try so that every exit — the
  // named error paths below AND the outer catch — reports what happened to the brand's money:
  //   capturedHeldNow  = this request's capture is VERIFIED (Stripe's PI is 'succeeded').
  // An uncertain capture never reaches the code after the capture block (it returns at once), and a
  // definitive "not captured" is the only case that may say "nothing was charged".
  let capturedHeldNow = false;   // Codex C2 / H1 / R4-02
  let ctxBookingId = null, ctxAction = null;

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
    ctxBookingId = booking_id; ctxAction = action;

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

    // Codex R4-02 (1): everything this action NEEDS beyond the booking row — the venue (name, fee),
    // the retailer (cancellation mode, ...) and a valid demo fee for a confirm — is read and validated
    // HERE, before any money moves. A failed, empty or malformed read is refused with nothing changed
    // and nothing charged; there are no unguarded reads between a capture and its protections.
    let venue = null, retailer = null;
    try {
      const venues = await sb(`venues?id=eq.${encodeURIComponent(booking.venue_id)}&select=name,demo_fee`);
      venue = Array.isArray(venues) ? venues[0] : null;
      const retailers = await sb(`retailers?id=eq.${encodeURIComponent(booking.retailer_id)}&select=name,slug,cancellation_mode,platform_keeps_all`);
      retailer = Array.isArray(retailers) ? retailers[0] : null;
    } catch (e) {
      return res.status(503).json({ error: 'booking_context_unavailable', message: 'The venue or retailer details could not be loaded (' + String((e && e.message) || e).slice(0, 120) + '). Nothing was changed and nothing was charged — retry in a moment.' });
    }
    if (!venue || typeof venue !== 'object' || !retailer || typeof retailer !== 'object') {
      return res.status(503).json({ error: 'booking_context_unavailable', message: 'The venue or retailer for this booking could not be found. Nothing was changed and nothing was charged.' });
    }
    let demoFee = null;
    if (action === 'confirm') {
      const fee = demo_fee != null ? Number(demo_fee) : (venue.demo_fee != null ? Number(venue.demo_fee) : null);
      if (fee == null || !Number.isFinite(fee) || fee < 0) {
        return res.status(400).json({ error: 'venue_missing_fee', message: demo_fee != null ? 'The demo fee override is not a valid amount. Nothing was changed and nothing was charged.' : 'This venue has no demo fee configured. Set one in the admin before confirming this booking. Nothing was charged.' });
      }
      demoFee = fee;
    }

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
      if (capd.outcome === 'captured') capturedHeldNow = true;   // verified by Stripe's PI state — set BEFORE any later exit
      if (!capd.ok) {
        console.error('held-capture failed:', capd.outcome, capd.stage, capd.error, booking_id);
        if (capd.outcome === 'uncertain') {
          // Codex R4-02 (4): the capture may or may not have happened and Stripe's state could not be
          // established. Say exactly that. NOT captured:true, NOT "nothing was charged". The PI-scoped
          // idempotency key means a later retry of this confirm converges; payment_intent.succeeded /
          // the 24h sweep converge the ledger; the case (if recorded) puts it in front of an operator.
          return res.status(502).json({ ok: false, action, booking_id, error: 'payment_outcome_unknown', payment_uncertain: true,
            payment_intent_id: booking.payment_intent_id,
            message: 'The payment for this hold may have completed — Stripe did not confirm either way (' + String(capd.error || '').slice(0, 120) + '). Its status is being checked. Do NOT charge the brand again, cancel, decline or ask them to rebook on the assumption it failed — refresh in a minute and retry the confirm; it is safe to retry. '
              + (capd.case_recorded ? 'A reconciliation case was opened.' : 'The reconciliation case could NOT be recorded — contact support with this booking id.'),
            reconciliation_case_id: capd.case_id || null, reconciliation_recorded: !!capd.case_recorded });
        }
        if (capd.outcome === 'not_captured') {
          // Authoritative: Stripe refused the capture or the PI is in an uncaptured state. Only here is
          // "nothing was charged" a true statement.
          return res.status(502).json({ ok: false, action, booking_id, error: 'capture_failed', captured: false, stage: capd.stage, message: 'Stripe could not capture the held payment (' + capd.error + '). The authorization may have expired — nothing was charged.' });
        }
        // outcome 'captured' but the ledger apply failed: the brand HAS been charged. Same truthful
        // outcome + durable case as a post-capture transition failure (Codex H1 / R4-02 (3)).
        return await capturedButUnverified(res, { booking_id, action, error: 'apply:' + String(capd.error || 'failed'), case_id: capd.case_id || null });
      }
      // Codex H1: NO read-back and NO guessed state after the capture. The transition below judges the
      // CURRENT row under lock — pending -> confirmed, or already_applied when the capture-side
      // auto-confirm got there first — and capacity was verified BEFORE the capture, so the post-capture
      // re-check is skipped: it would count this booking's own demo and call a charged, confirmed
      // booking a capacity failure.
      booking.payment_status = 'paid';
    }

    // Race check at confirmation for an ordinary paid confirm (the only check on that path). For a
    // held booking it ran BEFORE the capture (P0-2) and is not repeated.
    if (action === 'confirm' && !capturedHeldNow) {
      const capStatus = await slotCapacityStatus(booking);
      if (capStatus.full) {
        return res.status(409).json({ error: `Slot is at capacity (${capStatus.taken}/${capStatus.cap}). Cannot confirm — decline this booking and ask the brand to pick another slot.` });
      }
    }

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
      // The reason rides on bookings.cancel_reason -> the demo_cancelled event payload (0074) -> the
      // store-contact "Demo cancelled" notice. Plain text, bounded.
      if (reason && String(reason).trim()) patch.cancel_reason = String(reason).trim().slice(0, 500);
      // (The reason is no longer appended to bookings.notes: notes is the brand's operational text
      //  and is shown to store contacts; owner reasons are not.)
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
    // Codex R2 (2026-09-11): the booking transition AND its calendar projection are ONE database
    // transaction (0077 booking_transition): the booking row is locked, its CURRENT state is judged
    // against the action's allow-list, the audited fields are applied, and the linked demo is
    // created / reactivated (confirm) or retired (cancel, decline) from the booking's current
    // schedule and duration. No check-then-write gap, no separate demo INSERT/PATCH, no "core-only"
    // fallback that could produce an unlinked demo. Stripe (above) and mail (below) stay outside it.
    let tr = null;
    try {
      const rows = await sbRpc('booking_transition', { p_booking_id: booking_id, p_retailer_id: session.retailer_id, p_action: action, p_fields: patch, p_demo_fee: demoFee });
      tr = Array.isArray(rows) ? rows[0] : rows;
    } catch (e) {
      // The transition did NOT happen. For a cancel/decline the refund may already be in flight
      // (Stripe ran above): record a deduplicated reconciliation case so an operator resolves the
      // booking, and report a non-success. Nothing was half-applied.
      console.error('booking_transition failed for', booking_id, '-', (e && e.message) || e);
      let caseId = null;
      // Money moved before this point: a refund/release for cancel/decline, or the CAPTURE for a held
      // confirm (Codex H1). Either way an operator must converge the booking — record it once.
      if (action !== 'confirm' || capturedHeldNow) {
        try {
          const _c = await sbRpc('_open_case', {
            p_kind: 'settlement_exception', p_dedupe: 'transition:' + booking_id,
            p_reason: capturedHeldNow ? 'capture_succeeded_confirmation_unverified' : 'booking_transition_failed_after_refund_step',
            p_group: null, p_request: null, p_operation: null,
            p_session: null, p_pi: null, p_charge: null, p_refund: null, p_amount: null, p_currency: null,
            p_details: { booking_id, action, refund_status: refundStatus, error: String((e && e.message) || e).slice(0, 300) },
          });
          caseId = Array.isArray(_c) ? _c[0] : _c;
        } catch (caseErr) {
          console.error('reconciliation case NOT recorded for booking', booking_id, '-', (caseErr && caseErr.message) || caseErr);
        }
      }
      if (capturedHeldNow) {
        // Codex H1: the brand HAS been charged and the booking is being confirmed; say exactly that.
        // Never "declined/rebook", never "nothing was charged".
        return capturedUnverifiedResponse(res, { booking_id, action, caseId });
      }
      return res.status(500).json({ ok: false, action, booking_id, error: 'transition_failed', refund_status: refundStatus,
        message: 'The booking could not be updated. ' + (caseId ? 'A reconciliation case was opened.' : 'Retry; if a refund was submitted it is tracked by the refund ledger.'),
        reconciliation_case_id: caseId, reconciliation_recorded: !!caseId });
    }
    if (!tr || tr.ok !== true) {
      // Codex C2-B: a LOGICAL refusal after money already moved is not an ordinary stale tab. The
      // refund (or the authorization release) happened; the booking is in a state this action cannot
      // transition (a concurrent confirm, say). Record ONE deduplicated reconciliation case so an
      // operator converges booking/demo/refund, and say explicitly what has already happened.
      const moneyMoved = refundStatus === 'submitted' || refundStatus === 'auth_released' || capturedHeldNow;
      let caseId = null;
      if (moneyMoved) {
        try {
          const _c = await sbRpc('_open_case', {
            p_kind: 'settlement_exception', p_dedupe: 'transition:' + booking_id,
            p_reason: capturedHeldNow ? 'capture_succeeded_confirmation_unverified' : 'booking_transition_refused_after_refund_step',
            p_group: null, p_request: null, p_operation: null,
            p_session: null, p_pi: null, p_charge: null, p_refund: (refundInfo && refundInfo.refund_id) || null, p_amount: null, p_currency: null,
            p_details: { booking_id, action, refund_status: refundStatus, transition_reason: (tr && tr.reason) || 'no_result', status_now: (tr && tr.status_before) || null },
          });
          caseId = Array.isArray(_c) ? _c[0] : _c;
        } catch (caseErr) {
          console.error('reconciliation case NOT recorded for booking', booking_id, '-', (caseErr && caseErr.message) || caseErr);
        }
      }
      return res.status(409).json({
        ok: false, error: capturedHeldNow ? 'capture_succeeded_confirmation_unverified' : 'state_changed', action, booking_id, captured: capturedHeldNow || undefined,
        status: tr && tr.status_before, payment_status: booking.payment_status,
        refund_status: moneyMoved ? refundStatus : undefined,
        refund_id: (moneyMoved && refundInfo && refundInfo.refund_id) || undefined,
        reconciliation_case_id: caseId || undefined,
        reconciliation_recorded: moneyMoved ? !!caseId : undefined,
        message: `This booking changed while you were working (now ${tr && tr.status_before ? tr.status_before : 'unknown'}). ` +
          (moneyMoved
            ? (capturedHeldNow ? 'The brand\'s card WAS captured — do not decline it or ask the brand to rebook; ' : refundStatus === 'submitted' ? 'A refund was already submitted for it; ' : 'Its payment hold was already released; ') + (caseId ? 'a reconciliation case was opened for an operator to settle the booking.' : 'the reconciliation case could NOT be recorded — contact support with this booking id.')
            : 'Reload and try again.'),
      });
    }
    // Codex C2-A: reason 'already_applied' = this action's terminal state was ALREADY in place when
    // the transition ran — the authorization release above did it (held cancel/decline), the
    // capture-side auto-confirm did it (held confirm), or a concurrent identical request did. The
    // transition converged the audited fields and the projection; the outcome is a truthful
    // success. Emails: still due when THIS request did the provider-side work (release/capture);
    // for a concurrent duplicate the first request sent them.
    const alreadyApplied = tr.reason === 'already_applied';
    const thisRequestDidTheWork = refundStatus === 'auth_released' || capturedHeldNow;
    const idempotentReplay = alreadyApplied && !thisRequestDidTheWork;
    demoCancelConverged = true;   // retired in the same transaction as the cancellation
    let demoId = tr.demo_id || null;
    if (action === 'confirm') {
      const brandId = booking.brand_id || null;
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

    // 2b) Store contacts (internal_contacts) are NOT emailed from here. The bookings.status
    //     transition above fires trg_booking_notification_events (0074), which writes the
    //     demo_confirmed / demo_cancelled event in the SAME transaction; api/notification-worker.js
    //     fans it out to every in-scope contact with the matching preference and sends with retries.
    //     A decline of a pending/held booking writes no event — contacts were never told about it.

    // 3) Send email (best-effort)
    let emailOk = false;
    if (_b.resendApiKey && booking.contact_email && !idempotentReplay) {
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
      idempotent: idempotentReplay || undefined,
      email_sent: emailOk,
      refund_status: action === 'cancel' ? refundStatus : undefined,
      refund_id: (refundInfo && refundInfo.refund_id) || undefined,
      // false ⇒ the demo did not cancel; a durable reconciliation case (reconciliation_case_id) was
      // opened. The caller must NOT treat the cancellation as fully complete.
      demo_cancelled: action === 'cancel' ? demoCancelConverged : undefined,
      reconciliation_case_id: (action === 'cancel' && demoCancelConverged === false) ? (demoCancelCaseId || undefined) : undefined,
    });
  } catch (e) {
    // Codex R4-02 (2)/(3): an unexpected exception AFTER a verified capture is still a captured
    // booking — report it as such and record the deduplicated case; never a generic 500 that reads
    // like "nothing happened".
    if (capturedHeldNow && ctxBookingId) {
      console.error('booking-action failed after a verified capture for', ctxBookingId, '-', (e && e.message) || e);
      return await capturedButUnverified(res, { booking_id: ctxBookingId, action: ctxAction, error: String((e && e.message) || e) });
    }
    return res.status(500).json({ error: String(e?.message || e) });
  }
}

// Codex H1 / R4-02: the ONE captured-but-unverified exit. Records the deduplicated reconciliation
// case ('transition:<booking>') when the caller has not already, then answers with the truthful
// outcome: captured:true, the booking is being confirmed, do not decline / rebook.
async function capturedButUnverified(res, { booking_id, action, error, case_id = null }) {
  let caseId = case_id;
  if (!caseId) {
    try {
      const _c = await sbRpc('_open_case', {
        p_kind: 'settlement_exception', p_dedupe: 'transition:' + booking_id, p_reason: 'capture_succeeded_confirmation_unverified',
        p_group: null, p_request: null, p_operation: null,
        p_session: null, p_pi: null, p_charge: null, p_refund: null, p_amount: null, p_currency: null,
        p_details: { booking_id, action, error: String(error || '').slice(0, 300) },
      });
      caseId = Array.isArray(_c) ? _c[0] : _c;
    } catch (caseErr) {
      console.error('reconciliation case NOT recorded for booking', booking_id, '-', (caseErr && caseErr.message) || caseErr);
    }
  }
  return capturedUnverifiedResponse(res, { booking_id, action, caseId });
}
function capturedUnverifiedResponse(res, { booking_id, action, caseId }) {
  return res.status(500).json({ ok: false, action, booking_id, error: 'capture_succeeded_confirmation_unverified', captured: true,
    message: 'The brand\'s card WAS captured and this booking is being confirmed, but the confirmation could not be verified just now. Do not decline it or ask the brand to rebook — refresh the booking. '
      + (caseId ? 'A reconciliation case was opened.' : 'The reconciliation case could NOT be recorded — contact support with this booking id.'),
    reconciliation_case_id: caseId || null, reconciliation_recorded: !!caseId });
}
