// api/book.js, F5-05 secure booking endpoint. Composes the proven engines:
// identity from the SESSION (not a typed email), COI must be VERIFIED, slot capacity enforced
// by the DB trigger, server owns tenant/brand/amount. Replaces the anonymous email-based booking.
import { validateProducts, describeErrors } from './_products.js';
import { requireBrandSession } from './_booking-identity.js';
import { coiCovered } from './_coi-coverage.js';
import { FLAGS } from './_flags.js';
import { getBinding, sendBindingFailure } from './_env.js';
import { requireSameOrigin } from './_csrf.js';
import { parseYmd, parseDemoTime, localDateOf, shiftYmd, ymdString, safeZone, demoStartUtc } from './_local-time.js';
import { resolveRequestedSlot, SLOT_REFUSAL_MESSAGES, slotRefusalFromDbError } from './_slots.js';
import { retailerIsLive, NOT_LIVE_BODY } from './_retailer-live.js';
let _b = null;

// Minimum booking lead time (2026-09-30). The store's settings.advance_booking_days (default 14) counted in whole
// retailer-local calendar days from today: earliest allowed date = today + N. Until now only the booking page's
// calendar applied this (greyed-out days); a stale tab, a failed settings load (page fallback 14) or a direct API call
// could book inside the window. The server is the rule; the calendar is the explanation. Nothing before today, ever.
export function earliestBookableYmd(now, tz, advanceDays) {
  const n = Number.isInteger(advanceDays) && advanceDays >= 0 ? advanceDays : 14;
  return ymdString(shiftYmd(localDateOf(now, safeZone(tz)), n));
}
const rest=(p,o={})=>fetch(`${_b.supabaseUrl}/rest/v1/${p}`,{...o,headers:{apikey:_b.serviceKey,Authorization:`Bearer ${_b.serviceKey}`,'Content-Type':'application/json',...(o.headers||{})}});
const one=async(p)=>{const r=await rest(p);return r.ok?(await r.json())[0]:null;};

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  try { _b = await getBinding(); } catch (e) { return sendBindingFailure(res, e); }
  // Codex finding B, CSRF wiring: this is the live brand booking endpoint, it creates a booking under the caller's brand.
  // Checked before the session is read. No exemption applies, this route is cookie-authenticated
  // and carries neither a Stripe signature nor a CRON_SECRET.
  if (!requireSameOrigin(req, res, _b)) return;
  let body={}; try{ body = typeof req.body==='string'?JSON.parse(req.body||'{}'):(req.body||{}); }catch(_){}

  // 1) identity comes from the authenticated brand session
  const auth = await requireBrandSession(req, body);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

  // 2) resolve retailer + venue; venue MUST belong to that retailer and be active
  const retailer = await one(`retailers?slug=eq.${encodeURIComponent(String(body.retailer_slug||''))}&select=id,slug,timezone,verification_status`);
  if (!retailer) return res.status(404).json({ error: 'retailer_not_found' });
  // Go-live gate: a store Demohub has not approved takes no bookings (api/_retailer-live.js).
  if (!retailerIsLive(retailer)) return res.status(403).json(NOT_LIVE_BODY);
  const venue = await one(`venues?id=eq.${encodeURIComponent(String(body.venue_id||''))}&select=id,retailer_id,active,demo_fee,availability`);
  if (!venue || venue.retailer_id !== retailer.id) return res.status(400).json({ error: 'invalid_venue' });
  if (venue.active === false) return res.status(400).json({ error: 'venue_inactive' });
  if (!body.demo_date || !body.demo_time) return res.status(400).json({ error: 'date_time_required' });
  if (!parseYmd(String(body.demo_date))) return res.status(400).json({ error: 'invalid_demo_date', message: 'demo_date must be a real calendar date (YYYY-MM-DD).' });
  if (!parseDemoTime(String(body.demo_time))) return res.status(400).json({ error: 'invalid_demo_time', message: 'demo_time must be a time such as "11:00 AM" or "13:00".' });
  // Release B: the requested time must be a slot this location OFFERS on that date (configured
  // slots, weekday hours, blackouts). The canonical spelling and the configured length are what get
  // stored, the browser never picks a storage label, a duration or an end time. The database
  // re-runs the same check under the venue lock (booking_slot_resolve, 0075); this is the early,
  // precise refusal.
  const slot = resolveRequestedSlot(venue.availability, String(body.demo_date), String(body.demo_time), retailer.timezone);
  if (!slot.ok) {
    return res.status(slot.reason === 'slot_config_invalid' ? 503 : 400).json({ error: slot.reason, message: SLOT_REFUSAL_MESSAGES[slot.reason] || 'That time is not available.' });
  }
  // 2c) Minimum lead time, enforced here (see earliestBookableYmd). A settings read failure is "unavailable", never a
  // silently different rule. One clock for the whole decision; a test hook may pin it.
  const sr = await rest(`settings?retailer_id=eq.${encodeURIComponent(retailer.id)}&select=advance_booking_days`);
  if (!sr.ok) return res.status(503).json({ error: 'settings_unavailable', message: "Could not read this store's booking rules. Try again in a moment." });
  const settingsRow = (await sr.json())[0];
  const advanceDays = settingsRow && Number.isInteger(settingsRow.advance_booking_days) && settingsRow.advance_booking_days >= 0 ? settingsRow.advance_booking_days : 14;
  const nowClock = (process.env.DEMOHUB_TEST_HOOKS === '1' && process.env.DEMOHUB_CLOCK_OVERRIDE) ? new Date(process.env.DEMOHUB_CLOCK_OVERRIDE) : new Date();
  const todayYmd = earliestBookableYmd(nowClock, retailer.timezone, 0);
  const earliestYmd = earliestBookableYmd(nowClock, retailer.timezone, advanceDays);
  if (String(body.demo_date) < todayYmd) return res.status(400).json({ error: 'date_in_past', message: 'That date has already passed.' });
  if (String(body.demo_date) < earliestYmd) {
    return res.status(400).json({ error: 'lead_time_required', message: `This store needs ${advanceDays} days' notice. The earliest date you can book is ${earliestYmd}.`, earliest_date: earliestYmd, advance_booking_days: advanceDays });
  }
  if (String(body.demo_date) === todayYmd) {
    const startAt = demoStartUtc(String(body.demo_date), slot.time, retailer.timezone);
    if (!startAt || startAt.getTime() <= nowClock.getTime()) return res.status(400).json({ error: 'slot_started', message: 'That time has already started today. Pick a later slot.' });
  }
  // Release A: electricity is a TYPED per-booking value. true/false from the form's toggle, absent
  // -> null ("Not specified"). Anything else is refused, never parsed out of the notes text.
  if (body.needs_electricity !== undefined && body.needs_electricity !== null && typeof body.needs_electricity !== 'boolean') {
    return res.status(400).json({ error: 'invalid_needs_electricity', message: 'needs_electricity must be true or false.' });
  }
  const needsElectricity = typeof body.needs_electricity === 'boolean' ? body.needs_electricity : null;

  // 3) COI must be VERIFIED for the authenticated brand
  const brand = await one(`brands?id=eq.${encodeURIComponent(auth.brandId)}&select=default_coi_url,default_coi_expires,coi_verification_status,company_name,contact_name,email,phone`);
  const cov = coiCovered(brand, body.demo_date);
  // Provisional holds (behind PROVISIONAL_HOLDS_ENABLED): a brand may book WITHOUT a verified COI,
  // the booking becomes 'held' (funds authorized, not captured) with a 24h window to get COI-verified
  // + confirmed, else the hold is released. Flag OFF = current hard gate (COI required to book).
  const provisional = FLAGS.provisionalHolds && !cov.covered;
  if (!cov.covered && !FLAGS.provisionalHolds) return res.status(400).json({ error: 'coi_required', reason: cov.reason });

  // 3b) Contact info (name + phone) required to book, retailers must be able to reach the brand.
  if (!brand.contact_name || !String(brand.contact_name).trim() || !brand.phone || !String(brand.phone).trim()) {
    return res.status(400).json({ error: 'contact_required', reason: 'missing_contact_name_or_phone' });
  }

  // 3c) Codex product-list P-1: every brand-created booking carries 1..40 validated selected items. An empty or
  // missing selection is refused (never silently filled from the profile); malformed data is refused with bounded
  // field errors. This runs BEFORE the insert, the capacity bump and any checkout, and reads nothing else: a
  // supplied item id is a label inside this brand's own list, never a key into another brand's catalog.
  if (body.product_skus === undefined || body.product_skus === null || (Array.isArray(body.product_skus) && body.product_skus.length === 0)) {
    return res.status(400).json({ error: 'products_required', message: 'Select at least one item you will be sampling. The store uses it to make sure your product is on the shelf.' });
  }
  const productCheck = validateProducts(body.product_skus, 'booking');
  if (!productCheck.ok) {
    const code = productCheck.errors.some(e => e.code === 'required' && e.field === 'items') ? 'products_required' : 'invalid_products';
    return res.status(400).json({ error: code, message: code === 'products_required' ? 'Select at least one item you will be sampling.' : 'Check the items you selected: ' + describeErrors(productCheck.errors) + '.', errors: productCheck.errors });
  }
  const productSnapshot = productCheck.items;

  // 4) create the booking, server sets tenant/brand/state; slot trigger enforces capacity
  const payload = { retailer_id: retailer.id, venue_id: venue.id, brand_id: auth.brandId,
    brand_name: brand.company_name || null, contact_name: brand.contact_name || null, contact_email: auth.email, contact_phone: brand.phone || null,
    demo_date: body.demo_date, demo_time: slot.time, duration_hours: slot.hours,
    product: (body.product||null), notes: (body.notes||null), product_skus: productSnapshot,
    needs_electricity: needsElectricity,
    status: provisional ? 'held' : 'pending_payment',
    held_expires_at: provisional ? new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() : null,
    payment_status: 'unpaid', amount_paid: Math.round(Number(venue.demo_fee||0)*100) };
  let r = await rest('bookings', { method:'POST', headers:{Prefer:'return=representation'}, body: JSON.stringify(payload) });
  if (!r.ok) {
    let t = await r.text();
    // Slot contention (provisional holds): a VERIFIED brand booking a full slot may bump a 'held'
    // provisional hold, insured/confirmed beats provisional by design (the held brand was told so
    // in the hold email). Bump = release the newest hold (cancel auth, 'expired', notify) and retry.
    // Provisional bookers never bump anyone.
    if (t.includes('slot_full') && FLAGS.provisionalHolds && cov.covered) {
      const { releaseHeldBooking } = await import('./_provisional.js');
      for (let attempt = 0; attempt < 3 && !r.ok && t.includes('slot_full'); attempt++) {
        const held = await rest(`bookings?venue_id=eq.${encodeURIComponent(venue.id)}&demo_date=eq.${encodeURIComponent(body.demo_date)}&demo_time=eq.${encodeURIComponent(slot.time)}&status=eq.held&select=id,status,payment_status,payment_intent_id,contact_email&order=created_at.desc&limit=1`);
        const victim = held.ok ? (await held.json())[0] : null;
        if (!victim) break;
        const rel = await releaseHeldBooking(victim, { target: 'expired', reason: 'bumped_by_verified_booking', notify: true, bumped: true });
        if (!rel.ok) { console.warn('contention bump failed for', victim.id, rel.error); break; }
        // P0-1: if the victim was CAPTURED at this instant (rel.was_captured), it converged to PAID and
        // now occupies the slot as a confirmed demo, the bump did not free space. The retry below will
        // re-fail slot_full; the next loop re-queries status=eq.held, which excludes this now-paid row,
        // so it either bumps a different still-held hold or exits and returns slot_full. No extra branch
        // needed, just do not treat was_captured as a freed slot.
        r = await rest('bookings', { method:'POST', headers:{Prefer:'return=representation'}, body: JSON.stringify(payload) });
        if (!r.ok) t = await r.text();
      }
    }
    if (!r.ok) {
      if (t.includes('slot_full')) return res.status(409).json({ error: 'slot_full' });
      // The venue's offering changed between our read and the insert (blackout added, slot
      // removed): the database refused under the venue lock. Same vocabulary, 409 because the
      // request was valid when quoted.
      const dbRefusal = slotRefusalFromDbError(t);
      if (dbRefusal) return res.status(409).json({ error: dbRefusal, message: SLOT_REFUSAL_MESSAGES[dbRefusal] });
      return res.status(500).json({ error: 'booking_failed' });
    }
  }
  const booking = (await r.json())[0];
  return res.status(200).json({ ok: true, booking_id: booking.id, next: 'checkout' });
}
