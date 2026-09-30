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
let bookingId = null;
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

  console.log('\n— clearing the default restores the fallback —');
  const clr = await adminPatch('settings', settingsId, { notification_defaults: null });
  const prof2 = await owner('owner-retailer-profile', { retailer_id: retailerId }); const pf2 = (prof2.body.contacts || []).find(c => c.name === 'Follows Store');
  ok('null clears the default; the following contact is back on the fallback (lifecycle on, no reminders)', clr.statusCode < 300 && prof2.body.notification_defaults === null && pf2 && pf2.prefs_source === 'fallback' && pf2.notifications.reminders.length === 0 && pf2.notifications.lifecycle.length === 3, JSON.stringify(pf2));
} finally {
  if (bookingId) { await db(`notification_deliveries?booking_id=eq.${bookingId}`, { method: 'DELETE' }); await db(`notification_events?booking_id=eq.${bookingId}`, { method: 'DELETE' }); await db(`bookings?id=eq.${bookingId}`, { method: 'DELETE' }); }
  await db(`notification_events?retailer_id=eq.${retailerId}`, { method: 'DELETE' });
  await db(`admin_sessions?retailer_id=eq.${retailerId}`, { method: 'DELETE' }); await db(`admin_tokens?retailer_id=eq.${retailerId}`, { method: 'DELETE' });
  for (const [t, id] of bin.reverse()) await db(`${t}?id=eq.${id}`, { method: 'DELETE' });
  spy.restore();
}
process.exit(summary('notification defaults') ? 0 : 1);
