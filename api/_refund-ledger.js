// api/_refund-ledger.js — F5-18 / LG-06: refunds are recorded against the EXACT booking they
// were issued for, never split across every booking that shared a PaymentIntent.
// Each booking stores its own charged amount (amount_paid). A refund updates only its target.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
function rest(path, opts = {}) {
  return fetch(`${SUPABASE_URL}/rest/v1/${path}`, { ...opts, headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json', ...(opts.headers || {}) } });
}

// At checkout: record what THIS booking was charged (used later to refund the exact amount).
export async function recordBookingCharge(bookingId, amountCents, paymentIntentId) {
  await rest(`bookings?id=eq.${encodeURIComponent(bookingId)}`, { method: 'PATCH', body: JSON.stringify({ amount_paid: amountCents, payment_status: 'paid', payment_intent_id: paymentIntentId }) });
}

// Apply a refund to ONE booking only (called from the webhook, keyed on the refund's own
// booking_id metadata — NOT by dividing a charge total across every booking in the PI).
export async function applyRefundToBooking(bookingId, refundId, amountCents) {
  const r = await rest(`bookings?id=eq.${encodeURIComponent(bookingId)}&payment_status=eq.paid`, {
    method: 'PATCH', headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ payment_status: 'refunded', amount_refunded: amountCents, refund_id: refundId }),
  });
  const rows = r.ok ? await r.json() : [];
  return Array.isArray(rows) && rows.length === 1;
}
