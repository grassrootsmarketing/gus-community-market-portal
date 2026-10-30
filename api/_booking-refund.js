// api/_booking-refund.js, the ledger-backed booking refund, shared (2026-10-16).
//
// Lifted verbatim from api/booking-action.js (R2-03, R10-P1-2/P0-4, DH-04) so that the retailer's
// cancel/decline path and the demo-move settlement (api/_booking-moves.js: a brand that cannot make a
// moved demo, or one that never answered) refund through ONE implementation. Behaviour is unchanged:
//   * refund_reserve_cas reserves the exact allocation amount under a per-(booking, operation) key and
//     returns the canonical request (a retry returns the SAME request, never a second reservation);
//   * the Stripe refund is submitted with the durable idempotency key; a submit failure leaves the
//     reservation 'failed_retryable' for the leased refund worker;
//   * the ledger converges through the verified apply_refund_event RPC; the booking's payment_status is
//     flipped only by a verified success (webhook / worker), never optimistically here.
// Every function takes the validated binding; nothing here reads process.env for a key.

async function sbRaw(b, path, opts = {}) {
  const headers = { apikey: b.serviceKey, Authorization: `Bearer ${b.serviceKey}`, 'Content-Type': 'application/json', Prefer: 'return=representation', ...(opts.headers || {}) };
  const r = await fetch(`${b.supabaseUrl}/rest/v1/${path}`, { ...opts, headers });
  const text = await r.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch (_) {}
  if (!r.ok) throw new Error((json && json.message) || text || `HTTP ${r.status}`);
  return json;
}
export async function sbRpc(b, fn, args) {
  const r = await fetch(`${b.supabaseUrl}/rest/v1/rpc/${fn}`, {
    method: 'POST', headers: { apikey: b.serviceKey, Authorization: `Bearer ${b.serviceKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  const text = await r.text();
  if (!r.ok) throw new Error('rpc ' + fn + ' ' + r.status + ' ' + text.slice(0, 200));
  try { return text ? JSON.parse(text) : null; } catch (_) { return null; }
}

// Codex C3: minor units, normalised ONCE. An integer number, or a string of digits, becomes a positive safe
// integer; anything else (null, zero, negative, fractional, nonfinite, unsafe, other strings) is null.
export function normalizeMinorUnits(v) {
  let n = null;
  if (typeof v === 'number') n = v;
  else if (typeof v === 'string' && /^\d{1,15}$/.test(v.trim())) n = Number(v.trim());
  else return null;
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

export async function refundPaymentIntent(b, paymentIntentId, opts = {}) {
  const key = (b && b.stripeKey) || null;
  if (!key) return { ok: false, error: 'STRIPE_SECRET_KEY not configured' };
  if (!paymentIntentId) return { ok: false, error: 'payment_intent_id required' };
  const params = new URLSearchParams();
  params.set('payment_intent', paymentIntentId);
  // DH-04: when several bookings share one PaymentIntent (batch checkout), refund only this booking's
  // share. Codex C3: the ledger-backed path (requireAmount) can never omit the amount; an invalid amount
  // is refused before any provider call. The amount-less form (Stripe refunds the whole intent) is only
  // reachable when a caller deliberately omits requireAmount AND the amount; no caller does today.
  const amount = normalizeMinorUnits(opts.amountCents);
  if (opts.requireAmount && amount == null) return { ok: false, error: 'amount_invalid', detail: { amount: opts.amountCents == null ? null : String(opts.amountCents) } };
  if (amount != null) params.set('amount', String(amount));
  // Keeps-all retailers take a plain platform charge: no transfer, no application fee. Sending
  // reverse_transfer / refund_application_fee on those charges makes Stripe reject the refund outright.
  // Connected (0117, Codex CC-1): the transfer reversal follows the refund (reverse_transfer), which is exactly the
  // booking's entitlement on an on_behalf_of destination charge. The application fee is NOT refunded through the
  // proportional flag any more (strategy 2): Stripe would return the fee in proportion to the WHOLE charge, which is
  // wrong for an unequal-price cart; settleConnectRefund() creates the exact allocation-derived fee refund instead.
  // A request reserved before 0117 (strategy 1) keeps the flag: its payload under its idempotency key never changes.
  if (!opts.keepsAll) {
    params.set('reverse_transfer', 'true');
    if (Number(opts.strategy == null ? 1 : opts.strategy) === 1) params.set('refund_application_fee', 'true');
  }
  if (opts.reason) params.set('reason', opts.reason);
  if (opts.metadata) {
    for (const [k, v] of Object.entries(opts.metadata)) params.set('metadata[' + k + ']', String(v));
  }
  try {
    const headers = { Authorization: 'Bearer ' + key, 'Content-Type': 'application/x-www-form-urlencoded' };
    // R2-03: idempotency key so two concurrent requests can't double-refund the same booking.
    if (opts.idempotencyKey) headers['Idempotency-Key'] = String(opts.idempotencyKey).slice(0, 255);
    const r = await fetch('https://api.stripe.com/v1/refunds', { method: 'POST', headers, body: params.toString() });
    const json = await r.json();
    if (!r.ok) return { ok: false, error: (json && json.error && json.error.message) || ('HTTP ' + r.status), detail: json };
    return { ok: true, refund_id: json.id, amount: json.amount, refund: json };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

// Connected settlement (Codex review of 8f43360, 2026-10-30: CC-1 exact per-allocation fee refunds, CC-2 recovery that
// does not depend on webhooks or on the customer leg's status, CC-3 evidence that is bound and verified before it is
// recorded). A refund of a destination charge is three legs on Stripe: the customer refund (re_), the transfer reversal
// (trr_) and the application fee refund (fr_). settleConnectRefund() takes ONE refund request by id and brings its two
// Stripe-side legs to 'complete' through the verified RPC record_settlement_leg (0117), or reports why it could not.
//
// Strategy 2 (every connected request reserved after 0117): the customer refund was submitted with reverse_transfer
// only, so Stripe reversed the booking's own entitlement; the application fee refund is created HERE, through the
// fee-refund API, for the allocation-derived amount the request expects, under the request's own durable idempotency
// key (fee_refund_idempotency_key, set at reservation and never changed), with metadata naming the request. Intent is
// recorded (settlement_mark_fee_intent) before the provider call; on a later attempt the fee's refund list is searched
// for that request id BEFORE any new call, so an ambiguous earlier response can never turn into a second refund. A zero
// expected fee is a satisfied leg with no provider call.
//
// Strategy 1 (requests reserved before 0117, none in production): the proportional fee refund Stripe created on the
// customer refund is matched on the fee's refund list by amount, inside a time window, excluding ids another request
// holds; anything but exactly one candidate is an unresolved exception, never an invented association.
//
// Every provider object is retrieved and compared with the ledger before it is recorded: the refund against the
// request (amount, currency, PaymentIntent, charge, metadata), the reversal against the group's transfer and the
// expected amount, the fee refund against the group's application fee, the expected amount and the currency. The RPC
// refuses conflicting ids, status regressions and amount or currency mismatches; those become a settlement exception
// (a deduplicated reconciliation case, the request stops being claimed). Provider or database errors are 'retry'
// outcomes for the leased settlement queue in api/refund-worker.js.
export function stripeIdOf(v) { return v == null ? null : (typeof v === 'string' ? v : (typeof v === 'object' && v.id) || null); }

async function stripeCall(b, method, path, { form = null, idempotencyKey = null } = {}) {
  const headers = { Authorization: 'Bearer ' + b.stripeKey };
  if (form) headers['Content-Type'] = 'application/x-www-form-urlencoded';
  if (idempotencyKey) headers['Idempotency-Key'] = String(idempotencyKey).slice(0, 255);
  try {
    const r = await fetch('https://api.stripe.com' + path, { method, headers, body: form ? new URLSearchParams(form).toString() : undefined });
    const text = await r.text();
    let json = null; try { json = text ? JSON.parse(text) : null; } catch (_) {}
    if (r.ok) return { ok: true, status: r.status, json };
    const msg = (json && json.error && json.error.message) || ('HTTP ' + r.status);
    const type = json && json.error && json.error.type;
    return { ok: false, status: r.status, json, error: msg, type, transient: r.status === 429 || r.status >= 500 };
  } catch (e) {
    return { ok: false, status: 0, json: null, error: String((e && e.message) || e), transient: true };
  }
}

// Paginated read of an application fee's refunds. A read that fails part way is a failure (never a short list), and so
// is one that cannot be proven complete (Codex round 4, small correction 2): a malformed page, or the page cap reached
// with has_more still true, returns a transient failure, because a negative answer from this list is what authorizes
// a new fee refund.
async function listFeeRefunds(b, feeId) {
  const out = []; let after = null; let complete = false;
  for (let page = 0; page < 20; page++) {
    const r = await stripeCall(b, 'GET', `/v1/application_fees/${encodeURIComponent(feeId)}/refunds?limit=100${after ? '&starting_after=' + encodeURIComponent(after) : ''}`);
    if (!r.ok) return { ok: false, error: r.error, transient: r.transient };
    if (!r.json || !Array.isArray(r.json.data)) return { ok: false, error: 'malformed_fee_refund_list', transient: true };
    out.push(...r.json.data);
    if (!r.json.has_more || !r.json.data.length) { complete = true; break; }
    after = r.json.data[r.json.data.length - 1].id;
  }
  if (!complete) return { ok: false, error: 'incomplete_fee_refund_list', transient: true };
  return { ok: true, data: out };
}

const SETTLE_SELECT = 'id,amount,currency,status,customer_refund_status,settlement_status,settlement_strategy,stripe_refund_id,expected_transfer_reversal_amount,expected_fee_refund_amount,stripe_transfer_reversal_id,stripe_fee_refund_id,transfer_reversal_status,fee_refund_status,fee_refund_idempotency_key,fee_refund_intent_at,payment_allocation_id,booking_id,settlement_attempts';

export async function settleConnectRefund(b, requestId) {
  const retry = (reason, extra = {}) => ({ outcome: 'retry', reason, ...extra });
  const exception = async (reason, details) => {
    try { await sbRpc(b, 'settlement_mark_exception', { p_request_id: requestId, p_reason: reason, p_details: details || {} }); } catch (e) { return retry('db_mark_exception', { error: String((e && e.message) || e).slice(0, 160), wanted_exception: reason }); }
    return { outcome: 'exception', reason, details };
  };
  const recordLeg = async (leg, id, status, amount, currency) => {
    try {
      const r = await sbRpc(b, 'record_settlement_leg', { p_request_id: requestId, p_leg: leg, p_stripe_id: id, p_status: status, p_amount: amount, p_currency: currency });
      return { ok: true, outcome: r && r.outcome };
    } catch (e) {
      const msg = String((e && e.message) || e);
      if (/settlement_leg_(conflict|mismatch|regress)/.test(msg)) return { ok: false, conflict: true, error: msg.slice(0, 200) };
      return { ok: false, conflict: false, error: msg.slice(0, 200) };
    }
  };
  if (!b || !b.stripeKey) return retry('no_stripe_key');
  let req;
  try { const rows = await sbRaw(b, `refund_requests?id=eq.${encodeURIComponent(requestId)}&select=${SETTLE_SELECT}`); req = Array.isArray(rows) ? rows[0] : null; }
  catch (e) { return retry('db_read_request', { error: String((e && e.message) || e).slice(0, 160) }); }
  if (!req) return { outcome: 'no_request' };
  if (req.settlement_status === 'complete') return { outcome: 'already_complete' };
  if (req.settlement_status === 'not_required') return { outcome: 'not_required' };
  if (req.settlement_status === 'exception') return { outcome: 'exception', reason: 'already_exception' };
  if (req.status !== 'succeeded' || req.customer_refund_status !== 'succeeded' || !req.stripe_refund_id) return { outcome: 'not_ready', reason: 'customer_leg_not_succeeded' };

  let alloc, grp, feeSum;
  try {
    const allocs = await sbRaw(b, `payment_allocations?id=eq.${encodeURIComponent(req.payment_allocation_id)}&select=id,booking_id,payment_group_id,platform_fee_amount`);
    alloc = Array.isArray(allocs) ? allocs[0] : null;
    if (!alloc) return await exception('allocation_missing', { payment_allocation_id: req.payment_allocation_id });
    const grps = await sbRaw(b, `payment_groups?id=eq.${encodeURIComponent(alloc.payment_group_id)}&select=id,platform_keeps_all,connect_account_id,currency,stripe_checkout_session_id,stripe_payment_intent_id,stripe_charge_id,stripe_transfer_id,stripe_application_fee_id,total_customer_amount`);
    grp = Array.isArray(grps) ? grps[0] : null;
    if (!grp) return await exception('group_missing', { payment_group_id: alloc.payment_group_id });
    const sums = await sbRaw(b, `payment_allocations?payment_group_id=eq.${encodeURIComponent(grp.id)}&select=platform_fee_amount`);
    feeSum = (Array.isArray(sums) ? sums : []).reduce((s, a) => s + (a.platform_fee_amount || 0), 0);
  } catch (e) { return retry('db_read_group', { error: String((e && e.message) || e).slice(0, 160) }); }
  if (grp.platform_keeps_all !== false) return { outcome: 'not_required', reason: 'keeps_all_group' };

  // ---- the customer refund, bound to the request and the group ----
  const rf = await stripeCall(b, 'GET', `/v1/refunds/${encodeURIComponent(req.stripe_refund_id)}`);
  if (!rf.ok) return rf.status === 404 ? await exception('refund_not_found_on_stripe', { refund: req.stripe_refund_id }) : retry('stripe_get_refund', { error: rf.error });
  const refund = rf.json;
  if (String(refund.status || '').toLowerCase() !== 'succeeded') return retry('refund_not_succeeded_on_stripe', { stripe_status: refund.status });
  const metaReq = refund.metadata && refund.metadata.refund_request_id;
  if (refund.amount !== req.amount || String(refund.currency || '').toLowerCase() !== String(req.currency || '').toLowerCase()
      || stripeIdOf(refund.payment_intent) !== grp.stripe_payment_intent_id || stripeIdOf(refund.charge) !== grp.stripe_charge_id
      || (metaReq && String(metaReq) !== String(req.id))) {
    return await exception('refund_binding_mismatch', { refund: refund.id, refund_amount: refund.amount, refund_currency: refund.currency, refund_pi: stripeIdOf(refund.payment_intent), refund_charge: stripeIdOf(refund.charge), refund_meta_request: metaReq || null, request_amount: req.amount, request_currency: req.currency, group_pi: grp.stripe_payment_intent_id, group_charge: grp.stripe_charge_id });
  }

  // ---- the group's transfer and application fee ids, filled from validated provider state when still missing ----
  // A zero-fee destination charge carries no application fee object (Codex round 4, small correction 1): the fee id is
  // required only when the allocations' fee sum is positive; the transfer id, and its reversal, are verified regardless.
  const feeIdRequired = feeSum > 0;
  if (!grp.stripe_transfer_id || (!grp.stripe_application_fee_id && feeIdRequired)) {
    const ch = await stripeCall(b, 'GET', `/v1/charges/${encodeURIComponent(grp.stripe_charge_id)}`);
    if (!ch.ok) return retry('stripe_get_charge', { error: ch.error });
    const charge = ch.json;
    const dest = stripeIdOf(charge.destination) || (charge.transfer_data && stripeIdOf(charge.transfer_data.destination)) || null;
    if (stripeIdOf(charge.payment_intent) !== grp.stripe_payment_intent_id || dest !== grp.connect_account_id || (charge.application_fee_amount == null ? 0 : charge.application_fee_amount) !== feeSum) {
      return await exception('group_charge_mismatch', { charge: charge.id, charge_pi: stripeIdOf(charge.payment_intent), destination: dest, application_fee_amount: charge.application_fee_amount, expected_destination: grp.connect_account_id, expected_fee: feeSum });
    }
    const trId = stripeIdOf(charge.transfer), feeId = stripeIdOf(charge.application_fee);
    if (!trId || (!feeId && feeIdRequired)) return retry('group_ids_not_on_charge_yet');
    try {
      const applied = await sbRpc(b, 'apply_verified_payment', {
        p_session_id: grp.stripe_checkout_session_id, p_payment_intent: grp.stripe_payment_intent_id, p_charge: charge.id,
        p_amount: grp.total_customer_amount, p_currency: grp.currency, p_connect_dest: dest, p_on_behalf_of: stripeIdOf(charge.on_behalf_of) || dest,
        p_application_fee: charge.application_fee_amount == null ? 0 : charge.application_fee_amount, p_transfer_id: trId, p_fee_id: feeId || null,
      });
      const val = Array.isArray(applied) ? applied[0] : applied;
      if (val && val.outcome === 'contradiction') return await exception('group_id_fill_contradiction', { reason: val.reason, case_id: val.case_id });
      const again = await sbRaw(b, `payment_groups?id=eq.${encodeURIComponent(grp.id)}&select=stripe_transfer_id,stripe_application_fee_id`);
      grp.stripe_transfer_id = again[0] && again[0].stripe_transfer_id; grp.stripe_application_fee_id = again[0] && again[0].stripe_application_fee_id;
    } catch (e) { return retry('db_fill_group_ids', { error: String((e && e.message) || e).slice(0, 160) }); }
    if (!grp.stripe_transfer_id || (!grp.stripe_application_fee_id && feeIdRequired)) return retry('group_ids_still_missing');
  }

  const legs = {};
  // ---- leg: the transfer reversal, verified against the group's transfer and the expected amount ----
  if (req.transfer_reversal_status !== 'succeeded') {
    const trrId = stripeIdOf(refund.transfer_reversal) || req.stripe_transfer_reversal_id;
    if (!trrId) return retry('transfer_reversal_missing_on_refund');
    const tr = await stripeCall(b, 'GET', `/v1/transfers/${encodeURIComponent(grp.stripe_transfer_id)}/reversals/${encodeURIComponent(trrId)}`);
    if (!tr.ok) return tr.status === 404 ? await exception('transfer_reversal_not_under_group_transfer', { reversal: trrId, transfer: grp.stripe_transfer_id }) : retry('stripe_get_reversal', { error: tr.error });
    const rev = tr.json;
    if (stripeIdOf(rev.transfer) !== grp.stripe_transfer_id || rev.amount !== req.expected_transfer_reversal_amount || String(rev.currency || '').toLowerCase() !== String(req.currency).toLowerCase()) {
      return await exception('transfer_reversal_mismatch', { reversal: rev.id, reversal_transfer: stripeIdOf(rev.transfer), amount: rev.amount, currency: rev.currency, expected_amount: req.expected_transfer_reversal_amount, group_transfer: grp.stripe_transfer_id });
    }
    const rec = await recordLeg('transfer_reversal', rev.id, 'succeeded', rev.amount, rev.currency);
    if (!rec.ok) return rec.conflict ? await exception('transfer_reversal_conflict', { reversal: rev.id, error: rec.error }) : retry('db_record_reversal', { error: rec.error });
    legs.transfer_reversal = { id: rev.id, amount: rev.amount, rpc: rec.outcome };
  } else legs.transfer_reversal = { id: req.stripe_transfer_reversal_id, rpc: 'already_recorded' };

  // ---- leg: the application fee refund ----
  if (!['succeeded', 'not_required'].includes(req.fee_refund_status || '')) {
    const expected = req.expected_fee_refund_amount == null ? 0 : req.expected_fee_refund_amount;
    const feeId = grp.stripe_application_fee_id;
    if (expected > 0 && !feeId) return await exception('fee_refund_expected_without_fee_object', { expected_amount: expected, fee_sum: feeSum });
    const verifyAndRecord = async (fr) => {
      if (stripeIdOf(fr.fee) !== feeId || fr.amount !== expected || String(fr.currency || '').toLowerCase() !== String(req.currency).toLowerCase()) {
        return await exception('fee_refund_mismatch', { fee_refund: fr.id, fee: stripeIdOf(fr.fee), amount: fr.amount, currency: fr.currency, expected_amount: expected, group_fee: feeId });
      }
      const rec = await recordLeg('fee_refund', fr.id, 'succeeded', fr.amount, fr.currency);
      if (!rec.ok) return rec.conflict ? await exception('fee_refund_conflict', { fee_refund: fr.id, error: rec.error }) : retry('db_record_fee_refund', { error: rec.error });
      legs.fee_refund = { id: fr.id, amount: fr.amount, rpc: rec.outcome };
      return null;
    };
    if (expected === 0) {
      const rec = await recordLeg('fee_refund', null, 'not_required', 0, req.currency);
      if (!rec.ok) return rec.conflict ? await exception('fee_refund_conflict', { error: rec.error }) : retry('db_record_fee_refund', { error: rec.error });
      legs.fee_refund = { id: null, amount: 0, rpc: rec.outcome };
    } else if (req.stripe_fee_refund_id) {
      const g = await stripeCall(b, 'GET', `/v1/application_fees/${encodeURIComponent(feeId)}/refunds/${encodeURIComponent(req.stripe_fee_refund_id)}`);
      if (!g.ok) return g.status === 404 ? await exception('fee_refund_not_under_group_fee', { fee_refund: req.stripe_fee_refund_id, fee: feeId }) : retry('stripe_get_fee_refund', { error: g.error });
      const bad = await verifyAndRecord(g.json); if (bad) return bad;
    } else if (Number(req.settlement_strategy) === 2) {
      if (!req.fee_refund_idempotency_key) return await exception('fee_refund_key_missing', {});
      let intent;
      try { intent = await sbRpc(b, 'settlement_mark_fee_intent', { p_request_id: req.id }); } catch (e) { return retry('db_mark_intent', { error: String((e && e.message) || e).slice(0, 160) }); }
      let fr = null;
      if (intent && intent.first === false) {
        // an earlier attempt may have reached Stripe: look before creating, by the metadata this request stamps
        const list = await listFeeRefunds(b, feeId);
        if (!list.ok) return retry('stripe_list_fee_refunds', { error: list.error });
        fr = list.data.find(x => x.metadata && String(x.metadata.refund_request_id) === String(req.id)) || null;
      }
      if (!fr) {
        const c = await stripeCall(b, 'POST', `/v1/application_fees/${encodeURIComponent(feeId)}/refunds`, {
          form: { amount: String(expected), 'metadata[refund_request_id]': req.id, 'metadata[booking_id]': req.booking_id, 'metadata[payment_group_id]': grp.id, 'metadata[refund]': req.stripe_refund_id },
          idempotencyKey: req.fee_refund_idempotency_key,
        });
        if (!c.ok) {
          if (c.transient) return retry('stripe_create_fee_refund', { error: c.error });
          return await exception('fee_refund_create_refused', { error: c.error, type: c.type || null, status: c.status });
        }
        fr = c.json;
      }
      const bad = await verifyAndRecord(fr); if (bad) return bad;
    } else {
      // strategy 1 (legacy proportional flag): match, never guess
      const list = await listFeeRefunds(b, feeId);
      if (!list.ok) return retry('stripe_list_fee_refunds', { error: list.error });
      const near = (x) => Math.abs((x.created || 0) - (refund.created || 0)) <= 600;
      const candidates = list.data.filter(x => x.amount === expected && near(x));
      let taken;
      try { taken = candidates.length ? (await sbRaw(b, `refund_requests?stripe_fee_refund_id=in.(${candidates.map(x => encodeURIComponent(x.id)).join(',')})&select=stripe_fee_refund_id`)).map(x => x.stripe_fee_refund_id) : []; }
      catch (e) { return retry('db_read_taken_ids', { error: String((e && e.message) || e).slice(0, 160) }); }
      const free = candidates.filter(x => !taken.includes(x.id));
      if (free.length !== 1) return await exception('legacy_fee_refund_ambiguous', { candidates: candidates.map(x => x.id), free: free.map(x => x.id), expected_amount: expected });
      const bad = await verifyAndRecord(free[0]); if (bad) return bad;
    }
  } else legs.fee_refund = { id: req.stripe_fee_refund_id, rpc: 'already_recorded' };

  let after;
  try { const rows = await sbRaw(b, `refund_requests?id=eq.${encodeURIComponent(req.id)}&select=settlement_status,transfer_reversal_status,fee_refund_status`); after = rows[0]; }
  catch (e) { return retry('db_read_after', { error: String((e && e.message) || e).slice(0, 160), legs }); }
  if (after && after.settlement_status === 'complete') return { outcome: 'complete', legs };
  if (after && after.settlement_status === 'exception') return { outcome: 'exception', reason: 'leg_failed', legs };
  return retry('settlement_incomplete_after_legs', { legs, after });
}

// Reserve against the booking's immutable allocation and submit. opName is the per-booking operation
// identity ('cancel', 'decline', 'move_declined', 'move_lapsed'): the same (booking, opName) always
// maps to the same reservation and the same Stripe idempotency key.
// opts.onExisting: 'submit' (default, the retailer cancel/decline path: a replayed reservation is
// resubmitted under its stored idempotency key, which Stripe deduplicates) or 'defer' (the demo-move
// settlement: an existing reservation is NEVER resubmitted here; the leased refund worker owns its
// recovery, with provider-id lookup and aged-request reconciliation). Codex RM-4.
export async function reserveAndRefund(b, booking, actor, reason, opName, opts = {}) {
  const opKey = booking.id + ':' + opName;
  let rr;
  try { rr = await sbRpc(b, 'refund_reserve_cas', { p_booking_id: booking.id, p_op_key: opKey, p_actor: actor || null, p_reason: reason || null }); }
  catch (e) { return { ok: false, error: 'reserve_failed', requires_review: true }; }
  const row = Array.isArray(rr) ? rr[0] : rr;
  const outcome = row && row.outcome;
  if (outcome === 'no_allocation' || outcome === 'not_charged') return { ok: false, error: outcome, requires_review: true };
  if (outcome === 'nothing_refundable') return { ok: false, error: 'nothing_refundable' };
  if (outcome === 'no_booking' || outcome === 'booking_state_conflict') return { ok: false, error: outcome };
  // Codex RM-4: the reservation's shape is checked BEFORE any provider call. A full refund is the affected
  // allocation's remaining entitlement, an explicit amount; an amount-less request would refund a shared
  // payment in full and is refused here.
  const amount = row ? normalizeMinorUnits(row.amount) : null;
  if (!row || (outcome !== 'reserved' && outcome !== 'existing') || typeof row.payment_intent !== 'string' || !row.payment_intent
      || amount == null || typeof row.idempotency_key !== 'string' || !row.idempotency_key || !row.refund_request_id) {
    return { ok: false, error: 'reserve_malformed', requires_review: true, outcome: outcome || null, refund_request_id: (row && row.refund_request_id) || null };
  }
  if (outcome === 'existing' && opts.onExisting === 'defer') {
    return { ok: false, error: 'existing', deferred: true, refund_request_id: row.refund_request_id };
  }

  const r = await refundPaymentIntent(b, row.payment_intent, {
    keepsAll: !!row.keeps_all, strategy: row.settlement_strategy, amountCents: amount, requireAmount: true, idempotencyKey: row.idempotency_key,
    reason: 'requested_by_customer', metadata: { refund_request_id: row.refund_request_id, booking_id: booking.id },
  });
  if (r.ok) {
    let applied = null;
    try {
      applied = await sbRpc(b, 'apply_refund_event', {
        p_refund_id: r.refund_id, p_status: (r.refund && r.refund.status) || 'pending',
        p_amount: row.amount, p_currency: (r.refund && r.refund.currency) || 'usd',
        p_pi: row.payment_intent, p_charge: (r.refund && r.refund.charge) || row.charge_id || null,
        p_meta_request_id: row.refund_request_id, p_event_id: null,
      });
    } catch (_) { /* webhook/worker will still converge */ }
    // Connected settlement (0117, Codex CC-2): a customer refund that succeeded synchronously used to fall out of
    // every recovery path. The two Stripe-side legs are attempted here at once (best effort) and, whatever happens
    // here, the leased settlement queue in api/refund-worker.js picks the request up until it is complete.
    const appliedVal = Array.isArray(applied) ? applied[0] : applied;
    let settlement = null;
    if (!row.keeps_all && appliedVal && ['applied', 'already_terminal'].includes(appliedVal.outcome) && r.refund && String(r.refund.status).toLowerCase() === 'succeeded') {
      try { settlement = await settleConnectRefund(b, row.refund_request_id); } catch (e) { settlement = { outcome: 'retry', reason: 'threw', error: String((e && e.message) || e).slice(0, 120) }; }
      if (settlement && settlement.outcome !== 'complete') console.warn('connected settlement deferred to the worker for', row.refund_request_id, settlement.outcome, settlement.reason || '');
    }
    return { ok: true, ledger: true, submitted: true, refund_id: r.refund_id, refund_request_id: row.refund_request_id, settlement: settlement && settlement.outcome };
  }
  // Submit failed: leave the reservation for the LEASED worker to retry with the same key.
  await sbRaw(b, `refund_requests?id=eq.${encodeURIComponent(row.refund_request_id)}`, { method: 'PATCH', body: JSON.stringify({ status: 'failed_retryable', last_error: String(r.error || 'stripe refund failed').slice(0, 200) }) }).catch(() => {});
  return { ok: false, error: 'refund_failed', requires_review: true, retrying: true, refund_request_id: row.refund_request_id };
}
