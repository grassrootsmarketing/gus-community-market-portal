// tests/owner_alert.test.mjs — the owner's "a brand actually booked" ping (api/_owner-alerts.js).
// Offline: memory-only binding + a fetch spy for Resend. Asserts what is sent, for which kind, and
// that a mail failure or a missing mail binding never throws into the fulfilment worker.
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { TARGETS, _resetBindingCache } from '../api/_env.js';

let pass = 0, fail = 0; const fails = [];
const ok = (name, cond, detail) => { if (cond) { pass++; console.log('  ok   ' + name); } else { fail++; fails.push(name); console.log('  FAIL ' + name + (detail ? ' ' + detail : '')); } };

const REF = 'bbbbbbbbbbbbbbbbbbbb';
TARGETS.preview.projectRef = REF;
const ENV = {
  VERCEL_ENV: 'preview', SUPABASE_URL: `https://${REF}.supabase.co`, SUPABASE_SERVICE_KEY: 'fake', SUPABASE_ANON_KEY: 'fake',
  SITE_ORIGIN: 'https://staging.example.test', STRIPE_SECRET_KEY: 'sk_test_fake', EMAIL_ALLOWLIST: 'qa@example.test',
  RESEND_API_KEY: 'fake', VERIFY_PEPPER: 'x'.repeat(40), CRON_SECRET: 'fake-cron',
};
const realEnv = process.env, realFetch = globalThis.fetch;
function spy({ resendStatus = 200 } = {}) {
  const sent = [];
  const f = async (url, opts = {}) => {
    const u = String(url);
    if (u.includes('/rpc/get_deployment_identity')) return { ok: true, status: 200, json: async () => [{ environment: 'staging', project_ref: REF }] };
    if (u.includes('api.resend.com')) { sent.push(JSON.parse(opts.body || '{}')); return { ok: resendStatus < 400, status: resendStatus, json: async () => (resendStatus < 400 ? { id: 'msg_1' } : { message: 'boom' }), text: async () => '' }; }
    return { ok: true, status: 200, json: async () => [], text: async () => '[]' };
  };
  f.sent = sent; return f;
}
const ctx = {
  id: 'b0000000-0000-4000-8000-000000000001', booking_id: 'b0000000-0000-4000-8000-000000000001',
  brand_name: 'Cold Brew Co', contact_name: 'Rep W', contact_email: 'rep@brand.test', contact_phone: '555-0100',
  demo_date: '2026-10-12', demo_time: '11:00 AM', product: 'Cold Brew', amount_paid: 3000, held_expires_at: null,
  venues: { name: 'Mission District' }, retailers: { name: "Gus's Community Market", slug: 'gus' },
};

process.env = { ...ENV }; _resetBindingCache();
const mod = await import(pathToFileURL(resolve('api', '_owner-alerts.js')).href + '?t=' + Math.random());

{ // paid, awaiting confirmation
  const f = spy(); globalThis.fetch = f;
  const r = await mod.notifyOwnerBooked(ctx, { kind: 'paid', targetStatus: 'pending' });
  const m = f.sent[0] || {};
  // The preview binding's containment layer redirects every send to the sink and prefixes the subject
  // with [SINK]; the intended recipient is asserted on the pure message builder instead.
  const built = mod.ownerBookedEmail(ctx, { kind: 'paid', targetStatus: 'pending' }, { siteOrigin: 'https://x.test' });
  ok('paid: one email, addressed to the owner', r.sent === true && f.sent.length === 1 && built.to === 'david@demohubhq.com' && built.from.includes('bookings@demohubhq.com'), JSON.stringify({ r, to: built.to }));
  ok('paid: subject names the brand, store, location, date and time', /^(\[SINK\] )?Booked: Cold Brew Co -> Gus's Community Market \/ Mission District \| 2026-10-12 11:00 AM/.test(m.subject || ''), m.subject);
  ok('paid: body says PAID and awaiting confirmation, carries fee, booking id and the admin link', /PAID - awaiting/.test(m.html || '') && /\$30\.00/.test(m.html) && m.html.includes(ctx.booking_id) && /\/r\/gus\/admin/.test(m.html) && !/Review the COI/.test(m.html), (m.html || '').slice(0, 200));
}
{ // paid + auto-confirmed
  const f = spy(); globalThis.fetch = f;
  await mod.notifyOwnerBooked(ctx, { kind: 'paid', targetStatus: 'confirmed' });
  ok('paid + auto-confirm: body says CONFIRMED', /PAID and CONFIRMED/.test((f.sent[0] || {}).html || ''));
}
{ // hold
  const f = spy(); globalThis.fetch = f;
  const r = await mod.notifyOwnerBooked({ ...ctx, held_expires_at: '2026-10-01T18:00:00Z' }, { kind: 'hold', targetStatus: 'held' });
  const m = f.sent[0] || {};
  ok('hold: subject says Hold placed; body says authorized-not-charged with the deadline and the COI review button', r.sent && /^(\[SINK\] )?Hold placed: Cold Brew Co/.test(m.subject || '') && /authorized, not charged/.test(m.html || '') && /Review the COI/.test(m.html) && /\/owner/.test(m.html), m.subject);
}
{ // hostile strings are escaped
  const f = spy(); globalThis.fetch = f;
  await mod.notifyOwnerBooked({ ...ctx, brand_name: 'Evil<img src=x onerror=alert(1)>', product: '<script>x</script>' }, { kind: 'paid', targetStatus: 'pending' });
  const h = (f.sent[0] || {}).html || '';
  ok('stored strings are escaped in the body', !h.includes('<img src=x') && !h.includes('<script>') && h.includes('&lt;img src=x'), h.slice(0, 160));
}
{ // failures never throw
  const f = spy({ resendStatus: 500 }); globalThis.fetch = f;
  const r = await mod.notifyOwnerBooked(ctx, { kind: 'paid', targetStatus: 'pending' });
  ok('a provider failure is reported, not thrown', r.sent === false && !!r.reason, JSON.stringify(r));
  process.env = { ...ENV, RESEND_API_KEY: '' }; _resetBindingCache();
  const mod2 = await import(pathToFileURL(resolve('api', '_owner-alerts.js')).href + '?t=' + Math.random());
  const f2 = spy(); globalThis.fetch = f2;
  const r2 = await mod2.notifyOwnerBooked(ctx, { kind: 'paid', targetStatus: 'pending' });
  ok('no mail binding -> nothing sent, nothing thrown', r2.sent === false && f2.sent.length === 0, JSON.stringify(r2));
}
process.env = realEnv; globalThis.fetch = realFetch;
console.log(`\nowner booked alert: ${pass} passed, ${fail} failed`);
if (fail) { console.log('FAILURES:'); fails.forEach(x => console.log('  x ' + x)); }
process.exit(fail ? 1 : 0);
