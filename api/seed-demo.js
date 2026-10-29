// /api/seed-demo, Seeds the live demo tenant (Harvest Lane Market).
// Idempotent: safe to call multiple times. ?reset=true (or the nightly Vercel cron) wipes the
// tenant's bookings, demos and contacts and lays the sample month down again.
//
// The demo tenant is the store David shows prospects: a public booking page with open slots and
// no demo fee (so a demo can be booked end to end without a card), a store admin with a full
// calendar, store contacts with notification settings, two brand accounts with product lists,
// and the staff calendar page. Admin data writes stay blocked by /api/admin (is_demo check);
// bookings, confirmations and the brand portal work for real so a live walkthrough is real.
//
// Mail: seeded bookings are inserted already confirmed, which makes the outbox trigger queue a
// "demo confirmed" event for every one of them. Those events are deleted here before the worker
// can fan them out, so a nightly reseed never emails anyone. A demo booked live on the page is
// a normal booking: its confirmation and reminders go to the store contacts, which are plus
// addresses on one mailbox (DEMO_MAILBOX, default demo@demohubhq.com).
//
// Env required:
//   SUPABASE_SERVICE_KEY
//   SEED_SECRET  (any strong random string; required in body to prevent abuse)
// Optional:
//   DEMO_MAILBOX      mailbox that owns the demo tenant and every contact address (plus-tagged)
//   DEMO_ADMIN_EMAIL  the real person who signs in to the demo store admin (retailer_admins owner)

import { getBinding, sendBindingFailure, link } from './_env.js';
let _b = null;
const SEED_SECRET = process.env.SEED_SECRET;

const DEMO_SLUG = 'harvest-lane-demo';
const DEMO_NAME = 'Harvest Lane Market';
const DEMO_TZ = 'America/Los_Angeles';
const DEMO_MAILBOX = String(process.env.DEMO_MAILBOX || 'demo@demohubhq.com').trim().toLowerCase();
const DEMO_ADMIN_EMAIL = String(process.env.DEMO_ADMIN_EMAIL || 'david@demohubhq.com').trim().toLowerCase();
// demo+dana@demohubhq.com style: every fictional person is a plus tag on the one real mailbox.
const tagged = (tag) => { const i = DEMO_MAILBOX.indexOf('@'); return i < 1 ? DEMO_MAILBOX : `${DEMO_MAILBOX.slice(0, i)}+${tag}@${DEMO_MAILBOX.slice(i + 1)}`; };

const DEMO_POLICY = 'Arrive 15 minutes before your slot to set up at the demo table by the front registers. Bring your own sampling supplies: cups, napkins, toothpicks, a cooler with ice if your product needs it. Check in with the floor lead on arrival. Sample only the items on your booking, keep the table tidy, and break down at the end of the slot. Alcohol, open flame and raw animal products are not demoed without written approval.';
// The same default sentence the booking route and the admin write (tests/cancellation_policy_text).
const CANCELLATION_POLICY = 'Cancel at least 72 hours before your demo for a refund. Inside 72 hours the fee is not refunded, because the store has usually already ordered product for you. Please cancel as early as you can, ideally a week ahead. Reschedules are welcome anytime.';

// Two three-hour slots a day, every day. Matches the 11:00 AM and 3:00 PM demo times below.
const allDays = (windows) => Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map(d => [String(d), windows]));
const AVAILABILITY = { schedule: allDays([{ open: '09:00', close: '20:00' }]), slots: [{ start: '11:00', hours: 3 }, { start: '15:00', hours: 3 }], blackouts: [] };

// Canonical fictional data (matches homepage tour + mockups). Fee 0: the demo store charges nothing.
const DEMO_STORES = [
  { name: 'Elm Street',      address: '412 Elm St, Portland, OR 97205',         display_order: 1 },
  { name: 'Riverside',       address: '1820 Riverside Dr, Portland, OR 97202',  display_order: 2 },
  { name: 'Old Mill',        address: '77 Old Mill Rd, Portland, OR 97219',     display_order: 3 },
  { name: 'Parkside',        address: '350 Parkside Ave, Portland, OR 97214',   display_order: 4 },
  { name: 'Depot District',  address: '1201 Depot St, Portland, OR 97210',      display_order: 5 },
];

