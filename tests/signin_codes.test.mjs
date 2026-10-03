// tests/signin_codes.test.mjs — Codex S-2 (design review 2026-10-03): verification windows (migration 0089).
//
// Through the ACTUAL brand and retailer routes against the real test database, mail intercepted:
//   * every code issued in a window is redeemable until one succeeds (resend, then type the FIRST code);
//   * at most five live codes per window, oldest retired first, also under parallel issuance (service-level
//     fixture: createChallenge directly, since the public request throttles stop a sixth request);
//   * one shared failed-guess budget per (email, purpose) window: six wrong guesses exhaust it, a resend neither
//     resets nor extends it, parallel wrong guesses are all counted, other pairs are independent;
//   * expired, superseded, used and post-success sibling codes fail, on database time;
//   * parallel redemption of two different valid codes issues exactly one session;
//   * an injected failure inside the brand transaction rolls everything back and leaves the code usable;
//   * the MATCHED challenge's payload is applied, blank-only, never to a brand the email merely belongs to;
//   * browser roles cannot execute the new or changed functions; a malformed guess costs nothing;
//   * retailer idempotency and the approval gate are unchanged.
import crypto from 'node:crypto';
import { callRoute, req, ok, summary, uniq, installSpy, ENV } from './_route.mjs';

ENV.PUBLIC_RETAILER_SIGNUP_ENABLED = 'true';

