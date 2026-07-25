// api/checkout.js — F5-16 (hardened, multi-booking): session-bound, ownership-checked, idempotent.
// Merges the complete multi-booking / keeps-all / Connect pricing of the old checkout-session with
// the security guards of the LG-08 fix:
//   - identity from the authenticated BRAND session (never a submitted email)
//   - EVERY booking must belong to that brand and be in a payable state
//   - a Stripe idempotency key derived from the (sorted) booking set stops parallel double-charge
// The webhook (stripe-webhook.js) already flips every booking in metadata[booking_ids] to paid.
import crypto from 'node:crypto';
import { requireBrandSession } from './_booking-identity.js';

const SUPABASE_URL = process.env.SUPABASE_URL, SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY, STRIPE = process.env.STRIPE_SECRET_KEY;
const SITE = process.env.SITE_ORIGIN || 'https://www.demohubhq.com';
const PLATFORM_FEE_CENTS = 500;

function rest(path, opts = {}) {
  return fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...opts,
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=representation', ...(opts.headers || {}) },
  });
}
async function sbJson(path, opts) { const r = await rest(path, opts); const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch (_) {} if (!r.ok) throw new Error((j && j.message) || t || ('HTTP ' + r.status)); return j; }

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!STRIPE) return res.status(500).json({ error: 'STRIPE_SECRET_KEY not configured' });
  if (!SUPABASE_URL || !SERVICE_KEY) return res.status(500).json({ error: 'server_not_configured' });
  let body = {}; try { body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}); } catch (_) {}

  // 1) identity from the authenticated brand session
  const auth = await requireBrandSession(req, body);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

  // 2) collect requested bookings (array or single)
  let ids = Array.isArray(body.booking_ids) ? body.booking_ids.filter(Boolean) : (body.booking_id ? [body.booking_id] : []);
  ids = [...new Set(ids.map(String))];
  if (!ids.length) return res.status(400).json({ error: 'booking_ids required' });

  try {
    const idList = ids.map(id => encodeURIComponent(id)).join(',');
    const bookings = await sbJson(`bookings?id=in.(${idList})&select=id,brand_id,retailer_id,venue_id,demo_date,demo_time,brand_name,contact_email,status,payment_status,stripe_session_id`);
    if (!Array.isArray(bookings) || bookings.length === 0) return res.status(404).json({ error: 'booking_not_found' });

    // 3) OWNERSHIP + payable-state guard on every booking (session brand only)
    for (const b of bookings) {
      if (b.brand_id !== auth.brandId) return res.status(403).json({ error: 'not_your_booking' });
      if (b.payment_status === 'paid') return res.status(409).json({ error: 'already_paid', booking_id: b.id });
      if (b.status !== 'pending_payment' && b.payment_status !== 'unpaid') return res.status(409).json({ error: 'not_payable_state', booking_id: b.id });
    }
    // all bookings in one checkout must share a retailer
    const retailerId = bookings[0].retailer_id;
    if (bookings.some(b => b.retailer_id !== retailerId)) return res.status(400).json({ error: 'mixed_retailers' });

    // 4) retailer + keeps-all / Connect posture
    const retailers = await sbJson(`retailers?id=eq.${encodeURIComponent(retailerId)}&select=name,slug,stripe_account_id,stripe_charges_enabled,platform_keeps_all`);
    const retailer = Array.isArray(retailers) ? retailers[0] : null;
    if (!retailer) return res.status(404).json({ error: 'retailer_not_found' });
    const platformKeepsAll = !!retailer.platform_keeps_all;
    if (!platformKeepsAll && (!retailer.stripe_account_id || !retailer.stripe_charges_enabled)) {
      return res.status(200).json({ ok: true, skip: true, reason: 'stripe_not_connected', booking_ids: bookings.map(b => b.id) });
    }

    // 5) venues (server-owned pricing)
    const venueIds = [...new Set(bookings.map(b => b.venue_id).filter(Boolean))];
    const venues = venueIds.length ? await sbJson(`venues?id=in.(${venueIds.map(encodeURIComponent).join(',')})&select=id,name,demo_fee`) : [];
    const venuesById = new Map((venues || []).map(v => [v.id, v]));

    const slug = retailer.slug || '';
    const params = {
      mode: 'payment', 'payment_method_types[0]': 'card',
      customer_email: bookings[0].contact_email || undefined,
      'metadata[booking_ids]': bookings.map(b => b.id).join(','),
      'metadata[retailer_id]': retailerId,
      success_url: `${SITE}/r/${slug}/?paid=1&bookings=${bookings.map(b => b.id).join(',')}`,
      cancel_url: `${SITE}/r/${slug}/?cancelled=1`,
      'payment_intent_data[metadata][booking_ids]': bookings.map(b => b.id).join(','),
      'payment_intent_data[metadata][retailer_id]': retailerId,
    };
    let idx = 0, demoTotalCents = 0;
    for (const b of bookings) {
      const v = venuesById.get(b.venue_id);
      if (!v || v.demo_fee == null || Number(v.demo_fee) < 0) return res.status(400).json({ error: 'venue_missing_fee', venue_id: b.venue_id });
      const venueFeeCents = Math.max(0, Math.round(Number(v.demo_fee) * 100));
      const bundledCents = platformKeepsAll ? venueFeeCents : (venueFeeCents + PLATFORM_FEE_CENTS);
      demoTotalCents += venueFeeCents;
      const label = v.name ? `Demo at ${v.name}` : 'Demo';
      params[`line_items[${idx}][price_data][currency]`] = 'usd';
      params[`line_items[${idx}][price_data][unit_amount]`] = String(Math.max(50, bundledCents));
      params[`line_items[${idx}][price_data][product_data][name]`] = label;
      params[`line_items[${idx}][price_data][product_data][description]`] = `${b.brand_name || ''} - ${(b.demo_date || '')} ${(b.demo_time || '')} (${retailer.name || ''})`.trim();
      params[`line_items[${idx}][quantity]`] = '1';
      idx++;
    }
    const platformFeeCents = PLATFORM_FEE_CENTS * bookings.length;
    if (!platformKeepsAll) {
      params['payment_intent_data[application_fee_amount]'] = String(platformFeeCents);
      params['payment_intent_data[transfer_data][destination]'] = retailer.stripe_account_id;
      params['payment_intent_data[on_behalf_of]'] = retailer.stripe_account_id;
    }

    const bodyStr = Object.entries(params).filter(([, v]) => v !== undefined && v !== null)
      .map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(String(v))).join('&');

    // Stable idempotency key for THIS exact booking set → parallel submits reuse one session (no double-charge)
    const idem = 'co-' + crypto.createHash('sha256').update(bookings.map(b => b.id).sort().join(',')).digest('hex').slice(0, 48);
    const stripeResp = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${STRIPE}`, 'Content-Type': 'application/x-www-form-urlencoded', 'Idempotency-Key': idem },
      body: bodyStr,
    });
    const session = await stripeResp.json();
    if (!stripeResp.ok) { console.error('Stripe session failed:', session); return res.status(502).json({ error: 'stripe_failed', detail: session }); }

    await Promise.allSettled(bookings.map(b => rest(`bookings?id=eq.${encodeURIComponent(b.id)}`, { method: 'PATCH', body: JSON.stringify({ stripe_session_id: session.id }) })));
    return res.status(200).json({ ok: true, url: session.url, session_id: session.id, booking_ids: bookings.map(b => b.id), total_cents: platformKeepsAll ? demoTotalCents : (demoTotalCents + platformFeeCents) });
  } catch (e) {
    console.error('checkout error:', e);
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
}
