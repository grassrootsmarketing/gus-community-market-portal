// tests/mail_containment.test.mjs — Codex finding C.
// The load-bearing claim: in a non-production target, the ORIGINAL customer address cannot
// receive a message. Codex asked for that specifically, so it is asserted directly.
import { planDelivery, sendMail, MailError } from '../api/_mail.js';

let pass = 0, fail = 0; const fails = [];
const ok = (n, c, x = '') => c ? pass++ : (fail++, fails.push(`${n} ${x}`));

const STAGING = { targetName: 'preview', emailMode: 'sink', emailAllowlist: ['qa@example.test', 'dev@example.test'], resendApiKey: 'fake', siteOrigin: 'https://staging.example.test' };
const PROD    = { targetName: 'production', emailMode: 'real', emailAllowlist: [], resendApiKey: 'fake', siteOrigin: 'https://www.demohubhq.com' };
const NOKEY   = { ...STAGING, resendApiKey: null };

// --- planDelivery: pure containment logic ---
{
  const p = planDelivery(STAGING, 'realcustomer@bigbrand.com');
  ok('staging: real customer is NOT a recipient', !p.to.includes('realcustomer@bigbrand.com'), JSON.stringify(p.to));
  ok('staging: redirected to the sink', p.redirected && p.to.length === 1 && p.to[0] === 'qa@example.test');
  ok('staging: intended recipient recorded', p.intended.includes('realcustomer@bigbrand.com'));
}
{
  const p = planDelivery(STAGING, 'qa@example.test');
  ok('staging: allowlisted address delivered as-is', !p.redirected && p.to[0] === 'qa@example.test');
}
{
  // one allowlisted + one not => the whole message is redirected, not partially delivered
  const p = planDelivery(STAGING, ['qa@example.test', 'realcustomer@bigbrand.com']);
  ok('staging: mixed list redirects ENTIRELY', p.redirected && !p.to.includes('realcustomer@bigbrand.com'));
}
{
  const p = planDelivery(STAGING, 'QA@Example.TEST');
  ok('staging: allowlist match is case-insensitive', !p.redirected);
}
{
  const p = planDelivery(PROD, 'realcustomer@bigbrand.com');
  ok('production: delivers to the real address', p.mode === 'real' && p.to[0] === 'realcustomer@bigbrand.com');
}
{
  let err = null; try { planDelivery({ ...STAGING, emailAllowlist: [] }, 'x@y.test'); } catch (e) { err = e; }
  ok('staging with empty allowlist refuses', err instanceof MailError && err.code === 'email_allowlist_empty');
}
{
  let err = null; try { planDelivery(STAGING, ''); } catch (e) { err = e; }
  ok('no recipient refuses', err instanceof MailError && err.code === 'no_recipient');
}

// --- sendMail: network behaviour ---
{
  const calls = [];
  const f = async (u, o) => { calls.push({ u, body: JSON.parse(o.body) }); return { ok: true, status: 200, json: async () => ({}) }; };
  const r = await sendMail({ to: 'realcustomer@bigbrand.com', subject: 'Your booking', html: '<p>hi</p>' }, { binding: STAGING, fetch: f });
  ok('sendMail: one provider call', calls.length === 1);
  ok('sendMail: payload does NOT contain the real address as a recipient',
     !calls[0].body.to.includes('realcustomer@bigbrand.com'), JSON.stringify(calls[0].body.to));
  ok('sendMail: subject marked [SINK]', calls[0].body.subject.startsWith('[SINK]'));
  ok('sendMail: banner names the intended recipient', calls[0].body.html.includes('realcustomer@bigbrand.com'));
  ok('sendMail: reports redirection to the caller', r.redirected === true);
}
{
  // Missing provider key must throw and must NOT leak the payload it was carrying.
  const calls = [];
  const f = async () => { calls.push(1); return { ok: true, status: 200, json: async () => ({}) }; };
  let err = null;
  try {
    await sendMail({ to: 'qa@example.test', subject: 'Your login code is 123456', html: '<p>123456</p>' },
                   { binding: NOKEY, fetch: f });
  } catch (e) { err = e; }
  ok('no provider key: throws', err instanceof MailError && err.code === 'mail_provider_not_configured');
  ok('no provider key: zero network calls', calls.length === 0);
  ok('no provider key: error carries no subject/body/code',
     !JSON.stringify(err.detail || {}).includes('123456') && !String(err.message).includes('123456'));
}

console.log(`\n=== mail containment: ${pass} passed, ${fail} failed ===`);
if (fails.length) for (const f of fails) console.log('  ✗ ' + f);
process.exit(fail === 0 ? 0 : 1);
