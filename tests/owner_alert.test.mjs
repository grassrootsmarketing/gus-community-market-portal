// tests/owner_alert.test.mjs — the owner's "a brand actually booked" message BUILDER (api/_owner-alerts.js).
// Pure and offline: no binding, no provider. Delivery (event identity, leases, freezing, idempotency,
// retries) is the notification outbox's job and is proven in tests/owner_booking_events.test.mjs.
// Covers Codex's preview review (2026-09-11) items 1 and 3 and the H2 wording rule for manual-confirm
// retailers.
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

let pass = 0, fail = 0; const fails = [];
const ok = (name, cond, detail) => { if (cond) { pass++; console.log('  ok   ' + name); } else { fail++; fails.push(name); console.log('  FAIL ' + name + (detail ? ' ' + detail : '')); } };

const mod = await import(pathToFileURL(resolve('api', '_owner-alerts.js')).href + '?t=' + Math.random());
const B = { siteOrigin: 'https://staging.example.test' };
const ctx = {
  id: 'b0000000-0000-4000-8000-000000000001', booking_id: 'b0000000-0000-4000-8000-000000000001', retailer_id: 'r0000000-0000-4000-8000-000000000001',
  brand_name: 'Cold Brew Co', contact_name: 'Rep W', contact_email: 'rep@brand.test', contact_phone: '555-0100',
  demo_date: '2026-10-12', demo_time: '11:00 AM', product: 'Cold Brew', amount_paid: 3000, held_expires_at: null,
  venues: { name: 'Mission District' }, retailers: { name: "Gus's Community Market", slug: 'gus' },
};
const LA = 'America/Los_Angeles';
const facts = (o = {}) => ({ autoConfirm: null, retailerTimezone: LA, settingDuration: '3 hours', ...o });
const build = (c, opts) => mod.ownerBookedEmail(c, opts, B);

