// /api/find-retailer
// Two actions:
//   - existence check: GET ?slug=... or POST {slug} → { ok, name }
//   - public-data (Privacy Phase 0): POST {action:"public-data", slug} → sanitized
//     payload for the public booking page. Server-side, uses SERVICE key, returns
//     ONLY safe public fields (no PII, no contacts, no compliance docs).

const SUPABASE_URL = 'https://ecapmcyumpjjgjwuokyv.supabase.co';
const SUPABASE_KEY = 'sb_publishable__e8tiRc5-f7Wexa-r1Perg_hJ84vltF';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

async function sb(path, useService = false) {
  const key = useService ? SERVICE_KEY : SUPABASE_KEY;
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  });
  const text = await r.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch(_) {}
  if (!r.ok) throw new Error(json?.message || text || `HTTP ${r.status}`);
  return json;
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(204).end();
  }
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  let body = {};
  if (req.method === 'POST') {
    try { body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}); } catch (_) {}
  }
  const action = body.action || '';
  const slug = String(body.slug || req.query?.slug || '').trim().toLowerCase();
  if (!slug || !/^[a-z0-9-]+$/.test(slug)) return res.status(400).json({ error: 'invalid slug' });

  try {
    // ---- ACTION: public-data — sanitized read for /r/{slug} booking page ----
    if (action === 'public-data') {
      if (!SERVICE_KEY) return res.status(500).json({ error: 'service key not configured' });
      // Whitelist of safe retailer columns. Explicitly excludes: billing_email,
      // stripe_customer_id, stripe_subscription_id, billing_status, billing_tier,
      // billing_period_*, welcome_day0_sent_at, and any email field.
      const retailerCols = 'id,slug,name,branding,demo_policy,cancellation_policy,logo_url,booking_advance_days';
      const rets = await sb(`retailers?slug=eq.${encodeURIComponent(slug)}&select=${retailerCols}`, true);
      const retailer = Array.isArray(rets) ? rets[0] : null;
      if (!retailer) return res.status(404).json({ error: 'not found' });
      const rid = retailer.id;

      // Venues: safe public columns only, active only, ordered for display
      const venueCols = 'id,name,address,availability,max_demos_per_slot,display_order';
      const venues = await sb(`venues?retailer_id=eq.${encodeURIComponent(rid)}&active=eq.true&select=${venueCols}&order=display_order`, true);

      // Capacity snapshot from bookings + demos — venue_id + demo_date + demo_time + status only,
      // NO contact info / email / phone / brand name. Pure aggregate input for slot capacity calc.
      const bookings = await sb(`bookings?retailer_id=eq.${encodeURIComponent(rid)}&select=venue_id,demo_date,demo_time,status`, true);
      const demos = await sb(`demos?retailer_id=eq.${encodeURIComponent(rid)}&select=venue_id,demo_date,demo_time,status`, true);

      // Settings: a few safe public fields (advance booking, demo fee — for display)
      const settingsAll = await sb(`settings?retailer_id=eq.${encodeURIComponent(rid)}&select=demo_fee,demo_duration,advance_booking_days&limit=1`, true);
      const settings = Array.isArray(settingsAll) ? (settingsAll[0] || null) : null;

      return res.status(200).json({
        ok: true,
        retailer,
        venues: venues || [],
        bookings: bookings || [],
        demos: demos || [],
        settings,
      });
    }

    // ---- DEFAULT ACTION: existence check (unchanged behavior for /signin) ----
    const r = await sb(`retailers?slug=eq.${encodeURIComponent(slug)}&select=name`);
    if (!Array.isArray(r) || r.length === 0) return res.status(404).json({ error: 'not found' });
    return res.status(200).json({ ok: true, name: r[0].name });
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
}