const SB = process.env.SB_URL, KEY = process.env.SB_KEY;
const H = { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json', Prefer: 'return=representation' };
const spy = installSpy();
const db = async (path, opts = {}) => { const r = await fetch(`${SB}/rest/v1/${path}`, { ...opts, headers: { ...H, ...(opts.headers || {}) } }); const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch (_) {} return { ok: r.ok, status: r.status, body: j }; };
const rpcRaw = async (name, args, key = KEY) => { const r = await fetch(`${SB}/rest/v1/rpc/${name}`, { method: 'POST', headers: { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' }, body: JSON.stringify(args) }); const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch (_) {} return { ok: r.ok, status: r.status, body: j }; };
const one = (r) => (r && Array.isArray(r.body) ? r.body[0] : null);

const RUN = uniq('sc2');
const emails = []; const ips = []; const brandIds = []; const retailerIds = [];
const newEmail = (tag) => { const e = `${uniq(tag)}@fixture.test`; emails.push(e); return e; };
let ipN = 0; const newIp = () => { const ip = `test-${RUN}-${++ipN}`; ips.push(ip); return ip; };
// Database time rules boundaries; the harness clock may differ by a few seconds, so "past" is two minutes ago.
const PAST = new Date(Date.now() - 120000).toISOString();
const emailKey = (e) => crypto.createHash('sha256').update(String(e)).digest('hex').slice(0, 32);

const brand = (body, ip) => callRoute('brand-signup.js', req({ body, headers: { 'x-real-ip': ip } }));
const retailer = (body, ip) => callRoute('retailer-signup.js', req({ body, headers: { 'x-real-ip': ip } }));
// Every code mailed to an address, oldest first.
// (mail is redirected to the sink in this binding; the intended recipient is named in the banner, so match the whole message)
const codesFor = (email) => spy.calls.resend.filter(m => /verification code/i.test(m.subject || '') && JSON.stringify(m).includes(email)).map(m => (/(\d{6})/.exec(m.html) || [])[1]).filter(Boolean);
const windowRow = async (email, purpose) => one(await db(`verification_windows?email=eq.${encodeURIComponent(email)}&purpose=eq.${purpose}&select=*`));
const challenges = async (email, purpose) => (await db(`email_verifications?email=eq.${encodeURIComponent(email)}&purpose=eq.${purpose}&select=id,window_seq,consumed_at,superseded_at,expires_at,payload,created_at&order=created_at.asc`)).body || [];
const live = (rows) => rows.filter(c => !c.consumed_at && !c.superseded_at && new Date(c.expires_at) > new Date());
const sessionsFor = async (email) => (await db(`brand_account_sessions?email=eq.${encodeURIComponent(email)}&select=id,brand_id`)).body || [];
const brandByEmail = async (email) => one(await db(`brands?email=eq.${encodeURIComponent(email)}&select=id,company_name,contact_name,phone,default_categories`));
const noteBrand = async (email) => { const b = await brandByEmail(email); if (b && !brandIds.includes(b.id)) brandIds.push(b.id); return b; };

// Service-level issuance (the public request throttles forbid a sixth request per hour, as they should).
let verify;
async function issueDirect(email, purpose, payload = null) {
  process.env = { ...ENV };
  if (!verify) verify = await import('../api/_verify.js?t=' + Date.now());
  return verify.createChallenge(email, purpose, payload);
}
// Brand verify with a specific session token: the ONLY way to make the brand transaction fail from outside is a
// token that already exists (brand_account_sessions.session_token is unique), which fails the LAST statement of
// the transaction, after the challenge was consumed and the brand created inside it.
async function brandRedeemRaw(email, code, token) {
  process.env = { ...ENV };
  if (!verify) verify = await import('../api/_verify.js?t=' + Date.now());
  return rpcRaw('redeem_brand_signup', { p_email: email, p_code_hash: verify.hashCode(email, 'brand_signup', code), p_session_token: token, p_session_days: 30, p_max_attempts: 6 });
}

try {
  console.log('\n— brand: resend twice, then type the FIRST code —');
  {
    const email = newEmail('b1'), ip = newIp();
    for (const n of [1, 2, 3]) ok(`request ${n} → generic 200`, (await brand({ action: 'request', email, company_name: 'First Co ' + n }, ip)).statusCode === 200);
    const codes = codesFor(email);
    ok('three distinct codes were mailed', codes.length === 3 && new Set(codes).size === 3, JSON.stringify(codes));
    ok('three live challenges in one window', live(await challenges(email, 'brand_signup')).length === 3);
    const v = await brand({ action: 'verify', email, code: codes[0] }, ip);
    ok('the FIRST code signs in (200 + HttpOnly cookie, no token in body)', v.statusCode === 200 && !!v.cookie('dh_brand_session') && !/session_token/.test(JSON.stringify(v.body)), JSON.stringify([v.statusCode, v.body]));
    const rows = await challenges(email, 'brand_signup');
    ok('exactly the matched challenge is consumed', rows.filter(c => c.consumed_at).length === 1 && rows.find(c => c.consumed_at).payload.company_name === 'First Co 1');
    ok('its two siblings are retired (superseded), not consumed', rows.filter(c => c.superseded_at && !c.consumed_at).length === 2);
    ok('the window is closed', !!(await windowRow(email, 'brand_signup')).closed_at);
    const b = await noteBrand(email);
    ok('the brand was created from the MATCHED payload (First Co 1), not the newest (First Co 3)', b && b.company_name === 'First Co 1', JSON.stringify(b));
    for (const c of [codes[1], codes[2]]) ok(`post-success sibling ${c === codes[1] ? 2 : 3} → 400 (no second session)`, (await brand({ action: 'verify', email, code: c }, ip)).statusCode === 400);
    ok('exactly one session exists for the address', (await sessionsFor(email)).length === 1);
  }

  console.log('\n— brand: the second of three codes; the third of three —');
  for (const pick of [1, 2]) {
    const email = newEmail('b2'), ip = newIp();
    for (const n of [1, 2, 3]) await brand({ action: 'request', email, company_name: 'Pick Co ' + n }, ip);
    const codes = codesFor(email);
    const v = await brand({ action: 'verify', email, code: codes[pick] }, ip);
    ok(`code #${pick + 1} of 3 signs in`, v.statusCode === 200 && !!v.cookie('dh_brand_session'), JSON.stringify([v.statusCode, v.body]));
    const b = await noteBrand(email);
    ok(`brand built from code #${pick + 1}'s own payload`, b && b.company_name === 'Pick Co ' + (pick + 1), JSON.stringify(b));
    ok('the other two codes are dead afterwards', (await Promise.all(codes.filter((_, i) => i !== pick).map(c => brand({ action: 'verify', email, code: c }, ip)))).every(r => r.statusCode === 400));
  }

  console.log('\n— retailer: resend, then the first code; match + provision is one transaction —');
  {
    const email = newEmail('r1'), ip = newIp();
    ok('request 1', (await retailer({ action: 'request', email, store_name: 'Window Market' }, ip)).statusCode === 200);
    ok('request 2 (resend)', (await retailer({ action: 'request', email, store_name: 'Window Market again' }, ip)).statusCode === 200);
    const codes = codesFor(email);
    ok('two codes mailed, two live', codes.length === 2 && live(await challenges(email, 'retailer_signup')).length === 2);
    const v = await retailer({ action: 'verify', email, code: codes[0] }, ip);
    ok('first code provisions the store (200, pending, cookie set)', v.statusCode === 200 && v.body && v.body.ok && !!v.cookie('dh_retailer_session') && v.body.live === false, JSON.stringify(v.body));
    const r = one(await db(`retailers?billing_email=eq.${encodeURIComponent(email)}&select=id,name,verification_status`));
    if (r) retailerIds.push(r.id);
    ok('store name comes from the MATCHED payload (Window Market)', r && r.name === 'Window Market' && r.verification_status === 'pending', JSON.stringify(r));
    ok('second code is dead after success', (await retailer({ action: 'verify', email, code: codes[1] }, ip)).statusCode === 400);
    ok('exactly one store for the address', ((await db(`retailers?billing_email=eq.${encodeURIComponent(email)}&select=id`)).body || []).length === 1);
  }

  console.log('\n— cap: sixth issuance retires the oldest only; parallel issuance never exceeds five —');
  {
    const email = newEmail('cap');
    const issued = [];
    for (let i = 1; i <= 6; i++) issued.push(await issueDirect(email, 'brand_signup', { company_name: 'Cap ' + i }));
    let rows = await challenges(email, 'brand_signup');
    ok('after six sequential issues exactly five are live', live(rows).length === 5, String(live(rows).length));
    ok('the retired one is the OLDEST (first issued)', rows.find(c => c.id === issued[0].id).superseded_at && !rows.find(c => c.id === issued[1].id).superseded_at);
    ok('a new code did not extend any older code: all share the window deadline', new Set(rows.map(c => c.expires_at)).size === 1);
    const email2 = newEmail('cap2');
    await Promise.all(Array.from({ length: 8 }, (_, i) => issueDirect(email2, 'brand_signup', { company_name: 'Par ' + i })));
    rows = await challenges(email2, 'brand_signup');
    ok('eight PARALLEL issues → eight rows, exactly five live', rows.length === 8 && live(rows).length === 5, JSON.stringify([rows.length, live(rows).length]));
    ok('all eight belong to one window', new Set(rows.map(c => c.window_seq)).size === 1);
    ok('a retired (sixth-oldest) code is refused', (await brand({ action: 'verify', email, code: issued[0].code }, newIp())).statusCode === 400);
    ok('the newest code of the capped window still works', (await brand({ action: 'verify', email, code: issued[5].code }, newIp())).statusCode === 200);
    await noteBrand(email);
  }

  console.log('\n— budget: six wrong guesses exhaust the window; a resend does not reset it —');
  {
    const email = newEmail('bud'), ip = newIp();
    await brand({ action: 'request', email, company_name: 'Budget Co' }, ip);
    const code = codesFor(email)[0];
    const wrong = () => brand({ action: 'verify', email, code: code === '000000' ? '000001' : '000000' }, ip);
    for (let i = 1; i <= 5; i++) ok(`wrong guess ${i} → 400`, (await wrong()).statusCode === 400);
    await brand({ action: 'request', email, company_name: 'Budget Co resend' }, ip);
    ok('after a resend the window still counts five failed guesses', (await windowRow(email, 'brand_signup')).failed_guesses === 5);
    const sixth = await wrong();
    ok('sixth wrong guess → 429 (exhausted)', sixth.statusCode === 429, String(sixth.statusCode));
    const w = await windowRow(email, 'brand_signup');
    ok('window marked exhausted with failed_guesses = 6', w.failed_guesses === 6 && !!w.exhausted_at);
    ok('the correct ORIGINAL code is now unusable (429)', (await brand({ action: 'verify', email, code }, ip)).statusCode === 429);
    ok('the correct RESENT code is unusable too (same window)', (await brand({ action: 'verify', email, code: codesFor(email)[1] }, ip)).statusCode === 429);
    ok('no session was issued', (await sessionsFor(email)).length === 0);
    // Lapsed window: starting a new window does not resurrect the exhausted codes.
    await db(`verification_windows?email=eq.${encodeURIComponent(email)}&purpose=eq.brand_signup`, { method: 'PATCH', body: JSON.stringify({ deadline: PAST }) });
    await brand({ action: 'request', email, company_name: 'Budget Co new window' }, ip);
    const w2 = await windowRow(email, 'brand_signup');
    ok('a request after the deadline opens window 2 with a fresh budget', w2.window_seq === 2 && w2.failed_guesses === 0 && !w2.exhausted_at, JSON.stringify(w2));
    ok('the old window\'s correct code stays dead in the new window', (await brand({ action: 'verify', email, code }, ip)).statusCode === 400);
    ok('the new window\'s code works', (await brand({ action: 'verify', email, code: codesFor(email).pop() }, ip)).statusCode === 200);
    await noteBrand(email);
    // Different pair: the retailer purpose for the SAME address is a separate window and budget (checked last,
    // because provisioning a store makes the address a retailer and the brand route's cross-role guard then
    // refuses it, by design).
    const rip = newIp();
    await retailer({ action: 'request', email, store_name: 'Other purpose' }, rip);
    ok('the retailer-purpose window for the same address starts with a clean budget', (await windowRow(email, 'retailer_signup')).failed_guesses === 0);
    const rv = await retailer({ action: 'verify', email, code: codesFor(email).pop() }, rip);
    ok('the same address under the retailer purpose is unaffected (its code works)', rv.statusCode === 200 && rv.body && rv.body.ok, JSON.stringify([rv.statusCode, rv.body]));
    const rr = one(await db(`retailers?billing_email=eq.${encodeURIComponent(email)}&select=id`)); if (rr) retailerIds.push(rr.id);
  }

  console.log('\n— budget: parallel wrong guesses are all counted (no lost increments) —');
  {
    const email = newEmail('par'), ip = newIp();
    await brand({ action: 'request', email, company_name: 'Parallel Co' }, ip);
    const code = codesFor(email)[0];
    const bad = ['111111', '222222', '333333', '444444'].filter(c => c !== code);
    const results = await Promise.all(bad.slice(0, 4).map(c => brand({ action: 'verify', email, code: c }, ip)));
    ok('four parallel wrong guesses all answer 400', results.every(r => r.statusCode === 400), JSON.stringify(results.map(r => r.statusCode)));
    ok('failed_guesses is exactly 4', (await windowRow(email, 'brand_signup')).failed_guesses === 4, String((await windowRow(email, 'brand_signup')).failed_guesses));
    const more = await Promise.all(['555555', '666666', '777777', '888888'].filter(c => c !== code).slice(0, 4).map(c => brand({ action: 'verify', email, code: c }, ip)));
    ok('four more in parallel: the budget closes at six, the rest answer 429', more.filter(r => r.statusCode === 429).length >= 2 && (await windowRow(email, 'brand_signup')).failed_guesses >= 6, JSON.stringify(more.map(r => r.statusCode)));
    ok('the correct code is refused once exhausted', (await brand({ action: 'verify', email, code }, ip)).statusCode === 429);
  }

  console.log('\n— malformed guesses cost nothing —');
  {
    const email = newEmail('shape'), ip = newIp();
    await brand({ action: 'request', email, company_name: 'Shape Co' }, ip);
    for (const g of ['12345', '1234567', 'abcdef', '', '12 345']) ok(`guess ${JSON.stringify(g)} → 400 before hashing`, (await brand({ action: 'verify', email, code: g }, ip)).statusCode === 400);
    ok('failed_guesses still 0', (await windowRow(email, 'brand_signup')).failed_guesses === 0);
    ok('retailer route: malformed guess → 400 wrong_code, nothing counted', (await retailer({ action: 'verify', email, code: 'abc' }, ip)).statusCode === 400 && !(await windowRow(email, 'retailer_signup')));
    ok('a code with surrounding spaces is accepted (trimmed)', (await brand({ action: 'verify', email, code: '  ' + codesFor(email)[0] + ' ' }, ip)).statusCode === 200);
    await noteBrand(email);
  }

  console.log('\n— expired and used codes, on database time —');
  {
    const email = newEmail('exp'), ip = newIp();
    await brand({ action: 'request', email, company_name: 'Exp Co' }, ip);
    const code = codesFor(email)[0];
    await db(`verification_windows?email=eq.${encodeURIComponent(email)}&purpose=eq.brand_signup`, { method: 'PATCH', body: JSON.stringify({ deadline: PAST }) });
    await db(`email_verifications?email=eq.${encodeURIComponent(email)}&purpose=eq.brand_signup`, { method: 'PATCH', body: JSON.stringify({ expires_at: PAST }) });
    ok('a code past the deadline → 400', (await brand({ action: 'verify', email, code }, ip)).statusCode === 400);
    ok('and it did not count as a wrong guess', (await windowRow(email, 'brand_signup')).failed_guesses === 0);
    const email2 = newEmail('used'), ip2 = newIp();
    await brand({ action: 'request', email: email2, company_name: 'Used Co' }, ip2);
    const c2 = codesFor(email2)[0];
    ok('first redemption 200', (await brand({ action: 'verify', email: email2, code: c2 }, ip2)).statusCode === 200);
    ok('replaying the same code → 400', (await brand({ action: 'verify', email: email2, code: c2 }, ip2)).statusCode === 400);
    ok('still one session', (await sessionsFor(email2)).length === 1);
    await noteBrand(email2);
    // Retailer reasons stay distinct internally (page copy depends on them) without leaking existence externally.
    const email3 = newEmail('rexp'), ip3 = newIp();
    const nothing = await retailer({ action: 'verify', email: email3, code: '123456' }, ip3);
    ok('retailer: no window at all → 400 no_active_code', nothing.statusCode === 400 && nothing.body.reason === 'no_active_code', JSON.stringify(nothing.body));
  }

  console.log('\n— concurrency: two valid codes redeemed in parallel issue ONE session —');
  {
    const email = newEmail('race'), ip = newIp();
    await brand({ action: 'request', email, company_name: 'Race Co' }, ip);
    await brand({ action: 'request', email, company_name: 'Race Co 2' }, ip);
    const [c1, c2] = codesFor(email);
    const results = await Promise.all([c1, c2, c1, c2, c1, c2].map(c => brand({ action: 'verify', email, code: c }, ip)));
    const wins = results.filter(r => r.statusCode === 200);
    ok('exactly one of six parallel redemptions (two valid codes) succeeds', wins.length === 1, JSON.stringify(results.map(r => r.statusCode)));
    ok('exactly one session row', (await sessionsFor(email)).length === 1);
    ok('exactly one brand row', ((await db(`brands?email=eq.${encodeURIComponent(email)}&select=id`)).body || []).length === 1);
    const rows = await challenges(email, 'brand_signup');
    ok('one consumed, one superseded', rows.filter(c => c.consumed_at).length === 1 && rows.filter(c => c.superseded_at && !c.consumed_at).length === 1);
    await noteBrand(email);
    // Retailer: the same race must create one store and one session.
    const remail = newEmail('rrace'), rip = newIp();
    await retailer({ action: 'request', email: remail, store_name: 'Race Market' }, rip);
    await retailer({ action: 'request', email: remail, store_name: 'Race Market 2' }, rip);
    const [r1, r2] = codesFor(remail);
    const rres = await Promise.all([r1, r2, r1, r2].map(c => retailer({ action: 'verify', email: remail, code: c }, rip)));
    const rwins = rres.filter(r => r.statusCode === 200 && r.cookie('dh_retailer_session'));
    ok('retailer race: exactly one 200 with a session cookie', rwins.length === 1, JSON.stringify(rres.map(r => [r.statusCode, r.body && r.body.reason])));
    const stores = (await db(`retailers?billing_email=eq.${encodeURIComponent(remail)}&select=id`)).body || [];
    stores.forEach(s => retailerIds.push(s.id));
    ok('retailer race: exactly one store', stores.length === 1);
  }

  console.log('\n— injected brand transaction failure: full rollback, code still usable —');
  {
    const email = newEmail('fail'), ip = newIp();
    await brand({ action: 'request', email, company_name: 'Rollback Co', contact_name: 'Roll Back' }, ip);
    const code = codesFor(email)[0];
    // A token that already exists: the session insert (last statement) violates the unique constraint.
    const existing = one(await db('brand_account_sessions?select=session_token&limit=1'));
    ok('fixture: an existing session token is available to collide with', !!(existing && existing.session_token));
    const r = await brandRedeemRaw(email, code, existing.session_token);
    ok('the RPC call fails (unique violation surfaces as an error, not an outcome)', !r.ok, JSON.stringify([r.status, r.body && r.body.code]));
    ok('no brand was created', !(await brandByEmail(email)));
    ok('no session was created', (await sessionsFor(email)).length === 0);
    const rows = await challenges(email, 'brand_signup');
    ok('the challenge is NOT consumed and the window is NOT closed', rows.length === 1 && !rows[0].consumed_at && !rows[0].superseded_at && !(await windowRow(email, 'brand_signup')).closed_at);
    ok('failed_guesses unchanged (a database failure is not a wrong guess)', (await windowRow(email, 'brand_signup')).failed_guesses === 0);
    const v = await brand({ action: 'verify', email, code }, ip);
    ok('the same code then succeeds through the route', v.statusCode === 200 && !!v.cookie('dh_brand_session'));
    const b = await noteBrand(email);
    ok('brand created from the payload on the retry', b && b.company_name === 'Rollback Co' && b.contact_name === 'Roll Back');
  }

  console.log('\n— matched payload, blank-only, authority boundaries —');
  {
    // Existing brand with values set: a sign-in payload must not overwrite them, but fills blanks.
    const email = newEmail('own'), ip = newIp();
    const made = one(await db('brands', { method: 'POST', body: JSON.stringify({ email, company_name: 'Kept Co', contact_name: null, phone: '555-0101', default_categories: 'Kept Category', is_verified: false }) }));
    brandIds.push(made.id);
    await brand({ action: 'request', email, company_name: 'Overwrite Co', contact_name: 'Filled Name', phone: '999', default_categories: 'Overwrite Category' }, ip);
    const v = await brand({ action: 'verify', email, code: codesFor(email)[0] }, ip);
    ok('own-brand sign-in succeeds into the existing brand', v.statusCode === 200 && v.body.brand_id === made.id && v.body.created === false, JSON.stringify(v.body));
    const after = await brandByEmail(email);
    ok('non-blank values kept (company, phone, category); blank contact filled from the matched payload', after.company_name === 'Kept Co' && after.phone === '555-0101' && after.default_categories === 'Kept Category' && after.contact_name === 'Filled Name', JSON.stringify(after));
    // Brand new: category applied from the matched payload.
    const email2 = newEmail('new'), ip2 = newIp();
    await brand({ action: 'request', email: email2, company_name: 'New Co', default_categories: 'Protein, bars & energy' }, ip2);
    await brand({ action: 'request', email: email2, company_name: 'New Co later', default_categories: 'Beverages' }, ip2);
    const [n1] = codesFor(email2);
    ok('brand-new sign-up with the FIRST code', (await brand({ action: 'verify', email: email2, code: n1 }, ip2)).statusCode === 200);
    const nb = await noteBrand(email2);
    ok('category and name come from the FIRST code\'s payload, not the newest', nb && nb.default_categories === 'Protein, bars & energy' && nb.company_name === 'New Co', JSON.stringify(nb));
    // Team member: an invited email with no own brand signs into the team's brand and must not edit it.
    const ownerEmail = newEmail('teamowner'), memberEmail = newEmail('member'), ip3 = newIp();
    const team = one(await db('brands', { method: 'POST', body: JSON.stringify({ email: ownerEmail, company_name: 'Team Brand', default_categories: null, is_verified: true }) }));
    brandIds.push(team.id);
    await db('brand_members', { method: 'POST', body: JSON.stringify({ brand_id: team.id, email: memberEmail, name: 'Member', role: 'admin' }) });
    await brand({ action: 'request', email: memberEmail, company_name: 'Hijack Co', default_categories: 'Hijack Category' }, ip3);
    const mv = await brand({ action: 'verify', email: memberEmail, code: codesFor(memberEmail)[0] }, ip3);
    ok('member signs into the team brand (no new brand created)', mv.statusCode === 200 && mv.body.brand_id === team.id && mv.body.created === false && !(await brandByEmail(memberEmail)), JSON.stringify(mv.body));
    const teamAfter = one(await db(`brands?id=eq.${team.id}&select=company_name,default_categories`));
    ok('the team brand\'s blank category was NOT filled by a member\'s payload', teamAfter.company_name === 'Team Brand' && teamAfter.default_categories === null, JSON.stringify(teamAfter));
  }

  console.log('\n— retailer: idempotency and the approval gate are unchanged —');
  {
    const email = newEmail('idem'), ip = newIp();
    await retailer({ action: 'request', email, store_name: 'Idem Market' }, ip);
    const v1 = await retailer({ action: 'verify', email, code: codesFor(email)[0] }, ip);
    ok('first sign-up provisions (pending, awaiting approval)', v1.statusCode === 200 && v1.body.ok && v1.body.live === false && !v1.body.already, JSON.stringify(v1.body));
    const r = one(await db(`retailers?billing_email=eq.${encodeURIComponent(email)}&select=id,slug,verification_status`)); if (r) retailerIds.push(r.id);
    ok('store is pending (approval gate intact)', r && r.verification_status === 'pending');
    await retailer({ action: 'request', email, store_name: 'Idem Market second try' }, ip);
    const v2 = await retailer({ action: 'verify', email, code: codesFor(email).pop() }, ip);
    ok('a later sign-up with the same email returns the existing store (already:true), no cookie, no duplicate', v2.statusCode === 200 && v2.body.already === true && v2.body.slug === r.slug && !v2.cookie('dh_retailer_session') && ((await db(`retailers?billing_email=eq.${encodeURIComponent(email)}&select=id`)).body || []).length === 1, JSON.stringify(v2.body));
  }

  console.log('\n— privileges: browser roles cannot execute; service role can —');
  {
    const anonKey = process.env.SB_ANON_KEY || null;
    const priv = await rpcRaw('verification_issue', { p_email: 'x@y.test', p_purpose: 'brand_signup', p_code_hash: 'h' }, 'not-a-key');
    ok('an invalid key cannot call verification_issue', !priv.ok && (priv.status === 401 || priv.status === 403), String(priv.status));
    if (anonKey) {
      for (const [fn, args] of [['verification_issue', { p_email: 'x@y.test', p_purpose: 'brand_signup', p_code_hash: 'h' }], ['redeem_brand_signup', { p_email: 'x@y.test', p_code_hash: 'h', p_session_token: 't' }], ['redeem_retailer_signup', { p_email: 'x@y.test', p_code_hash: 'h' }], ['verification_match', { p_email: 'x@y.test', p_purpose: 'brand_signup', p_code_hash: 'h' }]]) {
        const r = await rpcRaw(fn, args, anonKey);
        ok(`anon cannot execute ${fn}`, !r.ok && [401, 403, 404].includes(r.status), String(r.status));
      }
      const t = await fetch(`${SB}/rest/v1/verification_windows?select=email&limit=1`, { headers: { apikey: anonKey, Authorization: 'Bearer ' + anonKey } });
      ok('anon cannot read verification_windows', !t.ok && [401, 403, 404].includes(t.status), String(t.status));
    } else {
      console.log('  (SB_ANON_KEY not set: anon execution is asserted by the migration postcondition and the pg privilege check in the evidence)');
    }
    const direct = await rpcRaw('verification_match', { p_email: 'x@y.test', p_purpose: 'brand_signup', p_code_hash: 'h' });
    ok('even the service role cannot call verification_match directly (redeem functions only)', !direct.ok && [401, 403, 404].includes(direct.status), String(direct.status));
  }
} finally {
  for (const e of emails) {
    await db(`brand_account_sessions?email=eq.${encodeURIComponent(e)}`, { method: 'DELETE' });
    await db(`brand_members?email=eq.${encodeURIComponent(e)}`, { method: 'DELETE' });
    await db(`email_verifications?email=eq.${encodeURIComponent(e)}`, { method: 'DELETE' });
    await db(`verification_windows?email=eq.${encodeURIComponent(e)}`, { method: 'DELETE' });
    await db(`verification_throttle?scope=eq.email&key=eq.${encodeURIComponent(e)}`, { method: 'DELETE' });
    await db(`signup_budgets?bucket_key=eq.${encodeURIComponent('rsu-req-email:' + emailKey(e))}`, { method: 'DELETE' });
  }
  for (const ip of ips) {
    await db(`verification_throttle?scope=eq.ip&key=eq.${encodeURIComponent(ip)}`, { method: 'DELETE' });
    await db(`signup_budgets?bucket_key=like.${encodeURIComponent('rsu-*:' + ip)}`, { method: 'DELETE' });
  }
  for (const rid of [...new Set(retailerIds)]) {
    await db(`admin_sessions?retailer_id=eq.${rid}`, { method: 'DELETE' });
    await db(`retailer_admins?retailer_id=eq.${rid}`, { method: 'DELETE' });
    await db(`settings?retailer_id=eq.${rid}`, { method: 'DELETE' });
    await db(`venues?retailer_id=eq.${rid}`, { method: 'DELETE' });
    await db(`retailers?id=eq.${rid}`, { method: 'DELETE' });
  }
  for (const bid of [...new Set(brandIds)]) await db(`brands?id=eq.${bid}`, { method: 'DELETE' });
  spy.restore();
}
process.exit(summary('sign-in codes: verification windows (S-2)') ? 0 : 1);
