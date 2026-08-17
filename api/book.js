// api/book.js — F5-05 secure booking endpoint. Composes the proven engines:
// identity from the SESSION (not a typed email), COI must be VERIFIED, slot capacity enforced
// by the DB trigger, server owns tenant/brand/amount. Replaces the anonymous email-based booking.
import { requireBrandSession } from './_booking-identity.js';
import { coiCovered } from './_coi-coverage.js';
import { FLAGS } from './_flags.js';
import { getBinding, sendBindingFailure } from './_env.js';
import { requireSameOrigin } from './_csrf.js';
let _b = null;
const rest=(p,o={})=>fetch(`${_b.supabaseUrl}/rest/v1/${p}`,{...o,headers:{apikey:_b.serviceKey,Authorization:`Bearer ${_b.serviceKey}`,'Content-Type':'application/json',...(o.headers||{})}});
const one=async(p)=>{const r=await rest(p);return r.ok?(await r.json())[0]:null;};

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  try { _b = await getBinding(); } catch (e) { return sendBindingFailure(res, e); }
  // Codex finding B, CSRF wiring: this is the live brand booking endpoint — it creates a booking under the caller's brand.
  // Checked before the session is read. No exemption applies — this route is cookie-authenticated
  // and carries neither a Stripe signature nor a CRON_SECRET.
  if (!requireSameOrigin(req, res, _b)) return;
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
  // Provisional holds (behind PROVISIONAL_HOLDS_ENABLED): a brand may book WITHOUT a verified COI —
  // the booking becomes 'held' (funds authorized, not captured) with a 24h window to get COI-verified
  // + confirmed, else the hold is released. Flag OFF = current hard gate (COI required to book).
  const provisional = FLAGS.provisionalHolds && !cov.covered;
  if (!cov.covered && !FLAGS.provisionalHolds) return res.status(400).json({ error: 'coi_required', reason: cov.reason });

  // 3b) Contact info (name + phone) required to book — retailers must be able to reach the brand.
  if (!brand.contact_name || !String(brand.contact_name).trim() || !brand.phone || !String(brand.phone).trim()) {
    return res.status(400).json({ error: 'contact_required', reason: 'missing_contact_name_or_phone' });
  }

  // 4) create the booking — server sets tenant/brand/state; slot trigger enforces capacity
  const payload = { retailer_id: retailer.id, venue_id: venue.id, brand_id: auth.brandId,
    brand_name: brand.company_name || null, contact_name: brand.contact_name || null, contact_email: auth.email, contact_phone: brand.phone || null,
    demo_date: body.demo_date, demo_time: body.demo_time, product: (body.product||null), notes: (body.notes||null), product_skus: (body.product_skus||null),
    status: provisional ? 'held' : 'pending_payment',
    held_expires_at: provisional ? new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() : null,
    payment_status: 'unpaid', amount_paid: Math.round(Number(venue.demo_fee||0)*100) };
  let r = await rest('bookings', { method:'POST', headers:{Prefer:'return=representation'}, body: JSON.stringify(payload) });
  if (!r.ok) {
    let t = await r.text();
    // Slot contention (provisional holds): a VERIFIED brand booking a full slot may bump a 'held'
    // provisional hold — insured/confirmed beats provisional by design (the held brand was told so
    // in the hold email). Bump = release the newest hold (cancel auth, 'expired', notify) and retry.
    // Provisional bookers never bump anyone.
    if (t.includes('slot_full') && FLAGS.provisionalHolds && cov.covered) {
      const { releaseHeldBooking } = await import('./_provisional.js');
      for (let attempt = 0; attempt < 3 && !r.ok && t.includes('slot_full'); attempt++) {
        const held = await rest(`bookings?venue_id=eq.${encodeURIComponent(venue.id)}&demo_date=eq.${encodeURIComponent(body.demo_date)}&demo_time=eq.${encodeURIComponent(body.demo_time)}&status=eq.held&select=id,status,payment_status,payment_intent_id,contact_email&order=created_at.desc&limit=1`);
        const victim = held.ok ? (await held.json())[0] : null;
        if (!victim) break;
        const rel = await releaseHeldBooking(victim, { target: 'expired', reason: 'bumped_by_verified_booking', notify: true, bumped: true });
        if (!rel.ok) { console.warn('contention bump failed for', victim.id, rel.error); break; }
        r = await rest('bookings', { method:'POST', headers:{Prefer:'return=representation'}, body: JSON.stringify(payload) });
        if (!r.ok) t = await r.text();
      }
    }
    if (!r.ok) { if (t.includes('slot_full')) return res.status(409).json({ error: 'slot_full' }); return res.status(500).json({ error: 'booking_failed' }); }
  }
  const booking = (await r.json())[0];
  return res.status(200).json({ ok: true, booking_id: booking.id, next: 'checkout' });
}
