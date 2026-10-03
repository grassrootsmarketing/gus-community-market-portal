// tests/signin_config.test.mjs — Codex S-1 / S-3 / S-5 (design review 2026-10-03).
//
// The defect: the code-based sign-in routes answered "a code is on its way" even when OUR configuration made
// sending a code impossible (hashing secret absent on the Preview, 2026-10-02). The generic reply exists to hide
// account existence from an attacker; it must not hide a global outage from the operator or the user.
//
// What this proves, against the real rebuilt test database through the route harness:
//   S-1  missing or short VERIFY_PEPPER, and a missing mail-provider key, make BOTH sign-in routes answer
//        503 signin_unavailable for request AND verify, identical for every address, writing no challenge and
//        consuming no throttle or sign-up budget; the public status check reports signin.ok=false and degraded;
//        unrelated routes keep working on the same binding; valid configuration preserves the existing flow;
//        a provider refusal still gets the generic reply (no account-status leak) and leaves internal evidence.
//   S-5  no rendered sign-in or notification mail carries a literal em dash or the &mdash; entity.
import crypto from 'node:crypto';
import { callRoute, req, ok, summary, uniq, installSpy, ENV } from './_route.mjs';
// The validator imports api/_flags.js, whose non-getter flags freeze at first import; load it AFTER the harness env
// is in place (callRoute sets process.env from ENV), or PUBLIC_RETAILER_SIGNUP_ENABLED would freeze as off.
import * as mail from '../api/_notification-mail.js';

ENV.PUBLIC_RETAILER_SIGNUP_ENABLED = 'true'; // the suite exercises sign-up; tests/launch_flags.test.mjs proves the default-off

