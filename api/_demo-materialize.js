// api/_demo-materialize.js — F5-19 / LG (confirm race): creating the calendar demo for a booking
// is idempotent and keyed on booking_id, so confirming twice (or a retry) never makes two demos.
import { getBinding } from './_env.js';
const rest=async(p,o={})=>{const b=await getBinding();return fetch(`${b.supabaseUrl}/rest/v1/${p}`,{...o,headers:{apikey:b.serviceKey,Authorization:`Bearer ${b.serviceKey}`,'Content-Type':'application/json',...(o.headers||{})}});};

export async function materializeDemo(booking) {
  // reuse if one already exists for this booking
  const ex = await rest(`demos?booking_id=eq.${encodeURIComponent(booking.id)}&select=id&limit=1`);
  const existing = ex.ok ? (await ex.json())[0] : null;
  if (existing) return { id: existing.id, created: false };
  const payload = { booking_id: booking.id, retailer_id: booking.retailer_id, venue_id: booking.venue_id, brand_id: booking.brand_id || null,
    company_name: booking.brand_name || 'Unknown', demo_date: booking.demo_date, demo_time: booking.demo_time, status: 'confirmed', confirmed_at: new Date().toISOString() };
  try {
    const r = await rest('demos', { method:'POST', headers:{Prefer:'return=representation'}, body: JSON.stringify(payload) });
    if (r.ok) { const rows = await r.json(); return { id: rows[0].id, created: true }; }
    // unique index tripped (concurrent create) -> reuse the one that won
    const again = await rest(`demos?booking_id=eq.${encodeURIComponent(booking.id)}&select=id&limit=1`);
    const won = again.ok ? (await again.json())[0] : null;
    return won ? { id: won.id, created: false } : { error: 'materialize_failed' };
  } catch (_) { return { error: 'materialize_failed' }; }
}
