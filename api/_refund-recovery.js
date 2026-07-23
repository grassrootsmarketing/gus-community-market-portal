// api/_refund-recovery.js — F5-15 / LG-07: if a Stripe refund FAILS on decline/cancel, the
// booking is NOT closed into an un-retryable state and money is NOT falsely marked refunded.
// It goes to payment_status='refund_pending' so a retry worker can finish it.
const SUPABASE_URL = process.env.SUPABASE_URL, SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const rest=(p,o={})=>fetch(`${SUPABASE_URL}/rest/v1/${p}`,{...o,headers:{apikey:SERVICE_KEY,Authorization:`Bearer ${SERVICE_KEY}`,'Content-Type':'application/json',...(o.headers||{})}});

export async function resolveDeclineRefund(bookingId, refund) {
  const patch = { status: 'declined' };
  if (refund && refund.ok) { patch.payment_status = 'refunded'; patch.refund_id = refund.refund_id; patch.amount_refunded = refund.amount; }
  else { patch.payment_status = 'refund_pending'; }   // retryable — money NOT marked refunded
  const r = await rest(`bookings?id=eq.${encodeURIComponent(bookingId)}`, { method:'PATCH', headers:{Prefer:'return=representation'}, body: JSON.stringify(patch) });
  return (await r.json())[0];
}
export async function listRetryableRefunds() {
  const r = await rest(`bookings?payment_status=eq.refund_pending&select=id,amount_paid,payment_intent_id`);
  return r.ok ? await r.json() : [];
}
