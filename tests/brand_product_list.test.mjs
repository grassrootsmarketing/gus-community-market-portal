// tests/brand_product_list.test.mjs — Codex product-list review P-1, P-3, P-4 (2026-10-07), real routes against the
// test database with mail and Stripe intercepted.
//   P-1  every brand-created booking needs 1..40 validated selected items: a populated profile with an empty or
//        missing selection fails; request-only items succeed without touching the profile; malformed or oversized
//        input fails before any insert or side effect; another brand's ids are only labels; the held path enforces
//        the same rule; existing bookings without items keep working through confirmation.
//   P-3  the catalog save validates (never clears on invalid input, never "degrades"), is conditional on the version
//        the client saw (409 products_conflict with the current list), and returns the normalised list with ids.
//   P-4  the booking snapshot holds the normalised objects, the demo projection copies them whole, later catalog
//        edits do not change a booked snapshot, and the mail builders choose full versus compact from the queued
//        offset and never from the clock; legacy and empty snapshots render; everything is escaped.
import crypto from 'node:crypto';
import { callRoute, req, ok, summary, uniq, installSpy, ENV, FIXTURE_PRODUCTS } from './_route.mjs';
import { STANDARD } from './_fixture_availability.mjs';
import { buildContext, confirmedMessage, reminderMessage, rescheduledMessage, cancelledMessage, offsetWantsFullProducts } from '../api/_notification-mail.js';

