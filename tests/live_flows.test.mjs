// tests/live_flows.test.mjs — Codex Step 4, the remaining valid-binding flow groups.
// Run against the rebuilt staging project. Every group cleans up what it creates.
import { rest, rpc, ok, summary, uniq } from './_live.mjs';

const bin = [];   // [table, id] teardown, reverse order
const track = (t, id) => { if (id) bin.push([t, id]); return id; };

async function mkRetailer(extra = {}) {
  const r = await rest('retailers', { method: 'POST', body: JSON.stringify({
    slug: uniq('flow'), name: 'Flow Fixture', billing_email: uniq('flow') + '@fixture.test',
    billing_tier: 'pro', billing_status: 'active', ...extra }) });
  return track('retailers', r.ok && r.body[0] && r.body[0].id);
}
async function mkVenue(rid, extra = {}) {
  const r = await rest('venues', { method: 'POST', body: JSON.stringify({
    retailer_id: rid, name: 'Main', address: '1 Flow St', demo_fee: 30, ...extra }) });
  return track('venues', r.ok && r.body[0] && r.body[0].id);
}
async function mkBrand(extra = {}) {
  const r = await rest('brands', { method: 'POST', body: JSON.stringify({
    email: uniq('brand') + '@fixture.test', company_name: 'Flow Brand', is_verified: true, ...extra }) });
  return track('brands', r.ok && r.body[0] && r.body[0].id);
}
const day = (n) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + 40 + n); return d.toISOString().slice(0, 10); };

// =====================================================================
console.log('\n— GROUP 1: owner verification queue —');
{
  const r = await rest('retailers?select=id&verification_status=eq.pending&limit=1');
  ok('verification queue is queryable', r.ok, `HTTP ${r.status} ${JSON.stringify(r.body).slice(0,120)}`);
  const rid = await mkRetailer();
  const p = await rest(`retailers?id=eq.${rid}`, { method: 'PATCH', body: JSON.stringify({
    verification_status: 'approved', verified_at: new Date().toISOString(), verified_by: 'owner@test', verification_notes: 'ok' }) });
  ok('retailer can be approved', p.ok, `HTTP ${p.status} ${JSON.stringify(p.body).slice(0,120)}`);
}

// =====================================================================
console.log('\n— GROUP 2: first booking for a newly verified brand —');
let bookRid, bookVid, bookBid, bookingId;
{
  bookRid = await mkRetailer(); bookVid = await mkVenue(bookRid); bookBid = await mkBrand();
  const b = await rest('bookings', { method: 'POST', body: JSON.stringify({
    retailer_id: bookRid, venue_id: bookVid, brand_id: bookBid, brand_name: 'Flow Brand',
    contact_name: 'Tester', contact_email: 'tester@fixture.test',
    demo_date: day(1), demo_time: '10:00', status: 'pending_payment', payment_status: 'unpaid' }) });
  bookingId = track('bookings', b.ok && b.body[0] && b.body[0].id);
  ok('first booking is created', b.ok && !!bookingId, `HTTP ${b.status} ${JSON.stringify(b.body).slice(0,140)}`);

  const cross = await rest('bookings', { method: 'POST', body: JSON.stringify({
    retailer_id: bookRid, venue_id: await mkVenue(await mkRetailer()), brand_id: bookBid, brand_name: 'X',
    contact_name: 'X', contact_email: 'x@fixture.test', demo_date: day(2), demo_time: '11:00' }) });
  ok('a venue from ANOTHER retailer is refused', !cross.ok, `HTTP ${cross.status}`);
}

// =====================================================================
console.log('\n— GROUP 3: slot capacity is enforced atomically —');
{
  const rid = await mkRetailer(); const vid = await mkVenue(rid, { max_demos_per_slot: 1 });
  const d = day(3), t = '09:00';
  const mk = () => rest('bookings', { method: 'POST', body: JSON.stringify({
    retailer_id: rid, venue_id: vid, brand_name: 'Race', contact_name: 'R',
    contact_email: 'r@fixture.test', demo_date: d, demo_time: t, status: 'pending_payment', payment_status: 'unpaid' }) });
  const results = await Promise.all([mk(), mk(), mk(), mk(), mk(), mk()]);
  results.forEach(r => { if (r.ok && r.body[0]) track('bookings', r.body[0].id); });
  const accepted = results.filter(r => r.ok).length;
  const rows = await rest(`bookings?venue_id=eq.${vid}&demo_date=eq.${d}&demo_time=eq.${t}&select=id`);
  ok('slot cap 1: exactly one of 6 parallel bookings wins', accepted === 1, `accepted ${accepted}`);
  ok('slot cap 1: database holds exactly one booking for that slot',
     Array.isArray(rows.body) && rows.body.length === 1, `rows ${Array.isArray(rows.body) ? rows.body.length : '?'}`);
}

