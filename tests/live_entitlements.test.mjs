// tests/live_entitlements.test.mjs — Codex Step 4, groups 2 and 3.
//
// Solo location boundary + parallel-insert enforcement, and the Pro ceiling at locations 10/11.
//
// This is the finding-D repair under a real database. The JS helper was repaired earlier so the
// route stopped returning 503, but the DB trigger still carried pro=10 — which moved the failure
// from "always" to "at the 11th location", a worse defect because it looks like it works.
import { rest, ok, summary, uniq } from './_live.mjs';

async function mkRetailer(tier, slug) {
  const r = await rest('retailers', { method: 'POST', body: JSON.stringify({
    slug, name: `fixture ${tier}`, billing_email: `${slug}@fixture.test`, billing_tier: tier, billing_status: 'active',
  })});
  if (!r.ok) throw new Error(`retailer create failed: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body[0].id;
}
const addVenue = (rid, n) => rest('venues', { method: 'POST', body: JSON.stringify({
  retailer_id: rid, name: `loc ${n}`, address: `${n} Test St`, demo_fee: 30,
})});

const created = [];

// ---- SOLO: exactly one location, second is refused ----
{
  const rid = await mkRetailer('solo', uniq('t-solo')); created.push(rid);
  const a = await addVenue(rid, 1);
  ok('solo: first location is accepted', a.ok, `status ${a.status}`);
  const b = await addVenue(rid, 2);
  ok('solo: SECOND location is refused by the database', !b.ok, `status ${b.status}`);
  ok('solo: refusal names the venue limit, not a generic error',
     JSON.stringify(b.body).includes('venue_limit_reached'), JSON.stringify(b.body).slice(0, 160));
  const n = await rest(`venues?retailer_id=eq.${rid}&select=id`);
  ok('solo: exactly one location exists afterwards', n.body.length === 1, `saw ${n.body.length}`);
}

// ---- SOLO under CONCURRENCY: the real test of the trigger ----
// A count-then-insert check in application code cannot survive this. The trigger takes
// FOR UPDATE on the retailer row, which serialises the inserts.
{
  const rid = await mkRetailer('solo', uniq('t-solo-race')); created.push(rid);
  const results = await Promise.all([1,2,3,4,5,6,7,8].map(i => addVenue(rid, i)));
  const accepted = results.filter(r => r.ok).length;
  const rows = await rest(`venues?retailer_id=eq.${rid}&select=id`);
  ok('solo race: exactly ONE of 8 parallel inserts is accepted', accepted === 1, `accepted ${accepted}`);
  ok('solo race: the database holds exactly one location', rows.body.length === 1, `rows ${rows.body.length}`);
}

// ---- PRO: locations 10 and 11 both succeed (the ceiling used to be 10) ----
{
  const rid = await mkRetailer('pro', uniq('t-pro')); created.push(rid);
  let failedAt = null;
  for (let i = 1; i <= 11; i++) {
    const r = await addVenue(rid, i);
    if (!r.ok) { failedAt = i; break; }
  }
  ok('pro: no refusal anywhere up to location 11', failedAt === null, `refused at ${failedAt}`);
  const rows = await rest(`venues?retailer_id=eq.${rid}&select=id`);
  ok('pro: 11 locations exist (old trigger capped at 10)', rows.body.length === 11, `rows ${rows.body.length}`);
}

// ---- PRO with a lapsed subscription drops back to the Solo limit ----
{
  const rid = await mkRetailer('pro', uniq('t-pro-unpaid')); created.push(rid);
  await rest(`retailers?id=eq.${rid}`, { method: 'PATCH', body: JSON.stringify({ billing_status: 'past_due' }) });
  const a = await addVenue(rid, 1);
  const b = await addVenue(rid, 2);
  ok('pro past_due: first location accepted', a.ok, `status ${a.status}`);
  ok('pro past_due: second location refused (entitlement follows billing state)', !b.ok, `status ${b.status}`);
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
