// api/book.js — F5-05 secure booking endpoint. Composes the proven engines:
// identity from the SESSION (not a typed email), COI must be VERIFIED, slot capacity enforced
// by the DB trigger, server owns tenant/brand/amount. Replaces the anonymous email-based booking.
import { requireBrandSession } from './_booking-identity.js';
import { coiCovered } from './_coi-coverage.js';
import { FLAGS } from './_flags.js';
import { getBinding, sendBindingFailure } from './_env.js';
import { requireSameOrigin } from './_csrf.js';
import { parseYmd, parseDemoTime, localDateOf, shiftYmd, ymdString, safeZone } from './_local-time.js';
import { resolveRequestedSlot, SLOT_REFUSAL_MESSAGES, slotRefusalFromDbError } from './_slots.js';
import { normalizeCode, CODE_MESSAGES } from './_booking-codes.js';
let _b = null;
const rest=(p,o={})=>fetch(`${_b.supabaseUrl}/rest/v1/${p}`,{...o,headers:{apikey:_b.serviceKey,Authorization:`Bearer ${_b.serviceKey}`,'Content-Type':'application/json',...(o.headers||{})}});
const one=async(p)=>{const r=await rest(p);return r.ok?(await r.json())[0]:null;};
const rpc=async(fn,args)=>{const r=await rest(`rpc/${fn}`,{method:'POST',body:JSON.stringify(args)});if(!r.ok)throw new Error(`${fn}: ${r.status} ${(await r.text()).slice(0,200)}`);const j=await r.json();return Array.isArray(j)?j[0]:j;};