// =====================================================================
console.log('\n— GROUP 4: calendar token issue / resolve / revoke —');
{
  const bid = await mkBrand();
  const iss = await rpc('issue_calendar_token', { p_brand_id: bid, p_label: 'test', p_rotate: false });
  ok('calendar token issued', iss.ok, `HTTP ${iss.status} ${JSON.stringify(iss.body).slice(0,140)}`);
  // The RPC returns the token as a bare scalar, not an object — PostgREST unwraps a
  // single-column, single-row result. Accept either shape rather than assume one.
  const tok = typeof iss.body === 'string' ? iss.body
            : (iss.body && (iss.body.token || (iss.body[0] && (iss.body[0].token || iss.body[0])))) || null;
  if (tok) {
    const res1 = await rpc('resolve_calendar_token', { p_token: tok });
    ok('issued token resolves to its brand', res1.ok && JSON.stringify(res1.body).includes(bid),
       JSON.stringify(res1.body).slice(0, 140));
    const rev = await rpc('revoke_calendar_tokens', { p_brand_id: bid });
    ok('tokens revoked', rev.ok, `HTTP ${rev.status}`);
    const res2 = await rpc('resolve_calendar_token', { p_token: tok });
    const resolved = res2.body && JSON.stringify(res2.body) !== 'null' && JSON.stringify(res2.body) !== '[]';
    ok('a REVOKED token no longer resolves', !resolved, JSON.stringify(res2.body).slice(0, 140));
  } else {
    ok('calendar token returned a token value', false, JSON.stringify(iss.body).slice(0, 200));
  }
}

// =====================================================================
console.log('\n— GROUP 5: COI private storage —');
{
  const path = `probe/${uniq('coi')}.pdf`;
  const SB = process.env.SB_URL, K = process.env.SB_KEY;
  const put = await fetch(`${SB}/storage/v1/object/coi-docs/${path}`, {
    method: 'POST', headers: { apikey: K, Authorization: 'Bearer ' + K, 'Content-Type': 'application/pdf' }, body: '%PDF-1.4 probe' });
  ok('service role can upload a PDF to coi-docs', put.ok, `HTTP ${put.status}`);

  // The bucket restricts MIME types. A COI is a document; accepting text/plain or text/html would
  // let a caller stage script content behind a signed URL, so the refusal is a control.
  const badMime = await fetch(`${SB}/storage/v1/object/coi-docs/${path}.txt`, {
    method: 'POST', headers: { apikey: K, Authorization: 'Bearer ' + K, 'Content-Type': 'text/html' }, body: '<script>x</script>' });
  ok('coi-docs REFUSES a non-document mime type', !badMime.ok, `HTTP ${badMime.status}`);

  const anon = await fetch(`${SB}/storage/v1/object/public/coi-docs/${path}`);
  ok('coi-docs is NOT publicly readable', !anon.ok, `HTTP ${anon.status} (200 would mean COIs are world-readable)`);

  const signed = await fetch(`${SB}/storage/v1/object/sign/coi-docs/${path}`, {
    method: 'POST', headers: { apikey: K, Authorization: 'Bearer ' + K, 'Content-Type': 'application/json' },
    body: JSON.stringify({ expiresIn: 60 }) });
  ok('a signed URL can be minted for an authorised reader', signed.ok, `HTTP ${signed.status}`);

  await fetch(`${SB}/storage/v1/object/coi-docs/${path}`, { method: 'DELETE', headers: { apikey: K, Authorization: 'Bearer ' + K } });
}

