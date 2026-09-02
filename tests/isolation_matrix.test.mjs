// tests/isolation_matrix.test.mjs — Codex final-launch Phases B + C, at the HTTP-response level.
//
// Runs the REAL exported handlers (api/admin.js, api/admin-auth.js) through tests/_route.mjs
// against staging, with real role cookies minted through the real verify route. Asserts on the
// SERVER RESPONSE — never on rendered HTML — because cross-retailer isolation must be enforced by
// the server, not by hidden UI.
//
//   Phase B (cross-retailer COI oracle): a retailer cannot plant a foreign brand_id or brand email on
//   a contact and read that brand's account/COI state back; relationship fields are server-owned.
//   Phase C (viewer scope): a venue-scoped viewer receives only its permitted venues' calendar data
//   and none of the retailer-wide collections; team/agreement lists are owner/admin/manager-only.
//
// Fixtures: Retailer A (venues A1, A2; owner; viewer scoped to A1; viewer scoped to A2), Retailer B
// (venue B1; owner). Brands: brandA (booked at A1), brandB (booked at B1), brandX (no relationship).
// Everything created here is torn down in FK-safe order.
import { installSpy, callRoute, req, ok, summary, uniq } from './_route.mjs';

const SB = process.env.SB_URL.replace(/\/+$/, '').replace(/\/rest\/v1$/, '');
const KEY = process.env.SB_KEY;
const H = { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json', Prefer: 'return=representation' };
async function db(path, opts = {}) {
  const r = await fetch(`${SB}/rest/v1/${path}`, { ...opts, headers: { ...H, ...(opts.headers || {}) } });
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch (_) {}
  return { ok: r.ok, status: r.status, body: j, text: t };
}
// api/admin.js replies through send(), which ALWAYS emits a JSON string (even for objects), so the
// mock response body arrives as text; api/admin-auth.js uses res.json() and arrives parsed. Normalise.
const parse = (r) => { const b = r && r.body; if (typeof b === 'string') { try { return JSON.parse(b); } catch (_) { return b; } } return b; };
const one = (r) => { const b = parse(r); return Array.isArray(b) ? b[0] : b; };
const wrap = (r) => ({ statusCode: r.statusCode, body: parse(r), cookie: (n) => r.cookie(n), cookies: () => r.cookies() });
const bin = []; // [table, id] in creation order; torn down in reverse
const track = (t, id) => { if (id) bin.push([t, id]); return id; };

installSpy();

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const slugA = uniq('iso-a'), slugB = uniq('iso-b');
const mkRetailer = async (slug, name) => track('retailers', one(await db('retailers', { method: 'POST', body: JSON.stringify({
  slug, name, billing_email: `${slug}@fixture.test`, billing_tier: 'pro', billing_status: 'active', platform_keeps_all: true }) })).id);
const mkVenue = async (rid, name) => track('venues', one(await db('venues', { method: 'POST', body: JSON.stringify({
  retailer_id: rid, name, address: '1 Iso St', demo_fee: 30, max_demos_per_slot: 5 }) })).id);
const mkBrand = async (label) => {
  const email = `${uniq(label)}@fixture.test`;
  const row = one(await db('brands', { method: 'POST', body: JSON.stringify({
    email, company_name: label + ' Co', is_verified: true, contact_name: label, phone: '555-0100',
    coi_verification_status: 'approved', default_coi_expires: '2027-12-31' }) }));
  track('brands', row.id); return row;
};
let seedN = 0;
const mkBooking = async (rid, vid, brand, status = 'pending') => {
  seedN++;
  const d = new Date(Date.UTC(2026, 11, 1 + (seedN % 20))).toISOString().slice(0, 10);
  const row = one(await db('bookings', { method: 'POST', body: JSON.stringify({
    retailer_id: rid, venue_id: vid, brand_id: brand.id, brand_name: brand.company_name,
    contact_name: brand.contact_name, contact_email: brand.email, demo_date: d, demo_time: `${8 + (seedN % 9)}:${String(seedN % 60).padStart(2, '0')}`,
    status, payment_status: 'unpaid' }) }));
  track('bookings', row.id); return row;
};
const mkMember = async (rid, email, role, venue_ids) => track('retailer_admins', one(await db('retailer_admins', { method: 'POST', body: JSON.stringify({
  retailer_id: rid, email, email_normalized: email, name: role + ' fixture', role, ...(venue_ids ? { venue_ids } : {}) }) })).id);
async function mintCookie(rid, email) {
  const tok = one(await db('admin_tokens', { method: 'POST', body: JSON.stringify({ email, retailer_id: rid }) }));
  const v = await callRoute('admin-auth.js', req({ body: { action: 'verify', token: tok.token } }));
  if (v.statusCode !== 200) throw new Error('verify failed for ' + email + ': ' + v.statusCode + ' ' + JSON.stringify(v.body));
  return v.cookie('dh_retailer_session');
}

const A = await mkRetailer(slugA, 'Iso Retailer A');
const B = await mkRetailer(slugB, 'Iso Retailer B');
const A1 = await mkVenue(A, 'A1'), A2 = await mkVenue(A, 'A2'), B1 = await mkVenue(B, 'B1');
const brandA = await mkBrand('brandA'), brandB = await mkBrand('brandB'), brandX = await mkBrand('brandX');
const bkA1 = await mkBooking(A, A1, brandA, 'held');
const bkA2 = await mkBooking(A, A2, brandA, 'pending');
const bkB1 = await mkBooking(B, B1, brandB, 'held');
// retailer-wide collections in A that a viewer must never receive
const icA = track('internal_contacts', one(await db('internal_contacts', { method: 'POST', body: JSON.stringify({ retailer_id: A, name: 'A Staff', role: 'Lead', email: 'a-staff@fixture.test', venue_ids: [A2] }) })).id);
const crA = track('compliance_records', one(await db('compliance_records', { method: 'POST', body: JSON.stringify({ retailer_id: A, doc_type: 'coi', doc_number: 'SECRET-DOC-A', expires_at: '2027-01-01' }) })).id);
// a contact in B, to prove A cannot PATCH/DELETE it by guessed id
const bcB = track('brand_contacts', one(await db('brand_contacts', { method: 'POST', body: JSON.stringify({ retailer_id: B, name: 'B Contact', email: 'b-contact@fixture.test' }) })).id);

const ownerAEmail = `owner-${slugA}@fixture.test`, viewerA1Email = `v1-${slugA}@fixture.test`, viewerA2Email = `v2-${slugA}@fixture.test`, ownerBEmail = `owner-${slugB}@fixture.test`;
await mkMember(A, ownerAEmail, 'owner');
await mkMember(A, viewerA1Email, 'viewer', [A1]);
await mkMember(A, viewerA2Email, 'viewer', [A2]);
await mkMember(B, ownerBEmail, 'owner');
const ownerA = await mintCookie(A, ownerAEmail);
const viewerA1 = await mintCookie(A, viewerA1Email);
const viewerA2 = await mintCookie(A, viewerA2Email);
const ownerB = await mintCookie(B, ownerBEmail);

const proxy = async (cookie, method, table, body, id) => wrap(await callRoute('admin.js', req({ method, query: { table, ...(id ? { id } : {}) }, body, cookies: { dh_retailer_session: cookie } })));
const data = async (cookie) => wrap(await callRoute('admin.js', req({ method: 'GET', query: { action: 'data' }, cookies: { dh_retailer_session: cookie } })));
const authAction = async (cookie, action) => wrap(await callRoute('admin-auth.js', req({ body: { action }, cookies: { dh_retailer_session: cookie } })));
const hasCoi = (c) => c && (Object.prototype.hasOwnProperty.call(c, 'coi_status') || Object.prototype.hasOwnProperty.call(c, 'coi_expires'));

try {
  // =========================================================================
  console.log('\n— Phase B: cross-retailer COI oracle is closed —');
  // =========================================================================
  // B1. Retailer A submits Retailer B's brand UUID as brand_id -> the field is removed, never stored.
  {
    const r = await proxy(ownerA, 'POST', 'brand_contacts', { name: 'Planted UUID', email: 'planted-uuid@fixture.test', brand_id: brandB.id });
    ok('B1 planted foreign brand_id write is accepted as a plain contact (2xx)', r.statusCode >= 200 && r.statusCode < 300, `${r.statusCode} ${JSON.stringify(r.body).slice(0, 120)}`);
    const created = one(r); const id = created && created.id; if (id) track('brand_contacts', id);
    const row = id ? one(await db(`brand_contacts?id=eq.${id}&select=brand_id,retailer_id`)) : null;
    ok('B1 stored row has NO brand_id (relationship field is server-owned)', !!row && row.brand_id === null, JSON.stringify(row));
    ok('B1 stored row is pinned to Retailer A', !!row && row.retailer_id === A, JSON.stringify(row));
  }
  // B2. Retailer A plants Retailer B's brand EMAIL -> data response carries no COI / existence signal.
  //     B3. Case/whitespace/alias/duplicate/nonexistent variants are all indistinguishable.
  {
    const variants = [
      ['exact', brandB.email], ['upper', brandB.email.toUpperCase()], ['spaces', '  ' + brandB.email + '  '],
      ['alias', brandB.email.replace('@', '+probe@')], ['dup', brandB.email], ['nonexistent', `${uniq('nobody')}@fixture.test`],
    ];
    const ids = [];
    for (const [label, email] of variants) {
      const r = await proxy(ownerA, 'POST', 'brand_contacts', { name: 'Probe ' + label, email });
      const id = one(r) && one(r).id; if (id) { ids.push([label, id]); track('brand_contacts', id); }
    }
    const d = await data(ownerA);
    ok('B2 owner data read is 200', d.statusCode === 200, `${d.statusCode}`);
    const contacts = (d.body && d.body.brand_contacts) || [];
    for (const [label, id] of ids) {
      const c = contacts.find(x => x.id === id);
      ok(`B2/B3 planted "${label}" email contact exposes NO coi_status/coi_expires`, !!c && !hasCoi(c), JSON.stringify(c && { coi_status: c.coi_status, coi_expires: c.coi_expires }));
    }
    // existence oracle: the real-brand probe and the nonexistent-email probe must have identical key sets
    const real = contacts.find(x => x.id === ids[0][1]), fake = contacts.find(x => x.id === ids[5][1]);
    ok('B3 real-brand probe and nonexistent-email probe have IDENTICAL response keys (no existence signal)',
      !!real && !!fake && JSON.stringify(Object.keys(real).sort()) === JSON.stringify(Object.keys(fake).sort()),
      `${real && Object.keys(real).sort()} vs ${fake && Object.keys(fake).sort()}`);
  }
  // B4. retailer_id cannot be altered through create or update.
  {
    const r = await proxy(ownerA, 'POST', 'brand_contacts', { name: 'Hijack', email: 'hijack@fixture.test', retailer_id: B });
    ok('B4 POST with foreign retailer_id is refused 403', r.statusCode === 403, `${r.statusCode} ${JSON.stringify(r.body)}`);
    const mine = one(await proxy(ownerA, 'POST', 'brand_contacts', { name: 'Mine', email: 'mine@fixture.test' }));
    if (mine && mine.id) track('brand_contacts', mine.id);
    const p = await proxy(ownerA, 'PATCH', 'brand_contacts', { name: 'Mine Edited', retailer_id: B, brand_id: brandB.id }, mine.id);
    const after = one(await db(`brand_contacts?id=eq.${mine.id}&select=retailer_id,brand_id,name`));
    ok('B4 PATCH cannot move the row to another retailer (pinned to A)', p.statusCode < 300 && after.retailer_id === A, `${p.statusCode} ${JSON.stringify(after)}`);
    ok('B4 PATCH cannot plant brand_id either', after.brand_id === null, JSON.stringify(after));
    ok('B4 PATCH still applied the allowed field (name)', after.name === 'Mine Edited', JSON.stringify(after));
  }
  // B5. A legitimate retailer-scoped HELD booking still gets its COI state (brand_id is server-set).
  {
    const d = await data(ownerA);
    const held = ((d.body && d.body.bookings) || []).find(b => b.id === bkA1.id);
    ok('B5 held booking for own brand carries coi_status (enrichment preserved)', !!held && held.coi_status === 'approved', JSON.stringify(held && { status: held.status, coi_status: held.coi_status, coi_expires: held.coi_expires }));
    // a server-created contact linked to a brand that HAS booked here is enriched...
    const legit = one(await db('brand_contacts', { method: 'POST', body: JSON.stringify({ retailer_id: A, name: 'Legit', email: brandA.email, brand_id: brandA.id }) }));
    track('brand_contacts', legit.id);
    // ...while an identical contact linked to a brand that has NOT booked here is not (even if a valid brand)
    const stranger = one(await db('brand_contacts', { method: 'POST', body: JSON.stringify({ retailer_id: A, name: 'Stranger', email: brandX.email, brand_id: brandX.id }) }));
    track('brand_contacts', stranger.id);
    const d2 = await data(ownerA);
    const cs = (d2.body && d2.body.brand_contacts) || [];
    const L = cs.find(c => c.id === legit.id), S = cs.find(c => c.id === stranger.id);
    ok('B5 contact for a brand that BOOKED here is enriched with its COI', !!L && L.coi_status === 'approved', JSON.stringify(L && { coi_status: L.coi_status }));
    ok('B5 contact for a brand with NO booking here gets NO coi fields (relationship not server-proven)', !!S && !hasCoi(S), JSON.stringify(S && { coi_status: S.coi_status }));
  }
  // B6. A normal manual contact create + edit with approved fields works.
  {
    const r = await proxy(ownerA, 'POST', 'brand_contacts', { name: 'Normal', company: 'Normal Co', email: 'normal@fixture.test', phone: '555-1', notes: 'hi', venue: 'A1', address: '2 St' });
    const c = one(r); if (c && c.id) track('brand_contacts', c.id);
    ok('B6 normal contact create succeeds with all allowed fields', r.statusCode < 300 && c && c.company === 'Normal Co' && c.phone === '555-1' && c.notes === 'hi', `${r.statusCode} ${JSON.stringify(c).slice(0, 160)}`);
    const p = await proxy(ownerA, 'PATCH', 'brand_contacts', { phone: '555-2' }, c.id);
    const after = one(await db(`brand_contacts?id=eq.${c.id}&select=phone`));
    ok('B6 normal contact edit succeeds', p.statusCode < 300 && after.phone === '555-2', `${p.statusCode} ${JSON.stringify(after)}`);
  }

  // =========================================================================
  console.log('\n— Phase C: viewer scope enforced at the response level —');
  // =========================================================================
  {
    const d = await data(viewerA1);
    ok('C1 viewer A1 data read is 200', d.statusCode === 200, `${d.statusCode} ${JSON.stringify(d.body).slice(0, 120)}`);
    const b = d.body || {};
    const venueIds = (b.venues || []).map(v => v.id);
    ok('C1 viewer A1 sees ONLY venue A1', venueIds.length === 1 && venueIds[0] === A1, JSON.stringify(venueIds));
    ok('C1 viewer A1 bookings are only A1 (no A2, no B1)', (b.bookings || []).every(x => x.venue_id === A1) && !(b.bookings || []).some(x => x.id === bkA2.id || x.id === bkB1.id), JSON.stringify((b.bookings || []).map(x => x.venue_id)));
    ok('C1 viewer receives NO brand_contacts', Array.isArray(b.brand_contacts) && b.brand_contacts.length === 0, JSON.stringify(b.brand_contacts));
    ok('C1 viewer receives NO internal_contacts (staff)', Array.isArray(b.internal_contacts) && b.internal_contacts.length === 0, JSON.stringify(b.internal_contacts));
    ok('C1 viewer receives NO compliance records', Array.isArray(b.compliance) && b.compliance.length === 0, JSON.stringify(b.compliance));
    const raw = JSON.stringify(b);
    ok('C1 viewer response contains no compliance doc identifier', !raw.includes('SECRET-DOC-A'));
    ok('C1 viewer response contains no cal_feed_key / billing fields', !/cal_feed_key|billing_status|billing_tier|billing_email/.test(raw));
    ok('C1 viewer bookings carry no contact PII', (b.bookings || []).every(x => !('contact_email' in x) && !('contact_phone' in x) && !('notes' in x)));
    ok('C1 viewer settings are minimal (no retailer-wide internals)', b.settings === null || (Object.keys(b.settings).every(k => ['demo_duration', 'advance_booking_days'].includes(k))), JSON.stringify(b.settings));
  }
  {
    const d = await data(viewerA2);
    const venueIds = ((d.body || {}).venues || []).map(v => v.id);
    ok('C1 viewer A2 sees ONLY venue A2 (scopes are disjoint)', venueIds.length === 1 && venueIds[0] === A2, JSON.stringify(venueIds));
    ok('C1 viewer A2 does not see the A1 booking', !((d.body || {}).bookings || []).some(x => x.id === bkA1.id));
  }
  {
    const t = await authAction(viewerA1, 'team-list');
    ok('C2 viewer team-list is 403 (owner/admin/manager only)', t.statusCode === 403, `${t.statusCode} ${JSON.stringify(t.body)}`);
    ok('C2 viewer team-list leaks no roster', !(t.body && Array.isArray(t.body.admins)), JSON.stringify(t.body));
    const a = await authAction(viewerA1, 'agreement-retailer-list');
    ok('C2 viewer agreement-retailer-list is 403', a.statusCode === 403, `${a.statusCode} ${JSON.stringify(a.body)}`);
    ok('C2 viewer agreement list leaks no brand emails', !(a.body && Array.isArray(a.body.agreements)), JSON.stringify(a.body));
  }
  {
    // ID guessing does not bypass scope, and viewers are read-only
    const p = await proxy(viewerA1, 'PATCH', 'brand_contacts', { name: 'x' }, bcB);
    ok('C3 viewer PATCH by guessed id is refused (403)', p.statusCode === 403, `${p.statusCode} ${JSON.stringify(p.body)}`);
    const po = await proxy(ownerA, 'PATCH', 'brand_contacts', { name: 'x' }, bcB);
    ok('C3 owner A PATCH of a Retailer-B row by guessed id is refused (403)', po.statusCode === 403, `${po.statusCode} ${JSON.stringify(po.body)}`);
    const del = await proxy(ownerA, 'DELETE', 'brand_contacts', {}, bcB);
    ok('C3 owner A DELETE of a Retailer-B row by guessed id is refused (403)', del.statusCode === 403, `${del.statusCode} ${JSON.stringify(del.body)}`);
    const still = one(await db(`brand_contacts?id=eq.${bcB}&select=id,name`));
    ok('C3 the Retailer-B row is untouched', !!still && still.name === 'B Contact', JSON.stringify(still));
  }
  {
    const d = await data(ownerA);
    const b = d.body || {};
    const vids = (b.venues || []).map(v => v.id).sort();
    ok('C4 owner A sees BOTH its venues and nothing of B', JSON.stringify(vids) === JSON.stringify([A1, A2].sort()) && !(b.bookings || []).some(x => x.id === bkB1.id), JSON.stringify(vids));
    ok('C4 owner A still receives its full collections', Array.isArray(b.internal_contacts) && b.internal_contacts.some(c => c.id === icA) && Array.isArray(b.compliance) && b.compliance.some(c => c.id === crA));
    const t = await authAction(ownerA, 'team-list');
    ok('C4 owner team-list still 200', t.statusCode === 200 && Array.isArray(t.body.admins), `${t.statusCode}`);
    const a = await authAction(ownerA, 'agreement-retailer-list');
    ok('C4 owner agreement-retailer-list still 200', a.statusCode === 200, `${a.statusCode}`);
    const dB = await data(ownerB);
    ok('C4 owner B sees only B (no A venues/bookings)', ((dB.body || {}).venues || []).every(v => v.id === B1) && !((dB.body || {}).bookings || []).some(x => x.id === bkA1.id || x.id === bkA2.id));
  }
} catch (e) {
  console.error('HARNESS ERROR', (e && e.stack) || e);
  ok('harness completed without throwing', false, String((e && e.message) || e));
} finally {
  // Teardown in FK-safe order (children first).
  const order = ['bookings', 'brand_contacts', 'internal_contacts', 'compliance_records', 'admin_tokens', 'retailer_admins', 'venues', 'brands', 'retailers'];
  for (const t of order) {
    if (t === 'admin_tokens') { for (const rid of [A, B]) { await db(`admin_sessions?retailer_id=eq.${rid}`, { method: 'DELETE' }).catch(() => {}); await db(`admin_tokens?retailer_id=eq.${rid}`, { method: 'DELETE' }).catch(() => {}); } continue; }
    for (const [tt, id] of [...bin].reverse()) { if (tt === t) await db(`${t}?id=eq.${id}`, { method: 'DELETE' }).catch(() => {}); }
  }
}
process.exit(summary('isolation matrix (Phase B + C)') ? 0 : 1);