// Booking codes (0085): the advance-booking minimum is a retailer setting (settings.advance_booking_days, default
// 14) counted in whole retailer-local calendar days from today. Earliest allowed date = today + N. A code with
// waives_lead_time is the only way past it; nothing ever allows a date before today.
export function earliestBookableYmd(now, tz, advanceDays) {
  const n = Number.isInteger(advanceDays) && advanceDays >= 0 ? advanceDays : 14;
  return ymdString(shiftYmd(localDateOf(now, safeZone(tz)), n));
}

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
  const retailer = await one(`retailers?slug=eq.${encodeURIComponent(String(body.retailer_slug||''))}&select=id,slug,timezone`);
  if (!retailer) return res.status(404).json({ error: 'retailer_not_found' });
  const venue = await one(`venues?id=eq.${encodeURIComponent(String(body.venue_id||''))}&select=id,retailer_id,active,demo_fee,availability`);
  if (!venue || venue.retailer_id !== retailer.id) return res.status(400).json({ error: 'invalid_venue' });
  if (venue.active === false) return res.status(400).json({ error: 'venue_inactive' });
  if (!body.demo_date || !body.demo_time) return res.status(400).json({ error: 'date_time_required' });
  if (!parseYmd(String(body.demo_date))) return res.status(400).json({ error: 'invalid_demo_date', message: 'demo_date must be a real calendar date (YYYY-MM-DD).' });
  if (!parseDemoTime(String(body.demo_time))) return res.status(400).json({ error: 'invalid_demo_time', message: 'demo_time must be a time such as "11:00 AM" or "13:00".' });
  // Release B: the requested time must be a slot this location OFFERS on that date (configured
  // slots, weekday hours, blackouts). The canonical spelling and the configured length are what get
  // stored — the browser never picks a storage label, a duration or an end time. The database
  // re-runs the same check under the venue lock (booking_slot_resolve, 0075); this is the early,
  // precise refusal.
  const slot = resolveRequestedSlot(venue.availability, String(body.demo_date), String(body.demo_time), retailer.timezone);
  if (!slot.ok) {
    return res.status(slot.reason === 'slot_config_invalid' ? 503 : 400).json({ error: slot.reason, message: SLOT_REFUSAL_MESSAGES[slot.reason] || 'That time is not available.' });
  }
  // Release A: electricity is a TYPED per-booking value. true/false from the form's toggle, absent
  // -> null ("Not specified"). Anything else is refused — never parsed out of the notes text.
  if (body.needs_electricity !== undefined && body.needs_electricity !== null && typeof body.needs_electricity !== 'boolean') {
    return res.status(400).json({ error: 'invalid_needs_electricity', message: 'needs_electricity must be true or false.' });
  }
  const needsElectricity = typeof body.needs_electricity === 'boolean' ? body.needs_electricity : null;

  // 2b) Booking code (0085): previewed here so a bad code is refused before anything is written, and so a
  // short-notice code can lift the lead-time rule below. Redeemed (counted) only after the booking row exists.
  let codeInfo = null;
  if (body.booking_code !== undefined && body.booking_code !== null && String(body.booking_code).trim() !== '') {
    const norm = normalizeCode(body.booking_code);
    if (!norm) return res.status(400).json({ error: 'code_invalid_format', message: CODE_MESSAGES.code_invalid_format });
    const chk = await rpc('booking_code_check', { p_code: norm, p_retailer_id: retailer.id });
    if (!chk || !chk.ok) return res.status(400).json({ error: (chk && chk.reason) || 'code_not_found', message: CODE_MESSAGES[(chk && chk.reason) || 'code_not_found'] });
    codeInfo = { code: norm, waives_fee: !!chk.waives_fee, waives_lead_time: !!chk.waives_lead_time };
  }

  // 2c) Advance-booking minimum (0085): settings.advance_booking_days, counted in retailer-local calendar days.
  // Before today is never allowed; inside the minimum is allowed only with a short-notice code.
  const settings = await one(`settings?retailer_id=eq.${encodeURIComponent(retailer.id)}&select=advance_booking_days`);
  const advanceDays = settings && Number.isInteger(settings.advance_booking_days) ? settings.advance_booking_days : 14;
  const todayYmd = earliestBookableYmd(new Date(), retailer.timezone, 0);
  const earliestYmd = earliestBookableYmd(new Date(), retailer.timezone, advanceDays);
  if (String(body.demo_date) < todayYmd) return res.status(400).json({ error: 'date_in_past', message: 'That date has already passed.' });
  if (String(body.demo_date) < earliestYmd && !(codeInfo && codeInfo.waives_lead_time)) {
    return res.status(400).json({ error: 'lead_time_required', message: `This store needs ${advanceDays} days' notice — the earliest date is ${earliestYmd}. A short-notice code from the store lifts this.`, earliest_date: earliestYmd, advance_booking_days: advanceDays });
  }

  // 3) COI must be VERIFIED for the authenticated brand
  const brand = await one(`brands?id=eq.${encodeURIComponent(auth.brandId)}&select=default_coi_url,default_coi_expires,coi_verification_status,company_name,contact_name,email,phone`);
  const cov = coiCovered(brand, body.demo_date);
  // Provisional holds (behind PROVISIONAL_HOLDS_ENABLED): a brand may book WITHOUT a verified COI —
  // the booking becomes 'held' (funds authorized, not captured) with a 24h window to get COI-verified
  // + confirmed, else the hold is released. Flag OFF = current hard gate (COI required to book).
  const provisional = FLAGS.provisionalHolds && !cov.covered;
  if (!cov.covered && !FLAGS.provisionalHolds) return res.status(400).json({ error: 'coi_required', reason: cov.reason });
  // A provisional (held) booking exists to authorize funds while the COI is reviewed; with the fee waived there is
  // nothing to hold, and a free unreviewed booking is a different feature (not asked for). So: fee waiver needs a
  // verified COI. Short-notice-only codes work on held bookings like any other.
  if (provisional && codeInfo && codeInfo.waives_fee) return res.status(400).json({ error: 'coi_required_for_free_booking', reason: cov.reason, message: 'A no-fee code needs a verified Certificate of Insurance on file first.' });

  // 3b) Contact info (name + phone) required to book — retailers must be able to reach the brand.
  if (!brand.contact_name || !String(brand.contact_name).trim() || !brand.phone || !String(brand.phone).trim()) {
    return res.status(400).json({ error: 'contact_required', reason: 'missing_contact_name_or_phone' });
  }

  // 4) create the booking — server sets tenant/brand/state; slot trigger enforces capacity
  const payload = { retailer_id: retailer.id, venue_id: venue.id, brand_id: auth.brandId,
    brand_name: brand.company_name || null, contact_name: brand.contact_name || null, contact_email: auth.email, contact_phone: brand.phone || null,
    demo_date: body.demo_date, demo_time: slot.time, duration_hours: slot.hours,
    product: (body.product||null), notes: (body.notes||null), product_skus: (body.product_skus||null),
    needs_electricity: needsElectricity,
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
        const held = await rest(`bookings?venue_id=eq.${encodeURIComponent(venue.id)}&demo_date=eq.${encodeURIComponent(body.demo_date)}&demo_time=eq.${encodeURIComponent(slot.time)}&status=eq.held&select=id,status,payment_status,payment_intent_id,contact_email&order=created_at.desc&limit=1`);
        const victim = held.ok ? (await held.json())[0] : null;
        if (!victim) break;
        const rel = await releaseHeldBooking(victim, { target: 'expired', reason: 'bumped_by_verified_booking', notify: true, bumped: true });
        if (!rel.ok) { console.warn('contention bump failed for', victim.id, rel.error); break; }
        // P0-1: if the victim was CAPTURED at this instant (rel.was_captured), it converged to PAID and
        // now occupies the slot as a confirmed demo — the bump did not free space. The retry below will
        // re-fail slot_full; the next loop re-queries status=eq.held, which excludes this now-paid row,
        // so it either bumps a different still-held hold or exits and returns slot_full. No extra branch
        // needed — just do not treat was_captured as a freed slot.
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

  // 5) Redeem the code against the row that now exists (one transaction under the code's lock). A race for the
  // last use is refused here; the just-created, unpaid booking is then withdrawn so nothing dangles.
  if (codeInfo) {
    let red = null;
    try { red = await rpc('booking_code_redeem', { p_code: codeInfo.code, p_retailer_id: retailer.id, p_booking_id: booking.id, p_brand_id: auth.brandId }); } catch (e) { console.error('booking_code_redeem failed', e.message); }
    if (!red || !red.ok) {
      await rest(`bookings?id=eq.${encodeURIComponent(booking.id)}&status=eq.${provisional ? 'held' : 'pending_payment'}&payment_status=eq.unpaid`, { method: 'DELETE' });
      const reason = (red && red.reason) || 'code_not_found';
      return res.status(409).json({ error: reason, message: CODE_MESSAGES[reason] || 'That code could not be applied.' });
    }
    // A fee waiver is only meaningful for a pending_payment booking; a provisional (held) booking has no fee to
    // waive yet, and the redeem RPC refuses it as booking_not_redeemable. That path is closed at 2b: a code with
    // waives_fee is not accepted for a brand without a verified COI.
    if (red.waived_fee) return res.status(200).json({ ok: true, booking_id: booking.id, next: 'confirmed', fee_waived: true, target_status: red.target_status, code_applied: codeInfo.code });
    return res.status(200).json({ ok: true, booking_id: booking.id, next: 'checkout', fee_waived: false, code_applied: codeInfo.code });
  }
  return res.status(200).json({ ok: true, booking_id: booking.id, next: 'checkout' });
}
