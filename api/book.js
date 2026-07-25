// api/book.js — F5-05 secure booking endpoint. Composes the proven engines:
// identity from the SESSION (not a typed email), COI must be VERIFIED, slot capacity enforced
// by the DB trigger, server owns tenant/brand/amount. Replaces the anonymous email-based booking.
import { requireBrandSession } from './_booking-identity.js';
import { coiCovered } from './_coi-coverage.js';
const SUPABASE_URL = process.env.SUPABASE_URL, SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const rest=(p,o={})=>fetch(`${SUPABASE_URL}/rest/v1/${p}`,{...o,headers:{apikey:SERVICE_KEY,Authorization:`Bearer ${SERVICE_KEY}`,'Content-Type':'application/json',...(o.headers||{})}});
const one=async(p)=>{const r=await rest(p);return r.ok?(await r.json())[0]:null;};

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  let body={}; try{ body = typeof req.body==='string'?JSON.parse(req.body||'{}'):(req.body||{}); }catch(_){}

  // 1) identity comes from the authenticated brand session
  const auth = await requireBrandSession(req, body);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

  // 2) resolve retailer + venue; venue MUST belong to that retailer and be active
  const retailer = await one(`retailers?slug=eq.${encodeURIComponent(String(body.retailer_slug||''))}&select=id,slug`);
  if (!retailer) return res.status(404).json({ error: 'retailer_not_found' });
  const venue = await one(`venues?id=eq.${encodeURIComponent(String(body.venue_id||''))}&select=id,retailer_id,active,demo_fee`);
  if (!venue || venue.retailer_id !== retailer.id) return res.status(400).json({ error: 'invalid_venue' });
  if (venue.active === false) return res.status(400).json({ error: 'venue_inactive' });
  if (!body.demo_date || !body.demo_time) return res.status(400).json({ error: 'date_time_required' });

  // 3) COI must be VERIFIED for the authenticated brand
  const brand = await one(`brands?id=eq.${encodeURIComponent(auth.brandId)}&select=default_coi_url,default_coi_expires,coi_verification_status,company_name,contact_name,email,phone`);
  const cov = coiCovered(brand, body.demo_date);
  if (!cov.covered) return res.status(400).json({ error: 'coi_required', reason: cov.reason });

  // 4) create the booking — server sets tenant/brand/state; slot trigger enforces capacity
  const payload = { retailer_id: retailer.id, venue_id: venue.id, brand_id: auth.brandId,
    brand_name: brand.company_name || null, contact_name: brand.contact_name || null, contact_email: auth.email, contact_phone: brand.phone || null,
    demo_date: body.demo_date, demo_time: body.demo_time, product: (body.product||null), notes: (body.notes||null), product_skus: (body.product_skus||null),
    status: 'pending_payment', payment_status: 'unpaid', amount_paid: Math.round(Number(venue.demo_fee||0)*100) };
  const r = await rest('bookings', { method:'POST', headers:{Prefer:'return=representation'}, body: JSON.stringify(payload) });
  if (!r.ok) { const t = await r.text(); if (t.includes('slot_full')) return res.status(409).json({ error: 'slot_full' }); return res.status(500).json({ error: 'booking_failed' }); }
  const booking = (await r.json())[0];
  return res.status(200).json({ ok: true, booking_id: booking.id, next: 'checkout' });
}
