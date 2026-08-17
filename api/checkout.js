// api/checkout.js — combined-charge checkout backed by the payment ledger (0029).
// checkout_claim_group() atomically verifies ownership + payable state, snapshots an IMMUTABLE
// per-demo allocation, and (via UNIQUE booking_id) makes concurrent double-checkout impossible.
// One Stripe Checkout Session per payment group; the durable group id is the Stripe idempotency key.
import crypto from 'node:crypto';
import { requireBrandSession } from './_booking-identity.js';
import { FLAGS, maxCartSize } from './_flags.js';

import { getBinding, sendBindingFailure } from './_env.js';
import { requireSameOrigin } from './_csrf.js';
const STRIPE = process.env.STRIPE_SECRET_KEY;
let _b = null;
// SITE comes from the validated binding inside the handler (_b.siteOrigin). A hardcoded
// fallback here is what let a preview deployment send customers to production on checkout return.
const PLATFORM_FEE_CENTS = 500;

function rest(path, opts = {}) {
  return fetch(`${_b.supabaseUrl}/rest/v1/${path}`, {
    ...opts,
    headers: { apikey: _b.serviceKey, Authorization: `Bearer ${_b.serviceKey}`, 'Content-Type': 'application/json', Prefer: 'return=representation', ...(opts.headers || {}) },
  });
}
async function sbJson(path, opts) { const r = await rest(path, opts); const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch (_) {} if (!r.ok) throw new Error((j && j.message) || t || ('HTTP ' + r.status)); return j; }
async function rpc(fn, args) {
  const r = await fetch(`${_b.supabaseUrl}/rest/v1/rpc/${fn}`, {
    method: 'POST', headers: { apikey: _b.serviceKey, Authorization: `Bearer ${_b.serviceKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch (_) {}
  return { ok: r.ok, status: r.status, json: j, text: t };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!FLAGS.checkoutEnabled) return res.status(503).json({ error: 'checkout_disabled', message: 'Checkout is temporarily paused. Please try again shortly.' });
  if (!STRIPE) return res.status(500).json({ error: 'STRIPE_SECRET_KEY not configured' });
  try { _b = await getBinding(); } catch (e) { return sendBindingFailure(res, e); }
  // Codex finding B, CSRF wiring: this route claims a payment group and opens a Stripe Checkout Session.
  // Checked before the session is read. No exemption applies — this route is cookie-authenticated
  // and carries neither a Stripe signature nor a CRON_SECRET.
  if (!requireSameOrigin(req, res, _b)) return;
  let body = {}; try { body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}); } catch (_) {}

  const auth = await requireBrandSession(req, body);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

  let ids = Array.isArray(body.booking_ids) ? body.booking_ids.filter(Boolean) : (body.booking_id ? [body.booking_id] : []);
  ids = [...new Set(ids.map(String))];
  if (!ids.length) return res.status(400).json({ error: 'booking_ids required' });
  const MAX_CART = maxCartSize();
  if (ids.length > MAX_CART) return res.status(400).json({ error: 'too_many_bookings', max: MAX_CART });

  try {
    const idList = ids.map(id => encodeURIComponent(id)).join(',');
    const bookings = await sbJson(`bookings?id=in.(${idList})&select=id,brand_id,retailer_id,venue_id,demo_date,demo_time,brand_name,contact_email,status`);
    if (!Array.isArray(bookings) || bookings.length === 0) return res.status(404).json({ error: 'booking_not_found' });
    // exact requested==returned set (Codex): no silent partial
    if (bookings.length !== ids.length) return res.status(400).json({ error: 'booking_set_mismatch' });

    // Provisional holds: a 'held' (unverified-COI) booking checks out ALONE. Capture/cancel act on
    // the whole PaymentIntent, so a held booking can never share a Session with anything else —
    // mixed or multi-booking held carts are rejected, and manual capture is applied ONLY to a held
    // cart (verified brands keep the immediate charge even with the flag on).
    const heldCount = bookings.filter(b => b.status === 'held').length;
    const provisionalCart = heldCount > 0;
    if (provisionalCart && (heldCount !== bookings.length || bookings.length !== 1)) {
      return res.status(400).json({ error: 'provisional_checkout_single_only' });
    }

    const retailerId = bookings[0].retailer_id;
    const retailers = await sbJson(`retailers?id=eq.${encodeURIComponent(retailerId)}&select=name,slug,stripe_account_id,stripe_charges_enabled,platform_keeps_all`);
    const retailer = Array.isArray(retailers) ? retailers[0] : null;
    if (!retailer) return res.status(404).json({ error: 'retailer_not_found' });
    const platformKeepsAll = !!retailer.platform_keeps_all;
    // R11 strict pilot gate (Codex "fastest safe launch"): the pilot is keeps-all ONLY. All
    // connected/destination-charge checkout is rejected at the handler until the full Connect
    // settlement (exact transfer reversal + fee refund legs) + its live-Stripe evidence are done.
    // This keeps every Connect requirement (proportional refunds, transfer_data.destination
    // validation, three-leg reconciliation) entirely out of the launch surface. The DB command
    // (checkout_claim_group) is gated the same way in 0035 so this cannot be bypassed.
    if (!platformKeepsAll) {
      return res.status(409).json({ error: 'connected_checkout_unavailable_pilot', booking_ids: bookings.map(b => b.id) });
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

    // immutable allocation snapshot -> Stripe line items.
    // R12-P1-4: order MUST be deterministic. PostgREST gives no ordering guarantee, so a retry could
    // otherwise build the same logical request with a different parameter order and Stripe would
    // reject the idempotency-key reuse. Sort by booking_id everywhere (line items, email choice, URLs).
    const allocs = (await sbJson(`payment_allocations?payment_group_id=eq.${encodeURIComponent(gid)}&select=booking_id,customer_amount,platform_fee_amount&order=booking_id.asc`))
      .slice().sort((a, b) => String(a.booking_id).localeCompare(String(b.booking_id)));
    bookings.sort((a, b) => String(a.id).localeCompare(String(b.id)));
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
      // R11-P0-5: do NOT put booking UUIDs in metadata — 14+ ids exceed Stripe's 500-char value
      // limit and break checkout for large carts. Fulfilment resolves allocations from the ledger
      // by payment_group_id; only a non-sensitive count is kept for at-a-glance dashboards.
      'metadata[booking_count]': String(bookings.length),
      success_url: `${_b.siteOrigin}/r/${slug}/?paid=1${provisionalCart ? '&held=1' : ''}&bookings=${bookings.map(b => b.id).join(',')}`,
      cancel_url: `${_b.siteOrigin}/r/${slug}/?cancelled=1`,
      'payment_intent_data[metadata][payment_group_id]': gid,
      'payment_intent_data[metadata][retailer_id]': retailerId,
    };
    // Provisional holds (24h escrow): AUTHORIZE now, capture on confirm/verify within 24h, cancel on
    // expiry. 24h < Stripe's ~7-day auth window, so a manual-capture hold is safe. Gated behind
    // PROVISIONAL_HOLDS_ENABLED; off = immediate charge (current launch behavior). See
    // docs/provisional-holds.md. Manual capture applies ONLY to a held (unverified-COI) cart —
    // verified brands are charged immediately exactly as before.
    if (FLAGS.provisionalHolds && provisionalCart) {
      params['payment_intent_data[capture_method]'] = 'manual';
    }
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

    // R10-P0-3: canonical request hash over the IMMUTABLE money-routing snapshot (sorted allocation
    // legs + charge model + connect + currency). A retry must reproduce this exact request; if the
    // retailer's live config changed after the claim, the hash diverges and register_payment_attempt
    // rejects the fork rather than routing money by the new config.
    const canonical = JSON.stringify({
      gid, currency: 'usd', keepsAll: platformKeepsAll, connect: platformKeepsAll ? null : retailer.stripe_account_id,
      appFee: platformKeepsAll ? 0 : allocs.reduce((s, a) => s + (a.platform_fee_amount || 0), 0),
      legs: [...allocs].sort((a, b) => String(a.booking_id).localeCompare(String(b.booking_id)))
        .map(a => [a.booking_id, a.customer_amount, a.platform_fee_amount]),
    });
    const reqHash = crypto.createHash('sha256').update(canonical).digest('hex');

    // R11-P0-2: the idempotency key must be ATTEMPT-scoped, not group-scoped. A group-scoped key
    // would make a post-expiry retry return the SAME (now expired) Session, permanently locking the
    // cart. `attemptSeq` is the count of prior attempts on this group, so each new attempt gets a
    // distinct key while a genuine in-flight retry of the same attempt still reuses its Session.
    let attemptSeq = 0;
    try {
      const prior = await sbJson(`payment_attempts?payment_group_id=eq.${encodeURIComponent(gid)}&select=id`);
      attemptSeq = Array.isArray(prior) ? prior.length : 0;
    } catch (_) { /* fall back to 0; a duplicate key here only reuses an in-flight session */ }
    const stripeResp = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${STRIPE}`, 'Content-Type': 'application/x-www-form-urlencoded', 'Idempotency-Key': `co-${gid}-${attemptSeq}` },
      body: bodyStr,
    });
    const session = await stripeResp.json();
    if (!stripeResp.ok) { console.error('Stripe session failed:', session && session.error); return res.status(502).json({ error: 'stripe_failed' }); }

    if (session.amount_total != null && Number(session.amount_total) !== Number(totalCents)) {
      console.error('RECONCILE: stripe amount_total', session.amount_total, '!= ledger total', totalCents, 'group', gid);
      return res.status(500).json({ error: 'amount_reconcile_failed' });
    }

    // REQUIRED durable write via RPC (no swallow): register the immutable attempt. Enforces ONE open
    // attempt per group and records session id + canonical hash. A concurrent fork with a different
    // session/hash -> 'attempt_in_progress' (409). Idempotent retry of the SAME session -> reused.
    const pi = typeof session.payment_intent === 'string' ? session.payment_intent : (session.payment_intent && session.payment_intent.id) || null;
    const reg = await rpc('register_payment_attempt', { p_group_id: gid, p_session_id: session.id, p_payment_intent: pi, p_hash: reqHash, p_schema: 1 });
    if (!reg.ok) {
      const msg = String((reg.json && reg.json.message) || reg.text || '');
      if (/attempt_in_progress/.test(msg)) return res.status(409).json({ error: 'attempt_in_progress' });
      console.error('register_payment_attempt failed:', msg);
      return res.status(503).json({ error: 'attempt_persist_failed' });
    }
    // mirror onto bookings for the existing admin UI (best-effort, non-authoritative)
    await Promise.allSettled(allocs.map(a => rest(`bookings?id=eq.${encodeURIComponent(a.booking_id)}`, { method: 'PATCH', body: JSON.stringify({ stripe_session_id: session.id }) })));

    return res.status(200).json({ ok: true, url: session.url, session_id: session.id, payment_group_id: gid, total_cents: totalCents, booking_ids: allocs.map(a => a.booking_id) });
  } catch (e) {
    console.error('checkout error:', (e && e.message) || e);
    return res.status(500).json({ error: 'checkout_error' });
  }
}