// Brands. The first two have real brand accounts (sign-in code goes to the demo mailbox); the
// rest only exist as names on demos and in the store's Brands tab.
const DEMO_BRANDS = [
  { company: 'Golden Hour Granola', contact: 'Maya Lindqvist', phone: '(503) 555-0142', account: 'goldenhour', categories: 'Snacks', product: 'Granola and oat clusters',
    items: [
      { id: 'ghg-1', name: 'Maple Pecan Granola', size: '11 oz', sku: 'GHG-001', upc: '850012340011', distributor: 'unfi', distributor_item_number: '0045001', case_pack: 6 },
      { id: 'ghg-2', name: 'Cherry Almond Clusters', size: '10 oz', sku: 'GHG-004', upc: '850012340042', distributor: 'unfi', distributor_item_number: '0045004', case_pack: 6 },
      { id: 'ghg-3', name: 'Dark Chocolate Sea Salt Granola', size: '11 oz', sku: 'GHG-007', upc: '850012340073', distributor: 'kehe', distributor_item_number: '7790073', case_pack: 6 },
    ] },
  { company: 'North Fork Hot Sauce', contact: 'Teo Alvarez', phone: '(503) 555-0177', account: 'northfork', categories: 'Condiments', product: 'Hot sauce',
    items: [
      { id: 'nf-1', name: 'Habanero Carrot Hot Sauce', size: '5 oz', sku: 'NF-01', upc: '850098760011', distributor: 'kehe', distributor_item_number: '7781201', case_pack: 12 },
      { id: 'nf-2', name: 'Smoked Jalapeno Hot Sauce', size: '5 oz', sku: 'NF-02', upc: '850098760028', distributor: 'kehe', distributor_item_number: '7781202', case_pack: 12 },
    ] },
  { company: 'Cedar & Sage Kombucha', contact: 'Rowan Blake', phone: '(503) 555-0118', product: 'Kombucha',
    items: [{ name: 'Ginger Lemon Kombucha', size: '12 oz', upc: '850055550012', distributor: 'unfi', distributor_item_number: '0046012', case_pack: 12 }] },
  { company: 'Peak Provisions Jerky', contact: 'Sam Okafor', phone: '(503) 555-0163', product: 'Beef jerky',
    items: [{ name: 'Original Beef Jerky', size: '3 oz', upc: '850077770031', distributor: 'direct', case_pack: 12 }, { name: 'Spicy Beef Jerky', size: '3 oz', upc: '850077770048', distributor: 'direct', case_pack: 12 }] },
  { company: 'Bluebell Creamery', contact: 'Hannah Ruiz', phone: '(503) 555-0129', product: 'Small-batch ice cream',
    items: [{ name: 'Vanilla Bean Ice Cream', size: '1 pint', upc: '850033330016', distributor: 'unfi', distributor_item_number: '0047016', case_pack: 8 }] },
  { company: 'Sundial Coffee Co.', contact: 'Luis Herrera', phone: '(503) 555-0150', product: 'Cold brew',
    items: [{ name: 'Cold Brew Concentrate', size: '32 oz', upc: '850066660032', distributor: 'kehe', distributor_item_number: '7782032', case_pack: 6 }] },
  { company: 'Marigold Snacks', contact: 'Dana Park', phone: '(503) 555-0194', product: 'Herb crackers',
    items: [{ name: 'Rosemary Sea Salt Crackers', size: '4.5 oz', upc: '850044440045', distributor: 'unfi', distributor_item_number: '0048045', case_pack: 12 }] },
];

