// Store default demo notifications (0088, 2026-09-30): real routes and the real outbox against the TEST database.
// Proves: the retailer saves store-wide defaults (validated, normalized, null clears); a contact with no own prefs
// follows them, a contact with its own prefs does not; the reminder scheduler and the send-time re-check both read
// the resolved settings; the owner mirror reports the same words; the legacy fallback holds when no defaults exist.
import { callRoute, req, ok, summary, uniq, installSpy, ENV } from './_route.mjs';
import { STANDARD } from './_fixture_availability.mjs';
import { resolveContactPrefs } from '../api/_notification-prefs.js';

const SB = process.env.SB_URL, KEY = process.env.SB_KEY;
const H = { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json', Prefer: 'return=representation' };
ENV.NOTIFICATION_WORKER_ENABLED = 'true'; // the worker is a kill switch (default off); this suite exercises it
const spy = installSpy();
const db = async (path, opts = {}) => { const r = await fetch(`${SB}/rest/v1/${path}`, { ...opts, headers: { ...H, ...(opts.headers || {}) } }); const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch (_) {} return { ok: r.ok, status: r.status, body: j }; };
const one = (r) => (r && Array.isArray(r.body) ? r.body[0] : null);
const bin = []; const track = (t, id) => { if (id) bin.push([t, id]); return id; };
const J = (r) => { try { return typeof r.body === 'string' ? JSON.parse(r.body) : r.body; } catch (_) { return {}; } }; // api/admin.js replies pre-serialised
const CRON = { authorization: 'Bearer ' + ENV.CRON_SECRET };
const dayP = (n) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

console.log('\n— pure resolution rule —');
{
  const custom = resolveContactPrefs({ on_confirmed: false, reminders: ['d3'] }, { reminders: ['w1'] });
  const store = resolveContactPrefs(null, { on_cancelled: false, reminders: ['d14', 'morning_of'] });
  const empty = resolveContactPrefs({}, { reminders: ['w1'] });
  const fallback = resolveContactPrefs(null, null);
  ok('a contact with its own prefs is "custom" and the store default is ignored', custom.source === 'custom' && custom.prefs.on_confirmed === false && custom.prefs.reminders.join() === 'd3');
  ok('a contact with NULL prefs follows the store default', store.source === 'store' && store.prefs.on_cancelled === false && store.prefs.on_confirmed === true && store.prefs.reminders.join() === 'd14,morning_of');
  ok('an EMPTY prefs object counts as not set and follows the store', empty.source === 'store' && empty.prefs.reminders.join() === 'w1');
  ok('no contact prefs and no store default: the Release A fallback (lifecycle on, no reminders)', fallback.source === 'fallback' && fallback.prefs.on_confirmed && fallback.prefs.reminders.length === 0);
}

const slug = uniq('nd');
const retailerId = track('retailers', one(await db('retailers', { method: 'POST', body: JSON.stringify({ slug, name: 'Defaults Fixture Market', billing_email: `${slug}@fixture.test`, billing_tier: 'pro', billing_status: 'active', platform_keeps_all: true, timezone: 'America/Los_Angeles', auto_confirm_bookings: true, verification_status: 'approved' }) })).id);
const settingsId = track('settings', one(await db('settings', { method: 'POST', body: JSON.stringify({ retailer_id: retailerId, demo_fee: 30, advance_booking_days: 3 }) })).id);
const V1 = track('venues', one(await db('venues', { method: 'POST', body: JSON.stringify({ retailer_id: retailerId, name: 'Defaults Main', address: '1 Def St', demo_fee: 30, availability: STANDARD }) })).id);
const cFollow = track('internal_contacts', one(await db('internal_contacts', { method: 'POST', body: JSON.stringify({ retailer_id: retailerId, name: 'Follows Store', email: `follow-${slug}@fixture.test`, role: 'Manager' }) })).id);
const cCustom = track('internal_contacts', one(await db('internal_contacts', { method: 'POST', body: JSON.stringify({ retailer_id: retailerId, name: 'Custom Person', email: `custom-${slug}@fixture.test`, role: 'Buyer', notification_prefs: { on_confirmed: true, on_cancelled: true, on_rescheduled: true, reminders: ['d1'] } }) })).id);
const staffEmail = `staff-${slug}@fixture.test`;
track('retailer_admins', one(await db('retailer_admins', { method: 'POST', body: JSON.stringify({ retailer_id: retailerId, email: staffEmail, email_normalized: staffEmail, name: 'Def Staff', role: 'owner' }) })).id);
const stTok = one(await db('admin_tokens', { method: 'POST', body: JSON.stringify({ email: staffEmail, retailer_id: retailerId }) }));
const staffCookie = (await callRoute('admin-auth.js', req({ body: { action: 'verify', token: stTok.token } }))).cookie('dh_retailer_session');
const adminPatch = (table, id, body) => callRoute('admin.js', req({ method: 'PATCH', query: { table, id }, body, cookies: { dh_retailer_session: staffCookie } }));
let ownerCookie; { const OWNER_EMAIL = 'david@demohubhq.com'; const ex = await db('retailers?slug=eq.__owner__&select=id'); const ownerRid = ex.body[0].id; const tok = (await db('admin_tokens', { method: 'POST', body: JSON.stringify({ email: OWNER_EMAIL, retailer_id: ownerRid }) })).body[0]; ownerCookie = (await callRoute('admin-auth.js', req({ body: { action: 'owner-verify', token: tok.token } }))).cookie('dh_owner_session'); }
const owner = (action, body) => callRoute('admin-auth.js', req({ body: { action, ...body }, cookies: { dh_owner_session: ownerCookie } }));
let bookingId = null; const extraBookings = [];
try {
  ok('fixtures: staff and owner sessions exist', !!staffCookie && !!ownerCookie);

  console.log('\n— saving the store default through the retailer admin —');
  const bad = await adminPatch('settings', settingsId, { notification_defaults: { reminders: ['yesterday'] } });
  ok('an invalid default is refused 400 invalid_notification_defaults', bad.statusCode === 400 && J(bad).error === 'invalid_notification_defaults', `${bad.statusCode} ${JSON.stringify(J(bad)).slice(0, 120)}`);
  const good = await adminPatch('settings', settingsId, { notification_defaults: { on_confirmed: true, on_cancelled: false, on_rescheduled: true, reminders: ['w1', 'd14', 'w1', 'morning_of'] } });
  const stored = one(await db(`settings?id=eq.${settingsId}&select=notification_defaults`)).notification_defaults;
  ok('a valid default is stored normalized (duplicate collapsed, offsets sorted, lifecycle explicit)', good.statusCode < 300 && stored && stored.on_cancelled === false && stored.on_confirmed === true && stored.reminders.join() === 'd14,w1,morning_of', JSON.stringify(stored));
  const dataResp = await callRoute('admin.js', req({ method: 'GET', query: { action: 'data' }, cookies: { dh_retailer_session: staffCookie } }));
  ok('the admin data read returns the store default so the Team tab can show it', dataResp.statusCode === 200 && J(dataResp).settings && J(dataResp).settings.notification_defaults && J(dataResp).settings.notification_defaults.reminders.join() === 'd14,w1,morning_of');

  console.log('\n— the scheduler follows the resolved settings —');
  const bk = one(await db('bookings', { method: 'POST', body: JSON.stringify({ retailer_id: retailerId, venue_id: V1, brand_name: 'Defaults Brand', contact_email: 'brand@fixture.test', demo_date: dayP(20), demo_time: '11:00 AM', duration_hours: 3, status: 'confirmed', payment_status: 'paid', amount_paid: 3500 }) }));
  bookingId = bk && bk.id; ok('fixture: a confirmed booking 20 days out exists', !!bookingId);
  const wk = await callRoute('notification-worker.js', req({ method: 'GET', headers: CRON }));
  ok('notification-worker run -> 200', wk.statusCode === 200 && wk.body && wk.body.ok === true, `${wk.statusCode} ${JSON.stringify(wk.body).slice(0, 600)}`); console.log('   worker:', JSON.stringify(wk.body).slice(0, 700));
  const rem = (await db(`notification_deliveries?booking_id=eq.${bookingId}&kind=eq.reminder&select=recipient_id,offset_key,status`)).body || [];
  const followKeys = rem.filter(r => r.recipient_id === cFollow).map(r => r.offset_key).sort().join(), customKeys = rem.filter(r => r.recipient_id === cCustom).map(r => r.offset_key).sort().join();
  ok('the contact with no own prefs got the STORE default reminders (d14, w1, morning_of) scheduled', followKeys === ['d14', 'morning_of', 'w1'].sort().join(), followKeys);
  ok('the contact with its own prefs kept its own reminder (d1) and did not inherit the store default', customKeys === 'd1', customKeys);
  const conf = (await db(`notification_deliveries?booking_id=eq.${bookingId}&kind=eq.demo_confirmed&select=recipient_id,status`)).body || [];
  ok('both contacts got the confirmed notice (lifecycle on in both readings)', conf.some(r => r.recipient_id === cFollow) && conf.some(r => r.recipient_id === cCustom), JSON.stringify(conf));

  console.log('\n— the send-time re-check reads the CURRENT store default —');
  // Opt the store out of cancellation emails already; now also drop the 14-day reminder from the default. The scheduled
  // d14 row for the following contact must be skipped as opted_out at send time (it was in the default when scheduled).
  await adminPatch('settings', settingsId, { notification_defaults: { on_confirmed: true, on_cancelled: false, on_rescheduled: true, reminders: ['w1', 'morning_of'] } });
  // Force the d14 row due now by moving due_at into the past (test-only shortcut on the delivery row).
  const d14row = rem.find(r => r.recipient_id === cFollow && r.offset_key === 'd14');
  const rows14 = (await db(`notification_deliveries?booking_id=eq.${bookingId}&recipient_id=eq.${cFollow}&offset_key=eq.d14&select=id,status`)).body || [];
  if (rows14[0]) await db(`notification_deliveries?id=eq.${rows14[0].id}`, { method: 'PATCH', body: JSON.stringify({ due_at: new Date(Date.now() - 60e3).toISOString(), expires_at: new Date(Date.now() + 3600e3).toISOString() }) });
  const wk2 = await callRoute('notification-worker.js', req({ method: 'GET', headers: CRON }));
  const after14 = one(await db(`notification_deliveries?id=eq.${rows14[0] ? rows14[0].id : '00000000-0000-4000-8000-000000000000'}&select=status,skip_reason`));
  ok('a reminder the store default no longer includes is skipped opted_out at send time, not sent', wk2.statusCode === 200 && d14row && after14 && after14.status === 'skipped' && after14.skip_reason === 'opted_out', JSON.stringify(after14));

  console.log('\n— owner mirror —');
  const prof = await owner('owner-retailer-profile', { retailer_id: retailerId });
  const pf = (prof.body.contacts || []).find(c => c.name === 'Follows Store'), pc = (prof.body.contacts || []).find(c => c.name === 'Custom Person');
  ok('owner profile: the store default in words, and each contact tagged store default / custom with the resolved reminders', prof.statusCode === 200 && prof.body.notification_defaults && prof.body.notification_defaults.reminders.join('|') === '1 week before|Morning of (7 am)' && pf && pf.prefs_source === 'store' && pf.notifications.reminders.join('|') === '1 week before|Morning of (7 am)' && pc && pc.prefs_source === 'custom' && pc.notifications.reminders.join() === '1 day before', JSON.stringify({ d: prof.body.notification_defaults, pf, pc }));


  console.log('\n— ND-1: an unreadable store default is an ERROR, never "no default" —');
  const DEF_URL = `settings?retailer_id=eq.${retailerId}&select=notification_defaults`;
  const worker = () => callRoute('notification-worker.js', req({ method: 'GET', headers: CRON }));
  const rowsFor = async (bid, extra = '') => (await db(`notification_deliveries?booking_id=eq.${bid}${extra}&select=id,kind,offset_key,recipient_id,status,skip_reason,lease_until,due_at,expires_at`)).body || [];
  const eventFor = async (bid) => one(await db(`notification_events?booking_id=eq.${bid}&kind=eq.demo_confirmed&select=id,fanned_out_at`));
  const mailsTo = (email, from) => spy.calls.resend.slice(from).filter(x => JSON.stringify(x).includes(email)).length;
  const followEmail = `follow-${slug}@fixture.test`, customEmail = `custom-${slug}@fixture.test`;
  // Store default: confirmation OFF, one reminder (1 week). The following contact must inherit exactly that.
  await adminPatch('settings', settingsId, { notification_defaults: { on_confirmed: false, on_cancelled: true, on_rescheduled: true, reminders: ['w1'] } });
  const mkBooking = async (time) => { const r = one(await db('bookings', { method: 'POST', body: JSON.stringify({ retailer_id: retailerId, venue_id: V1, brand_name: 'Outage Brand', contact_email: 'brand2@fixture.test', demo_date: dayP(20), demo_time: time, duration_hours: 3, status: 'confirmed', payment_status: 'unpaid', amount_paid: 0 }) })); extraBookings.push(r.id); return r.id; };

  // A. HTTP 500 on the defaults read during fan-out and scheduling
  const B2 = await mkBooking('2:00 PM'); const mA = spy.calls.resend.length;
  spy.faults.push({ url: DEF_URL, status: 500 });
  const wkA = await worker();
  const evA = await eventFor(B2); const rowsA = await rowsFor(B2);
  ok('ND-1 A: with the settings read failing (HTTP 500), the run reports the failure (500, ok:false) and names it', wkA.statusCode === 500 && wkA.body.ok === false && /db_get_failed/.test(String(wkA.body.first_error)), `${wkA.statusCode} ${JSON.stringify(wkA.body).slice(0, 200)}`);
  ok('ND-1 A: the demo_confirmed event stays UNFANNED, no deliveries exist for the booking, no mail went out', evA && evA.fanned_out_at === null && rowsA.length === 0 && mailsTo(followEmail, mA) === 0 && mailsTo(customEmail, mA) === 0, `fanned=${evA && evA.fanned_out_at} rows=${rowsA.length}`);
  // B. network rejection and a malformed 200 are errors too (two more bookings, two more runs)
  spy.faults.length = 0;
  const B3 = await mkBooking('5:00 PM');
  { const real = globalThis.fetch; globalThis.fetch = (u, o) => String(u).includes(DEF_URL) ? Promise.reject(Object.assign(new TypeError('fetch failed'), { name: 'TypeError' })) : real(u, o);
    try { var wkB1 = await worker(); } finally { globalThis.fetch = real; } }
  const evB1 = await eventFor(B3);
  ok('ND-1 B: a network rejection on the defaults read is reported (db_unreachable), event unfanned, no rows', wkB1.statusCode === 500 && /db_unreachable/.test(String(wkB1.body.first_error)) && evB1 && evB1.fanned_out_at === null && (await rowsFor(B3)).length === 0, `${JSON.stringify(wkB1.body).slice(0, 160)}`);
  { const real = globalThis.fetch; globalThis.fetch = (u, o) => String(u).includes(DEF_URL) ? Promise.resolve(new Response(JSON.stringify({ not: 'an array' }), { status: 200, headers: { 'content-type': 'application/json' } })) : real(u, o);
    try { var wkB2 = await worker(); } finally { globalThis.fetch = real; } }
  const evB2 = await eventFor(B3);
  ok('ND-1 B: a malformed successful response is rejected (settings_read_malformed), not read as "no default"', wkB2.statusCode === 500 && /settings_read_malformed/.test(String(wkB2.body.first_error)) && evB2 && evB2.fanned_out_at === null && (await rowsFor(B3)).length === 0, `${JSON.stringify(wkB2.body).slice(0, 160)}`);
  // C. a healthy run recovers: real preferences apply, no fallback-derived rows, no duplicates on repeat
  const wkC = await worker();
  const rowsC2 = await rowsFor(B2), rowsC3 = await rowsFor(B3);
  const confFollow = rowsC2.filter(r => r.kind === 'demo_confirmed' && r.recipient_id === cFollow), confCustom = rowsC2.filter(r => r.kind === 'demo_confirmed' && r.recipient_id === cCustom);
  const remFollow = rowsC2.filter(r => r.kind === 'reminder' && r.recipient_id === cFollow).map(r => r.offset_key), remCustom = rowsC2.filter(r => r.kind === 'reminder' && r.recipient_id === cCustom).map(r => r.offset_key);
  ok('ND-1 C: healthy run: events fan out; the following contact gets NO confirmation (store default off) and exactly its w1 reminder; the custom contact keeps its confirmation and d1', wkC.statusCode === 200 && (await eventFor(B2)).fanned_out_at && (await eventFor(B3)).fanned_out_at && confFollow.length === 0 && confCustom.length === 1 && remFollow.join() === 'w1' && remCustom.join() === 'd1' && rowsC3.some(r => r.kind === 'reminder' && r.recipient_id === cFollow && r.offset_key === 'w1'), `follow conf=${confFollow.length} rem=${remFollow} | custom conf=${confCustom.length} rem=${remCustom}`);
  const before = (await rowsFor(B2)).length + (await rowsFor(B3)).length; await worker();
  ok('ND-1 C: a repeat healthy run creates no duplicate rows', (await rowsFor(B2)).length + (await rowsFor(B3)).length === before, `${before}`);
  // D. dispatch under an outage: the following contact's reminder is claimed, then left for lease-expiry recovery
  const w1Row = (await rowsFor(B2)).find(r => r.kind === 'reminder' && r.recipient_id === cFollow && r.offset_key === 'w1');
  await db(`notification_deliveries?id=eq.${w1Row.id}`, { method: 'PATCH', body: JSON.stringify({ due_at: new Date(Date.now() - 60e3).toISOString(), expires_at: new Date(Date.now() + 3600e3).toISOString() }) });
  const mD = spy.calls.resend.length; spy.faults.push({ url: DEF_URL, status: 503 });
  const wkD = await worker(); const afterD = one(await db(`notification_deliveries?id=eq.${w1Row.id}&select=status,skip_reason,lease_until,attempts`));
  ok('ND-1 D: dispatch with the defaults read failing: the run reports it, the row is CLAIMED with a lease (not skipped, accepted or failed), no mail', wkD.statusCode === 500 && wkD.body.dispatch && wkD.body.dispatch.errors >= 1 && afterD && afterD.status === 'claimed' && afterD.skip_reason === null && mailsTo(followEmail, mD) === 0, JSON.stringify({ wk: wkD.body.first_error, row: afterD }));
  // E. the custom contact's own reminder is unaffected by the outage: no defaults read, it sends
  const d1Row = (await rowsFor(B2)).find(r => r.kind === 'reminder' && r.recipient_id === cCustom && r.offset_key === 'd1');
  await db(`notification_deliveries?id=eq.${d1Row.id}`, { method: 'PATCH', body: JSON.stringify({ due_at: new Date(Date.now() - 60e3).toISOString(), expires_at: new Date(Date.now() + 3600e3).toISOString() }) });
  const mE = spy.calls.resend.length; await worker(); const afterE = one(await db(`notification_deliveries?id=eq.${d1Row.id}&select=status`));
  ok('ND-1 E: during the same outage a CUSTOM contact\'s reminder still sends (its decision needs no defaults read)', afterE && afterE.status === 'accepted' && mailsTo(customEmail, mE) === 1, JSON.stringify(afterE));
  // F. lease expiry + recovery: the following contact's reminder is reclaimed and sent exactly once on the real default
  spy.faults.length = 0;
  await db(`notification_deliveries?id=eq.${w1Row.id}`, { method: 'PATCH', body: JSON.stringify({ lease_until: new Date(Date.now() - 60e3).toISOString() }) });
  const mF = spy.calls.resend.length; const wkF = await worker(); const afterF = one(await db(`notification_deliveries?id=eq.${w1Row.id}&select=status,skip_reason,attempts`));
  ok('ND-1 F: after the lease expires and the read works again, the reminder is reclaimed and sent once (accepted); nothing was marked opted_out in between', wkF.statusCode === 200 && afterF && afterF.status === 'accepted' && mailsTo(followEmail, mF) === 1, JSON.stringify(afterF));
  // G. a default changed after scheduling but before dispatch is respected on a successful fresh read: drop w1 for B3's w1 row
  await adminPatch('settings', settingsId, { notification_defaults: { on_confirmed: false, on_cancelled: true, on_rescheduled: true, reminders: ['d3'] } });
  const w1B3 = (await rowsFor(B3)).find(r => r.kind === 'reminder' && r.recipient_id === cFollow && r.offset_key === 'w1');
  await db(`notification_deliveries?id=eq.${w1B3.id}`, { method: 'PATCH', body: JSON.stringify({ due_at: new Date(Date.now() - 60e3).toISOString(), expires_at: new Date(Date.now() + 3600e3).toISOString() }) });
  const mG = spy.calls.resend.length; await worker(); const afterG = one(await db(`notification_deliveries?id=eq.${w1B3.id}&select=status,skip_reason`));
  ok('ND-1 G: a reminder the store default no longer includes (changed after scheduling) is skipped opted_out on a SUCCESSFUL fresh read, not sent', afterG && afterG.status === 'skipped' && afterG.skip_reason === 'opted_out' && mailsTo(followEmail, mG) === 0, JSON.stringify(afterG));
  // H. a demo ten days out never gets a late 14-day reminder: it is recorded as skipped due_before_scheduling, not sent
  await adminPatch('settings', settingsId, { notification_defaults: { on_confirmed: true, on_cancelled: true, on_rescheduled: true, reminders: ['d14', 'd3'] } });
  const B4 = one(await db('bookings', { method: 'POST', body: JSON.stringify({ retailer_id: retailerId, venue_id: V1, brand_name: 'Ten Days Brand', contact_email: 'brand4@fixture.test', demo_date: dayP(10), demo_time: '11:00 AM', duration_hours: 3, status: 'confirmed', payment_status: 'unpaid', amount_paid: 0 }) })).id; extraBookings.push(B4);
  const mH = spy.calls.resend.length; await worker(); await worker();
  const rowsH = (await rowsFor(B4)).filter(r => r.kind === 'reminder' && r.recipient_id === cFollow);
  ok('ND-1 H: ten days out: the 14-day reminder is one skipped due_before_scheduling row (never sent), the 3-day reminder is pending, and a second run adds nothing', rowsH.filter(r => r.offset_key === 'd14').length === 1 && rowsH.find(r => r.offset_key === 'd14').status === 'skipped' && rowsH.find(r => r.offset_key === 'd14').skip_reason === 'due_before_scheduling' && rowsH.filter(r => r.offset_key === 'd3' && r.status === 'pending').length === 1 && rowsH.length === 2 && spy.calls.resend.slice(mH).filter(x => /reminder/i.test(x.subject || '') && JSON.stringify(x).includes(followEmail)).length === 0, JSON.stringify(rowsH.map(r => [r.offset_key, r.status, r.skip_reason])));


  console.log('\n— ND-3: who may change the store default; unrelated saves leave it alone —');
  const beforeDef = one(await db(`settings?id=eq.${settingsId}&select=notification_defaults,demo_fee,advance_booking_days`));
  const mkStaff = async (rid, role) => { const em = `${role}-${uniq('nd3')}@fixture.test`; track('retailer_admins', one(await db('retailer_admins', { method: 'POST', body: JSON.stringify({ retailer_id: rid, email: em, email_normalized: em, name: role, role }) })).id); const tk = one(await db('admin_tokens', { method: 'POST', body: JSON.stringify({ email: em, retailer_id: rid }) })); return (await callRoute('admin-auth.js', req({ body: { action: 'verify', token: tk.token } }))).cookie('dh_retailer_session'); };
  const viewerCookie = await mkStaff(retailerId, 'viewer');
  const rv = await callRoute('admin.js', req({ method: 'PATCH', query: { table: 'settings', id: settingsId }, body: { notification_defaults: { reminders: ['h1'] } }, cookies: { dh_retailer_session: viewerCookie } }));
  const afterViewer = one(await db(`settings?id=eq.${settingsId}&select=notification_defaults`));
  ok('a VIEWER cannot change the store default (refused, value unchanged)', rv.statusCode >= 400 && rv.statusCode < 500 && JSON.stringify(afterViewer.notification_defaults) === JSON.stringify(beforeDef.notification_defaults), `${rv.statusCode} ${JSON.stringify(J(rv)).slice(0, 100)}`);
  const otherSlug = uniq('nd3o'); const otherRid = track('retailers', one(await db('retailers', { method: 'POST', body: JSON.stringify({ slug: otherSlug, name: 'Other Store', billing_email: `${otherSlug}@fixture.test`, billing_tier: 'pro', billing_status: 'active', verification_status: 'approved' }) })).id);
  const otherOwner = await mkStaff(otherRid, 'owner');
  const ro = await callRoute('admin.js', req({ method: 'PATCH', query: { table: 'settings', id: settingsId }, body: { notification_defaults: { reminders: ['h1'] } }, cookies: { dh_retailer_session: otherOwner } }));
  const afterOther = one(await db(`settings?id=eq.${settingsId}&select=notification_defaults`));
  ok('ANOTHER retailer\'s owner cannot change this store\'s default (refused, value unchanged)', ro.statusCode >= 400 && ro.statusCode < 500 && JSON.stringify(afterOther.notification_defaults) === JSON.stringify(beforeDef.notification_defaults), `${ro.statusCode} ${JSON.stringify(J(ro)).slice(0, 100)}`);
  const rs = await adminPatch('settings', settingsId, { demo_fee: 31, advance_booking_days: 7 });
  const afterSettings = one(await db(`settings?id=eq.${settingsId}&select=notification_defaults,demo_fee,advance_booking_days`));
  ok('an unrelated Settings save (fee + lead time) leaves notification_defaults untouched', rs.statusCode < 300 && JSON.stringify(afterSettings.notification_defaults) === JSON.stringify(beforeDef.notification_defaults) && Number(afterSettings.demo_fee) === 31 && afterSettings.advance_booking_days === 7, JSON.stringify(afterSettings));
  const rd = await adminPatch('settings', settingsId, { notification_defaults: { on_confirmed: true, on_cancelled: true, on_rescheduled: true, reminders: ['w1'] } });
  const afterDefaults = one(await db(`settings?id=eq.${settingsId}&select=notification_defaults,demo_fee,advance_booking_days`));
  ok('saving notification defaults leaves the fee and lead time untouched', rd.statusCode < 300 && afterDefaults.notification_defaults.reminders.join() === 'w1' && Number(afterDefaults.demo_fee) === 31 && afterDefaults.advance_booking_days === 7, JSON.stringify(afterDefaults));
  await db(`admin_sessions?retailer_id=eq.${otherRid}`, { method: 'DELETE' }); await db(`admin_tokens?retailer_id=eq.${otherRid}`, { method: 'DELETE' });

  console.log('\n— clearing the default restores the fallback —');
  const clr = await adminPatch('settings', settingsId, { notification_defaults: null });
  const prof2 = await owner('owner-retailer-profile', { retailer_id: retailerId }); const pf2 = (prof2.body.contacts || []).find(c => c.name === 'Follows Store');
  ok('null clears the default; the following contact is back on the fallback (lifecycle on, no reminders)', clr.statusCode < 300 && prof2.body.notification_defaults === null && pf2 && pf2.prefs_source === 'fallback' && pf2.notifications.reminders.length === 0 && pf2.notifications.lifecycle.length === 3, JSON.stringify(pf2));
} finally {
  for (const id of extraBookings) { await db(`notification_deliveries?booking_id=eq.${id}`, { method: 'DELETE' }); await db(`notification_events?booking_id=eq.${id}`, { method: 'DELETE' }); await db(`bookings?id=eq.${id}`, { method: 'DELETE' }); }
  if (bookingId) { await db(`notification_deliveries?booking_id=eq.${bookingId}`, { method: 'DELETE' }); await db(`notification_events?booking_id=eq.${bookingId}`, { method: 'DELETE' }); await db(`bookings?id=eq.${bookingId}`, { method: 'DELETE' }); }
  await db(`notification_events?retailer_id=eq.${retailerId}`, { method: 'DELETE' });
  await db(`admin_sessions?retailer_id=eq.${retailerId}`, { method: 'DELETE' }); await db(`admin_tokens?retailer_id=eq.${retailerId}`, { method: 'DELETE' });
  for (const [t, id] of bin.reverse()) await db(`${t}?id=eq.${id}`, { method: 'DELETE' });
  spy.restore();
}
process.exit(summary('notification defaults') ? 0 : 1);
