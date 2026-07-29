// api/_checkout-guard.js — F5-16 / LG-08: a checkout can only be created by the brand that OWNS
// the booking, only when the booking is in 'pending_payment', and reuses an existing live
// checkout instead of spawning unlimited parallel ones (which could double-charge).
import { getBinding } from './_env.js';
const rest=async(p,o={})=>{const b=await getBinding();return fetch(`${b.supabaseUrl}/rest/v1/${p}`,{...o,headers:{apikey:b.serviceKey,Authorization:`Bearer ${b.serviceKey}`,'Content-Type':'application/json',...(o.headers||{})}});};

// Returns {ok, booking} or {ok:false, status, error}. brandId comes from the verified session.
export async function guardCheckout(bookingId, brandId) {
  const r = await rest(`bookings?id=eq.${encodeURIComponent(bookingId)}&select=id,brand_id,status,payment_status,stripe_session_id&limit=1`);
  const b = r.ok ? (await r.json())[0] : null;
  if (!b) return { ok:false, status:404, error:'booking_not_found' };
  if (b.brand_id !== brandId) return { ok:false, status:403, error:'not_your_booking' };   // ownership
  if (b.payment_status === 'paid') return { ok:false, status:409, error:'already_paid' };
  if (b.status !== 'pending_payment' && b.payment_status !== 'unpaid') return { ok:false, status:409, error:'not_payable_state' };
  return { ok:true, booking:b, reuseSession: b.stripe_session_id || null };  // reuse an existing session
}