// Store contacts: who the store emails about demos, with their notification settings. All of
// them are plus tags on the demo mailbox, so a demo booked live lands in one real inbox.
const DEMO_TEAM = [
  { name: 'Dana Whitfield', role: 'Store Manager',     tag: 'dana',   venues: [],                              prefs: { on_confirmed: true, on_cancelled: true, on_rescheduled: true, reminders: ['w1', 'd3', 'morning_of'] } },
  { name: 'Marcus Lee',     role: 'Grocery Buyer',     tag: 'marcus', venues: ['Riverside', 'Depot District'], prefs: { on_confirmed: true, on_cancelled: true, on_rescheduled: true, reminders: ['w1', 'd3'] } },
  { name: 'Priya Nair',     role: 'Assistant Manager', tag: 'priya',  venues: ['Elm Street'],                  prefs: { on_confirmed: true, on_cancelled: true, on_rescheduled: false, reminders: ['d1', 'morning_of'] } },
];

// The sample month: day offsets from today, store, brand, slot. A few in the past so the
// Demos tab and Billing have history; the rest spread over the next five weeks.
const DEMO_PLAN = [
  [-9, 0, 0, '11:00 AM'], [-6, 2, 2, '3:00 PM'], [-2, 4, 3, '11:00 AM'],
  [1, 1, 1, '11:00 AM'], [2, 4, 5, '11:00 AM'], [4, 0, 2, '3:00 PM'], [6, 2, 0, '11:00 AM'], [8, 3, 4, '3:00 PM'],
  [9, 1, 6, '11:00 AM'], [11, 4, 0, '11:00 AM'], [13, 0, 1, '3:00 PM'], [15, 2, 5, '11:00 AM'], [16, 3, 0, '11:00 AM'],
  [18, 1, 2, '3:00 PM'], [20, 4, 3, '11:00 AM'], [23, 0, 6, '11:00 AM'], [25, 2, 1, '3:00 PM'], [27, 3, 4, '11:00 AM'],
  [30, 1, 0, '11:00 AM'], [32, 4, 2, '3:00 PM'],
];

async function sb(path, opts = {}) {
  const headers = {
    apikey: _b.serviceKey, Authorization: `Bearer ${_b.serviceKey}`,
    'Content-Type': 'application/json', Prefer: 'return=representation',
    ...(opts.headers || {}),
  };
  const r = await fetch(`${_b.supabaseUrl}/rest/v1/${path}`, { ...opts, headers });
  const text = await r.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch(_) {}
  if (!r.ok) throw new Error((json && json.message) || text || `HTTP ${r.status}`);
  return json;
}
const first = (rows) => (Array.isArray(rows) && rows[0]) ? rows[0] : null;
const enc = encodeURIComponent;

