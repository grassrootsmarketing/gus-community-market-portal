// tests/owner_alert.test.mjs — the owner's "a brand actually booked" ping (api/_owner-alerts.js).
// Offline: memory-only binding + a fetch spy for Resend and the two fact reads (retailer mode/zone,
// demo-length setting). Covers Codex's preview review (2026-09-11) items 1 and 3, plus the safety
// properties (a mail failure or a missing mail binding never throws into the fulfilment worker).
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
// retailer / settings rows the spy serves for the fact reads (null = table read fails)
function spy({ resendStatus = 200, retailer = { auto_confirm_bookings: false, timezone: 'America/Los_Angeles' }, settings = { demo_duration: '3 hours' } } = {}) {
  const sent = []; const reads = [];
  const f = async (url, opts = {}) => {
    const u = String(url);
    if (u.includes('/rpc/get_deployment_identity')) return { ok: true, status: 200, json: async () => [{ environment: 'staging', project_ref: REF }] };
    if (u.includes('api.resend.com')) { sent.push(JSON.parse(opts.body || '{}')); return { ok: resendStatus < 400, status: resendStatus, json: async () => (resendStatus < 400 ? { id: 'msg_1' } : { message: 'boom' }), text: async () => '' }; }
    if (u.includes('/rest/v1/retailers?')) { reads.push('retailers'); return retailer ? { ok: true, status: 200, json: async () => [retailer] } : { ok: false, status: 500, json: async () => ({}) }; }
    if (u.includes('/rest/v1/settings?')) { reads.push('settings'); return settings ? { ok: true, status: 200, json: async () => [settings] } : { ok: false, status: 500, json: async () => ({}) }; }
    return { ok: true, status: 200, json: async () => [], text: async () => '[]' };
  };
  f.sent = sent; f.reads = reads; return f;
}
const ctx = {
  id: 'b0000000-0000-4000-8000-000000000001', booking_id: 'b0000000-0000-4000-8000-000000000001', retailer_id: 'r0000000-0000-4000-8000-000000000001',
  brand_name: 'Cold Brew Co', contact_name: 'Rep W', contact_email: 'rep@brand.test', contact_phone: '555-0100',
  demo_date: '2026-10-12', demo_time: '11:00 AM', product: 'Cold Brew', amount_paid: 3000, held_expires_at: null,
  venues: { name: 'Mission District' }, retailers: { name: "Gus's Community Market", slug: 'gus' },
};
const B = { siteOrigin: 'https://x.test' };
const bodyOf = (f) => (f.sent[0] || {}).html || '';
const subjOf = (f) => (f.sent[0] || {}).subject || '';

process.env = { ...ENV }; _resetBindingCache();
const mod = await import(pathToFileURL(resolve('api', '_owner-alerts.js')).href + '?t=' + Math.random());

