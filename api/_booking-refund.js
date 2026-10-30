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
  if (!opts.keepsAll) {
    params.set('refund_application_fee', 'true');
    params.set('reverse_transfer', 'true');
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

// Connected settlement legs (round 2 of the revenue split rehearsal, 2026-10-30). A refund of a destination charge is
// three legs on Stripe: the customer refund (re_), the transfer reversal (trr_) and the application fee refund (fr_).
// The ledger expected all three since 0032/0034 (record_settlement_leg) but no shipped code ever recorded the last two,
// so settlement_status stayed 'pending' on every connected refund. This reads both legs from Stripe for ONE succeeded
// refund and records them idempotently: record_settlement_leg keeps the first id it was given (coalesce) and the
// unique indexes on stripe_transfer_reversal_id / stripe_fee_refund_id make a double claim impossible. Keeps-all
// groups (settlement 'not_required') and refunds that are not yet succeeded return without touching anything.
// The fee refund is matched by amount against the application fee's refund list, newest first, skipping ids another
// request already holds; the Refund object itself does not name its fee refund.
async function stripeGetJson(b, path) {
  const r = await fetch('https://api.stripe.com' + path, { headers: { Authorization: 'Bearer ' + b.stripeKey } });
  const j = await r.json().catch(() => null);
  return r.ok ? j : null;
}
export async function recordConnectSettlementLegs(b, refund, { requestId = null } = {}) {
  if (!b || !b.stripeKey || !refund || !refund.id) return { outcome: 'skipped', reason: 'no_refund' };
  if (String(refund.status || '').toLowerCase() !== 'succeeded') return { outcome: 'skipped', reason: 'refund_not_succeeded' };
  const rid = requestId || (refund.metadata && refund.metadata.refund_request_id) || null;
  const where = rid ? `id=eq.${encodeURIComponent(rid)}` : `stripe_refund_id=eq.${encodeURIComponent(refund.id)}`;
  // three plain reads (refund_requests carries two foreign keys to payment_allocations, so an embedded select is ambiguous)
  let req = null, grp = null;
  try {
    const rows = await sbRaw(b, `refund_requests?${where}&select=id,amount,settlement_status,stripe_transfer_reversal_id,stripe_fee_refund_id,expected_transfer_reversal_amount,expected_fee_refund_amount,payment_allocation_id`);
    req = Array.isArray(rows) ? rows[0] : null;
    if (req) {
      const allocs = await sbRaw(b, `payment_allocations?id=eq.${encodeURIComponent(req.payment_allocation_id)}&select=payment_group_id`);
      const gid = Array.isArray(allocs) && allocs[0] ? allocs[0].payment_group_id : null;
      const grps = gid ? await sbRaw(b, `payment_groups?id=eq.${encodeURIComponent(gid)}&select=platform_keeps_all,stripe_application_fee_id,stripe_charge_id`) : [];
      grp = Array.isArray(grps) ? grps[0] : null;
    }
  } catch (_) { req = null; }
  if (!req) return { outcome: 'skipped', reason: 'no_request' };
  if (!grp || grp.platform_keeps_all !== false) return { outcome: 'skipped', reason: 'keeps_all' };
  if (req.settlement_status === 'complete') return { outcome: 'already_complete', refund_request_id: req.id };
  const out = { outcome: 'recorded', refund_request_id: req.id, legs: {} };
  // leg 1: the transfer reversal, named on the Refund object (id or expanded object)
  let trr = refund.transfer_reversal && (typeof refund.transfer_reversal === 'string' ? refund.transfer_reversal : refund.transfer_reversal.id);
  if (!trr) { const full = await stripeGetJson(b, `/v1/refunds/${encodeURIComponent(refund.id)}`); trr = full && full.transfer_reversal && (typeof full.transfer_reversal === 'string' ? full.transfer_reversal : full.transfer_reversal.id); }
  if (trr && !req.stripe_transfer_reversal_id) {
    try { const r1 = await sbRpc(b, 'record_settlement_leg', { p_request_id: req.id, p_leg: 'transfer_reversal', p_stripe_id: trr, p_status: 'succeeded' }); out.legs.transfer_reversal = { id: trr, rpc: r1 && r1.outcome }; }
    catch (e) { out.legs.transfer_reversal = { id: trr, error: String((e && e.message) || e).slice(0, 120) }; }
  } else if (req.stripe_transfer_reversal_id) out.legs.transfer_reversal = { id: req.stripe_transfer_reversal_id, rpc: 'already_recorded' };
  else out.legs.transfer_reversal = { id: null, rpc: 'not_found_on_stripe' };
  // leg 2: the application fee refund, matched by amount on the fee's refund list
  let feeId = grp.stripe_application_fee_id;
  if (!feeId && grp.stripe_charge_id) { const ch = await stripeGetJson(b, `/v1/charges/${encodeURIComponent(grp.stripe_charge_id)}`); feeId = ch && ch.application_fee; }
  if (feeId && !req.stripe_fee_refund_id) {
    const list = await stripeGetJson(b, `/v1/application_fees/${encodeURIComponent(feeId)}/refunds?limit=100`);
    const candidates = (list && Array.isArray(list.data) ? list.data : []).filter(fr => fr.amount === req.expected_fee_refund_amount);
    let taken = [];
    try { taken = (await sbRaw(b, `refund_requests?stripe_fee_refund_id=in.(${candidates.map(c => encodeURIComponent(c.id)).join(',') || 'none'})&select=stripe_fee_refund_id`)).map(x => x.stripe_fee_refund_id); } catch (_) { taken = []; }
    const fr = candidates.filter(c => !taken.includes(c.id)).sort((x, y) => Math.abs(x.created - (refund.created || 0)) - Math.abs(y.created - (refund.created || 0)))[0];
    if (fr) {
      try { const r2 = await sbRpc(b, 'record_settlement_leg', { p_request_id: req.id, p_leg: 'fee_refund', p_stripe_id: fr.id, p_status: 'succeeded' }); out.legs.fee_refund = { id: fr.id, rpc: r2 && r2.outcome }; }
      catch (e) { out.legs.fee_refund = { id: fr.id, error: String((e && e.message) || e).slice(0, 120) }; }
    } else out.legs.fee_refund = { id: null, rpc: 'no_matching_fee_refund' };
  } else if (req.stripe_fee_refund_id) out.legs.fee_refund = { id: req.stripe_fee_refund_id, rpc: 'already_recorded' };
  else out.legs.fee_refund = { id: null, rpc: 'no_application_fee_id' };
  return out;
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
    keepsAll: !!row.keeps_all, amountCents: amount, requireAmount: true, idempotencyKey: row.idempotency_key,
    reason: 'requested_by_customer', metadata: { refund_request_id: row.refund_request_id, booking_id: booking.id },
  });
  if (r.ok) {
    try {
      await sbRpc(b, 'apply_refund_event', {
        p_refund_id: r.refund_id, p_status: (r.refund && r.refund.status) || 'pending',
        p_amount: row.amount, p_currency: (r.refund && r.refund.currency) || 'usd',
        p_pi: row.payment_intent, p_charge: (r.refund && r.refund.charge) || row.charge_id || null,
        p_meta_request_id: row.refund_request_id, p_event_id: null,
      });
    } catch (_) { /* webhook/worker will still converge */ }
    return { ok: true, ledger: true, submitted: true, refund_id: r.refund_id, refund_request_id: row.refund_request_id };
  }
  // Submit failed: leave the reservation for the LEASED worker to retry with the same key.
  await sbRaw(b, `refund_requests?id=eq.${encodeURIComponent(row.refund_request_id)}`, { method: 'PATCH', body: JSON.stringify({ status: 'failed_retryable', last_error: String(r.error || 'stripe refund failed').slice(0, 200) }) }).catch(() => {});
  return { ok: false, error: 'refund_failed', requires_review: true, retrying: true, refund_request_id: row.refund_request_id };
}