// Today in the store's zone, as YYYY-MM-DD, plus a day-offset helper.
function todayIn(tz) {
  const p = {}; for (const x of new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date())) p[x.type] = x.value;
  return `${p.year}-${p.month}-${p.day}`;
}
const addDays = (ymd, n) => new Date(Date.parse(ymd + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);

async function findExistingDemo() {
  return first(await sb(`retailers?slug=eq.${enc(DEMO_SLUG)}&select=id,slug,name,is_demo`));
}

// Everything the nightly reseed lays down again. Venues, settings, the admin membership and the
// staff calendar links are NOT wiped: they are upserted, so their ids (and any staff calendar
// link scoped to a location) stay stable from night to night.
async function wipeExistingDemo(retailerId) {
  const R = enc(retailerId);
  const del = async (path) => { try { await sb(path, { method: 'DELETE' }); } catch (e) { console.warn('wipe', path.split('?')[0], 'failed:', (e && e.message) || e); } };
  // Outbox rows first: a delivery for a booking that no longer exists is a worker error waiting to happen.
  await del(`notification_deliveries?retailer_id=eq.${R}`);
  await del(`notification_events?retailer_id=eq.${R}`);
  const ids = ((await sb(`bookings?retailer_id=eq.${R}&select=id`).catch(() => [])) || []).map(b => b.id).filter(Boolean);
  if (ids.length) {
    const inList = `in.(${ids.map(enc).join(',')})`;
    // Children that RESTRICT the booking delete. Free bookings have none; this is defensive.
    await del(`booking_fulfillments?booking_id=${inList}`);
    await del(`booking_code_redemptions?booking_id=${inList}`);
  }
  for (const t of ['demos', 'bookings', 'compliance_records', 'internal_contacts', 'brand_contacts']) await del(`${t}?retailer_id=eq.${R}`);
}

const RETAILER_FIELDS = () => ({
  name: DEMO_NAME,
  billing_email: DEMO_MAILBOX,
  is_demo: true,
  billing_tier: 'pro',   // the demo showcases the multi-store experience (venue-limit trigger: pro=999)
  auto_confirm_bookings: true,
  cancellation_mode: 'refundable',
  platform_keeps_all: true,   // no per-demo platform fee on top of the store's $0, so the cart reads $0 too
  timezone: DEMO_TZ,
  verification_status: 'approved',   // the booking page takes bookings only for an approved store
  demo_policy: DEMO_POLICY,
  cancellation_policy: CANCELLATION_POLICY,
  phone: '(503) 555-0100',
});

async function ensureRetailer() {
  const existing = await findExistingDemo();
  if (existing) {
    // Bring an older demo tenant up to this seed's shape (zone, approval, policies, mailbox).
    try { await sb(`retailers?id=eq.${enc(existing.id)}`, { method: 'PATCH', body: JSON.stringify(RETAILER_FIELDS()) }); }
    catch (e) { console.warn('retailer patch:', (e && e.message) || e); }
    return existing;
  }
  return first(await sb('retailers', { method: 'POST', body: JSON.stringify({ slug: DEMO_SLUG, ...RETAILER_FIELDS() }) }));
}

// The real person who signs in to the demo admin. Login codes are only sent to retailer_admins
// members, so without this row nobody can open the demo store's admin.
async function ensureAdmin(retailerId) {
  const existing = first(await sb(`retailer_admins?retailer_id=eq.${enc(retailerId)}&email_normalized=eq.${enc(DEMO_ADMIN_EMAIL)}&select=id,role`));
  if (existing) return existing;
  return first(await sb('retailer_admins', { method: 'POST', body: JSON.stringify({ retailer_id: retailerId, email: DEMO_ADMIN_EMAIL, email_normalized: DEMO_ADMIN_EMAIL, name: 'Demohub', role: 'owner' }) }));
}

// Venues are matched by name and patched in place, so their ids survive a reseed.
async function ensureVenues(retailerId) {
  const existing = (await sb(`venues?retailer_id=eq.${enc(retailerId)}&select=id,name,active`)) || [];
  const byName = new Map(existing.map(v => [v.name, v]));
  const out = [];
  for (const s of DEMO_STORES) {
    const fields = { name: s.name, address: s.address, display_order: s.display_order, demo_fee: 0, availability: AVAILABILITY, active: true, max_demos_per_slot: 1 };
    const have = byName.get(s.name);
    const row = have
      ? first(await sb(`venues?id=eq.${enc(have.id)}`, { method: 'PATCH', body: JSON.stringify(fields) }))
      : first(await sb('venues', { method: 'POST', body: JSON.stringify({ retailer_id: retailerId, ...fields }) }));
    if (row) out.push(row);
  }
  for (const v of existing) if (!DEMO_STORES.some(s => s.name === v.name) && v.active !== false) {
    await sb(`venues?id=eq.${enc(v.id)}`, { method: 'PATCH', body: JSON.stringify({ active: false }) }).catch(() => {});
  }
  return out;
}

async function ensureSettings(retailerId) {
  // advance_booking_days is the LEAD TIME (earliest bookable day), not the window: two days, so a
  // walkthrough can book something this week.
  const fields = { demo_fee: 0, demo_duration: '3 hours', advance_booking_days: 2 };
  const existing = first(await sb(`settings?retailer_id=eq.${enc(retailerId)}&select=id&limit=1`));
  if (existing) return sb(`settings?id=eq.${enc(existing.id)}`, { method: 'PATCH', body: JSON.stringify(fields) }).catch(e => console.warn('settings patch:', (e && e.message) || e));
  return sb('settings', { method: 'POST', body: JSON.stringify({ retailer_id: retailerId, ...fields }) }).catch(e => console.warn('settings insert:', (e && e.message) || e));
}

// Brand accounts for the two hero brands: sign-in code goes to demo+goldenhour@ / demo+northfork@.
// Matched by email; the product list is restored on every run so a walkthrough that edited it
// starts clean the next day.
async function ensureBrandAccounts() {
  const out = new Map();
  const expires = addDays(todayIn(DEMO_TZ), 400);
  for (const b of DEMO_BRANDS) {
    if (!b.account) continue;
    const email = tagged(b.account);
    const fields = { company_name: b.company, contact_name: b.contact, phone: b.phone, website: 'https://' + b.account + '.example.com', is_verified: true, default_coi_url: `demo/${b.account}-coi.pdf`, default_coi_expires: expires, coi_verification_status: 'approved', default_categories: b.categories || null, products: b.items };
    let row = first(await sb(`brands?email=ilike.${enc(email)}&select=id,email`).catch(() => null));
    if (row) await sb(`brands?id=eq.${enc(row.id)}`, { method: 'PATCH', body: JSON.stringify(fields) }).catch(e => console.warn('brand patch:', (e && e.message) || e));
    else row = first(await sb('brands', { method: 'POST', body: JSON.stringify({ email, ...fields }) }).catch(e => { console.warn('brand insert:', (e && e.message) || e); return null; }));
    if (row) out.set(b.company, { id: row.id, email });
  }
  return out;
}

async function seed(retailerId) {
  const venues = await ensureVenues(retailerId);
  const venueByName = new Map(venues.map(v => [v.name, v]));
  await ensureSettings(retailerId);
  const admin = await ensureAdmin(retailerId);
  const accounts = await ensureBrandAccounts();

  // Store contacts
  for (const t of DEMO_TEAM) {
    await sb('internal_contacts', { method: 'POST', body: JSON.stringify({
      retailer_id: retailerId, name: t.name, role: t.role, email: tagged(t.tag), phone: '(503) 555-01' + String(20 + DEMO_TEAM.indexOf(t)),
      venue_ids: t.venues.map(n => (venueByName.get(n) || {}).id).filter(Boolean),
      notification_prefs: t.prefs,
    }) }).catch(e => console.warn('team insert:', (e && e.message) || e));
  }

  // Brands tab contacts (one per brand), linked to the account where there is one
  const brandContactId = new Map();
  for (const b of DEMO_BRANDS) {
    const acct = accounts.get(b.company);
    const row = first(await sb('brand_contacts', { method: 'POST', body: JSON.stringify({
      retailer_id: retailerId, name: b.contact, company: b.company, email: acct ? acct.email : b.company.toLowerCase().replace(/[^a-z0-9]+/g, '-') + '@example.com', phone: b.phone, brand_id: acct ? acct.id : null,
    }) }).catch(e => { console.warn('brand_contact insert:', (e && e.message) || e); return null; }));
    if (row) brandContactId.set(b.company, row.id);
  }

  // Compliance records (COIs, one expiring in 14 days for the tour visual)
  const today = todayIn(DEMO_TZ);
  const compRows = [
    ['Bluebell Creamery', addDays(today, 180)], ['Peak Provisions Jerky', addDays(today, 14)], ['Marigold Snacks', addDays(today, 240)], ['Cedar & Sage Kombucha', addDays(today, 300)],
  ];
  for (const [company, expires] of compRows) {
    await sb('compliance_records', { method: 'POST', body: JSON.stringify({ retailer_id: retailerId, brand_contact_id: brandContactId.get(company) || null, doc_type: 'coi', expires_at: expires, verified: true }) })
      .catch(e => console.warn('compliance insert:', (e && e.message) || e));
  }

  // Bookings + demos for the sample month. Inserted confirmed; the outbox events the insert
  // trigger queues are removed below so nothing is emailed for seeded demos.
  let bookings = 0, demos = 0;
  for (const [offset, si, bi, time] of DEMO_PLAN) {
    const venue = venueByName.get(DEMO_STORES[si].name); const b = DEMO_BRANDS[bi]; const acct = accounts.get(b.company);
    if (!venue) continue;
    const date = addDays(today, offset);
    const common = { retailer_id: retailerId, venue_id: venue.id, brand_id: acct ? acct.id : null, contact_name: b.contact, contact_email: acct ? acct.email : b.company.toLowerCase().replace(/[^a-z0-9]+/g, '-') + '@example.com', contact_phone: b.phone, product: b.product, product_skus: b.items, demo_date: date, demo_time: time, duration_hours: 3, status: 'confirmed' };
    const booking = first(await sb('bookings', { method: 'POST', body: JSON.stringify({ ...common, brand_name: b.company, needs_electricity: b.company === 'Bluebell Creamery' }) }).catch(e => { console.warn('booking insert:', (e && e.message) || e); return null; }));
    if (!booking) continue;
    bookings++;
    const demo = first(await sb('demos', { method: 'POST', body: JSON.stringify({ ...common, company_name: b.company, demo_fee: 0, booking_id: booking.id, confirmed_at: new Date().toISOString() }) }).catch(e => { console.warn('demo insert:', (e && e.message) || e); return null; }));
    if (demo) demos++;
  }
  // No mail for seeded demos: drop the confirmed events (and any delivery already fanned out).
  await sb(`notification_deliveries?retailer_id=eq.${enc(retailerId)}`, { method: 'DELETE' }).catch(e => console.warn('deliveries cleanup:', (e && e.message) || e));
  await sb(`notification_events?retailer_id=eq.${enc(retailerId)}`, { method: 'DELETE' }).catch(e => console.warn('events cleanup:', (e && e.message) || e));

  return {
    retailer_id: retailerId,
    venues: venues.length,
    admin_member: admin ? DEMO_ADMIN_EMAIL : null,
    brand_accounts: [...accounts.values()].map(a => a.email),
    team_created: DEMO_TEAM.length,
    brand_contacts_created: brandContactId.size,
    compliance_records_created: compRows.length,
    bookings_created: bookings,
    demos_created: demos,
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
  try { _b = await getBinding(); } catch (e) { return sendBindingFailure(res, e); }
  if (!SEED_SECRET) return res.status(500).json({ error: 'SEED_SECRET not configured' });

  // Auth: the SEED_SECRET (manual calls) OR a real Vercel cron identity. DH-07: the bare
  // x-vercel-cron header is client-spoofable, so it is NO LONGER sufficient on its own. Vercel
  // signs genuine cron invocations with `Authorization: Bearer <CRON_SECRET>` once CRON_SECRET
  // is set in the project env, that is what we trust here.
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
    retailer = await ensureRetailer();
    if (!retailer) return res.status(500).json({ error: 'Failed to create demo retailer' });
    const summary = await seed(retailer.id);
    return res.status(200).json({
      ok: true,
      reset,
      retailer: { id: retailer.id, slug: DEMO_SLUG, name: DEMO_NAME },
      summary,
      view_url: link(_b, `/r/${DEMO_SLUG}`),
      admin_url: link(_b, `/r/${DEMO_SLUG}/admin`),
    });
  } catch (e) {
    console.error('seed-demo error:', e);
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
}