console.log('\n— paid bookings —');
{
  const f = spy(); globalThis.fetch = f;
  const r = await mod.notifyOwnerBooked(ctx, { kind: 'paid', targetStatus: 'pending' });
  // The preview binding's containment layer redirects every send to the sink and prefixes the subject
  // with [SINK]; the intended recipient is asserted on the pure message builder instead.
  const built = mod.ownerBookedEmail(ctx, { kind: 'paid', targetStatus: 'pending' }, B);
  ok('paid: one email, addressed to the owner, from the bookings sender (unchanged provider From)', r.sent === true && f.sent.length === 1 && built.to === 'david@demohubhq.com' && built.from === 'Demohub <bookings@demohubhq.com>', JSON.stringify({ r, to: built.to }));
  ok('paid: subject names the brand, store, location, date and time', /^(\[SINK\] )?Booked: Cold Brew Co -> Gus's Community Market \/ Mission District \| 2026-10-12 11:00 AM/.test(subjOf(f)), subjOf(f));
  ok('paid: body says PAID awaiting confirmation, carries fee, booking id, the admin link, no COI button', /PAID — awaiting/.test(bodyOf(f)) && /\$30\.00/.test(bodyOf(f)) && bodyOf(f).includes(ctx.booking_id) && /\/r\/gus\/admin/.test(bodyOf(f)) && !/Review the COI/.test(bodyOf(f)), bodyOf(f).slice(0, 200));
  ok('paid: the facts were read at send time (retailer + settings)', f.reads.includes('retailers') && f.reads.includes('settings'), JSON.stringify(f.reads));
}
{
  const f = spy({ retailer: { auto_confirm_bookings: true, timezone: 'America/Los_Angeles' } }); globalThis.fetch = f;
  await mod.notifyOwnerBooked(ctx, { kind: 'paid', targetStatus: 'confirmed' });
  ok('paid + auto-confirm: body says PAID and CONFIRMED', /PAID and CONFIRMED/.test(bodyOf(f)));
}

console.log('\n— item 1: hold instructions follow the retailer\'s CURRENT confirmation mode —');
const held = { ...ctx, held_expires_at: '2026-10-01T18:00:00Z' };
{
  const f = spy({ retailer: { auto_confirm_bookings: false, timezone: 'America/Los_Angeles' } }); globalThis.fetch = f;
  const r = await mod.notifyOwnerBooked(held, { kind: 'hold', targetStatus: 'held' });
  const h = bodyOf(f);
  ok('hold, auto-confirm OFF: requires COI approval AND retailer confirmation; says approval alone does not capture', r.sent && /^(\[SINK\] )?Hold placed: Cold Brew Co/.test(subjOf(f)) && /then confirm the booking in the retailer admin/.test(h) && /Approving the COI alone does not capture/.test(h) && !/auto-confirm enabled/.test(h), h.slice(0, 300));
  ok('hold: the deadline is the booking\'s OWN held_expires_at, labelled with its zone (not "24 hours from now")', /Thursday, October 1 at 11:00 AM PDT/.test(h) && !/within 24 hours/.test(h), h.match(/before [^.]*/)?.[0]);
  ok('hold: authorization / release wording is distinct from refund', /authorized — not charged/.test(h) && /released after expiry \(not refunded/.test(h) && !/refund you|refunded to/.test(h));
  ok('hold: Review-the-COI (/owner) and retailer-admin links present, no secrets in either', /href="https:\/\/staging\.example\.test\/owner"/.test(h) && /href="https:\/\/staging\.example\.test\/r\/gus\/admin"/.test(h) && !/token=|key=|secret/i.test(h));
}
{
  const f = spy({ retailer: { auto_confirm_bookings: true, timezone: 'America/Los_Angeles' } }); globalThis.fetch = f;
  await mod.notifyOwnerBooked(held, { kind: 'hold', targetStatus: 'held' });
  const h = bodyOf(f);
  ok('hold, auto-confirm ON: approval triggers an ATTEMPT to capture; asks to verify the status; no guarantee', /auto-confirm enabled, approval triggers an attempt to capture/.test(h) && /check the booking(&#39;|')s status to verify/.test(h) && !/will be captured|guarantee/.test(h) && !/then confirm the booking in the retailer admin/.test(h), h.slice(0, 300));
}
{
  const f = spy({ retailer: null }); globalThis.fetch = f;
  const r = await mod.notifyOwnerBooked(held, { kind: 'hold', targetStatus: 'held' });
  const h = bodyOf(f);
  ok('hold, mode unavailable: neutral copy — review the COI, check whether confirmation is still required; no capture promise; still sent', r.sent && /check the booking in the retailer admin to see whether its confirmation is still required/.test(h) && !/triggers an attempt to capture/.test(h) && !/Approving the COI alone/.test(h), h.slice(0, 300));
}

console.log('\n— item 3: occurrence timezone + length —');
{
  // accepted snapshots of two different lengths (Release B rows)
  const two = { ...ctx, start_at: '2026-10-12T18:00:00Z', end_at: '2026-10-12T20:00:00Z', timezone: 'America/Los_Angeles' };
  const four = { ...ctx, demo_date: '2027-01-16', start_at: '2027-01-16T19:00:00Z', end_at: '2027-01-16T23:00:00Z', timezone: 'America/Los_Angeles' };
  const d2 = mod.describeOccurrence(two, { retailerTimezone: 'America/Los_Angeles', settingDuration: '3 hours' });
  const d4 = mod.describeOccurrence(four, { retailerTimezone: 'America/Los_Angeles', settingDuration: '3 hours' });
  ok('snapshot 2h (October, PDT): shows start–end, zone abbreviation and the accepted length, ignoring the 3-hour setting', d2.source === 'snapshot' && /Monday, October 12, 2026 · 11:00 AM–1:00 PM PDT · 2 hours/.test(d2.text), d2.text);
  ok('snapshot 4h (January, PST): correct abbreviation and length for the occurrence date', d4.source === 'snapshot' && /Saturday, January 16, 2027 · 11:00 AM–3:00 PM PST · 4 hours/.test(d4.text), d4.text);
  const moved = mod.describeOccurrence(two, { retailerTimezone: 'America/New_York', settingDuration: '3 hours' });
  ok('changing the retailer\'s current timezone does NOT shift an accepted occurrence (booking zone wins)', moved.text === d2.text, moved.text);
  // legacy fallback (pre-Release B rows): retailer zone + demo-length setting, labelled as such
  const legacy = mod.describeOccurrence(ctx, { retailerTimezone: 'America/Los_Angeles', settingDuration: '3 hours' });
  ok('legacy row: retailer zone + the demo-length SETTING, labelled as the setting', legacy.source === 'settings' && /Monday, October 12, 2026 · 11:00 AM–2:00 PM PDT · 3 hours \(retailer's demo-length setting\)/.test(legacy.text), legacy.text);
  const ninety = mod.describeOccurrence(ctx, { retailerTimezone: 'America/Los_Angeles', settingDuration: '90 minutes' });
  ok('legacy row: a 90-minute setting is honoured (11:00–12:30, 90 minutes)', /11:00 AM–12:30 PM PDT · 90 minutes/.test(ninety.text), ninety.text);
  const noLen = mod.describeOccurrence(ctx, { retailerTimezone: 'America/Los_Angeles', settingDuration: 'whenever' });
  ok('legacy row without a usable length: "length not recorded", nothing invented', noLen.source === 'partial' && /11:00 AM PDT · length not recorded/.test(noLen.text) && !/3 hours/.test(noLen.text), noLen.text);
  const raw = mod.describeOccurrence({ ...ctx, demo_time: 'noonish' }, { retailerTimezone: 'America/Los_Angeles', settingDuration: '3 hours' });
  ok('unparseable legacy time: raw values with the zone, length not recorded', raw.source === 'raw' && /2026-10-12 noonish \(America\/Los_Angeles\) · length not recorded/.test(raw.text), raw.text);
  ok('parseDurationHours: "3 hours"=3, "2 hour"=2, "90 minutes"=1.5, "1.5 hours"=1.5, garbage=null, 0=null', mod.parseDurationHours('3 hours') === 3 && mod.parseDurationHours('2 hour') === 2 && mod.parseDurationHours('90 minutes') === 1.5 && mod.parseDurationHours('1.5 hours') === 1.5 && mod.parseDurationHours('whenever') === null && mod.parseDurationHours('0 hours') === null);
  // through the sender: the demo-time row and the separate hold-expiry row both carry a zone
  const f = spy(); globalThis.fetch = f;
  await mod.notifyOwnerBooked({ ...two, held_expires_at: '2026-10-01T18:00:00Z' }, { kind: 'hold', targetStatus: 'held' });
  const h = bodyOf(f);
  ok('sent hold: "Demo time" row (11:00 AM–1:00 PM PDT · 2 hours) and a separate "Hold expires" row (… 11:00 AM PDT) are both zoned', /Demo time<\/td><td[^>]*>Monday, October 12, 2026 · 11:00 AM–1:00 PM PDT · 2 hours/.test(h) && /Hold expires<\/td><td[^>]*>Thursday, October 1 at 11:00 AM PDT/.test(h), h.slice(0, 400));
}

console.log('\n— safety —');
{
  const f = spy(); globalThis.fetch = f;
  await mod.notifyOwnerBooked({ ...ctx, brand_name: 'Evil<img src=x onerror=alert(1)>', product: '<script>x</script>' }, { kind: 'paid', targetStatus: 'pending' });
  const h = bodyOf(f);
  ok('stored strings are escaped in the body', !h.includes('<img src=x') && !h.includes('<script>') && h.includes('&lt;img src=x'), h.slice(0, 160));
}
{
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
