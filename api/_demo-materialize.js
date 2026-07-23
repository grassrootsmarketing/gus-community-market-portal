// api/_demo-materialize.js — F5-19 / LG (confirm race): creating the calendar demo for a booking
// is idempotent and keyed on booking_id, so confirming twice (or a retry) never makes two demos.
const SUPABASE_URL = process.env.SUPABASE_URL, SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const rest=(p,o={})=>fetch(`${SUPABASE_URL}/rest/v1/${p}`,{...o,headers:{apikey:SERVICE_KEY,Authorization:`Bearer ${SERVICE_KEY}`,'Content-Type':'application/json',...(o.headers||{})}});

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
