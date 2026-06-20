// /api/stripe-webhook — Listens for Stripe checkout.session.completed.
// On success, flips the booking to status=paid+confirmed and creates the demo row.
//
// IMPORTANT: This endpoint should NOT have body parsing — Stripe needs the raw body
// for signature verification. In Vercel, set config below to disable JSON parser.
//
// Env required:
//   STRIPE_SECRET_KEY
//   STRIPE_WEBHOOK_SECRET  (whsec_... — from `stripe listen` or the dashboard webhook setting)
//   SUPABASE_SERVICE_KEY

export const config = { api: { bodyParser: false } };

const SUPABASE_URL = 'https://ecapmcyumpjjgjwuokyv.supabase.co';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

async function sb(path, opts = {}) {
  const headers = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=representation', ...(opts.headers || {}) };
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { ...opts, headers });
  const text = await r.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch(_) {}
  if (!r.ok) throw new Error(json?.message || text || `HTTP ${r.status}`);
  return json;
}

// Read raw body for signature verification
async function getRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

// Verify Stripe signature header (no node SDK; do it by hand with WebCrypto)
async function verifyStripeSignature(payload, header, secret) {
  if (!header || !secret) return false;
  const parts = Object.fromEntries(header.split(',').map(s => s.trim().split('=')));
  const t = parts.t, v1 = parts.v1;
  if (!t || !v1) return false;
  const signedPayload = `${t}.${payload.toString('utf8')}`;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, enc.encode(signedPayload));
  const expected = Array.from(new Uint8Array(mac)).map(b => b.toString(16).padStart(2, '0')).join('');
  // constant-time compare
  if (expected.length !== v1.length) return false;
  let diff = 0; for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ v1.charCodeAt(i);
  return diff === 0;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end('Method not allowed');
  if (!STRIPE_WEBHOOK_SECRET) return res.status(500).end('STRIPE_WEBHOOK_SECRET not configured');

  const buf = await getRawBody(req);
  const sig = req.headers['stripe-signature'];
  const ok = await verifyStripeSignature(buf, sig, STRIPE_WEBHOOK_SECRET);
  if (!ok) return res.status(400).end('Invalid signature');

  let event;
  try { event = JSON.parse(buf.toString('utf8')); } catch(_) { return res.status(400).end('Bad JSON'); }

  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const bookingId = session.metadata?.booking_id;
      if (bookingId) {
        // Mark booking confirmed + create the demo row
        const bookings = await sb(`bookings?id=eq.${encodeURIComponent(bookingId)}&select=*`);
        const booking = Array.isArray(bookings) ? bookings[0] : null;
        if (booking && booking.status === 'pending') {
          await sb(`bookings?id=eq.${encodeURIComponent(bookingId)}`, {
            method: 'PATCH',
            body: JSON.stringify({ status: 'confirmed' }),
          });
          const venues = await sb(`venues?id=eq.${encodeURIComponent(booking.venue_id)}&select=demo_fee`);
          const fee = Array.isArray(venues) && venues[0] ? Number(venues[0].demo_fee) : 30;
          await sb(`demos`, {
            method: 'POST',
            body: JSON.stringify({
              retailer_id: booking.retailer_id,
              venue_id: booking.venue_id,
              company_name: booking.brand_name || 'Unknown',
              contact_name: booking.contact_name || null,
              product: booking.product || null,
              demo_date: booking.demo_date,
              demo_time: booking.demo_time,
              duration_hours: 3,
              status: 'confirmed',
              demo_fee: fee,
              notes: 'Paid via Stripe: ' + session.id,
            }),
          });
        }
      }
    }
    return res.status(200).end('ok');
  } catch (e) {
    return res.status(500).end(String(e?.message || e));
  }
}
