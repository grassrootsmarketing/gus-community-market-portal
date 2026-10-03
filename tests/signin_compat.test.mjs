// tests/signin_compat.test.mjs — Codex C-1 (closure review 2026-10-03): the OLD application against the database as
// it is NOW, through the old routes themselves. This is the "old app / new schema" half of the cutover matrix (the
// "new app / old schema" half, with the RPCs missing, is in tests/signin_codes.test.mjs). It records what actually
// happens so the runbook is evidence, not assumption:
//   * on the 0089 schema the old brand path mails a code that the window-based redeem then REFUSES (incompatible);
//   * the old retailer path still works, because its old verifier reads the newest row directly (compatible by
//     accident, not by design);
//   * on the pre-0089 schema (after the rollback script) both old paths work end to end.
// Run with OLD_APP_ROOT=<checkout of the production code, e.g. a git worktree of ae22e3f>; it refuses to run without
// it, because a silently skipped matrix would look like evidence. SCHEMA=new|old states which schema the test
// database currently carries; the expectations differ.
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import crypto from 'node:crypto';
import { req, mockRes, ok, summary, uniq, installSpy, ENV } from './_route.mjs';
import { _resetBindingCache } from '../api/_env.js';

const OLD = process.env.OLD_APP_ROOT;
const SCHEMA = process.env.SCHEMA || 'new';
if (!OLD) { console.error('OLD_APP_ROOT required (checkout of the production code)'); process.exit(2); }
if (!['new', 'old'].includes(SCHEMA)) { console.error('SCHEMA must be new or old'); process.exit(2); }
ENV.PUBLIC_RETAILER_SIGNUP_ENABLED = 'true';

