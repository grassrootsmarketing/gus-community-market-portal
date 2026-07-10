// /api/checkout-session — Creates a Stripe Checkout Session for one or more bookings.
// Called by the public booking page after the brand submits their booking(s).
// On success, Stripe redirects back to the retailer's public page with ?paid=1.
// The /api/stripe-webhook flips the bookings from pending → paid.
//
// Pricing model (canonical):
//   - Brand pays: demo_fee (goes to retailer) + $5 platform fee (goes to Demohub)
//   - Retailer receives: demo_fee only
//   - Demohub keeps: $5 per confirmed booking (flat, not percentage)
//
// Env required:
//   STRIPE_SECRET_KEY  (sk_live_... or sk_test_...)
//   SUPABASE_SERVICE_KEY

const SUPABASE_URL = 'https://ecapmcyumpjjgjwuokyv.supabase.co';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;

// Canonical: brands pay a flat $5 booking fee per confirmed demo.
const PLATFORM_FEE_CENTS = 500;

async function sb(path, opts = {}) {
  const headers = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=representation', ...(opts.headers || {}) };
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { ...opts, headers });
  const text = await r.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch(_) {}
  if (!r.ok) throw new Error(json?.message || text || `HTTP ${r.status}`);
  return json;
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
    // Accept either a single booking_id or an array of booking_ids (multi-book flow)
    let booking_ids = [];
    if (Array.isArray(body?.booking_ids)) booking_ids = body.booking_ids.filter(Boolean);
    else if (body?.booking_id) booking_ids = [body.booking_id];
    if (!booking_ids.length) return res.status(400).json({ error: 'booking_id or booking_ids required' });

    // Load all bookings
    const idList = booking_ids.map(id => encodeURIComponent(id)).join(',');
    const bookings = await sb(`bookings?id=in.(${idList})&select=*`);
    if (!Array.isArray(bookings) || bookings.length === 0) return res.status(404).json({ error: 'Bookings not found' });

    // All bookings must belong to the same retailer (single checkout session)
    const retailerId = bookings[0].retailer_id;
    if (bookings.some(b => b.retailer_id !== retailerId)) {
      return res.status(400).json({ error: 'All bookings must belong to the same retailer' });
    }
    // Only allow charging bookings that aren't already paid or cancelled
    const chargeable = bookings.filter(b => b.payment_status !== 'paid' && b.status !== 'cancelled');
    if (chargeable.length === 0) return res.status(409).json({ error: 'No chargeable bookings (all already paid or cancelled)' });

    // Load venue info for demo fees
    const venueIds = [...new Set(chargeable.map(b => b.venue_id).filter(Boolean))];
    const venueList = venueIds.map(id => encodeURIComponent(id)).join(',');
    const venues = venueIds.length
      ? await sb(`venues?id=in.(${venueList})&select=id,name,demo_fee`)
      : [];
    const venuesById = new Map((venues || []).map(v => [v.id, v]));

    const retailers = await sb(`retailers?id=eq.${encodeURIComponent(retailerId)}&select=name,slug,stripe_account_id,stripe_charges_enabled`);
    const retailer = Array.isArray(retailers) ? retailers[0] : null;
    if (!retailer) return res.status(404).json({ error: 'Retailer not found' });

    // Skip Stripe entirely if the retailer hasn't finished Connect onboarding.
    // Frontend falls back to the current success modal + the retailer collects offline.
    if (!retailer.stripe_account_id || !retailer.stripe_charges_enabled) {
      return res.status(200).json({
        ok: true,
        skip: true,
        reason: 'stripe_not_connected',
        booking_ids: chargeable.map(b => b.id),
      });
    }

    const origin = `https://${req.headers['x-forwarded-host'] || req.headers.host || 'demohubhq.com'}`.replace(/\/$/, '');
    const retailerSlug = retailer.slug || '';

    // Build one Stripe line item per booking: brand pays demo_fee + $5 booking fee
    // We tuck the $5 fee into a second line so the brand sees exactly what they're paying for.
    const params = {
      mode: 'payment',
      'payment_method_types[0]': 'card',
      customer_email: chargeable[0].contact_email || undefined,
      'metadata[booking_ids]': chargeable.map(b => b.id).join(','),
      'metadata[retailer_id]': retailerId,
      success_url: `${origin}/r/${retailerSlug}/?paid=1&bookings=${chargeable.map(b => b.id).join(',')}`,
      cancel_url: `${origin}/r/${retailerSlug}/?cancelled=1`,
    };

    let idx = 0;
    let demoTotalCents = 0;
    for (const b of chargeable) {
      const v = venuesById.get(b.venue_id);
      const feeUsd = Number(v?.demo_fee ?? 30);
      const feeCents = Math.max(0, Math.round(feeUsd * 100));
      demoTotalCents += feeCents;
      const label = v?.name ? `Demo at ${v.name}` : 'Demo';
      const sub = `${b.demo_date || ''} ${b.demo_time || ''}`.trim();
      params[`line_items[${idx}][price_data][currency]`] = 'usd';
      params[`line_items[${idx}][price_data][unit_amount]`] = feeCents;
      params[`line_items[${idx}][price_data][product_data][name]`] = label;
      params[`line_items[${idx}][price_data][product_data][description]`] = `${b.brand_name || ''} — ${sub} (${retailer.name || ''})`.trim();
      params[`line_items[${idx}][quantity]`] = 1;
      idx++;
    }
    // Add the flat platform fee as its own line so the brand sees exactly the breakdown
    // (One $5 fee for the whole session, matching the tour: "$X demo + $5 booking fee")
    // If multiple bookings in the session, keep charging one $5 per booking.
    const platformFeeCents = PLATFORM_FEE_CENTS * chargeable.length;
    const feeLabel = chargeable.length === 1
      ? 'Demohub booking fee'
      : `Demohub booking fee (${chargeable.length} × $5)`;
    params[`line_items[${idx}][price_data][currency]`] = 'usd';
    params[`line_items[${idx}][price_data][unit_amount]`] = platformFeeCents;
    params[`line_items[${idx}][price_data][product_data][name]`] = feeLabel;
    params[`line_items[${idx}][price_data][product_data][description]`] = 'Platform booking fee, per demo';
    params[`line_items[${idx}][quantity]`] = 1;

    // Stripe Connect: route the demo_fee portion to the retailer's connected account,
    // keep the $5 fee (per booking) on the platform balance.
    // (Guaranteed connected at this point — the not-connected case returned skip: true above.)
    params['payment_intent_data[application_fee_amount]'] = platformFeeCents;
    params['payment_intent_data[transfer_data][destination]'] = retailer.stripe_account_id;
    params['payment_intent_data[metadata][booking_ids]'] = chargeable.map(b => b.id).join(',');
    params['payment_intent_data[metadata][retailer_id]'] = retailerId;
    params['payment_intent_data[on_behalf_of]'] = retailer.stripe_account_id;

    // Form-encode
    const bodyStr = Object.entries(params)
      .filter(([, v]) => v !== undefined && v !== null)
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
    if (!stripeResp.ok) {
      console.error('Stripe session failed:', session);
      return res.status(502).json({ error: 'Stripe session failed', detail: session });
    }

    // Store the session id + payment intent on each booking so the webhook can match on refund
    await Promise.allSettled(chargeable.map(b => sb(`bookings?id=eq.${encodeURIComponent(b.id)}`, {
      method: 'PATCH',
      body: JSON.stringify({
        stripe_session_id: session.id,
        // pi is on the session but may not resolve immediately; webhook sets payment_intent_id
      }),
    })));

    return res.status(200).json({
      ok: true,
      url: session.url,
      session_id: session.id,
      demo_total_cents: demoTotalCents,
      platform_fee_cents: platformFeeCents,
      total_cents: demoTotalCents + 