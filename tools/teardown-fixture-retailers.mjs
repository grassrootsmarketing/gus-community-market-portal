// tools/teardown-fixture-retailers.mjs (2026-10-30): removes route-suite fixture retailers (and their bookings, payment
// groups, refund rows, cases and fixture brands) from demohub-rebuild-check by slug prefix, using tests/_teardown.mjs.
// Written for the connected checkout round 3 housekeeping: the simulated suites had left refund requests with invented
// Stripe ids that every real refund worker run on the test project kept retrying. Refuses any other project.
// Usage: node tools/teardown-fixture-retailers.mjs cs,cc,ka [--since 2026-10-30T00:00:00Z] [--dry]
import { teardownRetailerFixtures } from '../tests/_teardown.mjs';
const { SB_URL, SB_KEY, SB_REF } = process.env;
if (!SB_URL || !SB_KEY || SB_REF !== 'tileejdviuvijumjeplv' || !SB_URL.includes(SB_REF)) { console.error('REFUSING: SB_URL / SB_KEY / SB_REF must name demohub-rebuild-check'); process.exit(2); }
const args = process.argv.slice(2);
const prefixes = (args[0] || '').split(',').map(s => s.trim()).filter(Boolean);
if (!prefixes.length || prefixes.some(p => !/^[a-z0-9-]{2,24}$/.test(p) || p.startsWith('rehearsal'))) { console.error('usage: <prefix,prefix> (letters, digits, dashes; the rehearsal fixtures are kept on purpose)'); process.exit(2); }
const sinceIdx = args.indexOf('--since'); const since = sinceIdx >= 0 ? args[sinceIdx + 1] : null;
const dry = args.includes('--dry');
const H = { apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY };
const or = prefixes.map(p => `slug.like.${p}-*`).join(',');
const url = `${SB_URL}/rest/v1/retailers?select=id,slug,created_at&or=(${or})${since ? `&created_at=gte.${encodeURIComponent(since)}` : ''}&order=created_at.asc`;
const rows = await (await fetch(url, { headers: H })).json();
if (!Array.isArray(rows)) { console.error('lookup failed:', JSON.stringify(rows)); process.exit(1); }
console.log(`${rows.length} fixture retailer(s) match ${prefixes.join(', ')}${since ? ' since ' + since : ''}:`);
for (const r of rows) console.log(`  ${r.slug}  ${r.created_at}`);
if (dry || !rows.length) process.exit(0);
const counts = await teardownRetailerFixtures({ sbUrl: SB_URL, sbKey: SB_KEY, retailerIds: rows.map(r => r.id), log: (m) => console.log(m) });
console.log('done:', JSON.stringify(counts));
