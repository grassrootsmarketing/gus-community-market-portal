// api/checkout.js — combined-charge checkout backed by the payment ledger (0029).
// checkout_claim_group() atomically verifies ownership + payable state, snapshots an IMMUTABLE
// per-demo allocation, and (via UNIQUE booking_id) makes concurrent double-checkout impossible.
// One Stripe Checkout Session per payment group; the durable group id is the Stripe idempotency key.
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
async function rpc(fn, args) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST', headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch (_) {}
  return { ok: r.ok, status: r.status, json: j, text: t };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!STRIPE) return res.status(500).json({ error: 'STRIPE_SECRET_KEY not configured' });
  if (!SUPABASE_URL || !SERVICE_KEY) return res.status(500).json({ error: 'server_not_configured' });
  let body = {}; try { body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}); } catch (_) {}

  const auth = await requireBrandSession(req, body);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

  let ids = Array.isArray(body.booking_ids) ? body.booking_ids.filter(Boolean) : (body.booking_id ? [body.booking_id] : []);
  ids = [...new Set(ids.map(String))];
  if (!ids.length) return res.status(400).json({ error: 'booking_ids required' });
  if (ids.length > 25) return res.status(400).json({ error: 'too_many_bookings' });

  try {
    const idList = ids.map(id => encodeURIComponent(id)).join(',');
    const bookings = await sbJson(`bookings?id=in.(${idList})&select=id,brand_id,retailer_id,venue_id,demo_date,demo_time,brand_name,contact_email`);
    if (!Array.isArray(bookings) || bookings.length === 0) return res.status(404).json({ error: 'booking_not_found' });
    // exact requested==returned set (Codex): no silent partial
    if (bookings.length !== ids.length) return res.status(400).json({ error: 'booking_set_mismatch' });

    const retailerId = bookings[0].retailer_id;
    const retailers = await sbJson(`retailers?id=eq.${encodeURIComponent(retailerId)}&select=name,slug,stripe_account_id,stripe_charges_enabled,platform_keeps_all`);
    const retailer = Array.isArray(retailers) ? retailers[0] : null;
    if (!retailer) return res.status(404).json({ error: 'retailer_not_found' });
    const platformKeepsAll = !!retailer.platform_keeps_all;
    if (!platformKeepsAll && (!retailer.stripe_account_id || !retailer.stripe_charges_enabled)) {
      return res.status(200).json({ ok: true, skip: true, reason: 'stripe_not_connected', booking_ids: bookings.map(b => b.id) });
    }

    // ---- ATOMIC claim + immutable allocations (ownership/payable/venue-fee enforced in the fn) ----
    const claim = await rpc('checkout_claim_group', {
      p_brand_id: auth.brandId, p_retailer_id: retailerId, p_booking_ids: ids,
      p_platform_keeps_all: platformKeepsAll,
      p_connect_account_id: platformKeepsAll ? null : retailer.stripe_account_id,
      p_platform_fee_cents: PLATFORM_FEE_CENTS,
    });
    if (!claim.ok) {
      const msg = String((claim.json && claim.json.message) || claim.text || '');
      if (/not_your_booking/.test(msg)) return res.status(403).json({ error: 'not_your_booking' });
      if (/mixed_retailers/.test(msg)) return res.status(400).json({ error: 'mixed_retailers' });
      if (/not_payable_state/.test(msg)) return res.status(409).json({ error: 'not_payable_state' });
      if (/another payment group/.test(msg)) return res.status(409).json({ error: 'already_in_checkout' });
      if (/venue_missing_fee/.test(msg)) return res.status(400).json({ error: 'venue_missing_fee' });
      console.error('checkout_claim_group failed:', msg);
      return res.status(400).json({ error: 'claim_failed' });
    }
    const row = Array.isArray(claim.json) ? claim.json[0] : claim.json;
    const gid = row.payment_group_id;
    const totalCents = row.total_customer_amount;

    // immutable allocation snapshot -> Stripe line items
    const allocs = await sbJson(`payment_allocations?payment_group_id=eq.${encodeURIComponent(gid)}&select=booking_id,customer_amount,platform_fee_amount`);
    const venueIds = [...new Set(bookings.map(b => b.venue_id).filter(Boolean))];
    const venues = venueIds.length ? await sbJson(`venues?id=in.(${venueIds.map(encodeURIComponent).join(',')})&select=id,name`) : [];
    const venueNameById = new Map((venues || []).map(v => [v.id, v.name]));
    const bkById = new Map(bookings.map(b => [b.id, b]));
    if (allocs.length !== bookings.length) return res.status(500).json({ error: 'allocation_count_mismatch' });
    if (allocs.some(a => a.customer_amount < 50)) return res.status(400).json({ error: 'amount_below_minimum' });
    const slug = retailer.slug || '';

    const params = {
      mode: 'payment', 'payment_method_types[0]': 'card',
      customer_email: bookings[0].contact_email || undefined,
      'metadata[payment_group_id]': gid,
      'metadata[retailer_id]': retailerId,
      'metadata[booking_ids]': bookings.map(b => b.id).join(','),
      success_url: `${SITE}/r/${slug}/?paid=1&bookings=${bookings.map(b => b.id).join(',')}`,
      cancel_url: `${SITE}/r/${slug}/?cancelled=1`,
      'payment_intent_data[metadata][payment_group_id]': gid,
      'payment_intent_data[metadata][retailer_id]': retailerId,
    };
    let idx = 0;
    for (const a of allocs) {
      const bk = bkById.get(a.booking_id) || {};
      const vname = venueNameById.get(bk.venue_id) || 'store';
      params[`line_items[${idx}][price_data][currency]`] = 'usd';
      params[`line_items[${idx}][price_data][unit_amount]`] = String(a.customer_amount);
      params[`line_items[${idx}][price_data][product_data][name]`] = `Demo at ${vname}`;
      params[`line_items[${idx}][price_data][product_data][description]`] = `${bk.brand_name || ''} - ${(bk.demo_date || '')} ${(bk.demo_time || '')} (${retailer.name || ''})`.trim();
      params[`line_items[${idx}][quantity]`] = '1';
      idx++;
    }
    if (!platformKeepsAll) {
      params['payment_intent_data[application_fee_amount]'] = String(allocs.reduce((s, a) => s + (a.platform_fee_amount || 0), 0));
      params['payment_intent_data[transfer_data][destination]'] = retailer.stripe_account_id;
      params['payment_intent_data[on_behalf_of]'] = retailer.stripe_account_id;
    }

    const bodyStr = Object.entries(params).filter(([, v]) => v !== undefined && v !== null)
      .map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(String(v))).join('&');

    // durable idempotency key = the payment group id (stable across retries of THIS checkout)
    const stripeResp = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${STRIPE}`, 'Content-Type': 'application/x-www-form-urlencoded', 'Idempotency-Key': 'co-' + gid },
      body: bodyStr,
    });
    const session = await stripeResp.json();
    if (!stripeResp.ok) { console.error('Stripe session failed:', session && session.error); return res.status(502).json({ error: 'stripe_failed' }); }

    // REQUIRED durable write (no swallow): attach session to the group. On failure return retryable;
    // the same idempotency key reuses the same Stripe session on retry.
    if (session.amount_total != null && Number(session.amount_total) !== Number(totalCents)) {
      console.error('RECONCILE: stripe amount_total', session.amount_total, '!= ledger total', totalCents, 'group', gid);
      return res.status(500).json({ error: 'amount_reconcile_failed' });
    }
    const upd = await rest(`payment_groups?id=eq.${encodeURIComponent(gid)}`, { method: 'PATCH', body: JSON.stringify({ stripe_checkout_session_id: session.id, status: 'session_created' }) });
    if (!upd.ok) { console.error('payment_group session persist failed'); return res.status(503).json({ error: 'session_persist_failed' }); }
    // mirror onto bookings for the existing admin UI (best-effort, non-authoritative)
    await Promise.allSettled(allocs.map(a => rest(`bookings?id=eq.${encodeURIComponent(a.booking_id)}`, { method: 'PATCH', body: JSON.stringify({ stripe_session_id: session.id }) })));

    return res.status(200).json({ ok: true, url: session.url, session_id: session.id, payment_group_id: gid, total_cents: totalCents, booking_ids: allocs.map(a => a.booking_id) });
  } catch (e) {
    console.error('checkout error:', (e && e.message) || e);
    return res.status(500).json({ error: 'checkout_error' });
  }
}