ENV.PROVISIONAL_HOLDS_ENABLED = 'true';   // the held path exists in this suite; tests/launch_flags.test.mjs proves the default-off
const SB = process.env.SB_URL, KEY = process.env.SB_KEY;
const H = { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json', Prefer: 'return=representation' };
const spy = installSpy();
const db = async (path, opts = {}) => { const r = await fetch(`${SB}/rest/v1/${path}`, { ...opts, headers: { ...H, ...(opts.headers || {}) } }); const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch (_) {} return { ok: r.ok, status: r.status, body: j }; };
const one = (r) => (r && Array.isArray(r.body) ? r.body[0] : null);
const bin = []; const track = (t, id) => { if (id) bin.push([t, id]); return id; };
const dayP = (n) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const LA = 'America/Los_Angeles';

// ---- fixtures: an approved, auto-confirm retailer with one venue; two insured brands; a settings row with no lead time ----
const slug = uniq('pl');
const retailerId = track('retailers', one(await db('retailers', { method: 'POST', body: JSON.stringify({ slug, name: 'Product List Market', verification_status: 'approved', billing_email: `${slug}@fixture.test`, billing_tier: 'pro', billing_status: 'active', platform_keeps_all: true, timezone: LA, auto_confirm_bookings: false }) })).id);
track('settings', one(await db('settings', { method: 'POST', body: JSON.stringify({ retailer_id: retailerId, demo_fee: 30, advance_booking_days: 0 }) })).id);
const V = track('venues', one(await db('venues', { method: 'POST', body: JSON.stringify({ retailer_id: retailerId, name: 'PL Main', address: '1 PL St', demo_fee: 30, availability: STANDARD }) })).id);
async function mkBrand(tag, extra = {}) {
  const email = `${uniq(tag)}@fixture.test`;
  const id = track('brands', one(await db('brands', { method: 'POST', body: JSON.stringify({ email, company_name: 'PL Brand ' + tag, contact_name: 'Rep ' + tag, phone: '555-0100', is_verified: true, default_coi_url: 'brands/pl.pdf', default_coi_expires: dayP(400), coi_verification_status: 'approved', ...extra }) })).id);
  const tok = one(await db('brand_account_tokens', { method: 'POST', body: JSON.stringify({ brand_id: id, email, token: 'tk-' + uniq('t'), expires_at: new Date(Date.now() + 36e5).toISOString() }) }));
  const cookie = (await callRoute('brand-account.js', req({ body: { action: 'verify', token: tok.token } }))).cookie('dh_brand_session');
  return { id, email, cookie };
}
const staffEmail = `staff-${slug}@fixture.test`;
track('retailer_admins', one(await db('retailer_admins', { method: 'POST', body: JSON.stringify({ retailer_id: retailerId, email: staffEmail, email_normalized: staffEmail, name: 'PL Staff', role: 'admin' }) })).id);
const staffTok = one(await db('admin_tokens', { method: 'POST', body: JSON.stringify({ email: staffEmail, retailer_id: retailerId }) }));
const staffCookie = (await callRoute('admin-auth.js', req({ body: { action: 'verify', token: staffTok.token } }))).cookie('dh_retailer_session');
const confirmViaRoute = async (bookingId) => { await db(`bookings?id=eq.${bookingId}`, { method: 'PATCH', body: JSON.stringify({ payment_status: 'paid', status: 'pending' }) }); return callRoute('booking-action.js', req({ body: { booking_id: bookingId, action: 'confirm' }, cookies: { dh_retailer_session: staffCookie } })); };
const A = await mkBrand('a', { products: [{ id: 'cat-1', name: 'Catalog Chips', size: '5 oz', sku: 'CC-5', upc: '012345678905', distributor: 'unfi', distributor_item_number: '0007', case_pack: 12 }, { id: 'cat-2', name: 'Catalog Salsa', size: '16 oz' }] });
const B = await mkBrand('b', { products: [{ id: 'other-1', name: 'B Secret Sauce' }] });
const C = await mkBrand('c');   // no catalog
const book = (brand, body) => callRoute('book.js', req({ body: { retailer_slug: slug, venue_id: V, demo_time: '11:00 AM', product: 'Snacks', ...body }, cookies: { dh_brand_session: brand.cookie } }));
const profile = (brand, body) => callRoute('brand-account.js', req({ body: { action: 'profile-update', ...body }, cookies: { dh_brand_session: brand.cookie } }));
const brandRow = async (b) => one(await db(`brands?id=eq.${b.id}&select=products,products_version,updated_at`));
const data = (brand) => callRoute('brand-account.js', req({ body: { action: 'data' }, cookies: { dh_brand_session: brand.cookie } }));
const bookingsOf = async (b) => (await db(`bookings?brand_id=eq.${b.id}&select=id,status,product_skus&order=created_at.asc`)).body || [];
let slotDay = 5; const nextDay = () => dayP(slotDay++);
const LEAK = /SECRET|<script|onerror/;

try {
  console.log('\n— P-1: the booking rule —');
  {
    const before = (await bookingsOf(A)).length;
    const r1 = await book(A, { demo_date: nextDay() });
    ok('populated profile + no product_skus → 400 products_required (never filled from the profile)', r1.statusCode === 400 && r1.body.error === 'products_required', JSON.stringify([r1.statusCode, r1.body]));
    const r2 = await book(A, { demo_date: nextDay(), product_skus: [] });
    ok('populated profile + empty selection → 400 products_required', r2.statusCode === 400 && r2.body.error === 'products_required');
    const r3 = await book(A, { demo_date: nextDay(), product_skus: null });
    ok('null selection → 400 products_required', r3.statusCode === 400 && r3.body.error === 'products_required');
    ok('no booking rows were created by the refusals', (await bookingsOf(A)).length === before);
    const bad = await book(A, { demo_date: nextDay(), product_skus: [{ name: 'x', upc: 'abc', case_pack: '3' }] });
    ok('malformed items → 400 invalid_products with bounded field errors, before any insert', bad.statusCode === 400 && bad.body.error === 'invalid_products' && Array.isArray(bad.body.errors) && bad.body.errors.length === 2 && (await bookingsOf(A)).length === before, JSON.stringify(bad.body));
    const big = await book(A, { demo_date: nextDay(), product_skus: Array.from({ length: 41 }, (_, i) => ({ name: 'n' + i })) });
    ok('41 items → 400 invalid_products (too_many), nothing inserted', big.statusCode === 400 && big.body.error === 'invalid_products' && big.body.errors[0].code === 'too_many' && (await bookingsOf(A)).length === before);
    ok('no Stripe call was made by any refusal', spy.calls.stripe.length === 0);
    // request-only item: succeeds, profile untouched
    const profBefore = await brandRow(C);
    const d1 = nextDay();
    const r4 = await book(C, { demo_date: d1, product_skus: [{ name: 'Ad hoc Granola', size: '10 oz', upc: '0 12345-67890 5', distributor: 'other', distributor_other: 'Pod Foods', case_pack: 8 }] });
    ok('brand with EMPTY catalog books with a request-only item → 200', r4.statusCode === 200 && r4.body.ok && r4.body.booking_id, JSON.stringify([r4.statusCode, r4.body]));
    track('bookings', r4.body.booking_id);
    const snap = one(await db(`bookings?id=eq.${r4.body.booking_id}&select=product_skus`)).product_skus;
    ok('the booking snapshot is the NORMALISED object (digits-only UPC, generated id, other kept, canonical fields)', Array.isArray(snap) && snap.length === 1 && snap[0].upc === '012345678905' && /^p_/.test(snap[0].id) && snap[0].distributor_other === 'Pod Foods' && snap[0].case_pack === 8 && 'notes' in snap[0], JSON.stringify(snap));
    const profAfter = await brandRow(C);
    ok('the booking did NOT modify the brand\'s catalog (still empty, same version)', JSON.stringify(profAfter.products) === JSON.stringify(profBefore.products) && profAfter.updated_at === profBefore.updated_at);
    // another brand's ids are labels only
    const r5 = await book(A, { demo_date: nextDay(), product_skus: [{ id: 'other-1', name: 'Renamed' }] });
    ok('an id that exists in ANOTHER brand\'s catalog is accepted as a label (no cross-brand read)', r5.statusCode === 200, JSON.stringify([r5.statusCode, r5.body]));
    track('bookings', r5.body.booking_id);
    const snap5 = one(await db(`bookings?id=eq.${r5.body.booking_id}&select=product_skus`)).product_skus;
    ok('the snapshot holds what THIS brand sent, not brand B\'s item', snap5[0].name === 'Renamed' && !JSON.stringify(snap5).includes('Secret'));
    ok('brand B\'s catalog is untouched', (await brandRow(B)).products[0].name === 'B Secret Sauce');
    // held path (provisional holds on in the harness): same rule
    const U = await mkBrand('u', { default_coi_url: null, coi_verification_status: null, default_coi_expires: null });
    const h1 = await book(U, { demo_date: nextDay() });
    ok('uninsured brand (held path) without items → 400 products_required, no hold created', h1.statusCode === 400 && h1.body.error === 'products_required' && (await bookingsOf(U)).length === 0, JSON.stringify([h1.statusCode, h1.body]));
    const h2 = await book(U, { demo_date: nextDay(), product_skus: FIXTURE_PRODUCTS });
    ok('uninsured brand with items → 200, booking is held', h2.statusCode === 200 && one(await db(`bookings?id=eq.${h2.body.booking_id}&select=status`)).status === 'held', JSON.stringify([h2.statusCode, h2.body]));
    track('bookings', h2.body.booking_id);
    // historical booking without items keeps its lifecycle
    const legacy = track('bookings', one(await db('bookings', { method: 'POST', body: JSON.stringify({ retailer_id: retailerId, venue_id: V, brand_id: A.id, brand_name: 'PL Brand a', contact_email: A.email, demo_date: nextDay(), demo_time: '11:00 AM', status: 'pending', payment_status: 'paid', product_skus: null }) })).id);
    const up = await confirmViaRoute(legacy);
    ok('a pre-release booking with no items can still be confirmed through the real route (projection created)', up.statusCode === 200 && one(await db(`bookings?id=eq.${legacy}&select=status`)).status === 'confirmed' && !!(await db(`demos?booking_id=eq.${legacy}&select=id`)).body.length, JSON.stringify([up.statusCode, up.body]));
  }

  console.log('\n— P-3: catalog save —');
  {
    const cur = await brandRow(A);
    const bad = await profile(A, { products: 'nope', expected_products_version: cur.products_version });
    ok('invalid products value → 400 invalid_products, catalog NOT cleared', bad.statusCode === 400 && bad.body.error === 'invalid_products' && (await brandRow(A)).products.length === 2, JSON.stringify([bad.statusCode, bad.body]));
    const bad2 = await profile(A, { products: [{ name: 'ok' }, { name: 'bad upc', upc: '12' }], expected_products_version: cur.products_version });
    ok('one invalid item fails the whole save with the item index, nothing written', bad2.statusCode === 400 && bad2.body.errors[0].index === 1 && (await brandRow(A)).products.length === 2);
    const nov = await profile(A, { products: [{ name: 'ok' }] });
    ok('products without expected_products_version → 400 products_version_required (no unconditional replace)', nov.statusCode === 400 && nov.body.error === 'products_version_required');
    ok('a non-integer version is refused the same way', (await profile(A, { products: [{ name: 'ok' }], expected_products_version: '2026-10-07T12:34:56.123456+00:00' })).statusCode === 400);
    const good = await profile(A, { products: [...cur.products, { name: 'New Bar', upc: '1234-5678', distributor: 'kehe', distributor_item_number: '00099', case_pack: 24 }], expected_products_version: cur.products_version });
    ok('valid save with the current version → 200 with the normalised list and the persisted NEW version (exactly +1)', good.statusCode === 200 && Array.isArray(good.body.products) && good.body.products.length === 3 && good.body.products[2].upc === '12345678' && /^p_/.test(good.body.products[2].id) && good.body.products_version === cur.products_version + 1 && (await brandRow(A)).products_version === good.body.products_version, JSON.stringify(good.body).slice(0, 300));
    ok('existing ids preserved', good.body.products[0].id === 'cat-1' && good.body.products[1].id === 'cat-2');
    const stale = await profile(A, { products: [{ id: 'cat-1', name: 'Catalog Chips' }], expected_products_version: cur.products_version });
    ok('a save with the OLD version → 409 products_conflict carrying the current list and version; nothing overwritten', stale.statusCode === 409 && stale.body.error === 'products_conflict' && stale.body.products.length === 3 && stale.body.products_version === good.body.products_version && (await brandRow(A)).products.length === 3, JSON.stringify([stale.statusCode, stale.body && stale.body.error]));
    // two "tabs": both loaded version v; tab 1 saves, tab 2's save must conflict rather than drop tab 1's addition
    const v = (await brandRow(C)).products_version;
    const t1 = await profile(C, { products: [{ name: 'Tab One Item' }], expected_products_version: v });
    const t2 = await profile(C, { products: [{ name: 'Tab Two Item' }], expected_products_version: v });
    ok('two tabs (sequential): the first save wins, the second gets 409 and the first addition survives', t1.statusCode === 200 && t2.statusCode === 409 && (await brandRow(C)).products.map(p => p.name).join() === 'Tab One Item');
    // PL-C1: competing saves from ONE version, in parallel, against the real database: exactly one succeeds and the
    // winner's returned version differs from the loaded one. The application clock plays no part (integer, DB-owned).
    const v1 = (await brandRow(C)).products_version;
    const race = await Promise.all(['R1', 'R2', 'R3', 'R4'].map(n => profile(C, { products: [{ name: 'Race ' + n }], expected_products_version: v1 })));
    const wins = race.filter(r => r.statusCode === 200);
    ok('PL-C1: four PARALLEL saves from one version → exactly one 200, three 409', wins.length === 1 && race.filter(r => r.statusCode === 409).length === 3, JSON.stringify(race.map(r => r.statusCode)));
    ok('PL-C1: the winner returns version v+1 and the row holds exactly that', wins[0].body.products_version === v1 + 1 && (await brandRow(C)).products_version === v1 + 1 && (await brandRow(C)).products[0].name === wins[0].body.products[0].name);
    // same-millisecond sequential saves still advance the version by one each (no clock involved)
    const v2a = (await brandRow(C)).products_version;
    const s1 = await profile(C, { products: [{ name: 'Fast One' }], expected_products_version: v2a });
    const s2 = await profile(C, { products: [{ name: 'Fast Two' }], expected_products_version: s1.body.products_version });
    ok('PL-C1: two back-to-back saves advance the version twice (v+1, v+2)', s1.statusCode === 200 && s2.statusCode === 200 && s1.body.products_version === v2a + 1 && s2.body.products_version === v2a + 2);
    // a save that does not change products keeps the version; a client-sent products_version is ignored; the version never goes down
    const vKeep = (await brandRow(C)).products_version;
    const same = await profile(C, { products: (await brandRow(C)).products, expected_products_version: vKeep });
    ok('PL-C1: re-saving an identical list → 200 and the version is unchanged (trigger bumps only on a change)', same.statusCode === 200 && same.body.products_version === vKeep);
    const coreOnly = await profile(C, { phone: '555-0177', products_version: 0 });
    ok('PL-C1: a core-fields save cannot touch or lower the version', coreOnly.statusCode === 200 && (await brandRow(C)).products_version === vKeep);
    const staleAgain = await profile(C, { products: [{ name: 'Stale' }], expected_products_version: v1 });
    ok('PL-C1: the version held by a loser earlier can never save again', staleAgain.statusCode === 409);
    // the regression Codex reproduced: load through the REAL data route (microsecond timestamps and all), save immediately → success
    const loaded = (await data(C)).body.profile;
    const fresh = await profile(C, { products: [...(loaded.products || []), { name: 'Loaded Then Saved' }], expected_products_version: loaded.products_version });
    ok('PL-C1: a list loaded through the data route saves immediately (no self-conflict from timestamp rounding)', fresh.statusCode === 200 && /\d{2}:\d{2}:\d{2}\.\d{6}/.test(String(loaded.updated_at)) === true || fresh.statusCode === 200, JSON.stringify([fresh.statusCode, loaded.updated_at, loaded.products_version]));
    const other = await callRoute('brand-account.js', req({ body: { action: 'profile-update', products: [{ name: 'Hijack' }], expected_products_version: (await brandRow(B)).products_version }, cookies: { dh_brand_session: B.cookie } }));
    ok('another brand\'s session writes only its own catalog', other.statusCode === 200 && (await brandRow(A)).products.length === 3 && (await brandRow(B)).products[0].name === 'Hijack');
    const core = await profile(A, { phone: '555-0199' });
    ok('a save without products needs no version and keeps the catalog', core.statusCode === 200 && (await brandRow(A)).products.length === 3);
  }

  console.log('\n— PL-C1: a brand created by the database-side redemption path saves its list immediately —');
  {
    // The database-side redemption path (redeem_brand_signup) writes the brand row and its session with now(), i.e.
    // microsecond timestamps, and the token-verify route is not involved. Reproduce exactly that state: a brand row
    // whose timestamps are database-written (microseconds) and a session row written directly, then load through
    // the real data route and save with the version it returned.
    const email = `${uniq('rd')}@fixture.test`;
    const rbId = track('brands', one(await db('brands', { method: 'POST', body: JSON.stringify({ email, company_name: 'Redeemed Co', is_verified: true, updated_at: '2026-10-07T12:34:56.123456+00:00' }) })).id);
    const rbToken = crypto.randomUUID();
    await db('brand_account_sessions', { method: 'POST', body: JSON.stringify({ brand_id: rbId, session_token: rbToken, email, expires_at: new Date(Date.now() + 36e5).toISOString() }) });
    const rb = { cookie: rbToken };
    const prof = (await data(rb)).body.profile;
    ok('fixture: the loaded timestamp carries microseconds (the precision the old comparison lost)', /\.\d{6}/.test(String(prof.updated_at)), String(prof.updated_at));
    const first = await profile(rb, { products: [{ name: 'Redeemed Item', upc: '012345678905' }], expected_products_version: prof.products_version });
    ok('PL-C1: the first catalog save after a database-written row succeeds with the version the data route returned (0 → 1)', first.statusCode === 200 && prof.products_version === 0 && first.body.products_version === 1, JSON.stringify([first.statusCode, first.body && first.body.products_version, prof.updated_at]));
  }

  console.log('\n— P-4: snapshot, projection, edits do not leak into bookings —');
  {
    const cat = (await brandRow(A)).products;
    const d = nextDay();
    const bk = await book(A, { demo_date: d, product_skus: [cat[0], cat[2]] });
    ok('booking with two catalog items → 200', bk.statusCode === 200, JSON.stringify(bk.body));
    track('bookings', bk.body.booking_id);
    const cf = await confirmViaRoute(bk.body.booking_id);
    ok('confirmed through the real route', cf.statusCode === 200, JSON.stringify([cf.statusCode, cf.body]));
    const demo = one(await db(`demos?booking_id=eq.${bk.body.booking_id}&select=id,product_skus`));
    ok('the demo projection copies the complete item objects (all fields, both items)', demo && Array.isArray(demo.product_skus) && demo.product_skus.length === 2 && demo.product_skus[0].upc === '012345678905' && demo.product_skus[0].case_pack === 12 && demo.product_skus[1].distributor === 'kehe', JSON.stringify(demo && demo.product_skus));
    // edit the catalog: the booking snapshot and the demo projection do not move
    const vv = (await brandRow(A)).products_version;
    const ed = await profile(A, { products: cat.map(p => p.id === 'cat-1' ? { ...p, name: 'RENAMED Chips', upc: '00000000' } : p), expected_products_version: vv });
    ok('catalog edit saved', ed.statusCode === 200);
    const snapAfter = one(await db(`bookings?id=eq.${bk.body.booking_id}&select=product_skus`)).product_skus;
    const demoAfter = one(await db(`demos?id=eq.${demo.id}&select=product_skus`)).product_skus;
    ok('booking snapshot unchanged after the catalog edit', snapAfter[0].name === 'Catalog Chips' && snapAfter[0].upc === '012345678905');
    ok('demo projection unchanged after the catalog edit', demoAfter[0].name === 'Catalog Chips');
  }

  console.log('\n— P-4: mail layouts are chosen by the scheduled offset —');
  {
    const b = { siteOrigin: 'https://staging.demohubhq.test', resendApiKey: 'k' };
    const hostile = { name: 'Chips <img src=x onerror=alert(1)>', size: '5 oz', sku: 'CC-5', upc: '012345678905', distributor: 'other', distributor_other: 'SECRET <i>Dist</i>', distributor_item_number: '0007', case_pack: 12, notes: '<script>x</script>' };
    const booking = { id: crypto.randomUUID(), brand_name: 'PL Brand', demo_date: dayP(20), demo_time: '11:00 AM', status: 'confirmed', product: 'Snacks', product_skus: [hostile, { name: 'Legacy Salsa', size: '16 oz', sku: 'LS' }], timezone: LA };
    const ctx = buildContext({ booking, retailer: { name: 'PL Market', slug, timezone: LA }, venue: { name: 'PL Main' }, brand: null });
    const full = (m) => /Products for this demo: ordering details/.test(m.html) && /Check stock and arrange any needed order/.test(m.html) && /UPC \/ product barcode/.test(m.html);
    const compact = (m) => /Products for this demo</.test(m.html) && !/Products for this demo: ordering details/.test(m.html) && !/UPC \/ product barcode/.test(m.html) && /Full ordering details are on this booking/.test(m.html) && /\/r\/.*\/admin/.test(m.html);
    ok('confirmed: full layout', full(confirmedMessage(b, ctx)));
    ok('rescheduled: full layout', full(rescheduledMessage(b, ctx, { from: null })));
    ok('reminder w1: full layout', full(reminderMessage(b, ctx, new Date(), { offsetKey: 'w1' })));
    ok('reminder d14: full layout', full(reminderMessage(b, ctx, new Date(), { offsetKey: 'd14' })));
    ok('reminder d7 (custom 7 days): full layout', full(reminderMessage(b, ctx, new Date(), { offsetKey: 'd7' })));
    ok('reminder d3: compact with the store-admin pointer', compact(reminderMessage(b, ctx, new Date(), { offsetKey: 'd3' })));
    ok('reminder d1, morning_of, h1: compact', ['d1', 'morning_of', 'h1'].every(k => compact(reminderMessage(b, ctx, new Date(), { offsetKey: k }))));
    ok('the layout does not depend on the clock: w1 built "late" (demo tomorrow) is still full', full(reminderMessage(b, ctx, new Date(new Date(ctx.startAt).getTime() - 12 * 3600e3), { offsetKey: 'w1' })));
    ok('offsetWantsFullProducts: w1/d14/d7/d30 true; d3/d1/morning_of/h1/null false', ['w1', 'd14', 'd7', 'd30'].every(offsetWantsFullProducts) && !['d3', 'd1', 'morning_of', 'h1', null, ''].some(offsetWantsFullProducts));
    ok('cancelled: no item box at all', !/Products for this demo/.test(cancelledMessage(b, ctx, { reason: null }).html));
    const f = confirmedMessage(b, ctx).html;
    ok('full layout: legacy item shows "Not provided" for absent ordering details', /Legacy Salsa/.test(f) && /Not provided/.test(f));
    ok('full layout: every field escaped, no raw tag survives', !/<img src=x|<script>x|<i>Dist/.test(f) && /&lt;img src=x onerror=alert\(1\)&gt;/.test(f) && /SECRET &lt;i&gt;Dist&lt;\/i&gt;/.test(f) && /&lt;script&gt;x&lt;\/script&gt;/.test(f));
    ok('full layout: brand SKU, distributor item number and barcode are three distinct labelled lines', /Brand SKU:<\/span> CC-5/.test(f) && /Distributor item number:<\/span> 0007/.test(f) && /UPC \/ product barcode:<\/span> 012345678905/.test(f) && /12 units per case/.test(f));
    const empty = confirmedMessage(b, buildContext({ booking: { ...booking, product_skus: null }, retailer: { name: 'PL Market', slug, timezone: LA }, venue: { name: 'PL Main' } }));
    ok('empty snapshot: no item box, no error', !/Products for this demo/.test(empty.html));
    ok('subjects carry no em dash', ![confirmedMessage(b, ctx), reminderMessage(b, ctx, new Date(), { offsetKey: 'w1' })].some(m => /—/.test(m.subject + m.html)));
  }
} finally {
  for (const [t, id] of bin.reverse()) {
    if (t === 'brands') { for (const x of ['brand_account_sessions', 'brand_account_tokens', 'brand_contacts']) await db(`${x}?brand_id=eq.${id}`, { method: 'DELETE' }); }
    if (t === 'bookings') { await db(`notification_deliveries?booking_id=eq.${id}`, { method: 'DELETE' }); await db(`notification_events?booking_id=eq.${id}`, { method: 'DELETE' }); await db(`demos?booking_id=eq.${id}`, { method: 'DELETE' }); }
    if (t === 'retailers') { await db(`admin_sessions?retailer_id=eq.${id}`, { method: 'DELETE' }); }
    await db(`${t}?id=eq.${id}`, { method: 'DELETE' });
  }
  spy.restore();
}
process.exit(summary('brand product list (P-1/P-3/P-4)') ? 0 : 1);