console.log('\n— paid bookings —');
{
  const m = build(ctx, { kind: 'paid', targetStatus: 'pending', facts: facts({ autoConfirm: false }) });
  ok('paid: addressed to the owner from the bookings sender', m.to === 'david@demohubhq.com' && m.from === 'Demohub <bookings@demohubhq.com>' && m.replyTo === 'david@demohubhq.com', JSON.stringify([m.to, m.from]));
  ok('paid: subject names the brand, store, location, date and time', /^Booked: Cold Brew Co -> Gus's Community Market \/ Mission District \| 2026-10-12 11:00 AM$/.test(m.subject), m.subject);
  ok('paid: body says PAID awaiting confirmation, carries fee, booking id, the admin link, no COI button', /PAID — awaiting/.test(m.html) && /\$30\.00/.test(m.html) && m.html.includes(ctx.booking_id) && /\/r\/gus\/admin/.test(m.html) && !/Review the COI/.test(m.html), m.html.slice(0, 200));
  const manual = build(ctx, { kind: 'paid', targetStatus: 'confirmed', facts: facts({ autoConfirm: false }) });
  ok('paid + confirmed by a manual-confirm retailer: says CONFIRMED by the retailer, does NOT claim auto-confirm', /PAID and CONFIRMED by the retailer/.test(manual.html) && !/auto-confirms/.test(manual.html), manual.html.match(/Status<\/td><td[^>]*>[^<]*/)?.[0]);
  const auto = build(ctx, { kind: 'paid', targetStatus: 'confirmed', facts: facts({ autoConfirm: true }) });
  ok('paid + confirmed by auto-confirm: says so', /PAID and CONFIRMED \(this retailer auto-confirms\)/.test(auto.html));
}

console.log('\n— item 1: hold instructions follow the retailer\'s CURRENT confirmation mode —');
const held = { ...ctx, held_expires_at: '2026-10-01T18:00:00Z' };
{
  const m = build(held, { kind: 'hold', targetStatus: 'held', facts: facts({ autoConfirm: false }) });
  ok('hold, auto-confirm OFF: requires COI approval AND retailer confirmation; says approval alone does not capture', /^Hold placed: Cold Brew Co/.test(m.subject) && /then confirm the booking in the retailer admin/.test(m.html) && /Approving the COI alone does not capture/.test(m.html) && !/auto-confirm enabled/.test(m.html), m.html.slice(0, 300));
  ok('hold: the deadline is the booking\'s OWN held_expires_at, labelled with its zone (not "24 hours from now")', /Thursday, October 1 at 11:00 AM PDT/.test(m.html) && !/within 24 hours/.test(m.html), m.html.match(/before [^.]*/)?.[0]);
  ok('hold: authorization / release wording is distinct from refund', /authorized — not charged/.test(m.html) && /released after expiry \(not refunded/.test(m.html) && !/refund you|refunded to/.test(m.html));
  ok('hold: Review-the-COI (/owner) and retailer-admin links present, no secrets in either', /href="https:\/\/staging\.example\.test\/owner"/.test(m.html) && /href="https:\/\/staging\.example\.test\/r\/gus\/admin"/.test(m.html) && !/token=|key=|secret/i.test(m.html));
}
{
  const m = build(held, { kind: 'hold', targetStatus: 'held', facts: facts({ autoConfirm: true }) });
  ok('hold, auto-confirm ON: approval triggers an ATTEMPT to capture; asks to verify the status; no guarantee', /auto-confirm enabled, approval triggers an attempt to capture/.test(m.html) && /check the booking(&#39;|')s status to verify/.test(m.html) && !/will be captured|guarantee/.test(m.html) && !/then confirm the booking in the retailer admin/.test(m.html), m.html.slice(0, 300));
}
{
  const m = build(held, { kind: 'hold', targetStatus: 'held', facts: facts({ autoConfirm: null }) });
  ok('hold, mode unavailable: neutral copy — review the COI, check whether confirmation is still required; no capture promise', /check the booking in the retailer admin to see whether its confirmation is still required/.test(m.html) && !/triggers an attempt to capture/.test(m.html) && !/Approving the COI alone/.test(m.html), m.html.slice(0, 300));
}

console.log('\n— item 3: occurrence timezone + length —');
{
  const two = { ...ctx, start_at: '2026-10-12T18:00:00Z', end_at: '2026-10-12T20:00:00Z', timezone: LA };
  const four = { ...ctx, demo_date: '2027-01-16', start_at: '2027-01-16T19:00:00Z', end_at: '2027-01-16T23:00:00Z', timezone: LA };
  const d2 = mod.describeOccurrence(two, { retailerTimezone: LA, settingDuration: '3 hours' });
  const d4 = mod.describeOccurrence(four, { retailerTimezone: LA, settingDuration: '3 hours' });
  ok('snapshot 2h (October, PDT): shows start–end, zone abbreviation and the accepted length, ignoring the 3-hour setting', d2.source === 'snapshot' && /Monday, October 12, 2026 · 11:00 AM–1:00 PM PDT · 2 hours/.test(d2.text), d2.text);
  ok('snapshot 4h (January, PST): correct abbreviation and length for the occurrence date', d4.source === 'snapshot' && /Saturday, January 16, 2027 · 11:00 AM–3:00 PM PST · 4 hours/.test(d4.text), d4.text);
  const moved = mod.describeOccurrence(two, { retailerTimezone: 'America/New_York', settingDuration: '3 hours' });
  ok('changing the retailer\'s current timezone does NOT shift an accepted occurrence (booking zone wins)', moved.text === d2.text, moved.text);
  const legacy = mod.describeOccurrence(ctx, { retailerTimezone: LA, settingDuration: '3 hours' });
  ok('legacy row: retailer zone + the demo-length SETTING, labelled as the setting', legacy.source === 'settings' && /Monday, October 12, 2026 · 11:00 AM–2:00 PM PDT · 3 hours \(retailer's demo-length setting\)/.test(legacy.text), legacy.text);
  const ninety = mod.describeOccurrence(ctx, { retailerTimezone: LA, settingDuration: '90 minutes' });
  ok('legacy row: a 90-minute setting is honoured (11:00–12:30, 90 minutes)', /11:00 AM–12:30 PM PDT · 90 minutes/.test(ninety.text), ninety.text);
  const noLen = mod.describeOccurrence(ctx, { retailerTimezone: LA, settingDuration: 'whenever' });
  ok('legacy row without a usable length: "length not recorded", nothing invented', noLen.source === 'partial' && /11:00 AM PDT · length not recorded/.test(noLen.text) && !/3 hours/.test(noLen.text), noLen.text);
  const raw = mod.describeOccurrence({ ...ctx, demo_time: 'noonish' }, { retailerTimezone: LA, settingDuration: '3 hours' });
  ok('unparseable legacy time: raw values with the zone, length not recorded', raw.source === 'raw' && /2026-10-12 noonish \(America\/Los_Angeles\) · length not recorded/.test(raw.text), raw.text);
  ok('parseDurationHours: "3 hours"=3, "2 hour"=2, "90 minutes"=1.5, "1.5 hours"=1.5, garbage=null, 0=null', mod.parseDurationHours('3 hours') === 3 && mod.parseDurationHours('2 hour') === 2 && mod.parseDurationHours('90 minutes') === 1.5 && mod.parseDurationHours('1.5 hours') === 1.5 && mod.parseDurationHours('whenever') === null && mod.parseDurationHours('0 hours') === null);
  const m = build({ ...two, held_expires_at: '2026-10-01T18:00:00Z' }, { kind: 'hold', targetStatus: 'held', facts: facts({ autoConfirm: false }) });
  ok('built hold: "Demo time" row (11:00 AM–1:00 PM PDT · 2 hours) and a separate "Hold expires" row (… 11:00 AM PDT) are both zoned', /Demo time<\/td><td[^>]*>Monday, October 12, 2026 · 11:00 AM–1:00 PM PDT · 2 hours/.test(m.html) && /Hold expires<\/td><td[^>]*>Thursday, October 1 at 11:00 AM PDT/.test(m.html), m.html.slice(0, 400));
  ok('the builder reports its occurrence source', m.occurrence_source === 'snapshot' && build(ctx, { kind: 'paid', targetStatus: 'pending', facts: facts() }).occurrence_source === 'settings');
}

console.log('\n— safety —');
{
  const m = build({ ...ctx, brand_name: 'Evil<img src=x onerror=alert(1)>', product: '<script>x</script>' }, { kind: 'paid', targetStatus: 'pending', facts: facts() });
  ok('stored strings are escaped in the body', !m.html.includes('<img src=x') && !m.html.includes('<script>') && m.html.includes('&lt;img src=x'), m.html.slice(0, 160));
  const bare = build({ booking_id: 'x' }, { kind: 'paid', targetStatus: 'pending', facts: {} });
  ok('a minimal context still builds (no throw): generic brand/store, raw time fallback', /^Booked: A brand -> a retailer \|/.test(bare.subject) && /length not recorded/.test(bare.html), bare.subject);
}
console.log(`\nowner booked alert (builder): ${pass} passed, ${fail} failed`);
if (fail) { console.log('FAILURES:'); fails.forEach(x => console.log('  x ' + x)); }
process.exit(fail ? 1 : 0);
