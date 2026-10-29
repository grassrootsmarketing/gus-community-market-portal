// tests/live_entitlements.test.mjs, locations are not limited by plan (2026-10-28, migration 0115).
//
// History: this file used to prove the Solo boundary (one location, the second refused by the
// enforce_venue_limit() trigger, under concurrency too) and the Pro ceiling at locations 10 and 11.
// Demohub is now free for retailers at any number of locations and the Pro tier is gone, so 0115
// dropped the trigger. The assertions are inverted: whatever billing_tier or billing_status a row
// still carries, every insert is accepted, serially and in parallel, and no response mentions a
// venue limit any more.
import { rest, ok, summary, uniq } from './_live.mjs';
import { HOURLY } from './_fixture_availability.mjs';


async function mkRetailer(tier, slug, status = 'active') {
  const r = await rest('retailers', { method: 'POST', body: JSON.stringify({
    slug, name: `fixture ${tier}`, billing_email: `${slug}@fixture.test`, billing_tier: tier, billing_status: status,
  })});
  if (!r.ok) throw new Error(`retailer create failed: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body[0].id;
}
const addVenue = (rid, n) => rest('venues', { method: 'POST', body: JSON.stringify({
  retailer_id: rid, name: `loc ${n}`, address: `${n} Test St`, demo_fee: 30, availability: HOURLY,
})});

const created = [];

// ---- a 'solo' row takes three locations in a row ----
{
  const rid = await mkRetailer('solo', uniq('t-solo')); created.push(rid);
  const results = [];
  for (let i = 1; i <= 3; i++) results.push(await addVenue(rid, i));
  const refused = results.map((r, i) => (r.ok ? null : `#${i + 1} ${r.status} ${JSON.stringify(r.body).slice(0, 120)}`)).filter(Boolean);
  ok('solo: three serial locations are all accepted', refused.length === 0, refused.join(' | '));
  const n = await rest(`venues?retailer_id=eq.${rid}&select=id`);
  ok('solo: three locations exist afterwards', n.body.length === 3, `saw ${n.body.length}`);
  ok('solo: no response mentions venue_limit_reached', !results.some(r => JSON.stringify(r.body).includes('venue_limit_reached')));
}

// ---- a 'solo' row under CONCURRENCY: all eight parallel inserts land ----
{
  const rid = await mkRetailer('solo', uniq('t-solo-race')); created.push(rid);
  const results = await Promise.all([1,2,3,4,5,6,7,8].map(i => addVenue(rid, i)));
  const accepted = results.filter(r => r.ok).length;
  const rows = await rest(`venues?retailer_id=eq.${rid}&select=id`);
  ok('solo race: all 8 parallel inserts are accepted', accepted === 8, `accepted ${accepted}`);
  ok('solo race: the database holds all eight locations', rows.body.length === 8, `rows ${rows.body.length}`);
}

// ---- a legacy 'pro' row still takes locations 10 and 11 (nothing regressed for existing multi-store rows) ----
{
  const rid = await mkRetailer('pro', uniq('t-pro')); created.push(rid);
  let failedAt = null;
  for (let i = 1; i <= 11; i++) {
    const r = await addVenue(rid, i);
    if (!r.ok) { failedAt = i; break; }
  }
  ok('legacy pro: no refusal anywhere up to location 11', failedAt === null, `refused at ${failedAt}`);
  const rows = await rest(`venues?retailer_id=eq.${rid}&select=id`);
  ok('legacy pro: 11 locations exist', rows.body.length === 11, `rows ${rows.body.length}`);
}

// ---- billing_status no longer matters either: a past_due row is not dropped to one location ----
{
  const rid = await mkRetailer('pro', uniq('t-pro-unpaid')); created.push(rid);
  await rest(`retailers?id=eq.${rid}`, { method: 'PATCH', body: JSON.stringify({ billing_status: 'past_due' }) });
  const a = await addVenue(rid, 1);
  const b = await addVenue(rid, 2);
  ok('past_due: first location accepted', a.ok, `status ${a.status}`);
  ok('past_due: second location accepted too (billing state gates nothing)', b.ok, `status ${b.status} ${JSON.stringify(b.body).slice(0, 120)}`);
}

// ---- a legacy 'starter' row, which the old trigger treated as solo ----
{
  const rid = await mkRetailer('starter', uniq('t-starter')); created.push(rid);
  const a = await addVenue(rid, 1);
  const b = await addVenue(rid, 2);
  ok('legacy starter: two locations accepted', a.ok && b.ok, `${a.status} / ${b.status}`);
}

// ---- cleanup ----
for (const rid of created) {
  await rest(`venues?retailer_id=eq.${rid}`, { method: 'DELETE' });
  await rest(`retailers?id=eq.${rid}`, { method: 'DELETE' });
}
const leftover = await rest(`retailers?slug=like.t-*&select=id`);
ok('cleanup: no fixture retailers left behind', Array.isArray(leftover.body) && leftover.body.length === 0,
   `${Array.isArray(leftover.body) ? leftover.body.length : '?'} left`);

process.exit(summary('live entitlements') ? 0 : 1);
