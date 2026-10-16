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

export async function refundPaymentIntent(b, paymentIntentId, opts = {}) {
  const key = (b && b.stripeKey) || null;
  if (!key) return { ok: false, error: 'STRIPE_SECRET_KEY not configured' };
  if (!paymentIntentId) return { ok: false, error: 'payment_intent_id required' };
  const params = new URLSearchParams();
  params.set('payment_intent', paymentIntentId);
  // DH-04: when several bookings share one PaymentIntent (batch checkout), refund only this
  // booking's share. Omitted -> Stripe does a full refund (correct for single-booking PIs).
  if (opts.amountCents != null && Number.isFinite(opts.amountCents) && opts.amountCents > 0) {
    params.set('amount', String(Math.round(opts.amountCents)));
  }
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
  if (!row || (outcome !== 'reserved' && outcome !== 'existing') || typeof row.payment_intent !== 'string' || !row.payment_intent
      || !Number.isFinite(Number(row.amount)) || Number(row.amount) <= 0 || typeof row.idempotency_key !== 'string' || !row.idempotency_key || !row.refund_request_id) {
    return { ok: false, error: 'reserve_malformed', requires_review: true, outcome: outcome || null };
  }
  if (outcome === 'existing' && opts.onExisting === 'defer') {
    return { ok: false, error: 'existing', deferred: true, refund_request_id: row.refund_request_id };
  }

  const r = await refundPaymentIntent(b, row.payment_intent, {
    keepsAll: !!row.keeps_all, amountCents: row.amount, idempotencyKey: row.idempotency_key,
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
