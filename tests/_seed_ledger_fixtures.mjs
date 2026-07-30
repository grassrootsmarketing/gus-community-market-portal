// tests/_seed_ledger_fixtures.mjs — fixtures for payment_ledger_adversarial.mjs.
//
// That suite pins its fixtures to literal UUIDs which were created by hand on the retired staging
// project. Rebuilding staging from empty leaves them absent, so the suite fails at its first
// seedBooking with "venue does not belong to this retailer" — the booking trigger correctly
// refusing a venue that does not exist.
//
// This recreates those exact rows so the adversarial suite runs UNMODIFIED. Editing the suite to
// look fixtures up by name would also work, but it would mean Codex re-reviewing a changed test on
// the same round it is being asked to accept that test's results. Seeding is the smaller claim.
//
// Idempotent: upserts on primary key, so re-running after a rebuild is safe.
import { rest, ok, summary } from './_live.mjs';

const F = {
  KEEPS_RETAILER: '8cf80c18-ff37-4c32-8154-dcdd90486942',
  KEEPS_VENUE:    '35301125-8921-4bb2-a7d5-aac777e2e76e',
  CONN_RETAILER:  '768705e2-e2e8-4f50-ad7d-0bf02e63fb06',
  CONN_VENUE:     'f7646ef5-29cb-4942-83e2-e701ff1712c4',
  BRAND1:         '7f044529-1aba-417a-9b39-ea55f846d06d',
  BRAND2:         'a75b1fec-ae6c-4232-af2b-b0aa64dd2b7b',
};
const up = (table, row) => rest(table, {
  method: 'POST', body: JSON.stringify(row),
  headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
});

// Retailers. billing_tier 'pro' + active so the venue-limit trigger never interferes with a
// fixture; the entitlement behaviour itself is tested separately in live_entitlements.
const r1 = await up('retailers', {
  id: F.KEEPS_RETAILER, slug: 'test-a', name: 'Test A (keeps-all)',
  billing_email: 'test-a@fixture.test', billing_tier: 'pro', billing_status: 'active',
  platform_keeps_all: true,
});
ok('fixture retailer test-a (platform_keeps_all)', r1.ok, `${r1.status} ${JSON.stringify(r1.body).slice(0,140)}`);

const r2 = await up('retailers', {
  id: F.CONN_RETAILER, slug: 'test-b', name: 'Test B (connected)',
  billing_email: 'test-b@fixture.test', billing_tier: 'pro', billing_status: 'active',
  platform_keeps_all: false, stripe_account_id: 'acct_fixture_testb',
  stripe_charges_enabled: true, stripe_payouts_enabled: true, stripe_account_status: 'enabled',
});
ok('fixture retailer test-b (connected)', r2.ok, `${r2.status} ${JSON.stringify(r2.body).slice(0,140)}`);

// Venues. The fee values matter: the suite asserts allocation maths against $30 and $45.
const v1 = await up('venues', { id: F.KEEPS_VENUE, retailer_id: F.KEEPS_RETAILER, name: 'A - Main', address: '1 A St', demo_fee: 30 });
ok('fixture venue A - Main @ $30', v1.ok, `${v1.status} ${JSON.stringify(v1.body).slice(0,140)}`);
const v2 = await up('venues', { id: F.CONN_VENUE, retailer_id: F.CONN_RETAILER, name: 'B - Main', address: '1 B St', demo_fee: 45 });
ok('fixture venue B - Main @ $45', v2.ok, `${v2.status} ${JSON.stringify(v2.body).slice(0,140)}`);

const b1 = await up('brands', { id: F.BRAND1, email: 'brand1@fixture.test', company_name: 'Fixture Brand One', is_verified: true });
ok('fixture brand1@fixture.test', b1.ok, `${b1.status} ${JSON.stringify(b1.body).slice(0,140)}`);
const b2 = await up('brands', { id: F.BRAND2, email: 'brand2@fixture.test', company_name: 'Fixture Brand Two', is_verified: true });
ok('fixture brand2@fixture.test', b2.ok, `${b2.status} ${JSON.stringify(b2.body).slice(0,140)}`);

// Prove the rows are actually addressable by the IDs the suite will use.
for (const [label, path] of [
  ['retailer test-a', `retailers?id=eq.${F.KEEPS_RETAILER}&select=id,platform_keeps_all`],
  ['retailer test-b', `retailers?id=eq.${F.CONN_RETAILER}&select=id,stripe_account_id`],
  ['venue A - Main',  `venues?id=eq.${F.KEEPS_VENUE}&select=id,retailer_id,demo_fee`],
  ['venue B - Main',  `venues?id=eq.${F.CONN_VENUE}&select=id,retailer_id,demo_fee`],
  ['brand1',          `brands?id=eq.${F.BRAND1}&select=id`],
  ['brand2',          `brands?id=eq.${F.BRAND2}&select=id`],
]) {
  const r = await rest(path);
  ok(`readback: ${label}`, r.ok && Array.isArray(r.body) && r.body.length === 1, JSON.stringify(r.body).slice(0, 120));
}

process.exit(summary('ledger fixtures') ? 0 : 1);
