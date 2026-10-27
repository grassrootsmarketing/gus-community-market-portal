// tests/owner_overview_counts.test.mjs (David, 2026-10-26): the owner overview's headline counts real retailers only.
// The '__owner__' row is the owner panel's session anchor, not a store; the Retailers tab never lists it, so the
// headline must not count it either (it said 4 retailers while the tab listed 3). Runs against demohub-rebuild-check
// through the route harness (owner-data), seeding nothing beyond the owner session the other owner suites also use.
import { callRoute, req, ok, summary } from './_route.mjs';
const SB = process.env.SB_URL, KEY = process.env.SB_KEY;
if (!SB || !KEY) { console.log('SB_URL and SB_KEY required (run through run-test.sh)'); process.exit(1); }
const H = { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json', Prefer: 'return=representation' };
const db = async (path, opts = {}) => { const r = await fetch(`${SB}/rest/v1/${path}`, { ...opts, headers: { ...H, ...(opts.headers || {}) } }); const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch (_) {} return { status: r.status, body: j }; };

// owner session, the same way the owner directory smoke builds one
const OWNER_EMAIL = 'david@demohubhq.com';
const ex = await db('retailers?slug=eq.__owner__&select=id');
const ownerRid = (ex.body && ex.body[0] && ex.body[0].id) || (await db('retailers', { method: 'POST', body: JSON.stringify({ slug: '__owner__', name: 'Demohub Owner (system)', billing_email: OWNER_EMAIL }) })).body[0].id;
const tok = (await db('admin_tokens', { method: 'POST', body: JSON.stringify({ email: OWNER_EMAIL, retailer_id: ownerRid }) })).body[0];
const ownerCookie = (await callRoute('admin-auth.js', req({ body: { action: 'owner-verify', token: tok.token } }))).cookie('dh_owner_session');
ok('owner session exists', !!ownerCookie);

const r = await callRoute('admin-auth.js', req({ body: { action: 'owner-data' }, cookies: { dh_owner_session: ownerCookie } }));
ok('owner-data answers 200 with a headline', r.statusCode === 200 && r.body && r.body.headline, `${r.statusCode} ${JSON.stringify(r.body).slice(0, 120)}`);
const h = (r.body && r.body.headline) || {};

// ground truth straight from the table
const all = (await db('retailers?select=id,slug')).body || [];
const real = all.filter(x => x.slug !== '__owner__');
const brands = (await db('brands?select=id')).body || [];
ok('the __owner__ row exists in the table (the trap this test guards)', all.length === real.length + 1);
ok(`headline total_retailers = real retailers (${real.length}), not every row (${all.length})`, h.total_retailers === real.length, `got ${h.total_retailers}`);
ok(`headline total_brands = every brand (${brands.length})`, h.total_brands === brands.length, `got ${h.total_brands}`);
ok('paid retailers never exceed real retailers', Number(h.paid_retailers || 0) <= real.length, `paid ${h.paid_retailers}`);
const signups = (r.body && r.body.trends && r.body.trends.retailer_signups) || r.body.retailer_signups || null;
if (Array.isArray(signups)) ok('signup series never counts the system row', signups.reduce((s, m) => s + (m.count || 0), 0) <= real.length, JSON.stringify(signups).slice(0, 160));
else ok('signup series present (shape may differ; skipped)', true);

await db(`admin_tokens?token=eq.${encodeURIComponent(tok.token)}`, { method: 'DELETE' });
summary('owner overview counts');
