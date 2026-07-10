// /api/stripe-webhook — receives events from Stripe and updates our DB.
//
// Events handled:
//   account.updated              → flips retailers.stripe_charges_enabled / _payouts_enabled
//                                  when Plaid or micro-deposit verification completes.
//   payment_intent.succeeded     → marks the associated booking as paid.
//   payment_intent.payment_failed → marks the booking as payment-failed.
//   charge.refunded              → marks the booking as refunded.
//
// Env vars required:
//   STRIPE_WEBHOOK_SECRET (whsec_...)   — from Stripe Dashboard → Developers → Webhooks
//   SUPABASE_SERVICE_KEY                — bypasses RLS for DB writes
//
// Important: Vercel serverless needs the raw body for signature verification, so we
// disable the built-in body parser and read the stream manually.

import { createHmac, timingSafeEqual } from 'crypto';

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
async function handlePaymentIntentSucceeded(event) {
  const pi = event.data.object;
  const bookingIds = bookingIdsFrom(pi.metadata);
  if (bookingIds.length === 0) {
    console.warn('payment_intent.succeeded without booking_id(s) metadata', pi.id);
    return;
  }
  const paidAt = new Date().toISOString();
  const amount = pi.amount_received || pi.amount || 0;
  // Split the amount across bookings for audit trail — Stripe already knows the true split.
  const perBooking = bookingIds.length > 0 ? Math.floor(amount / bookingIds.length) : 0;
  await Promise.all(bookingIds.map(bookingId => sb(`bookings?id=eq.${encodeURIComponent(bookingId)}`, {
    method: 'PATCH',
    body: JSON.stringify({
      payment_status: 'paid',
      payment_intent_id: pi.id,
      paid_at: paidAt,
      amount_paid: perBooking,
    }),
  }).catch(e => console.warn(`booking ${bookingId} paid PATCH failed:`, e?.message || e))));
  console.log(`payment_intent.succeeded: marked ${bookingIds.length} booking(s) paid`);
}

async function handlePaymentIntentFailed(event) {
  const pi = event.data.object;
  const bookingIds = bookingIdsFrom(pi.metadata);
  if (bookingIds.length === 0) return;
  const err = pi.last_payment_error?.message || 'payment failed';
  await Promise.all(bookingIds.map(bookingId => sb(`bookings?id=eq.${encodeURIComponent(bookingId)}`, {
    method: 'PATCH',
    body: JSON.stringify({
      payment_status: 'failed',
      payment_intent_id: pi.id,
      payment_error: err,
    }),
  }).catch(e => console.warn(`booking ${bookingId} failed PATCH failed:`, e?.message || e))));
  console.log(`payment_intent.payment_failed: ${bookingIds.length} booking(s), ${err}`);
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
  }).catch(e => console.warn(`booking ${bookingId} refund PATCH failed:`, e?.message || e))));
  console.log(`charge.refunded: ${bookingIds.length} booking(s), total=${refunded} fully=${fully}`);
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
    return res.status(500).