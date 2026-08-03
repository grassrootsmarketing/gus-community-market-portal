// tests/retired_routes.test.mjs
//
// Static assertion (offline, no DB) that the legacy per-booking refund route stays retired (Codex C4):
//   * its dead helpers are gone;
//   * api/refund-booking.js is an explicit 410 stub that imports neither helper;
//   * NO active code path (api handler or shipped HTML) fetches /api/refund-booking, and no route
//     test drives it — booking-action.js is the sole canonical cancellation/refund route.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}  ${detail}`); }
};

// Recursively collect files with the given extensions, skipping node_modules/.git.
function walk(dir, exts, out = []) {
  let entries = [];
  try { entries = readdirSync(dir); } catch { return out; }
  for (const e of entries) {
    if (e === 'node_modules' || e === '.git') continue;
    const p = join(dir, e);
    let s; try { s = statSync(p); } catch { continue; }
    if (s.isDirectory()) walk(p, exts, out);
    else if (exts.some(x => e.endsWith(x))) out.push(p);
  }
  return out;
}

console.log('\n— retired route: api/refund-booking.js (410) —');

// 1. Dead helpers removed.
check('_refund-recovery.js is deleted', !existsSync(resolve('api/_refund-recovery.js')));
check('_refund-ledger.js is deleted', !existsSync(resolve('api/_refund-ledger.js')));

// 2. refund-booking.js is a 410 retirement stub that imports neither dead helper.
{
  const src = existsSync(resolve('api/refund-booking.js')) ? readFileSync(resolve('api/refund-booking.js'), 'utf8') : '';
  check('refund-booking.js returns 410', /\.status\(\s*410\s*\)/.test(src), src.slice(0, 80));
  check('refund-booking.js imports no dead refund helper',
    !/import[^;]*_refund-(recovery|ledger)/.test(src));
}

// 3. No active code path CALLS the retired endpoint.
const CALL = /\/api\/refund-booking\b/;                 // a client fetch/href to the endpoint
const CALLROUTE = /callRoute\(\s*['"]refund-booking\.js['"]/;   // a route test driving it
{
  const apiCallers = walk(resolve('api'), ['.js']).filter(f => !f.endsWith('refund-booking.js'))
    .filter(f => CALL.test(readFileSync(f, 'utf8')));
  const htmlCallers = walk(resolve('.'), ['.html']).filter(f => CALL.test(readFileSync(f, 'utf8')));
  const testCallers = walk(resolve('tests'), ['.mjs', '.js']).filter(f => CALLROUTE.test(readFileSync(f, 'utf8')));
  check('no api handler fetches /api/refund-booking', apiCallers.length === 0, JSON.stringify(apiCallers));
  check('no shipped HTML fetches /api/refund-booking', htmlCallers.length === 0, JSON.stringify(htmlCallers));
  check('no route test drives refund-booking.js', testCallers.length === 0, JSON.stringify(testCallers));
}

// 4. booking-action.js is the canonical refund/cancel path.
{
  const ba = readFileSync(resolve('api/booking-action.js'), 'utf8');
  check('booking-action.js is the canonical refund path (reserveAndRefund via apply_refund_event)',
    /reserveAndRefund/.test(ba) && /apply_refund_event/.test(ba));
}

console.log(`\nretired-routes: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
