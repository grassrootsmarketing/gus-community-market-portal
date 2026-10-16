// tests/demo_fee_card.test.mjs (David, 2026-10-16): the Settings fee card says what brands pay and where it goes,
// per arrangement. The renderer is lifted from the retailer admin page and run against a tiny DOM stub.
//   keeps-all pilot (Gus's): "Brands pay $30", pilot sentence, no "$5", no "You keep"
//   standard store:          "Brands pay $35", the flat $5 sentence with the store's $30
// Also pins the server side: api/admin.js must send platform_keeps_all with the retailer row, or the page cannot know.
import { readFileSync } from 'node:fs';
let pass = 0, fail = 0;
const ok = (n, c, d) => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n + (d ? ' ' + d : '')); } };
const src = readFileSync('r/gus/admin/index.html', 'utf8');
const fn = src.match(/function _updateDemoFeeSplit\(retailerFee\) \{[\s\S]*?\n        \}\n/);
if (!fn) throw new Error('renderer not found');
const run = (fee, keepsAll) => {
  const els = { feeBrandPays: { textContent: '' }, feeArrangement: { textContent: '' } };
  const document = { getElementById: (id) => els[id] || null };
  const window = { state: { retailer: { platform_keeps_all: keepsAll } } };
  new Function('document', 'window', '_PLATFORM_FEE', fn[0] + '\n_updateDemoFeeSplit(' + fee + ');')(document, window, 5);
  return els;
};
const pilot = run(30, true);
ok('pilot: brands pay $30', pilot.feeBrandPays.textContent === '$30', pilot.feeBrandPays.textContent);
ok('pilot: the sentence names the pilot arrangement and no store payout', /Pilot arrangement/.test(pilot.feeArrangement.textContent) && /no store payout/.test(pilot.feeArrangement.textContent), pilot.feeArrangement.textContent);
ok('pilot: no $5 and no $35 anywhere', !/\$5\b|\$35/.test(pilot.feeArrangement.textContent + pilot.feeBrandPays.textContent));
const std = run(30, false);
ok('standard: brands pay $35', std.feeBrandPays.textContent === '$35', std.feeBrandPays.textContent);
ok('standard: the sentence says flat $5, brands pay $35, store receives $30', /flat \$5/.test(std.feeArrangement.textContent) && /\$35/.test(std.feeArrangement.textContent) && /receives \$30/.test(std.feeArrangement.textContent), std.feeArrangement.textContent);
const zero = run(0, false);
ok('standard with a $0 store fee: brands pay $5, store receives $0', zero.feeBrandPays.textContent === '$5' && /receives \$0/.test(zero.feeArrangement.textContent), zero.feeArrangement.textContent);
ok('the three-box split is gone from the markup', !/id="feePlatform"|id="feeRetailerKeeps"|>You keep</.test(src));
ok('no em dashes in the card code', !/—/.test(fn[0]));
const admin = readFileSync('api/admin.js', 'utf8');
ok('api/admin.js sends platform_keeps_all with the retailer row', /retailers\?id=eq\.[^`]*select=[^`]*platform_keeps_all/.test(admin));
console.log(`\ndemo fee card: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
