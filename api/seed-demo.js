// /api/seed-demo — Seeds the live demo tenant (Harvest Lane Market).
// Idempotent: safe to call multiple times, will only create rows if missing.
// Also supports ?reset=true to wipe & re-seed, called by a nightly Vercel cron.
//
// The demo tenant is a read-only account visitors can poke around to see the
// retailer admin experience. Writes are blocked in /api/admin (see is_demo check).
// Email/SMS/Stripe are all skipped for demo tenant activity.
//
// Env required:
//   SUPABASE_SERVICE_KEY
//   SEED_SECRET  (any strong random string; required in body to prevent abuse)

const SUPABASE_URL = 'https://ecapmcyumpjjgjwuokyv.supabase.co';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const SEED_SECRET = process.env.SEED_SECRET;

const DEMO_SLUG = 'harvest-lane-demo';
const DEMO_NAME = 'Harvest Lane Market';
const DEMO_EMAIL = 'demo@demohubhq.com';

// Canonical fictional data (matches homepage tour + mockups)
const DEMO_STORES = [
  { name: 'Elm Street',      demo_fee: 35, address: '412 Elm St, Portland, OR 97205',        display_order: 1 },
  { name: 'Riverside',       demo_fee: 30, address: '1820 Riverside Dr, Portland, OR 97202',  display_order: 2 },
  { name: 'Old Mill',        demo_fee: 30, address: '77 Old Mill Rd, Portland, OR 97219',     display_order: 3 },
  { name: 'Parkside',        demo_fee: 40, address: '350 Parkside Ave, Portland, OR 97214',   display_order: 4 },
  { name: 'Depot District',  demo_fee: 35, address: '1201 Depot St, Portland, OR 97210',      display_order: 5 },
];

const DEMO_BRANDS = [
  'Cedar & Sage Kombucha',
  'Golden Hour Granola',
  'Peak Provisions Jerky',
  'Bluebell Creamery',
  'Sundial Coffee Co.',
  'Marigold Snacks',
  'North Fork Hot Sauce',
];

const DEMO_TEAM = [
  { name: 'Dana Whitfield', email: 'dana@harvest-lane-demo.example', role: 'owner' },
  { name: 'Marcus Lee',     email: 'marcus@harvest-lane-demo.example', role: 'admin' },
  { name: 'Priya Nair',     email: 'priya@harvest-lane-demo.example', role: 'viewer' },
];