const SB = process.env.SB_URL, KEY = process.env.SB_KEY;
const H = { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json', Prefer: 'return=representation' };
const spy = installSpy();
const db = async (path, opts = {}) => { const r = await fetch(`${SB}/rest/v1/${path}`, { ...opts, headers: { ...H, ...(opts.headers || {}) } }); const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch (_) {} return { ok: r.ok, status: r.status, body: j }; };
const emails = [], ips = [], retailerIds = [], brandIds = [];
const newEmail = (t) => { const e = `${uniq(t)}@fixture.test`; emails.push(e); return e; };
const newIp = (t) => { const ip = `test-compat-${uniq(t)}`; ips.push(ip); return ip; };
const emailKey = (e) => crypto.createHash('sha256').update(String(e)).digest('hex').slice(0, 32);
const codesFor = (email) => spy.calls.resend.filter(m => /verification code/i.test(m.subject || '') && JSON.stringify(m).includes(email)).map(m => (/(\d{6})/.exec(m.html) || [])[1]).filter(Boolean);

// The old handlers, loaded from the old tree (their own _env/_verify/_mail), with the harness env and binding.
async function callOld(file, request) {
  process.env = { ...ENV };
  _resetBindingCache();
  const mod = await import(pathToFileURL(resolve(OLD, 'api', file)).href + '?t=' + Date.now() + Math.random());
  const res = mockRes();
  await mod.default(request, res);
  return res;
}
const oldBrand = (body, ip) => callOld('brand-signup.js', req({ body, headers: { 'x-real-ip': ip } }));
const oldRetailer = (body, ip) => callOld('retailer-signup.js', req({ body, headers: { 'x-real-ip': ip } }));
const schemaHasWindows = async () => (await db('verification_windows?select=email&limit=1')).ok;
const redeemIsWindowBased = async () => { const r = await db('rpc/redeem_brand_signup', { method: 'POST', body: JSON.stringify({ p_email: 'nobody-' + uniq('x') + '@fixture.test', p_code_hash: 'h', p_session_token: crypto.randomUUID() }) }); return r.ok && r.body && r.body.outcome === 'no_active_code'; };

try {
  console.log(`\n— old application (${OLD}) against the ${SCHEMA} schema —`);
  const windowBased = await redeemIsWindowBased();
  ok(`fixture: redeem_brand_signup is ${SCHEMA === 'new' ? '' : 'NOT '}window-based`, SCHEMA === 'new' ? windowBased : !windowBased, String(windowBased));
  const bEmail = newEmail('ob'), rEmail = newEmail('or'), ip = newIp('a');
  const bReq = await oldBrand({ action: 'request', email: bEmail, company_name: 'Old Brand' }, ip);
  ok('old brand request → generic 200 and a code is mailed (the old issuer writes the row directly)', bReq.statusCode === 200 && codesFor(bEmail).length === 1, JSON.stringify([bReq.statusCode, codesFor(bEmail).length]));
  const bVer = await oldBrand({ action: 'verify', email: bEmail, code: codesFor(bEmail)[0] }, ip);
  if (SCHEMA === 'new') {
    ok('old brand verify on the NEW schema → 400 (the mailed code cannot match: no window). INCOMPATIBLE, hence the gate', bVer.statusCode === 400 && !bVer.cookie('dh_brand_session'), JSON.stringify([bVer.statusCode, bVer.body]));
    const again = await oldBrand({ action: 'request', email: bEmail, company_name: 'Old Brand' }, ip);
    ok('requesting again from the old app repeats the incompatible issuance (second code, still unredeemable)', again.statusCode === 200 && codesFor(bEmail).length === 2 && (await oldBrand({ action: 'verify', email: bEmail, code: codesFor(bEmail)[1] }, ip)).statusCode === 400);
  } else {
    ok('old brand verify on the OLD schema → 200 + cookie (baseline works)', bVer.statusCode === 200 && !!bVer.cookie('dh_brand_session'), JSON.stringify([bVer.statusCode, bVer.body]));
  }
  const rReq = await oldRetailer({ action: 'request', email: rEmail, store_name: 'Old Market' }, ip);
  ok('old retailer request → generic 200 and a code is mailed', rReq.statusCode === 200 && codesFor(rEmail).length === 1);
  const rVer = await oldRetailer({ action: 'verify', email: rEmail, code: codesFor(rEmail)[0] }, ip);
  ok(`old retailer verify on the ${SCHEMA} schema → 200 (the old verifier reads the newest row itself; compatible either way)`, rVer.statusCode === 200 && rVer.body && rVer.body.ok === true && !!rVer.cookie('dh_retailer_session'), JSON.stringify([rVer.statusCode, rVer.body]));
  const store = ((await db(`retailers?billing_email=eq.${encodeURIComponent(rEmail)}&select=id`)).body || [])[0]; if (store) retailerIds.push(store.id);
  const brandRow = ((await db(`brands?email=eq.${encodeURIComponent(bEmail)}&select=id`)).body || [])[0]; if (brandRow) brandIds.push(brandRow.id);
  ok('schema marker: verification_windows ' + (SCHEMA === 'new' ? 'present' : 'present or absent (rollback keeps tables)'), SCHEMA === 'new' ? await schemaHasWindows() : true);
} finally {
  for (const e of emails) {
    await db(`brand_account_sessions?email=eq.${encodeURIComponent(e)}`, { method: 'DELETE' });
    await db(`brand_members?email=eq.${encodeURIComponent(e)}`, { method: 'DELETE' });
    await db(`email_verifications?email=eq.${encodeURIComponent(e)}`, { method: 'DELETE' });
    await db(`verification_windows?email=eq.${encodeURIComponent(e)}`, { method: 'DELETE' });
    await db(`verification_throttle?scope=eq.email&key=eq.${encodeURIComponent(e)}`, { method: 'DELETE' });
    await db(`signup_budgets?bucket_key=eq.${encodeURIComponent('rsu-req-email:' + emailKey(e))}`, { method: 'DELETE' });
  }
  for (const ip of ips) { await db(`verification_throttle?scope=eq.ip&key=eq.${encodeURIComponent(ip)}`, { method: 'DELETE' }); await db(`signup_budgets?bucket_key=like.${encodeURIComponent('rsu-*:' + ip)}`, { method: 'DELETE' }); }
  for (const rid of retailerIds) { for (const t of ['admin_sessions', 'retailer_admins', 'settings', 'venues']) await db(`${t}?retailer_id=eq.${rid}`, { method: 'DELETE' }); await db(`retailers?id=eq.${rid}`, { method: 'DELETE' }); }
  for (const bid of brandIds) await db(`brands?id=eq.${bid}`, { method: 'DELETE' });
  spy.restore();
}
process.exit(summary(`sign-in compatibility matrix (old app / ${SCHEMA} schema)`) ? 0 : 1);