// =====================================================================
console.log('\n— GROUP 6: multi-demo checkout claim + allocations —');
{
  const rid = await mkRetailer({ platform_keeps_all: true }); const vid = await mkVenue(rid); const bid = await mkBrand();
  const ids = [];
  for (let i = 0; i < 3; i++) {
    const b = await rest('bookings', { method: 'POST', body: JSON.stringify({
      retailer_id: rid, venue_id: vid, brand_id: bid, brand_name: 'Multi', contact_name: 'M',
      contact_email: 'm@fixture.test', demo_date: day(10 + i), demo_time: '12:00',
      status: 'pending_payment', payment_status: 'unpaid' }) });
    if (b.ok && b.body[0]) ids.push(track('bookings', b.body[0].id));
  }
  ok('three same-retailer bookings created', ids.length === 3, `got ${ids.length}`);

  const claim = await rpc('checkout_claim_group', {
    p_brand_id: bid, p_retailer_id: rid, p_booking_ids: ids,
    p_platform_keeps_all: true, p_connect_account_id: null, p_platform_fee_cents: 500 });
  const gid = claim.body && (claim.body.payment_group_id || (claim.body[0] && claim.body[0].payment_group_id));
  ok('checkout claims one group for all three', claim.ok && !!gid, `HTTP ${claim.status} ${JSON.stringify(claim.body).slice(0,160)}`);
  if (gid) {
    track('payment_groups', gid);
    const alloc = await rest(`payment_allocations?payment_group_id=eq.${gid}&select=booking_id,customer_amount`);
    ok('one allocation per booking', Array.isArray(alloc.body) && alloc.body.length === 3,
       `allocations ${Array.isArray(alloc.body) ? alloc.body.length : '?'}`);
    const reclaim = await rpc('checkout_claim_group', {
      p_brand_id: bid, p_retailer_id: rid, p_booking_ids: ids,
      p_platform_keeps_all: true, p_connect_account_id: null, p_platform_fee_cents: 500 });
    const gid2 = reclaim.body && (reclaim.body.payment_group_id || (reclaim.body[0] && reclaim.body[0].payment_group_id));
    ok('re-claiming the SAME set reuses the group (no duplicate charge)', gid2 === gid, `${gid2} vs ${gid}`);
  }
}

// =====================================================================
console.log('\n— GROUP 7: webhook event replay is idempotent —');
{
  const evt = 'evt_' + uniq('probe');
  const c1 = await rpc('claim_stripe_event', { p_event_id: evt, p_event_type: 'checkout.session.completed', p_owner: 'w1', p_lease_seconds: 60 });
  const c2 = await rpc('claim_stripe_event', { p_event_id: evt, p_event_type: 'checkout.session.completed', p_owner: 'w2', p_lease_seconds: 60 });
  const claimed1 = JSON.stringify(c1.body), claimed2 = JSON.stringify(c2.body);
  ok('first worker claims the event', c1.ok, `HTTP ${c1.status} ${claimed1.slice(0,120)}`);
  ok('a second worker does NOT get the same live lease', claimed1 !== claimed2 || !c2.ok,
     `w1=${claimed1.slice(0,80)} w2=${claimed2.slice(0,80)}`);
  await rest(`processed_stripe_events?event_id=eq.${evt}`, { method: 'DELETE' });
}

// =====================================================================
console.log('\n— teardown —');
// FK-safe order: children before parents. payment_allocations reference bookings, so a booking
// delete fails while its allocation survives — which is what left rows behind on the first run.
for (const [, gid] of bin.filter(([t]) => t === 'payment_groups')) {
  await rest(`payment_allocations?payment_group_id=eq.${gid}`, { method: 'DELETE' });
}
for (const [t, id] of bin.reverse()) await rest(`${t}?id=eq.${id}`, { method: 'DELETE' });
// Scope this to rows THIS suite created. The first version matched any *@fixture.test address,
// which also matches the ledger suite's advtest-* rows — so an interrupted ledger run made this
// assertion fail for something live_flows never touched. An over-broad cleanup assertion is worse
// than none: it reports a failure in the wrong component and trains you to ignore it.
const mine = bin.filter(([t]) => t === 'bookings').map(([, id]) => id);
const stillThere = mine.length
  ? await rest(`bookings?select=id&id=in.(${mine.join(',')})`)
  : { body: [] };
ok('teardown: every booking THIS suite created is gone',
   Array.isArray(stillThere.body) && stillThere.body.length === 0,
   `${Array.isArray(stillThere.body) ? stillThere.body.length : '?'} of ${mine.length} left`);

process.exit(summary('live flows') ? 0 : 1);
