// api/checkout.js, combined-charge checkout backed by the payment ledger (0029).
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
const PLATFORM_FEE_CENTS = 1000;

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
  // Checked before the session is read. No exemption applies, this route is cookie-authenticated
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
    const bookings = await sbJson(`bookings?id=in.(${idList})&select=id,brand_id,retailer_id,venue_id,demo_date,demo_time,brand_name,contact_email,status,fee_waived,booked_by_member_id`);
    if (!Array.isArray(bookings) || bookings.length === 0) return res.status(404).json({ error: 'booking_not_found' });
    // Exact requested set, authority over the WHOLE set and one store, all before any write (Codex round 4, R3-1). The
    // ledger's claim checks ownership again under its locks; this is the handler's own refusal, so nothing below (the
    // held promotion included) can act on a booking the caller does not own. A row count alone is not an exact-set check.
    if (bookings.length !== ids.length || ids.some(id => !bookings.some(b => String(b.id) === String(id)))) return res.status(400).json({ error: 'booking_set_mismatch' });
    if (bookings.some(b => !b.brand_id || String(b.brand_id) !== String(auth.brandId))) return res.status(403).json({ error: 'not_your_booking' });
    // 0097 (Codex BK-4): a booker checks out only bookings attributed to them, every one in the batch.
    if (auth.role === 'booker' && bookings.some(b => !(b.booked_by_member_id && String(b.booked_by_member_id) === String(auth.memberId)))) {
      return res.status(403).json({ error: 'not_your_booking', message: 'You can only pay for demos you booked yourself.' });
    }
    if (new Set(bookings.map(b => String(b.retailer_id))).size !== 1) return res.status(400).json({ error: 'mixed_retailers' });
    // Booking codes (0085): a fee-waived booking is free and confirms through the outbox; it never enters checkout.
    if (bookings.some(b => b.fee_waived === true)) return res.status(400).json({ error: 'booking_fee_waived', message: 'This booking is free, so no payment is needed.' });

    // The store and its gates come BEFORE any held promotion (Codex round 4): a store that cannot be paid online (connected
    // checkout off, or payouts not ready) never has a hold moved to pending_payment for it.
    const retailerId = bookings[0].retailer_id;
    const retailers = await sbJson(`retailers?id=eq.${encodeURIComponent(retailerId)}&select=name,slug,stripe_account_id,stripe_charges_enabled,stripe_payouts_enabled,platform_keeps_all`);
    const retailer = Array.isArray(retailers) ? retailers[0] : null;
    if (!retailer) return res.status(404).json({ error: 'retailer_not_found' });
    const platformKeepsAll = !!retailer.platform_keeps_all;
    // Connected (destination-charge) checkout, 0116 / CONNECTED_CHECKOUT_ENABLED (2026-10-30). Before 0116 the
    // pilot was keeps-all ONLY (Codex R11 "fastest safe launch"): every non-keeps-all checkout was refused here
    // AND in checkout_claim_group. The flag keeps that refusal as the default. With the flag exactly "true", a
    // non-keeps-all store is accepted only when it can actually receive the money: a connected account id is
    // on the row and Stripe has reported charges enabled (api/stripe-webhook.js account.updated, or the status
    // action in api/stripe.js). A store that is not there yet is refused 409 store_not_payout_ready before any
    // claim, so no payment group is ever created for an account Stripe would reject as the destination.
    if (!platformKeepsAll) {
      if (!FLAGS.connectedCheckout) {
        return res.status(409).json({ error: 'connected_checkout_unavailable_pilot', booking_ids: bookings.map(b => b.id) });
      }
      // Payout readiness (Codex review, bounded condition): charges enabled alone is not readiness. Both booleans
      // come from Stripe's own account object (account.updated, or the admin's connect-status refresh), and the
      // account.updated handler marks a store 'active' only with the transfers capability live as well.
      const acct = typeof retailer.stripe_account_id === 'string' ? retailer.stripe_account_id.trim() : '';
      if (!acct || retailer.stripe_charges_enabled !== true || retailer.stripe_payouts_enabled !== true) {
        return res.status(409).json({ error: 'store_not_payout_ready', message: 'This store has not finished setting up payouts yet, so it cannot be paid online. Please contact the store.', booking_ids: bookings.map(b => b.id) });
      }
    }

    // Provisional holds: a 'held' (unverified-COI) booking checks out ALONE. Capture/cancel act on
    // the whole PaymentIntent, so a held booking can never share a Session with anything else,
    // mixed or multi-booking held carts are rejected, and manual capture is applied ONLY to a held
    // cart (verified brands keep the immediate charge even with the flag on).
    // Route forward for a held booking after COI approval (Codex connected-checkout review, bounded condition; rewritten
    // for round 4, R3-1 and R3-2): a brand books 'held' while its certificate is unreviewed; once the certificate is
    // approved and covers the demo date, the booking is an ordinary unpaid booking and is paid like one. The decision
    // which held bookings the owner's certificate covers is the shared policy (api/_coi-policy.js) applied to the
    // AUTHENTICATED brand's row, which is the owner of every booking here (checked above and again in the RPC). The move
    // itself is promote_held_bookings (0118): under the same row locks checkout_claim_group takes, it refuses the whole
    // set unless every booking is this brand's (and this booker's), and promotes only a booking that is still held and
    // unpaid, never authorized, not expired and in no payment group. Its fresh rows replace what was read first; a
    // failed call is a controlled rejection, never a continuation on stale objects.
    if (bookings.some(b => b.status === 'held')) {
      let covered = [];
      try {
        const br = await sbJson(`brands?id=eq.${encodeURIComponent(auth.brandId)}&select=default_coi_url,default_coi_expires,coi_verification_status`);
        const brand = (Array.isArray(br) && br[0]) || null;
        const { coiCovered } = await import('./_coi-coverage.js');
        if (brand) covered = bookings.filter(b => b.status === 'held' && coiCovered(brand, b.demo_date).covered).map(b => String(b.id));
      } catch (e) { console.warn('COI read for the held route forward failed; nothing is promoted:', (e && e.message) || e); covered = []; }
      if (covered.length) {
        const moved = await rpc('promote_held_bookings', { p_brand_id: auth.brandId, p_member_id: auth.memberId || null, p_role: auth.role || null, p_booking_ids: ids, p_covered_booking_ids: covered });
        if (!moved.ok) {
          const msg = String((moved.json && moved.json.message) || moved.text || '');
          if (/not_your_booking/.test(msg)) return res.status(403).json({ error: 'not_your_booking' });
          if (/booking_set_mismatch/.test(msg)) return res.status(400).json({ error: 'booking_set_mismatch' });
          if (/mixed_retailers/.test(msg)) return res.status(400).json({ error: 'mixed_retailers' });
          console.error('promote_held_bookings failed:', msg);
          return res.status(503).json({ error: 'held_recheck_failed', message: 'Could not confirm this booking just now. Please try again.' });
        }
        const fresh = Array.isArray(moved.json) ? moved.json : [];
        if (fresh.length !== ids.length || fresh.some(r => !r || !r.id || !ids.includes(String(r.id)))) return res.status(503).json({ error: 'held_recheck_failed', message: 'Could not confirm this booking just now. Please try again.' });
        bookings.splice(0, bookings.length, ...fresh);
      }
    }
    const heldCount = bookings.filter(b => b.status === 'held').length;
    const provisionalCart = heldCount > 0;
    if (provisionalCart && (heldCount !== bookings.length || bookings.length !== 1)) {
      return res.status(400).json({ error: 'provisional_checkout_single_only' });
    }
    // Flag-off rollback guard: if PROVISIONAL_HOLDS_ENABLED is flipped off while a 'held' booking
    // exists, checking it out here would take the IMMEDIATE-charge path (no capture_method=manual),
    // charging the card in full, but apply_verified_payment then freezes the group (a held+unpaid
    // booking is not flippable), so the customer is charged with no demo. Refuse instead; the hold
    // can only ever settle through the capture/release paths, which don't gate on the flag.
    if (provisionalCart && !FLAGS.provisionalHolds) {
      return res.status(409).json({ error: 'provisional_holds_disabled', message: 'This held booking can\'t be paid right now. Please contact the store.' });
    }

    // Provisional holds at a connected store are NOT supported yet (revenue split round 2, 2026-10-30). Provisional
    // holds are ON in production: a brand without a verified COI books 'held' and would check out with a manual-
    // capture destination charge. apply_verified_authorization still refuses a connected group (it opens a
    // contradiction case and applies nothing), so the authorization would stand on Stripe with the hold unapplied.
    // Refused here, before any claim and before Stripe, until the authorize / capture / release paths are
    // rehearsed for a connected store in their own round. The brand's remedy is the same as for any held booking:
    // get the COI on file, or contact the store.
    if (!platformKeepsAll && provisionalCart) {
      return res.status(409).json({ error: 'store_requires_insurance_on_file', message: 'This store can only take bookings from brands with insurance on file. Upload your certificate of insurance, or contact the store.', booking_ids: bookings.map(b => b.id) });
    }

    // ---- ATOMIC claim + immutable allocations (ownership/payable/venue-fee enforced in the fn) ----
    const claim = await rpc('checkout_claim_group', {
      p_brand_id: auth.brandId, p_retailer_id: retailerId, p_booking_ids: ids,
      p_platform_keeps_all: platformKeepsAll,
      p_connect_account_id: platformKeepsAll ? null : retailer.stripe_account_id,
      p_platform_fee_cents: PLATFORM_FEE_CENTS,
      // 0118 (R3-2): the capture-mode decision above is asserted inside the claim, under the booking locks
      p_provisional: provisionalCart,
    });
    if (!claim.ok) {
      const msg = String((claim.json && claim.json.message) || claim.text || '');
      if (/not_your_booking/.test(msg)) return res.status(403).json({ error: 'not_your_booking' });
      if (/mixed_retailers/.test(msg)) return res.status(400).json({ error: 'mixed_retailers' });
      if (/not_payable_state/.test(msg)) return res.status(409).json({ error: 'not_payable_state' });
      if (/capture_mode_stale/.test(msg)) return res.status(409).json({ error: 'booking_state_changed', message: 'This booking changed while you were paying. Please refresh the page and try again.' });
      if (/connected_hold_unsupported/.test(msg)) return res.status(409).json({ error: 'store_requires_insurance_on_file', message: 'This store can only take bookings from brands with insurance on file. Upload your certificate of insurance, or contact the store.' });
      if (/provisional_checkout_single_only/.test(msg)) return res.status(400).json({ error: 'provisional_checkout_single_only' });
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
      // R11-P0-5: do NOT put booking UUIDs in metadata, 14+ ids exceed Stripe's 500-char value
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
    // docs/provisional-holds.md. Manual capture applies ONLY to a held (unverified-COI) cart,
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

    // Round 7 (Codex "next action 2", the expired-session retry): the LEDGER reserves the attempt BEFORE any provider
    // call. reserve_payment_attempt (0120) answers under the group lock with the group's live attempt: an OPEN attempt,
    // whose session's CURRENT state on Stripe then decides (open: refused, the brand already holds that link; complete:
    // the payment is being confirmed; expired: recorded as expired through the same path the webhook uses, then a new
    // generation); a RESERVED attempt (simultaneous retries get the same reservation and therefore the same key); or a
    // new reservation with the next generation number. The Checkout Session is created under a key that names the
    // reservation (stable across retries, never random, never derived from a count the handler read). A session that
    // comes back unusable (an idempotent replay of one that expired or completed since) is recorded as the
    // reservation's terminal outcome, with the session id, before the handler advances to a new generation. A failed
    // ledger read fails the checkout closed; nothing falls back to a guessed sequence. The ledger's one-live-attempt
    // index means a brand can never hold two payable links for one cart.
    const readSession = async (sid) => {
      try {
        const r = await fetch(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sid)}`, { headers: { Authorization: `Bearer ${STRIPE}` } });
        let j = null; try { j = await r.json(); } catch (_) { j = null; }
        return r.ok && j && j.id ? { ok: true, session: j } : { ok: false, status: r.status, error: j && j.error && j.error.message };
      } catch (e) { return { ok: false, status: 0, error: String((e && e.message) || e) }; }
    };
    const reserve = async () => {
      const rv = await rpc('reserve_payment_attempt', { p_group_id: gid, p_hash: reqHash, p_schema: 1 });
      if (!rv.ok) { const msg = String((rv.json && rv.json.message) || rv.text || ''); return { ok: false, inProgress: /attempt_in_progress/.test(msg), msg }; }
      const v = Array.isArray(rv.json) ? rv.json[0] : rv.json;
      return v && v.attempt_id ? { ok: true, row: v } : { ok: false, inProgress: false, msg: 'no reservation row' };
    };
    const reserveFailure = (rsv) => {
      if (rsv.inProgress) return res.status(409).json({ error: 'attempt_in_progress' });
      console.error('reserve_payment_attempt failed:', rsv.msg);
      return res.status(503).json({ error: 'attempt_reserve_failed', message: 'Could not start the payment just now. Please try again.' });
    };
    let rsv = await reserve();
    if (!rsv.ok) return reserveFailure(rsv);
    if (rsv.row.outcome === 'open') {
      const cur = await readSession(rsv.row.session_id);
      if (!cur.ok) return res.status(503).json({ error: 'provider_unreachable', message: 'Could not confirm your payment session just now. Please try again.' });
      const st = String(cur.session.status || '');
      if (st === 'complete') return res.status(409).json({ error: 'payment_pending', message: 'This payment is being confirmed. Please refresh in a moment.' });
      if (st === 'open') return res.status(409).json({ error: 'attempt_in_progress' });
      if (st !== 'expired') return res.status(503).json({ error: 'provider_unreachable', message: 'Could not confirm your payment session just now. Please try again.' });
      const ex = await rpc('expire_payment_attempt', { p_session_id: rsv.row.session_id });
      if (!ex.ok) return res.status(503).json({ error: 'attempt_expire_failed', message: 'Could not refresh your payment session just now. Please try again.' });
      rsv = await reserve();
      if (!rsv.ok) return reserveFailure(rsv);
      if (rsv.row.outcome !== 'reserved') return res.status(409).json({ error: 'attempt_in_progress' });
    }
    let session = null;
    let attemptId = rsv.row.attempt_id;
    for (let advance = 0; advance < 2 && !session; advance++) {
      const stripeResp = await fetch('https://api.stripe.com/v1/checkout/sessions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${STRIPE}`, 'Content-Type': 'application/x-www-form-urlencoded', 'Idempotency-Key': `co-${gid}-${attemptId}` },
        body: bodyStr,
      });
      let created = null; try { created = await stripeResp.json(); } catch (_) { created = null; }
      if (!stripeResp.ok || !created || !created.id) { console.error('Stripe session failed:', created && created.error); return res.status(502).json({ error: 'stripe_failed' }); }
      const usable = String(created.status || '') === 'open' && String(created.payment_status || '') === 'unpaid';
      const amountOk = created.amount_total == null || Number(created.amount_total) === Number(totalCents);
      if (usable && amountOk) { session = created; break; }
      // not payable: the reservation ends here, with the provider object recorded, before any new generation
      const reason = !usable ? `session_unusable:${created.status}/${created.payment_status}` : 'amount_reconcile_failed';
      const failed = await rpc('fail_payment_attempt', { p_attempt_id: attemptId, p_session_id: created.id, p_error: reason });
      if (!failed.ok) return res.status(503).json({ error: 'attempt_persist_failed' });
      if (!amountOk) { console.error('RECONCILE: stripe amount_total', created.amount_total, '!= ledger total', totalCents, 'group', gid); return res.status(500).json({ error: 'amount_reconcile_failed' }); }
      rsv = await reserve();
      if (!rsv.ok) return reserveFailure(rsv);
      if (rsv.row.outcome !== 'reserved') return res.status(409).json({ error: 'attempt_in_progress' });
      attemptId = rsv.row.attempt_id;
    }
    if (!session) return res.status(503).json({ error: 'session_unusable', message: 'Could not open a payment session just now. Please try again.' });

    // REQUIRED durable write via RPC (no swallow): bind the session to the reservation (status open) and record the
    // canonical hash. A fork against an open attempt (a different session or hash) is still 'attempt_in_progress'.
    // If this write fails after Stripe created the session, the reservation stays and the next retry reuses its key, so
    // Stripe replays the same session and it is bound then; nothing is ever handed out unregistered.
    const pi = typeof session.payment_intent === 'string' ? session.payment_intent : (session.payment_intent && session.payment_intent.id) || null;
    const reg = await rpc('register_payment_attempt', { p_group_id: gid, p_session_id: session.id, p_payment_intent: pi, p_hash: reqHash, p_schema: 1 });
    if (!reg.ok) {
      const msg = String((reg.json && reg.json.message) || reg.text || '');
      if (/attempt_in_progress/.test(msg)) return res.status(409).json({ error: 'attempt_in_progress' });
      console.error('register_payment_attempt failed:', msg);
      return res.status(503).json({ error: 'attempt_persist_failed' });
    }
    // 0103 (Codex shipped-release finding 1): record WHO initiated this payment attempt, from the authenticated
    // session, on the durable attempt row. The booker receipt exception is decided from the PAID attempt's payer,
    // never from who booked or from the booking's contact address. If this write fails the payer stays unknown and
    // the receipt stays owner-only, which is the safe default.
    try {
      const payer = { payer_member_id: auth.memberId || null, payer_email: String(auth.email || '').toLowerCase() || null, payer_role: auth.role === 'booker' ? 'booker' : (auth.role === 'owner' ? 'owner' : null) };
      const pr = await rest(`payment_attempts?stripe_checkout_session_id=eq.${encodeURIComponent(session.id)}&payment_group_id=eq.${encodeURIComponent(gid)}`, { method: 'PATCH', body: JSON.stringify(payer) });
      if (!pr || !pr.ok) console.warn('payment attempt payer not recorded (receipt stays owner-only):', pr && pr.status);
    } catch (e) { console.warn('payment attempt payer not recorded (receipt stays owner-only):', e && e.message); }
    // mirror onto bookings for the existing admin UI (best-effort, non-authoritative)
    await Promise.allSettled(allocs.map(a => rest(`bookings?id=eq.${encodeURIComponent(a.booking_id)}`, { method: 'PATCH', body: JSON.stringify({ stripe_session_id: session.id }) })));

    return res.status(200).json({ ok: true, url: session.url, session_id: session.id, payment_group_id: gid, total_cents: totalCents, booking_ids: allocs.map(a => a.booking_id) });
  } catch (e) {
    console.error('checkout error:', (e && e.message) || e);
    return res.status(500).json({ error: 'checkout_error' });
  }
}
