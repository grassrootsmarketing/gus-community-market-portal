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

const SUPABASE_URL = process.env.SUPABASE_URL || (process.env.VERCEL_ENV === 'preview' ? undefined : 'https://ecapmcyumpjjgjwuokyv.supabase.co'); // WS1-R2-03: env-driven; a preview must set SUPABASE_URL and never silently falls back to prod
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;

// Canonical: brands pay a flat $5 booking fee per confirmed demo.
const PLATFORM_FEE_CENTS = 500;

async function sb(path, opts = {}) {
  const headers = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=representation', ...(opts.headers || {}) };
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { ...opts, headers });
  const text = await r.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch(_) {}
  if (!r.ok) throw new Error((json && json.message) || text || `HTTP ${r.status}`);
  return json;
}

function clientIpForRateLimit(req) {
  // cf-connecting-ip is attacker-supplied (not behind Cloudflare); x-real-ip is Vercel-set,
  // and the LAST x-forwarded-for hop is Vercel's. Trusting the client-controlled header let
  // every rate limit be bypassed by forging a fresh IP per request.
  const _xff = (req.headers['x-forwarded-for'] || '').toString().split(',').map(x => x.trim()).filter(Boolean);
  return req.headers['x-real-ip'] || _xff[_xff.length - 1] || req.socket?.remoteAddress || 'unknown';
}