async function sb(path, opts = {}) {
  const headers = {
    apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`,
    'Content-Type': 'application/json', Prefer: 'return=representation',
    ...(opts.headers || {}),
  };
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { ...opts, headers });
  const text = await r.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch(_) {}
  if (!r.ok) throw new Error((json && json.message) || text || `HTTP ${r.status}`);
  return json;
}

// Build a Monday-based upcoming demo schedule (fictional but plausible).
// Returns rows for the `demos` table with retailer_id/venue_id placeholders.
function buildDemos(retailerId, venuesBySlug) {
  const now = new Date();
  // Next Monday
  const day = now.getDay();
  const daysToMon = ((8 - day) % 7) || 7;
  const mon = new Date(now.getFullYear(), now.getMonth(), now.getDate() + daysToMon);
  const iso = (d) => d.toISOString().slice(0, 10);
  const rows = [
    { store: 'Elm Street',     day: 0, time: '11:00 AM', brand: 'Cedar & Sage Kombucha', product: 'Ginger kombucha', status: 'confirmed', fee: 35 },
    { store: 'Depot District', day: 2, time: '10:00 AM', brand: 'Sundial Coffee Co.',    product: 'Cold brew tasting', status: 'confirmed', fee: 35 },
    { store: 'Riverside',      day: 2, time: '3:00 PM',  brand: 'Bluebell Creamery',     product: 'Small-batch ice cream', status: 'confirmed', fee: 30 },
    { store: 'Old Mill',       day: 3, time: '11:00 AM', brand: 'Peak Provisions Jerky', product: 'Original & spicy jerky', status: 'confirmed', fee: 30 },
    { store: 'Parkside',       day: 3, time: '3:00 PM',  brand: 'Marigold Snacks',       product: 'Herb crackers', status: 'confirmed', fee: 40 },
    { store: 'Depot District', day: 4, time: '11:00 AM', brand: 'Cedar & Sage Kombucha', product: 'Ginger kombucha', status: 'confirmed', fee: 35 },
    { store: 'Elm Street',    day: 5, time: '10:00 AM', brand: 'North Fork Hot Sauce', product: 'Habanero + carrot',     status: 'confirmed', fee: 35 },
    { store: 'Riverside',     day: 5, time: '11:00 AM', brand: 'Bluebell Creamery',    product: 'Small-batch ice cream', status: 'confirmed', fee: 30 },
    { store: 'Old Mill',      day: 5, time: '3:00 PM',  brand: 'Peak Provisions Jerky', product: 'Original & spicy jerky', status: 'confirmed', fee: 30 },
    { store: 'Depot District', day: 6, time: '1:00 PM', brand: 'Golden Hour Granola',  product: 'Vanilla clusters',      status: 'confirmed', fee: 35 },
  ];
  return rows.map(r => {
    const d = new Date(mon.getFullYear(), mon.getMonth(), mon.getDate() + r.day);
    const venue = venuesBySlug.get(r.store);
    return {
      retailer_id: retailerId,
      venue_id: venue ? venue.id : null,
      company_name: r.brand,
      contact_name: 'Demo brand rep',
      product: r.product,
      demo_date: iso(d),
      demo_time: r.time,
      duration_hours: 3,
      status: r.status,
      demo_fee: r.fee,
    };
  });
}

async function findExistingDemo() {
  const rows = await sb(`retailers?slug=eq.${encodeURIComponent(DEMO_SLUG)}&select=id,slug,name,is_demo`);
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

async function wipeExistingDemo(retailerId) {
  // Order matters: clear child tables first
  const children = ['bookings', 'demos', 'compliance_records', 'internal_contacts', 'brand_contacts', 'settings', 'venues'];
  for (const t of children) {
    try {
      await sb(`${t}?retailer_id=eq.${encodeURIComponent(retailerId)}`, { method: 'DELETE' });
    } catch (e) { console.warn('wipe', t, 'failed:', (e && e.message) || e); }
  }
}

async function ensureRetailer() {
  const existing = await findExistingDemo();
  if (existing) return existing;
  const created = await sb('retailers', {
    method: 'POST',
    body: JSON.stringify({
      slug: DEMO_SLUG,
      name: DEMO_NAME,
      email: DEMO_EMAIL,
      description: 'A live demo of Demohub retailer admin. Read-only, nightly reset.',
      is_demo: true,
      auto_confirm_bookings: true,
      cancellation_mode: 'refundable',
      demo_policy: 'Arrive 15 minutes before your slot to set up. Bring sampling supplies (cups, napkins, ice if needed). Coordinate with the floor lead on arrival. Keep the demo area clean, present products in branded packaging only, and break down promptly at end of slot.',
      cancellation_policy: 'Cancellations accepted up to 48 hours before the demo. After that, fees are non-refundable. Reschedules welcome anytime.',
    }),
  });
  return Array.isArray(created) ? created[0] : null;
}

async function seed(retailerId, opts = {}) {
  // Venues (5 stores)
  const createdVenues = [];
  for (const s of DEMO_STORES) {
    const row = await sb('venues', {
      method: 'POST',
      body: JSON.stringify({
        retailer_id: retailerId,
        name: s.name,
        demo_fee: s.demo_fee,
        address: s.address,
        display_order: s.display_order,
        active: true,
        max_demos_per_slot: 1,
      }),
    });
    if (Array.isArray(row) && row[0]) createdVenues.push(row[0]);
  }
  const venuesBySlug = new Map(createdVenues.map(v => [v.name, v]));

  // Settings
  await sb('settings', {
    method: 'POST',
    body: JSON.stringify({
      retailer_id: retailerId,
      demo_fee: 30,
      demo_duration: '3 hours',
      advance_booking_days: 60,
    }),
  }).catch(e => console.warn('settings insert:', (e && e.message) || e));

  // Team (internal contacts) — with scoped venue IDs on Marcus
  const marcusVenues = createdVenues.filter(v => v.name === 'Riverside' || v.name === 'Depot District').map(v => v.id);
  for (const t of DEMO_TEAM) {
    await sb('internal_contacts', {
      method: 'POST',
      body: JSON.stringify({
        retailer_id: retailerId,
        name: t.name,
        email: t.email,
        role: t.role,
        venue_ids: t.name === 'Marcus Lee' ? marcusVenues : [],
        notification_prefs: { on_scheduled: true, on_cancelled: true, monthly_summary: t.role === 'owner' },
      }),
    }).catch(e => console.warn('team insert:', (e && e.message) || e));
  }

  // Brand contacts (7 fictional brands)
  for (const b of DEMO_BRANDS) {
    await sb('brand_contacts', {
      method: 'POST',
      body: JSON.stringify({
        retailer_id: retailerId,
        name: b + ' (demo)',
        company: b,
        email: b.toLowerCase().replace(/[^a-z0-9]+/g, '-') + '@example.com',
        phone: '(555) 812-4409',
      }),
    }).catch(e => console.warn('brand_contact insert:', (e && e.message) || e));
  }

  // Compliance records (COIs — one current, one expiring in 14 days for the tour visual)
  const soon = new Date(); soon.setDate(soon.getDate() + 14);
  const later = new Date(); later.setDate(later.getDate() + 180);
  const isoDate = d => d.toISOString().slice(0, 10);
  const compRows = [
    { brand: 'Bluebell Creamery',     status: 'current',        expires: isoDate(later) },
    { brand: 'Peak Provisions Jerky', status: 'expiring_soon',  expires: isoDate(soon) },
    { brand: 'Marigold Snacks',       status: 'current',        expires: isoDate(later) },
    { brand: 'Cedar & Sage Kombucha', status: 'current',        expires: isoDate(later) },
  ];
  for (const c of compRows) {
    await sb('compliance_records', {
      method: 'POST',
      body: JSON.stringify({
        retailer_id: retailerId,
        brand_name: c.brand,
        record_type: 'coi',
        status: c.status,
        expires_at: c.expires,
      }),
    }).catch(e => console.warn('compliance insert:', (e && e.message) || e));
  }

  // Demos (upcoming week schedule)
  const demoRows = buildDemos(retailerId, venuesBySlug);
  for (const d of demoRows) {
    await sb('demos', { method: 'POST', body: JSON.stringify(d) }).catch(e => console.warn('demo insert:', (e && e.message) || e));
  }

  return {
    retailer_id: retailerId,
    venues_created: createdVenues.length,
    team_created: DEMO_TEAM.length,
    brand_contacts_created: DEMO_BRANDS.length,
    compliance_records_created: compRows.length,
    demos_created: demoRows.length,
  };
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-vercel-cron');
    return res.status(204).end();
  }
  if (req.method !== 'POST' && req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!SERVICE_KEY) return res.status(500).json({ error: 'SUPABASE_SERVICE_KEY not configured' });
  if (!SEED_SECRET) return res.status(500).json({ error: 'SEED_SECRET not configured' });

  // Auth: the SEED_SECRET (manual calls) OR a real Vercel cron identity. DH-07: the bare
  // x-vercel-cron header is client-spoofable, so it is NO LONGER sufficient on its own. Vercel
  // signs genuine cron invocations with `Authorization: Bearer <CRON_SECRET>` once CRON_SECRET
  // is set in the project env — that is what we trust here.
  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  const cronSecret = process.env.CRON_SECRET;
  const isVercelCron = !!cronSecret && (req.headers['authorization'] || '') === 'Bearer ' + cronSecret;
  const bodySecret = body.secret || req.query?.secret;
  const authorized = (bodySecret && bodySecret === SEED_SECRET) || isVercelCron;
  if (!authorized) return res.status(401).json({ error: 'Unauthorized (need SEED_SECRET or a signed Vercel cron request)' });

  const reset = body.reset === true || req.query?.reset === 'true' || isVercelCron;

  try {
    let retailer = await findExistingDemo();
    if (retailer && reset) {
      await wipeExistingDemo(retailer.id);
    } else if (retailer && !reset) {
      return res.status(200).json({ ok: true, message: 'Demo tenant already exists (pass reset=true to re-seed)', retailer });
    }
    if (!retailer) retailer = await ensureRetailer();
    if (!retailer) return res.status(500).json({ error: 'Failed to create demo retailer' });
    const summary = await seed(retailer.id);
    return res.status(200).json({
      ok: true,
      reset,
      retailer,
      summary,
      view_url: `https://www.demohubhq.com/r/${DEMO_SLUG}`,
    });
  } catch (e) {
    console.error('seed-demo error:', e);
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
}
