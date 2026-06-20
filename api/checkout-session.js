// /api/checkout-session — Creates a Stripe Checkout Session for a booking.
// On success, Stripe redirects back to the success URL. We rely on the
// /api/stripe-webhook to flip the booking from pending → paid+confirmed.
//
// Env required:
//   STRIPE_SECRET_KEY  (sk_live_... or sk_test_...)
//   SUPABASE_SERVICE_KEY
// Optional:
//   STRIPE_APPLICATION_FEE_PCT  (e.g. "10" for 10% platform fee — only if using Connect)

const SUPABASE_URL = 'https://ecapmcyumpjjgjwuokyv.supabase.co';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;

async function sb(path, opts = {}) {
  const headers = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=representation', ...(opts.headers || {}) };
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { ...opts, headers });
  const text = await r.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch(_) {}
  if (!r.ok) throw new Error(json?.message || text || `HTTP ${r.status}`);
  return json;
}

// Stripe API is form-urlencoded. Use a tiny helper to flatten nested keys.
function formEncode(obj, prefix = '') {
  const parts = [];
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}[${k}]` : k;
    if (v === undefined || v === null) continue;
    if (typeof v === 'object' && !Array.isArray(v)) {
      parts.push(formEncode(v, key));
    } else if (Array.isArray(v)) {
      v.forEach((item, i) => {
        if (typeof item === 'object') parts.push(formEncode(item, `${key}[${i}]`));
        else parts.push(encodeURIComponent(`${key}[${i}]`) + '=' + encodeURIComponent(String(item)));
      });
    } else {
      parts.push(encodeURIComponent(key) + '=' + encodeURIComponent(String(v)));
    }
  }
  return parts.filter(Boolean).join('&');
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(204).end();
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!STRIPE_SECRET_KEY) return res.status(500).json({ error: 'STRIPE_SECRET_KEY not configured' });
  if (!SERVICE_KEY) return res.status(500).json({ error: 'SUPABASE_SERVICE_KEY not configured' });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const { booking_id } = body || {};
    if (!booking_id) return res.status(400).json({ error: 'booking_id required' });

    // Load the booking + venue (to get fee + names)
    const bookings = await sb(`bookings?id=eq.${encodeURIComponent(booking_id)}&select=*`);
    const booking = Array.isArray(bookings) ? bookings[0] : null;
    if (!booking) return res.status(404).json({ error: 'Booking not found' });
    if (booking.status !== 'pending') return res.status(409).json({ error: 'Booking is ' + booking.status });

    const venues = await sb(`venues?id=eq.${encodeURIComponent(booking.venue_id)}&select=name,demo_fee`);
    const venue = Array.isArray(venues) ? venues[0] : null;
    const retailers = await sb(`retailers?id=eq.${encodeURIComponent(booking.retailer_id)}&select=name,slug`);
    const retailer = Array.isArray(retailers) ? retailers[0] : null;

    const amountUsd = Number(venue?.demo_fee || 30);
    const amountCents = Math.round(amountUsd * 100);
    const origin = `https://${req.headers['x-forwarded-host'] || req.headers.host || 'demohubhq.com'}`.replace(/\/$/, '');

    const params = {
      mode: 'payment',
      'payment_method_types[0]': 'card',
      customer_email: booking.contact_email || undefined,
      'line_items[0][price_data][currency]': 'usd',
      'line_items[0][price_data][unit_amount]': amountCents,
      'line_items[0][price_data][product_data][name]': `Demo at ${venue?.name || 'store'} on ${booking.demo_date}`,
      'line_items[0][price_data][product_data][description]': `${booking.brand_name || ''} — ${booking.demo_time || ''} (${retailer?.name || ''})`,
      'line_items[0][quantity]': 1,
      'metadata[booking_id]': booking_id,
      'metadata[retailer_id]': booking.retailer_id,
      'metadata[venue_id]': booking.venue_id,
      success_url: `${origin}/r/${retailer?.slug || ''}/?paid=1&booking=${booking_id}`,
      cancel_url: `${origin}/r/${retailer?.slug || ''}/?cancelled=1&booking=${booking_id}`,
    };

    // Stripe wants form-encoded
    const bodyStr = Object.entries(params)
      .filter(([k, v]) => v !== undefined && v !== null)
      .map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(String(v)))
      .join('&');

    const stripeResp = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${STRIPE_SECRET_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: bodyStr,
    });
    const session = await stripeResp.json();
    if (!stripeResp.ok) return res.status(502).json({ error: 'Stripe session failed', detail: session });

    // Store session id on the booking for the webhook to match
    await sb(`bookings?id=eq.${encodeURIComponent(booking_id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ notes: ((booking.notes || '') + (booking.notes ? '\n' : '') + 'stripe_session_id: ' + session.id).slice(0, 4000) }),
    });

    return res.status(200).json({ ok: true, url: session.url, session_id: session.id });
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
}