// Fail-closed rate limit — prevents abuse of the Stripe API path via bulk POSTs.
async function checkRateLimit(req, maxPerHour) {
  try {
    const ip = clientIpForRateLimit(req);
    const key = 'checkout-session:' + ip;
    const windowStart = new Date(Math.floor(Date.now() / 3600000) * 3600000).toISOString();
    const existing = await sb(`rate_limit?bucket_key=eq.${encodeURIComponent(key)}&window_start=eq.${encodeURIComponent(windowStart)}&select=id,count`);
    const row = Array.isArray(existing) && existing[0];
    if (row && row.count >= maxPerHour) return { allowed: false };
    if (row) await sb(`rate_limit?id=eq.${row.id}`, { method: 'PATCH', body: JSON.stringify({ count: row.count + 1 }) });
    else await sb('rate_limit', { method: 'POST', body: JSON.stringify({ bucket_key: key, window_start: windowStart, count: 1 }) });
    return { allowed: true };
  } catch (e) {
    console.error('checkout-session rate limit failed — denying:', e?.message || e);
    return { allowed: false, error: 'rate_limit_unavailable' };
  }
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

  // Rate limit: cap Stripe API hits from any single IP to prevent runaway usage.
  const rl = await checkRateLimit(req, 60);
  if (!rl.allowed) {
    return res.status(rl.error === 'rate_limit_unavailable' ? 503 : 429).json({
      error: rl.error || 'too_many_requests',
      message: 'Too many checkout attempts. Try again in a moment.',
    });
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    // Accept either a single booking_id or an array of booking_ids
    let booking_ids = [];
    if (Array.isArray(body && body.booking_ids)) booking_ids = body.booking_ids.filter(Boolean);
    else if (body && body.booking_id) booking_ids = [body.booking_id];
    if (!booking_ids.length) return res.status(400).json({ error: 'booking_id or booking_ids required' });

    // Load all bookings
    const idList = booking_ids.map(id => encodeURIComponent(id)).join(',');
    const bookings = await sb(`bookings?id=in.(${idList})&select=*`);
    if (!Array.isArray(bookings) || bookings.length === 0) return res.status(404).json({ error: 'Bookings not found' });

    // All bookings must belong to the same retailer
    const retailerId = bookings[0].retailer_id;
    if (bookings.some(b => b.retailer_id !== retailerId)) {
      return res.status(400).json({ error: 'All bookings must belong to the same retailer' });
    }
    // Only allow charging bookings that aren't already paid or cancelled
    const chargeable = bookings.filter(b => b.payment_status !== 'paid' && b.status !== 'cancelled');
    if (chargeable.length === 0) return res.status(409).json({ error: 'No chargeable bookings' });

    // Load venues
    const venueIds = [...new Set(chargeable.map(b => b.venue_id).filter(Boolean))];
    const venueList = venueIds.map(id => encodeURIComponent(id)).join(',');
    const venues = venueIds.length
      ? await sb(`venues?id=in.(${venueList})&select=id,name,demo_fee`)
      : [];
    const venuesById = new Map((venues || []).map(v => [v.id, v]));

    const retailers = await sb(`retailers?id=eq.${encodeURIComponent(retailerId)}&select=name,slug,stripe_account_id,stripe_charges_enabled,platform_keeps_all`);
    const retailer = Array.isArray(retailers) ? retailers[0] : null;
    if (!retailer) return res.status(404).json({ error: 'Retailer not found' });

    // Special deal: some retailers (e.g. Gus's) let Demohub keep 100% of the fee.
    // For them we charge the brand and route everything to the platform account —
    // no Connect transfer, so the retailer doesn't need to be onboarded.
    const platformKeepsAll = !!retailer.platform_keeps_all;

    // Skip Stripe only if a NORMAL retailer hasn't finished Connect onboarding.
    // platform-keeps-all retailers don't need Connect at all.
    if (!platformKeepsAll && (!retailer.stripe_account_id || !retailer.stripe_charges_enabled)) {
      return res.status(200).json({
        ok: true,
        skip: true,
        reason: 'stripe_not_connected',
        booking_ids: chargeable.map(b => b.id),
      });
    }

    // R2-11: build Stripe success/cancel redirects from a fixed, configured origin — never from
    // client-controllable forwarded-host headers (which could redirect payment flow off-domain).
    const origin = process.env.SITE_ORIGIN || 'https://www.demohubhq.com';
    const retailerSlug = retailer.slug || '';

    // Build one line item per booking + one flat $5 fee line item per booking
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
      // Explicit null-fee guard — silently defaulting could over-charge a brand.
      if (!v || v.demo_fee == null || Number(v.demo_fee) < 0) {
        return res.status(400).json({
          error: 'venue_missing_fee',
          message: `Location "${(v && v.name) || 'this location'}" has no demo fee configured. Ask the retailer to set the fee in their admin.`,
          venue_id: b.venue_id,
        });
      }
      // Bundle the platform fee into the per-demo price. Brand sees ONE line item
      // per demo showing the total ($venue fee + $5). Platform still receives its
      // $5 cut via application_fee_amount below — invisible to the brand's checkout.
      const venueFeeCents = Math.max(0, Math.round(Number(v.demo_fee) * 100));
      // platform-keeps-all: brand pays just the demo fee (Demohub keeps 100%). Otherwise bundle +$5.
      const bundledCents = platformKeepsAll ? venueFeeCents : (venueFeeCents + PLATFORM_FEE_CENTS);
      demoTotalCents += venueFeeCents;
      const label = (v && v.name) ? `Demo at ${v.name}` : 'Demo';
      const sub = `${b.demo_date || ''} ${b.demo_time || ''}`.trim();
      params[`line_items[${idx}][price_data][currency]`] = 'usd';
      params[`line_items[${idx}][price_data][unit_amount]`] = bundledCents;
      params[`line_items[${idx}][price_data][product_data][name]`] = label;
      params[`line_items[${idx}][price_data][product_data][description]`] = `${b.brand_name || ''} - ${sub} (${retailer.name || ''})`.trim();
      params[`line_items[${idx}][quantity]`] = 1;
      idx++;
    }
    const platformFeeCents = PLATFORM_FEE_CENTS * chargeable.length;
    params['payment_intent_data[metadata][booking_ids]'] = chargeable.map(b => b.id).join(',');
    params['payment_intent_data[metadata][retailer_id]'] = retailerId;
    if (platformKeepsAll) {
      // Everything stays on the Demohub platform balance. No Connect transfer, no app fee split.
      // Retailer receives $0 (their arrangement). Nothing else to set.
    } else {
      // Standard: route the demo_fee to the retailer, keep the flat $5 on the platform balance.
      params['payment_intent_data[application_fee_amount]'] = platformFeeCents;
      params['payment_intent_data[transfer_data][destination]'] = retailer.stripe_account_id;
      params['payment_intent_data[on_behalf_of]'] = retailer.stripe_account_id;
    }

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

    // Store the session id on each booking
    await Promise.allSettled(chargeable.map(b => sb(`bookings?id=eq.${encodeURIComponent(b.id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ stripe_session_id: session.id }),
    })));

    return res.status(200).json({
      ok: true,
      url: session.url,
      session_id: session.id,
      demo_total_cents: demoTotalCents,
      // DH-24: for keeps-all retailers the $5 is NOT added to the charge (Demohub keeps the whole
      // demo fee), so the reported fee/total must match what Stripe actually charges.
      platform_fee_cents: platformKeepsAll ? 0 : platformFeeCents,
      total_cents: platformKeepsAll ? demoTotalCents : (demoTotalCents + platformFeeCents),
      booking_ids: chargeable.map(b => b.id),
    });
  } catch (e) {
    console.error('checkout-session error:', e);
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
}