process.env = { ...process.env, ...ENV };
const { signinConfigStatus, MIN_PEPPER_LEN, SIGNIN_UNAVAILABLE, SIGNIN_MAINTENANCE } = await import('../api/_signin-config.js');
const SB = process.env.SB_URL, KEY = process.env.SB_KEY;
const H = { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json', Prefer: 'return=representation' };
const spy = installSpy();
const db = async (path, opts = {}) => { const r = await fetch(`${SB}/rest/v1/${path}`, { ...opts, headers: { ...H, ...(opts.headers || {}) } }); const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch (_) {} return { ok: r.ok, status: r.status, body: j }; };
const count = async (path, col = 'id') => { const r = await db(path + '&select=' + col); return Array.isArray(r.body) ? r.body.length : -1; };

const RUN = uniq('sc');
const emails = []; const ips = [];
const newEmail = (tag) => { const e = `${uniq(tag)}@fixture.test`; emails.push(e); return e; };
const newIp = (tag) => { const ip = `test-${RUN}-${tag}`; ips.push(ip); return ip; };
const emailKey = (e) => crypto.createHash('sha256').update(String(e)).digest('hex').slice(0, 32);

// Server-log capture: the routes report configuration and provider failures with console.error as one JSON line.
const logged = [];
const realError = console.error;
console.error = (...a) => { logged.push(a.map(String).join(' ')); };
const logsWith = (event) => logged.filter(l => l.includes(`"event":"${event}"`));

// Run a route under a MODIFIED copy of the harness env. callRoute resets process.env to ENV each call, so
// the override is applied by swapping ENV's own entries for the duration of the call and restoring them after.
async function withEnv(overrides, fn) {
  const saved = {};
  for (const k of Object.keys(overrides)) { saved[k] = ENV[k]; if (overrides[k] === undefined) delete ENV[k]; else ENV[k] = overrides[k]; }
  try { return await fn(); }
  finally { for (const k of Object.keys(overrides)) { if (saved[k] === undefined) delete ENV[k]; else ENV[k] = saved[k]; } }
}
const brand = (body, ip) => callRoute('brand-signup.js', req({ body, headers: { 'x-real-ip': ip } }));
const retailer = (body, ip) => callRoute('retailer-signup.js', req({ body, headers: { 'x-real-ip': ip } }));
const status = () => callRoute('find-retailer.js', req({ body: { action: 'status' } }));

// Footprint of one address + ip across every quota and challenge store the two routes touch.
async function footprint(email, ip) {
  return {
    challenges: await count(`email_verifications?email=eq.${encodeURIComponent(email)}`),
    throttleEmail: await count(`verification_throttle?scope=eq.email&key=eq.${encodeURIComponent(email)}`),
    throttleIp: await count(`verification_throttle?scope=eq.ip&key=eq.${encodeURIComponent(ip)}`),
    budgetIp: await count(`signup_budgets?bucket_key=like.${encodeURIComponent('rsu-*:' + ip)}`, 'bucket_key'),
    budgetEmail: await count(`signup_budgets?bucket_key=eq.${encodeURIComponent('rsu-req-email:' + emailKey(email))}`, 'bucket_key'),
  };
}
const zero = (f) => Object.values(f).every(v => v === 0);
const is503 = (r) => r.statusCode === 503 && r.body && r.body.error === 'signin_unavailable' && (r.body.message === SIGNIN_UNAVAILABLE.message || (r.body.maintenance === true && r.body.message === SIGNIN_MAINTENANCE.message));

const BROKEN = {
  'pepper missing': { VERIFY_PEPPER: undefined },
  'pepper short': { VERIFY_PEPPER: 'x'.repeat(MIN_PEPPER_LEN - 1) },
  'pepper blank padding': { VERIFY_PEPPER: ' '.repeat(MIN_PEPPER_LEN + 4) },
  'mail key missing': { RESEND_API_KEY: undefined },
  // Codex C-1: the operator's maintenance gate is a configuration-level closure of the code-based sign-in only.
  'maintenance gate': { SIGNIN_MAINTENANCE_ENABLED: 'true' },
};

try {
  console.log('\n— validator: configuration only, reasons named, no secret echoed —');
  {
    process.env = { ...ENV };
    const good = signinConfigStatus({ resendApiKey: 'k' });
    ok('valid pepper + mail key is ok with no reasons', good.ok === true && good.reasons.length === 0);
    for (const v of ['TRUE', ' true', 'yes', '1', '']) { process.env.SIGNIN_MAINTENANCE_ENABLED = v; ok(`maintenance gate ignores ${JSON.stringify(v)} (literal "true" only)`, signinConfigStatus({ resendApiKey: 'k' }).ok === true); }
    process.env.SIGNIN_MAINTENANCE_ENABLED = 'true';
    ok('maintenance gate closes with the literal "true" and names itself', JSON.stringify(signinConfigStatus({ resendApiKey: 'k' })) === JSON.stringify({ ok: false, reasons: ['maintenance'] }));
    delete process.env.SIGNIN_MAINTENANCE_ENABLED;
    process.env.VERIFY_PEPPER = 'short';
    const s1 = signinConfigStatus({ resendApiKey: 'k' });
    ok('short pepper names verify_pepper only', !s1.ok && s1.reasons.join() === 'verify_pepper');
    const s2 = signinConfigStatus({});
    ok('short pepper + no mail key names both', !s2.ok && s2.reasons.join() === 'verify_pepper,mail_provider');
    ok('status object never carries the secret value', !JSON.stringify(s1).includes('short'));
    ok('floor is the one api/_verify.js enforces (32)', MIN_PEPPER_LEN === 32);
  }

  for (const [label, overrides] of Object.entries(BROKEN)) {
    console.log(`\n— ${label}: both routes fail safely for request and verify —`);
    const bEmail = newEmail('b'), rEmail = newEmail('r'), ip = newIp(label.replace(/\s+/g, '-'));
    const beforeLogs = logsWith('signin_config_invalid').length;
    const results = await withEnv(overrides, async () => ({
      bReq: await brand({ action: 'request', email: bEmail, company_name: 'Config Co' }, ip),
      bVer: await brand({ action: 'verify', email: bEmail, code: '000000' }, ip),
      rReq: await retailer({ action: 'request', email: rEmail, store_name: 'Config Store' }, ip),
      rVer: await retailer({ action: 'verify', email: rEmail, code: '000000' }, ip),
    }));
    ok('brand request → 503 signin_unavailable', is503(results.bReq), JSON.stringify([results.bReq.statusCode, results.bReq.body]));
    ok('brand verify → 503 signin_unavailable', is503(results.bVer), JSON.stringify([results.bVer.statusCode, results.bVer.body]));
    ok('retailer request → 503 signin_unavailable', is503(results.rReq), JSON.stringify([results.rReq.statusCode, results.rReq.body]));
    ok('retailer verify → 503 signin_unavailable', is503(results.rVer), JSON.stringify([results.rVer.statusCode, results.rVer.body]));
    ok('reply is identical for both addresses (no existence signal)', JSON.stringify(results.bReq.body) === JSON.stringify(results.rReq.body));
    const fb = await footprint(bEmail, ip), fr = await footprint(rEmail, ip);
    ok('no challenge row, throttle hit or budget taken for the brand address', zero(fb), JSON.stringify(fb));
    ok('no challenge row, throttle hit or budget taken for the retailer address', zero(fr), JSON.stringify(fr));
    ok('no mail attempted', !spy.calls.resend.some(m => JSON.stringify(m).includes(bEmail) || JSON.stringify(m).includes(rEmail)));
    const fresh = logsWith('signin_config_invalid').slice(beforeLogs);
    ok('four structured config-failure log lines (one per call)', fresh.length === 4, String(fresh.length));
    if (label === 'maintenance gate') ok('maintenance replies say so (maintenance:true, its own wording) on all four calls', [results.bReq, results.bVer, results.rReq, results.rVer].every(r => r.body.maintenance === true && /maintenance/.test(r.body.message)));
    ok('log names the route and the reason, never the address', fresh.every(l => /"route":"(brand|retailer)-signup"/.test(l) && /"reasons":\["(verify_pepper|mail_provider|maintenance)"\]/.test(l) && !l.includes('@fixture.test')));

    console.log(`— ${label}: status is degraded and says so coarsely —`);
    const st = await withEnv(overrides, status);
    ok('status route still answers 200', st.statusCode === 200, String(st.statusCode));
    ok('checks.signin.ok is false', st.body && st.body.checks && st.body.checks.signin && st.body.checks.signin.ok === false, JSON.stringify(st.body && st.body.checks));
    ok('overall status is not operational', st.body && st.body.status !== 'operational', st.body && st.body.status);
    ok('status payload carries no reasons or secrets', !JSON.stringify(st.body).match(/verify_pepper|mail_provider|VERIFY_PEPPER|RESEND|maintenance/));

    console.log(`— ${label}: unrelated routes on the same binding keep working —`);
    const unrelated = await withEnv(overrides, async () => ({
      pub: await callRoute('find-retailer.js', req({ body: { action: 'public-data', slug: 'no-such-store-' + RUN } })),
      owner: await callRoute('admin-auth.js', req({ body: { action: 'owner-verify', token: crypto.randomUUID() } })),
      book: await callRoute('book.js', req({ body: {} })),
    }));
    ok('find-retailer public-data runs past the binding (not 503)', unrelated.pub.statusCode !== 503 && unrelated.pub.statusCode !== 500, String(unrelated.pub.statusCode));
    ok('admin-auth owner-verify runs past the binding (not 503)', unrelated.owner.statusCode !== 503 && unrelated.owner.statusCode !== 500, String(unrelated.owner.statusCode));
    ok('book.js runs past the binding (not 503)', unrelated.book.statusCode !== 503 && unrelated.book.statusCode !== 500, String(unrelated.book.statusCode));
  }

  console.log('\n— valid configuration: existing behaviour preserved —');
  {
    const bEmail = newEmail('ok-b'), rEmail = newEmail('ok-r'), ip = newIp('ok');
    const bReq = await brand({ action: 'request', email: bEmail, company_name: 'Config Co' }, ip);
    const rReq = await retailer({ action: 'request', email: rEmail, store_name: 'Config Store' }, ip);
    ok('brand request → 200 generic reply', bReq.statusCode === 200 && bReq.body && bReq.body.ok === true, JSON.stringify(bReq.body));
    ok('retailer request → 200 generic reply', rReq.statusCode === 200 && rReq.body && rReq.body.ok === true, JSON.stringify(rReq.body));
    const fb = await footprint(bEmail, ip), fr = await footprint(rEmail, ip);
    ok('brand: one challenge, email + ip throttles recorded', fb.challenges === 1 && fb.throttleEmail === 1 && fb.throttleIp === 1, JSON.stringify(fb));
    ok('retailer: one challenge, ip + address budgets recorded', fr.challenges === 1 && fr.budgetIp === 1 && fr.budgetEmail === 1, JSON.stringify(fr));
    const bMail = spy.calls.resend.find(m => /verification code/i.test(m.subject || '') && JSON.stringify(m).includes(bEmail));
    const rMail = spy.calls.resend.find(m => /verification code/i.test(m.subject || '') && JSON.stringify(m).includes(rEmail));
    ok('brand code email handed to the provider', !!bMail);
    ok('retailer code email handed to the provider', !!rMail);
    const st = await status();
    ok('status: checks.signin.ok true', st.body && st.body.checks && st.body.checks.signin && st.body.checks.signin.ok === true, JSON.stringify(st.body && st.body.checks));
    ok('no config-failure log lines from the valid run', !logsWith('signin_config_invalid').some(l => l.includes(RUN)) && logsWith('signin_mail_failed').length === 0);

    console.log('\n— S-3: the sign-in page shows a 503 message instead of the success card —');
    const { readFileSync } = await import('node:fs');
    const page = readFileSync('brand/signin/index.html', 'utf8');
    ok('submit() throws json.message before json.error', page.includes("throw new Error(json.message || json.error || ('HTTP ' + r.status));"));
    ok('success card carries the delivery expectations', page.includes('Delivery can take a few minutes. Check spam.'));
    ok('success card promises no fixed lifetime: codes expire at the time stated in the email', page.includes('Codes expire at the time stated in the email.') && !page.includes('Expires in 30 minutes'));
    const signup = readFileSync('signup/index.html', 'utf8');
    ok('retailer verify card carries the delivery expectations', signup.includes('Delivery can take a few minutes. Check spam.'));
  }

  console.log('\n— provider refusal: generic reply to the caller, structured evidence inside —');
  {
    const bEmail = newEmail('ref-b'), rEmail = newEmail('ref-r'), ip = newIp('ref');
    spy.faults.push({ url: 'api.resend.com', method: 'POST', status: 422, message: 'provider_refused' });
    const bReq = await brand({ action: 'request', email: bEmail, company_name: 'Config Co' }, ip);
    spy.faults.push({ url: 'api.resend.com', method: 'POST', status: 422, message: 'provider_refused' });
    const rReq = await retailer({ action: 'request', email: rEmail, store_name: 'Config Store' }, ip);
    spy.faults.length = 0;
    ok('brand request still 200 generic (no leak of the refusal)', bReq.statusCode === 200 && bReq.body && bReq.body.ok === true && !JSON.stringify(bReq.body).match(/refus|provider|resend/i), JSON.stringify(bReq.body));
    ok('retailer request still 200 generic (no leak of the refusal)', rReq.statusCode === 200 && rReq.body && rReq.body.ok === true && !JSON.stringify(rReq.body).match(/refus|provider|resend/i), JSON.stringify(rReq.body));
    const fails = logsWith('signin_mail_failed');
    ok('one signin_mail_failed line per route', fails.filter(l => l.includes('"route":"brand-signup"')).length === 1 && fails.filter(l => l.includes('"route":"retailer-signup"')).length === 1, JSON.stringify(fails));
    ok('failure line carries a reason code and never the address or a code', fails.every(l => /"code":"[a-z_0-9]+"/i.test(l) && !l.includes('@fixture.test') && !/\b\d{6}\b/.test(l)));
  }

  console.log('\n— S-5: rendered mail carries no em dash (U+2014) or &mdash; —');
  {
    const dash = (s) => /—|&mdash;/.test(String(s));
    const b = { siteOrigin: 'https://staging.demohubhq.test', resendApiKey: 'harness-resend-key' };
    const booking = { id: crypto.randomUUID(), brand_name: 'Dash Free Snacks', demo_date: '2026-10-21', demo_time: '11:00 AM', status: 'confirmed', product_description: null, contact_name: null, skus: [], timezone: 'America/Los_Angeles' };
    const ctx = mail.buildContext({ booking, retailer: { name: 'Fixture Market', timezone: 'America/Los_Angeles' }, venue: { name: 'Mission Market' }, brand: null });
    const rendered = [
      mail.confirmedMessage(b, ctx),
      mail.reminderMessage(b, ctx, new Date('2026-10-14T16:00:00Z')),
      mail.reminderMessage(b, ctx, new Date('2026-10-21T14:00:00Z')),
      mail.cancelledMessage(b, ctx, { reason: 'brand_cancelled' }),
      mail.rescheduledMessage(b, ctx, { from: { ...ctx, demo_date: '2026-10-16' } }),
      mail.coiApprovedMessage(b, { brand: { name: 'Dash Free Snacks' }, verification: { expires_on: '2027-01-01' } }),
      mail.coiRejectedMessage(b, { brand: { name: 'Dash Free Snacks' }, verification: { rejection_reason: 'expired' } }),
    ];
    rendered.forEach((m, i) => ok(`notification mail ${i + 1} subject and body are dash-free`, m && !dash(m.subject) && !dash(m.html), m && (m.subject || '').slice(0, 80)));
    ok('blank Product / Brand rep rows read "not given" (not a dash placeholder)', rendered[0].html.includes('not given'));
    const codeMails = spy.calls.resend.filter(m => /verification code/i.test(m.subject || ''));
    ok('verification code emails (brand + retailer) are dash-free', codeMails.length >= 2 && codeMails.every(m => !dash(m.subject) && !dash(m.html)), String(codeMails.length));
    const { readFileSync } = await import('node:fs');
    const templates = ['api/_notification-mail.js', 'api/_provisional.js', 'api/booking-action.js', 'api/booking.js', 'api/brand-account.js', 'api/signup.js', 'api/stripe-webhook.js', 'api/brand-signup.js', 'api/retailer-signup.js', 'api/_owner-alerts.js', 'api/_mail.js'];
    ok('no &mdash; entity remains in any mail-authoring module', templates.every(f => !readFileSync(f, 'utf8').includes('&mdash;')), templates.filter(f => readFileSync(f, 'utf8').includes('&mdash;')).join(','));
  }
} finally {
  console.error = realError;
  for (const e of emails) {
    await db(`email_verifications?email=eq.${encodeURIComponent(e)}`, { method: 'DELETE' });
    await db(`verification_throttle?scope=eq.email&key=eq.${encodeURIComponent(e)}`, { method: 'DELETE' });
    await db(`signup_budgets?bucket_key=eq.${encodeURIComponent('rsu-req-email:' + emailKey(e))}`, { method: 'DELETE' });
  }
  for (const ip of ips) {
    await db(`verification_throttle?scope=eq.ip&key=eq.${encodeURIComponent(ip)}`, { method: 'DELETE' });
    await db(`signup_budgets?bucket_key=like.${encodeURIComponent('rsu-*:' + ip)}`, { method: 'DELETE' });
  }
  spy.restore();
}
process.exit(summary('signin config (S-1/S-3/S-5)') ? 0 : 1);
