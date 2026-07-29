// api/_refund-recovery.js — F5-15 / LG-07: if a Stripe refund FAILS on decline/cancel, the
// booking is NOT closed into an un-retryable state and money is NOT falsely marked refunded.
// It goes to payment_status='refund_pending' so a retry worker can finish it.
import { getBinding } from './_env.js';
const rest=async(p,o={})=>{const b=await getBinding();return fetch(`${b.supabaseUrl}/rest/v1/${p}`,{...o,headers:{apikey:b.serviceKey,Authorization:`Bearer ${b.serviceKey}`,'Content-Type':'application/json',...(o.headers||{})}});};

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
