// tests/store_contact_notifications.test.mjs — store contacts (internal_contacts) hear about a demo
// when it is CONFIRMED, get reminders before it, and are told when it is cancelled or rescheduled.
// Never when a brand merely books or pays. Codex Release A: every notice is a durable row in the 0074
// outbox (notification_events written by database triggers in the state-changing transaction;
// notification_deliveries fanned out, claimed, frozen, sent and recorded by api/notification-worker.js).
//
// Every assertion goes through a REAL exported handler against the real test database
// (tests/_route.mjs; Stripe and Resend spied). Mail is contained: every recipient is the sink, and a
// message's intended recipient is read off the containment banner in its body. Reminder timing is
// driven through the worker INTERNALS with an injected clock (the HTTP route accepts no clock).
//
// Fixtures: retailer R (America/Los_Angeles, manual confirm) with venues V1, V2; store contacts
//   C1  V1 only, new-contact defaults (lifecycle ON, reminders d3 + d1 + morning_of)
//   C2  every venue, reminders ['h1'] only, on_cancelled OFF
//   C3  V2 only, defaults (must never hear about a V1 demo)
//   C4  V1, LEGACY {on_scheduled:false} (explicit opt-out of confirmations; cancelled/rescheduled still on)
//   C5  V1, prefs NULL (genuinely missing -> lifecycle ON, reminders NONE)
//   C6  V1, reminders ['d1'] + custom_days 1 (equivalent offsets -> ONE reminder)
//   CX  a store contact of ANOTHER retailer, every venue (must never hear anything)
// a brand with an approved COI whose PROFILE says needs_electricity:true, and one paid booking at V1
// booked with needs_electricity:false (the booking value wins), driven through /api/book -> /api/checkout
// -> a signed checkout.session.completed -> /api/booking-action confirm.
//
// Run from the repository root with test-database creds:  node tests/store_contact_notifications.test.mjs
import { createHmac } from 'node:crypto';
import { installSpy, callRoute, req, rawReq, ok, summary, uniq, ENV } from './_route.mjs';
import { getBinding } from '../api/_env.js';
import { demoStartUtc, reminderWindow } from '../api/_local-time.js';
import { dispatchDue, scheduleReminders, fanOutEvents } from '../api/_notification-outbox.js';

// api/_flags.js reads env once per process: the worker flag must be on BEFORE the first route import.
ENV.NOTIFICATION_WORKER_ENABLED = 'true';

const SB = process.env.SB_URL, KEY = process.env.SB_KEY;
const H = { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json', Prefer: 'return=representation' };
const db = async (path, opts = {}) => {
  const r = await fetch(`${SB}/rest/v1/${path}`, { ...opts, headers: { ...H, ...(opts.headers || {}) } });
  const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch (_) {}
  return { ok: r.ok, status: r.status, body: j };
};
const one = (r) => (r && Array.isArray(r.body) ? r.body[0] : null);
const bin = [];
const track = (t, id) => { if (id) bin.push([t, id]); return id; };
const CRON = { authorization: 'Bearer ' + ENV.CRON_SECRET };
const LA = 'America/Los_Angeles';
const startIso = new Date().toISOString();
const dayP = (n) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const sign = (payload, secret = 'whsec_harness') => {
  const t = Math.floor(Date.now() / 1000);
  return `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${payload}`).digest('hex')}`;
};
const at = (d, ms = 0) => new Date(d.getTime() + ms);
const iso = (d) => d.toISOString();

const spy = installSpy();
const mailsSince = (n) => spy.calls.resend.slice(n);
const toContact = (m, email) => String(m.html || '').includes(email);
const subj = (m) => String(m.subject || '');
const withSubject = (mails, phrase) => mails.filter(m => subj(m).includes(phrase));
const anyToContacts = (mails, emails) => mails.filter(m => emails.some(e => toContact(m, e)));
const redact = (s) => String(s).replace(/[a-z0-9._-]+@[a-z0-9.-]+\.test/gi, '<redacted@fixture>').replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<uuid>');
const sameJson = (a, b) => JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));
const sortKeys = (v) => (Array.isArray(v) ? v.map(sortKeys) : (v && typeof v === 'object') ? Object.fromEntries(Object.keys(v).sort().map(k => [k, sortKeys(v[k])])) : v);
const textOf = (html) => String(html).replace(/<style[\s\S]*?<\/style>/g, '').replace(/<br\s*\/?>/g, '\n').replace(/<\/(tr|p|div|h1|li)>/g, '\n').replace(/<[^>]+>/g, '').replace(/&middot;/g, '·').replace(/&mdash;/g, '—').replace(/&rarr;/g, '→').replace(/&bull;/g, '•').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const slug = uniq('nt');
const retailerId = track('retailers', one(await db('retailers', { method: 'POST', body: JSON.stringify({
  slug, name: 'Notify Fixture Market', billing_email: `${slug}@fixture.test`, billing_tier: 'pro', billing_status: 'active',
  platform_keeps_all: true, timezone: LA, auto_confirm_bookings: false, cancellation_mode: 'refundable' }) })).id);
const V1 = track('venues', one(await db('venues', { method: 'POST', body: JSON.stringify({ retailer_id: retailerId, name: 'Notify Main', address: '12 Notify Ave, Portland, OR', demo_fee: 30 }) })).id);
const V2 = track('venues', one(await db('venues', { method: 'POST', body: JSON.stringify({ retailer_id: retailerId, name: 'Notify Annex', address: '99 Annex Rd', demo_fee: 30 }) })).id);
const otherSlug = uniq('nx');
const otherRetailerId = track('retailers', one(await db('retailers', { method: 'POST', body: JSON.stringify({
  slug: otherSlug, name: 'Other Market', billing_email: `${otherSlug}@fixture.test`, billing_tier: 'pro', billing_status: 'active', platform_keeps_all: true, timezone: LA }) })).id);

const staffEmail = `staff-${slug}@fixture.test`;
track('retailer_admins', one(await db('retailer_admins', { method: 'POST', body: JSON.stringify({ retailer_id: retailerId, email: staffEmail, email_normalized: staffEmail, name: 'Notify Staff', role: 'admin' }) })).id);
const staffTok = one(await db('admin_tokens', { method: 'POST', body: JSON.stringify({ email: staffEmail, retailer_id: retailerId }) }));
const staffCookie = (await callRoute('admin-auth.js', req({ body: { action: 'verify', token: staffTok.token } }))).cookie('dh_retailer_session');

const em = (n) => `${n}-${slug}@fixture.test`;
const C1e = em('c1'), C2e = em('c2'), C3e = em('c3'), C4e = em('c4'), C5e = em('c5'), C6e = em('c6'), CXe = em('cx');
const DEFAULTS = { on_confirmed: true, on_cancelled: true, on_rescheduled: true, reminders: ['d3', 'd1', 'morning_of'] };
const mkContact = async (rid, name, email, venue_ids, prefs) => track('internal_contacts', one(await db('internal_contacts', { method: 'POST', body: JSON.stringify({ retailer_id: rid, name, role: 'Store lead', email, venue_ids, notification_prefs: prefs }) })).id);
const C1 = await mkContact(retailerId, 'Contact One', C1e, [V1], DEFAULTS);
const C2 = await mkContact(retailerId, 'Contact Two', C2e, [], { on_confirmed: true, on_cancelled: false, on_rescheduled: true, reminders: ['h1'] });
const C3 = await mkContact(retailerId, 'Contact Three', C3e, [V2], DEFAULTS);
const C4 = await mkContact(retailerId, 'Contact Four', C4e, [V1], { on_scheduled: false });
const C5 = await mkContact(retailerId, 'Contact Five', C5e, [V1], null);
const C6 = await mkContact(retailerId, 'Contact Six', C6e, [V1], { on_confirmed: true, on_cancelled: true, on_rescheduled: true, reminders: ['d1'], custom_days: 1 });
const CX = await mkContact(otherRetailerId, 'Contact Other', CXe, [], DEFAULTS);
const ALL = [C1e, C2e, C3e, C4e, C5e, C6e, CXe];

const brandEmail = `${uniq('brand')}@fixture.test`;
const brandId = track('brands', one(await db('brands', { method: 'POST', body: JSON.stringify({
  email: brandEmail, company_name: 'Notify Brand Co', contact_name: 'Rep Person', phone: '555-0199', is_verified: true,
  default_coi_url: 'brands/notify.pdf', default_coi_expires: dayP(400), coi_verification_status: 'approved', needs_electricity: true }) })).id);
const brandTok = one(await db('brand_account_tokens', { method: 'POST', body: JSON.stringify({ brand_id: brandId, email: brandEmail, token: 'tk-' + uniq('n'), expires_at: new Date(Date.now() + 36e5).toISOString() }) }));
const brandCookie = (await callRoute('brand-account.js', req({ body: { action: 'verify', token: brandTok.token } }))).cookie('dh_brand_session');

const D = dayP(20), T = '11:00 AM';
const groups = [];
let bookingId = null, demoId = null;
const b = await getBinding();   // the harness binding (process.env is ENV after callRoute)

const deliveries = async (filter = '') => (await db(`notification_deliveries?booking_id=eq.${bookingId}&select=id,kind,offset_key,recipient_id,recipient_email,status,skip_reason,occurrence_key,dedupe_key,due_at,expires_at,attempts,idempotency_key,provider_message_id${filter}&order=due_at.asc`)).body || [];
const events = async (filter = '') => (await db(`notification_events?booking_id=eq.${bookingId}&select=id,kind,transition_id,fanned_out_at,payload${filter}&order=created_at.asc`)).body || [];
const hbRows = async () => (await db(`cron_heartbeat?cron_name=eq.notification-worker&ran_at=gte.${encodeURIComponent(startIso)}&select=outcome,summary&order=ran_at.asc`)).body || [];
const runWorkerRoute = (extra = {}) => callRoute('notification-worker.js', req({ method: 'GET', headers: CRON, ...extra }));
let C8 = null;
const who = (id) => ({ [C1]: 'C1', [C2]: 'C2', [C3]: 'C3', [C4]: 'C4', [C5]: 'C5', [C6]: 'C6', [CX]: 'CX', [C8]: 'C8' })[id] || '?';
const bookingRow = async () => one(await db(`bookings?id=eq.${bookingId}&select=id,status,payment_status,schedule_revision,start_at,end_at,timezone,needs_electricity,demo_date,demo_time,cancel_reason`));

try {
  ok('fixtures: staff and brand sessions exist', !!staffCookie && !!brandCookie);
  ok('fixtures: seven store contacts exist', [C1, C2, C3, C4, C5, C6, CX].every(Boolean));

  // =========================================================================
  console.log('\n— 1: booking and paying send NOTHING to store contacts; electricity is typed per booking —');
  // =========================================================================
  {
    const bad = await callRoute('book.js', req({ body: { retailer_slug: slug, venue_id: V1, demo_date: D, demo_time: T, needs_electricity: 'yes' }, cookies: { dh_brand_session: brandCookie } }));
    ok('/api/book refuses a non-boolean needs_electricity with 400 invalid_needs_electricity', bad.statusCode === 400 && bad.body && bad.body.error === 'invalid_needs_electricity', `${bad.statusCode} ${JSON.stringify(bad.body)}`);
    const badDate = await callRoute('book.js', req({ body: { retailer_slug: slug, venue_id: V1, demo_date: '2026-02-30', demo_time: T }, cookies: { dh_brand_session: brandCookie } }));
    ok('/api/book refuses an impossible date with 400 invalid_demo_date', badDate.statusCode === 400 && badDate.body && badDate.body.error === 'invalid_demo_date', `${badDate.statusCode} ${JSON.stringify(badDate.body)}`);
    const badTime = await callRoute('book.js', req({ body: { retailer_slug: slug, venue_id: V1, demo_date: D, demo_time: '11:00 AM sharp' }, cookies: { dh_brand_session: brandCookie } }));
    ok('/api/book refuses a time with trailing junk with 400 invalid_demo_time', badTime.statusCode === 400 && badTime.body && badTime.body.error === 'invalid_demo_time', `${badTime.statusCode}`);

    const n0 = spy.calls.resend.length;
    const bk = await callRoute('book.js', req({
      body: { retailer_slug: slug, venue_id: V1, demo_date: D, demo_time: T, product: 'Sparkling Yerba', needs_electricity: false,
              notes: 'Bring a folding table; samples are chilled.',
              product_skus: [{ name: 'Lime Fizz', size: '12 oz', sku: 'LF-12' }, { name: 'Berry Fizz', size: '12 oz', sku: 'BF-12' }] },
      cookies: { dh_brand_session: brandCookie } }));
    bookingId = bk.body && (bk.body.booking_id || bk.body.id || (bk.body.booking && bk.body.booking.id));
    if (bookingId) track('bookings', bookingId);
    ok('a booking was created through /api/book', bk.statusCode === 200 && !!bookingId, `${bk.statusCode} ${JSON.stringify(bk.body).slice(0, 200)}`);
    const row0 = await bookingRow();
    ok('bookings.needs_electricity is the TYPED false from the form (brand profile says true)', row0 && row0.needs_electricity === false, JSON.stringify(row0));
    ok('0074 snapshot: start_at/end_at/timezone were resolved on insert (11:00 LA, 3h)', row0 && row0.timezone === LA && row0.start_at && iso(new Date(row0.start_at)) === iso(demoStartUtc(D, T, LA)) && row0.end_at && (new Date(row0.end_at) - new Date(row0.start_at)) === 3 * 3600000 && row0.schedule_revision === 1, JSON.stringify(row0));
    ok('creating the booking emailed no store contact', anyToContacts(mailsSince(n0), ALL).length === 0, JSON.stringify(mailsSince(n0).map(subj)));

    const co = await callRoute('checkout.js', req({ body: { booking_ids: [bookingId] }, cookies: { dh_brand_session: brandCookie } }));
    const sessionId = co.body && co.body.session_id, groupId = co.body && co.body.payment_group_id, total = co.body && co.body.total_cents;
    if (groupId) groups.push(groupId);
    ok('checkout produced a session', co.statusCode === 200 && !!sessionId && !!groupId, `${co.statusCode} ${JSON.stringify(co.body).slice(0, 200)}`);
    const piId = 'pi_' + uniq('nt');
    spy.fixtures.paymentIntents[piId] = { id: piId, object: 'payment_intent', amount_received: total, currency: 'usd', on_behalf_of: null,
      latest_charge: { id: 'ch_' + uniq('nt'), object: 'charge', destination: null, application_fee_amount: null, transfer: null, application_fee: null } };
    const paidEvent = JSON.stringify({ id: 'evt_' + uniq('nt'), type: 'checkout.session.completed',
      data: { object: { id: sessionId, object: 'checkout.session', mode: 'payment', payment_status: 'paid', amount_total: total, currency: 'usd', payment_intent: piId, metadata: { payment_group_id: groupId } } } });
    const n1 = spy.calls.resend.length;
    const paid = await callRoute('stripe-webhook.js', rawReq(paidEvent, { signature: sign(paidEvent) }));
    ok('the signed paid event is accepted', paid.statusCode >= 200 && paid.statusCode < 300, `${paid.statusCode}`);
    const row = await bookingRow();
    ok('the booking is paid and PENDING (manual-confirm retailer)', row && row.payment_status === 'paid' && row.status === 'pending', JSON.stringify(row));
    const payMails = mailsSince(n1);
    ok('payment emailed the brand', payMails.some(m => subj(m).includes('Your demo booking at')), JSON.stringify(payMails.map(subj)));
    ok('payment emailed NO store contact', anyToContacts(payMails, ALL).length === 0 && withSubject(payMails, 'Demo confirmed').length === 0, JSON.stringify(payMails.map(subj)));
    ok('no notification event or delivery exists before confirmation', (await events()).length === 0 && (await deliveries()).length === 0);
    const n2 = spy.calls.resend.length;
    const w0 = await runWorkerRoute();
    ok('a worker run before confirmation sends nothing to store contacts', w0.statusCode === 200 && anyToContacts(mailsSince(n2), ALL).length === 0, `${w0.statusCode} ${JSON.stringify(w0.body).slice(0, 200)}`);

    // A never-confirmed request that is declined writes no event at all (trigger: pending -> declined is silent).
    const dec = one(await db('bookings', { method: 'POST', body: JSON.stringify({ retailer_id: retailerId, venue_id: V1, brand_id: brandId, brand_name: 'Notify Brand Co', contact_email: brandEmail, demo_date: dayP(25), demo_time: '1:00 PM', status: 'pending', payment_status: 'unpaid' }) }));
    track('bookings', dec.id);
    await db(`bookings?id=eq.${dec.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'declined' }) });
    const decEv = (await db(`notification_events?booking_id=eq.${dec.id}&select=id`)).body || [];
    ok('declining a never-confirmed request writes NO event (contacts were never told)', decEv.length === 0, JSON.stringify(decEv));
  }

  // =========================================================================
  console.log('\n— 2: confirming writes ONE event; the worker delivers "Demo confirmed" to in-scope, opted-in contacts only —');
  // =========================================================================
  let confirmedSample = null;
  {
    const n0 = spy.calls.resend.length;
    const c = await callRoute('booking-action.js', req({ body: { booking_id: bookingId, action: 'confirm' }, cookies: { dh_retailer_session: staffCookie } }));
    ok('confirm succeeds', c.statusCode === 200 && c.body && c.body.ok === true, `${c.statusCode} ${JSON.stringify(c.body).slice(0, 200)}`);
    demoId = c.body && c.body.demo_id;
    if (demoId) track('demos', demoId);
    ok('the confirm route itself emailed no store contact (the outbox does)', anyToContacts(mailsSince(n0), ALL).length === 0, JSON.stringify(mailsSince(n0).map(subj)));
    const ev = await events();
    ok('exactly ONE demo_confirmed event was written by the trigger, in the confirm transaction', ev.length === 1 && ev[0].kind === 'demo_confirmed' && ev[0].transition_id === `${bookingId}:confirmed:1` && ev[0].fanned_out_at === null, JSON.stringify(ev));

    const again = await callRoute('booking-action.js', req({ body: { booking_id: bookingId, action: 'confirm' }, cookies: { dh_retailer_session: staffCookie } }));
    ok('a second confirm call is refused (already confirmed) and writes no second event', again.statusCode === 409 && (await events()).length === 1, `${again.statusCode}`);

    const n1 = spy.calls.resend.length;
    const w = await runWorkerRoute({ query: { now: '2030-01-01T00:00:00Z' } });   // a ?now= is NOT a clock override
    ok('worker run -> 200 ok (a ?now= query is ignored, never a clock override)', w.statusCode === 200 && w.body && w.body.ok === true && w.body.now && w.body.now.slice(0, 4) !== '2030', `${w.statusCode} ${JSON.stringify(w.body).slice(0, 300)}`);
    const mails = mailsSince(n1);
    const conf = withSubject(mails, 'Demo confirmed:');
    ok('exactly FOUR "Demo confirmed" notices went out: C1, C2, C5, C6', conf.length === 4, JSON.stringify(mails.map(subj)));
    ok('C1 (V1 scope, defaults) got one', conf.filter(m => toContact(m, C1e)).length === 1);
    ok('C2 (all venues) got one', conf.filter(m => toContact(m, C2e)).length === 1);
    ok('C5 (prefs NULL -> lifecycle on) got one', conf.filter(m => toContact(m, C5e)).length === 1);
    ok('C6 got one', conf.filter(m => toContact(m, C6e)).length === 1);
    ok('C3 (V2 only) got none', !mails.some(m => toContact(m, C3e)));
    ok('C4 (legacy on_scheduled:false = explicit opt-out) got none', !mails.some(m => toContact(m, C4e)));
    ok('CX (another retailer) got none', !mails.some(m => toContact(m, CXe)));
    ok('every recipient is the contained sink', mails.every(m => [].concat(m.to).every(a => a === 'sink@fixture.test')));
    ok('no reminder went out yet (none is due)', !mails.some(m => /^\[SINK\] Demo (today|tomorrow|in )/.test(subj(m))), JSON.stringify(mails.map(subj)));

    const m = conf.find(x => toContact(x, C1e)) || { html: '', subject: '' };
    confirmedSample = m;
    const startAt = demoStartUtc(D, T, LA);
    const dateStr = startAt.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: LA });
    ok('subject: Demo confirmed: <brand> at <location> — <Weekday, Month D>', subj(m) === `[SINK] Demo confirmed: Notify Brand Co at Notify Main — ${dateStr}`, subj(m));
    const body = String(m.html);
    ok('body has the date with year', body.includes(startAt.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: LA })));
    ok('body has the start–end time range with the zone abbreviation', /11:00\s?AM – 2:00\s?PM P[DS]T/.test(body), (body.match(/11:00[^<]{0,30}/) || [])[0]);
    ok('body has the location name and address', body.includes('Notify Main') && body.includes('12 Notify Ave, Portland, OR'));
    ok('body has the brand and product', body.includes('Notify Brand Co') && body.includes('Sparkling Yerba'));
    ok('body lists every SKU (name, size, sku)', body.includes('Lime Fizz') && body.includes('Berry Fizz') && body.includes('LF-12') && body.includes('BF-12') && body.includes('12 oz'));
    ok('body has the electricity line from the BOOKING: No (brand profile says Yes)', /Needs electricity<\/td>[\s\S]{0,200}?>No<\/td>/.test(body) && !/Needs electricity<\/td>[\s\S]{0,200}?<strong>Yes<\/strong>/.test(body));
    ok('body has the brand rep name and phone', body.includes('Rep Person') && body.includes('555-0199'));
    ok('body has the brand\'s operational notes', body.includes('Bring a folding table; samples are chilled.'));
    ok('body never mentions COI/insurance or finance', !/insurance|certificate|refund|\$\d/i.test(body.replace(/Non-production email[\s\S]*?<\/div>/, '')));

    const rows = await deliveries('&kind=eq.demo_confirmed');
    ok('notification_deliveries: exactly four ACCEPTED demo_confirmed rows (C1, C2, C5, C6), none for C3/C4/CX', rows.length === 4 && rows.every(r => r.status === 'accepted' && r.provider_message_id && r.idempotency_key === r.id) && new Set(rows.map(r => who(r.recipient_id))).size === 4 && rows.every(r => ['C1', 'C2', 'C5', 'C6'].includes(who(r.recipient_id))), JSON.stringify(rows.map(r => [who(r.recipient_id), r.status])));
    ok('dedupe keys follow <kind>:<transition_id>:store_contact:<contact_id>', rows.every(r => r.dedupe_key === `demo_confirmed:${bookingId}:confirmed:1:store_contact:${r.recipient_id}`), JSON.stringify(rows.map(r => r.dedupe_key)));
    ok('the event is marked fanned out', (await events())[0].fanned_out_at !== null);

    const n2 = spy.calls.resend.length;
    const w2 = await runWorkerRoute();
    ok('a second worker run sends nothing more (idempotent: accepted rows are never re-sent)', w2.statusCode === 200 && anyToContacts(mailsSince(n2), ALL).length === 0, JSON.stringify(mailsSince(n2).map(subj)));
    const hb = await hbRows();
    ok('every worker run so far wrote a "succeeded" heartbeat with counts and no addresses', hb.length >= 3 && hb.every(h => h.outcome === 'succeeded') && !/@/.test(JSON.stringify(hb)), JSON.stringify(hb.map(h => h.outcome)));
  }

  // =========================================================================
  console.log('\n— 3: reminders are scheduled from prefs (deduped) and fire at the right local instant, once —');
  // =========================================================================
  const startAt = demoStartUtc(D, T, LA);
  const wd3 = reminderWindow('d3', startAt, LA), wd1 = reminderWindow('d1', startAt, LA), wMorn = reminderWindow('morning_of', startAt, LA), wh1 = reminderWindow('h1', startAt, LA);
  let reminderSample = null;
  {
    ok('sanity: d1 reminder is 09:00 local the day before (16:00Z PDT / 17:00Z PST)', /T1[67]:00:00\.000Z$/.test(iso(wd1.due_at)) && wd1.due_at < startAt, iso(wd1.due_at));
    ok('sanity: morning_of is 07:00 local on the demo day', /T1[45]:00:00\.000Z$/.test(iso(wMorn.due_at)), iso(wMorn.due_at));
    const rem = await deliveries('&kind=eq.reminder');
    const keyed = rem.map(r => `${who(r.recipient_id)}:${r.offset_key}:${r.status}`).sort();
    ok('scheduled reminders: C1 d3/d1/morning_of, C2 h1, C6 ONE d1 (d1 + custom 1 deduped); C5 none (prefs null); nobody else',
       JSON.stringify(keyed) === JSON.stringify(['C1:d1:pending', 'C1:d3:pending', 'C1:morning_of:pending', 'C2:h1:pending', 'C6:d1:pending'].sort()), JSON.stringify(keyed));
    const byKey = Object.fromEntries(rem.map(r => [`${who(r.recipient_id)}:${r.offset_key}`, r]));
    ok('due_at / expires_at follow the schedule rules (09:00 local, +2h; 07:00 local; start-60m +30m)',
       iso(new Date(byKey['C1:d3'].due_at)) === iso(wd3.due_at) && iso(new Date(byKey['C1:d3'].expires_at)) === iso(wd3.expires_at)
       && iso(new Date(byKey['C1:d1'].due_at)) === iso(wd1.due_at)
       && iso(new Date(byKey['C1:morning_of'].due_at)) === iso(wMorn.due_at) && iso(new Date(byKey['C1:morning_of'].expires_at)) === iso(wMorn.expires_at)
       && iso(new Date(byKey['C2:h1'].due_at)) === iso(wh1.due_at) && iso(new Date(byKey['C2:h1'].expires_at)) === iso(wh1.expires_at), JSON.stringify(rem.map(r => [who(r.recipient_id), r.offset_key, r.due_at, r.expires_at])));
    ok('reminder dedupe keys: reminder:<booking>:<rev>:store_contact:<contact>:<offset>', rem.every(r => r.dedupe_key === `reminder:${bookingId}:1:store_contact:${r.recipient_id}:${r.offset_key}` && r.occurrence_key === `${bookingId}:1`), JSON.stringify(rem.map(r => r.dedupe_key)));

    // A contact who opts in AFTER a reminder's due time: the row is recorded as skipped, never sent as a backlog.
    const lateEmail = em('c7');
    const C7 = await mkContact(retailerId, 'Contact Seven (late opt-in)', lateEmail, [V1], { on_confirmed: true, on_cancelled: true, on_rescheduled: true, reminders: ['d3', 'h1'] });
    const sched = await scheduleReminders(b, { now: at(wd3.due_at, 60 * 60000) });   // one hour after the d3 slot
    ok('scheduleReminders with an injected clock ran clean', sched.errors.length === 0 && sched.bookings >= 1, JSON.stringify(sched));
    const c7rows = (await deliveries('&kind=eq.reminder')).filter(r => r.recipient_id === C7);
    ok('late opt-in: the already-due d3 row is inserted SKIPPED (due_before_scheduling); the future h1 row is pending', c7rows.length === 2 && c7rows.some(r => r.offset_key === 'd3' && r.status === 'skipped' && r.skip_reason === 'due_before_scheduling') && c7rows.some(r => r.offset_key === 'h1' && r.status === 'pending'), JSON.stringify(c7rows.map(r => [r.offset_key, r.status, r.skip_reason])));

    let n = spy.calls.resend.length;
    let r = await dispatchDue(b, { now: at(wd3.due_at, -60000) });
    ok('one minute before the d3 slot: nothing is claimed or sent', r.claimed === 0 && r.accepted === 0 && spy.calls.resend.length === n, JSON.stringify(r));

    n = spy.calls.resend.length;
    r = await dispatchDue(b, { now: wd3.due_at });
    let mails = mailsSince(n);
    ok('at the d3 slot: exactly one reminder accepted, "Demo in 3 days" to C1 only', r.accepted === 1 && r.failed === 0 && mails.length === 1 && subj(mails[0]).includes('Demo in 3 days:') && toContact(mails[0], C1e), JSON.stringify({ r, subjects: mails.map(subj) }));
    reminderSample = mails[0];
    ok('the reminder body carries the SKUs, the time range and the electricity line', /Lime Fizz/.test(mails[0].html) && /11:00\s?AM – 2:00\s?PM P[DS]T/.test(mails[0].html) && /Needs electricity/.test(mails[0].html));
    n = spy.calls.resend.length;
    r = await dispatchDue(b, { now: at(wd3.due_at, 5 * 60000) });
    ok('a second dispatch in the same window sends nothing (accepted rows are done)', r.claimed === 0 && spy.calls.resend.length === n, JSON.stringify(r));

    // Preference change d3 -> d1 uses a NEW dedupe key: C6 switches from d1 to d3.
    const patch = (id, body) => callRoute('admin.js', req({ method: 'PATCH', query: { table: 'internal_contacts', id }, body, cookies: { dh_retailer_session: staffCookie } }));
    const p6 = await patch(C6, { notification_prefs: { on_confirmed: true, on_cancelled: true, on_rescheduled: true, reminders: ['d3'] } });
    ok('C6 prefs changed d1 -> d3 through the admin route', p6.statusCode >= 200 && p6.statusCode < 300, `${p6.statusCode} ${String(p6.body).slice(0, 120)}`);
    await scheduleReminders(b, { now: at(wd3.due_at, 10 * 60000) });
    const c6rows = (await deliveries('&kind=eq.reminder')).filter(r => r.recipient_id === C6);
    ok('C6 now has TWO rows with distinct dedupe keys: the old d1 (still pending) and a new d3 (skipped: its slot already passed)', c6rows.length === 2 && new Set(c6rows.map(r => r.dedupe_key)).size === 2 && c6rows.some(r => r.offset_key === 'd3' && r.status === 'skipped' && r.skip_reason === 'due_before_scheduling'), JSON.stringify(c6rows.map(r => [r.offset_key, r.status, r.skip_reason])));

    n = spy.calls.resend.length;
    r = await dispatchDue(b, { now: at(wd1.due_at, -60000) });
    ok('one minute before 09:00 the day before: d1 not yet due', r.claimed === 0 && spy.calls.resend.length === n, JSON.stringify(r));
    r = await dispatchDue(b, { now: wd1.due_at });
    mails = mailsSince(n);
    ok('at 09:00 local the day before: "Demo tomorrow" to C1 exactly once; C6\'s stale d1 row is SKIPPED opted_out (no email)', r.accepted === 1 && r.skipped === 1 && r.skip_reasons.opted_out === 1 && mails.length === 1 && subj(mails[0]).includes('Demo tomorrow:') && toContact(mails[0], C1e), JSON.stringify({ r, subjects: mails.map(subj) }));
    ok('C2 (h1 only) got nothing at the d1 slot', !mails.some(m => toContact(m, C2e)));
    n = spy.calls.resend.length;
    r = await dispatchDue(b, { now: at(wd1.due_at, 60000) });
    ok('re-run a minute later: nothing more', r.claimed === 0 && spy.calls.resend.length === n, JSON.stringify(r));

    // Catch-up expiry: morning_of is never dispatched inside its 2h window -> skipped 'expired'.
    n = spy.calls.resend.length;
    r = await dispatchDue(b, { now: at(wMorn.expires_at, 60000) });
    mails = mailsSince(n);
    ok('a morning_of reminder first seen 2h+ after due is SKIPPED expired, not sent late', r.skipped === 1 && r.skip_reasons.expired === 1 && r.accepted === 0 && mails.length === 0, JSON.stringify(r));

    // Contact deletion before dispatch: C7 is deleted; its pending h1 row is skipped at dispatch.
    await db(`internal_contacts?id=eq.${C7}`, { method: 'DELETE' });
    bin.splice(bin.findIndex(([t, id]) => id === C7), 1);
    n = spy.calls.resend.length;
    r = await dispatchDue(b, { now: at(wh1.due_at, -60000) });
    ok('61 minutes before the start: the h1 reminders are not due', r.claimed === 0 && spy.calls.resend.length === n, JSON.stringify(r));
    r = await dispatchDue(b, { now: wh1.due_at });
    mails = mailsSince(n);
    ok('60 minutes before the start: "Demo in 1 hour" to C2 exactly once; the deleted C7\'s row is SKIPPED recipient_deleted', r.accepted === 1 && r.skipped === 1 && r.skip_reasons.recipient_deleted === 1 && mails.length === 1 && subj(mails[0]).includes('Demo in 1 hour:') && toContact(mails[0], C2e), JSON.stringify({ r, subjects: mails.map(subj) }));
    ok('C1 (no h1) and C3 got nothing', !mails.some(m => toContact(m, C1e) || toContact(m, C3e)));
    n = spy.calls.resend.length;
    r = await dispatchDue(b, { now: at(wh1.due_at, 60000) });
    ok('re-run: the h1 reminder is not sent twice', r.claimed === 0 && spy.calls.resend.length === n, JSON.stringify(r));

    const c7left = (await deliveries('&kind=eq.reminder')).filter(r => r.recipient_id === C7);
    ok('the deleted contact\'s rows stay as an explainable record (skipped due_before_scheduling / recipient_deleted)', c7left.length === 2 && c7left.every(r => r.status === 'skipped'), JSON.stringify(c7left.map(r => [r.offset_key, r.status, r.skip_reason])));
  }

  // =========================================================================
  console.log('\n— 4: reschedule (retailer proposes, brand accepts) -> "Demo rescheduled"; old reminders retired, new ones scheduled; A -> B -> A —');
  // =========================================================================
  const D2 = dayP(30), T2 = '2:00 PM';
  {
    C8 = await mkContact(retailerId, 'Contact Eight (reminders only)', em('c8'), [V1], { on_confirmed: false, on_cancelled: false, on_rescheduled: false, reminders: ['h1'] });
    await scheduleReminders(b, { now: new Date() });
    const c8pending = (await deliveries(`&occurrence_key=eq.${bookingId}:1&kind=eq.reminder&status=eq.pending`)).filter(r => r.recipient_id === C8);
    ok('setup: a reminders-only contact has one pending h1 row for occurrence :1', c8pending.length === 1 && c8pending[0].offset_key === 'h1', JSON.stringify(c8pending.map(r => r.offset_key)));
    const prop = await callRoute('booking-action.js', req({ body: { action: 'reschedule', demo_id: demoId, new_date: D2, new_time: T2 }, cookies: { dh_retailer_session: staffCookie } }));
    ok('the retailer proposed a new date (with a proposal version)', prop.statusCode === 200 && prop.body && Number.isInteger(prop.body.proposal_version), `${prop.statusCode} ${JSON.stringify(prop.body).slice(0, 200)}`);
    const n0 = spy.calls.resend.length;
    const acc = await callRoute('brand-account.js', req({ body: { action: 'reschedule-respond', demo_id: demoId, decision: 'accept', proposal_version: prop.body && prop.body.proposal_version }, cookies: { dh_brand_session: brandCookie } }));
    ok('the brand accepted', acc.statusCode === 200, `${acc.statusCode} ${JSON.stringify(acc.body || '').slice(0, 200)}`);
    ok('the accept route itself emailed no store contact', anyToContacts(mailsSince(n0), ALL).length === 0, JSON.stringify(mailsSince(n0).map(subj)));
    const row = await bookingRow();
    ok('bookings moved: date/time/revision 2 and a fresh start_at snapshot (2:00 PM)', row && row.demo_date === D2 && row.demo_time === T2 && row.schedule_revision === 2 && iso(new Date(row.start_at)) === iso(demoStartUtc(D2, T2, LA)), JSON.stringify(row));
    const demoRow = one(await db(`demos?id=eq.${demoId}&select=demo_date,demo_time,status`));
    ok('the demos projection moved too', demoRow && demoRow.demo_date === D2 && demoRow.demo_time === T2 && demoRow.status === 'confirmed', JSON.stringify(demoRow));
    const ev = await events('&kind=eq.demo_rescheduled');
    ok('exactly one demo_rescheduled event with old and new slot in its payload', ev.length === 1 && ev[0].transition_id === `${bookingId}:rescheduled:2` && ev[0].payload && ev[0].payload.old_date === D && ev[0].payload.new_date === D2, JSON.stringify(ev));
    const oldPending = (await deliveries(`&occurrence_key=eq.${bookingId}:1&kind=eq.reminder`)).filter(r => ['pending', 'claimed'].includes(r.status));
    ok('every not-yet-sent reminder of the OLD occurrence was retired in the accept transaction', oldPending.length === 0, JSON.stringify(oldPending));
    const oldRetired = (await deliveries(`&occurrence_key=eq.${bookingId}:1&kind=eq.reminder&status=eq.skipped&skip_reason=eq.rescheduled`));
    ok('...as skipped "rescheduled" (C8\'s h1 row was the one still pending)', oldRetired.length === 1 && who(oldRetired[0].recipient_id) === 'C8' && oldRetired[0].offset_key === 'h1', JSON.stringify(oldRetired.map(r => [who(r.recipient_id), r.offset_key])));

    const n1 = spy.calls.resend.length;
    const w = await runWorkerRoute();
    const mails = mailsSince(n1);
    const resc = withSubject(mails, 'Demo rescheduled:');
    ok('worker run -> 200; exactly FIVE "Demo rescheduled" notices: C1, C2, C4 (on_rescheduled defaults on), C5, C6', w.statusCode === 200 && resc.length === 5 && [C1e, C2e, C4e, C5e, C6e].every(e => resc.some(m => toContact(m, e))), `${w.statusCode} ${JSON.stringify(mails.map(subj))}`);
    ok('C3 and CX heard nothing', !mails.some(m => toContact(m, C3e) || toContact(m, CXe)));
    const m = resc[0] || { html: '' };
    const s1 = demoStartUtc(D, T, LA), s2 = demoStartUtc(D2, T2, LA);
    const lbl = (d) => d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: LA });
    ok('the notice shows the old and the new date/time', String(m.html).includes(lbl(s1)) && String(m.html).includes(lbl(s2)) && /2:00\s?PM/.test(String(m.html)) && /11:00\s?AM/.test(String(m.html)), redact(textOf(m.html)).slice(0, 400));
    ok('subject names the NEW date', subj(m).includes(`— now ${s2.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: LA })}`), subj(m));
    const rem2 = await deliveries(`&occurrence_key=eq.${bookingId}:2&kind=eq.reminder`);
    const keyed2 = rem2.map(r => `${who(r.recipient_id)}:${r.offset_key}:${r.status}`).sort();
    ok('new reminders were scheduled for occurrence :2 (C1 d3/d1/morning_of, C2 h1, C6 d3, C8 h1), all pending', JSON.stringify(keyed2) === JSON.stringify(['C1:d1:pending', 'C1:d3:pending', 'C1:morning_of:pending', 'C2:h1:pending', 'C6:d3:pending', 'C8:h1:pending'].sort()), JSON.stringify(keyed2));

    // Old-slot instants fire nothing; the NEW slot's d3 fires for the new date.
    let n = spy.calls.resend.length;
    let r = await dispatchDue(b, { now: reminderWindow('d1', s1, LA).due_at });
    ok('at the OLD d1 instant nothing fires for the moved demo', r.claimed === 0 && spy.calls.resend.length === n, JSON.stringify(r));
    const wd3b = reminderWindow('d3', s2, LA);
    n = spy.calls.resend.length;
    r = await dispatchDue(b, { now: wd3b.due_at });
    const mails2 = mailsSince(n);
    ok('at the NEW d3 instant: "Demo in 3 days" to C1 and C6 for the new date (fresh keys after the move)', r.accepted === 2 && mails2.length === 2 && mails2.every(x => subj(x).includes('Demo in 3 days:') && /2:00\s?PM/.test(x.html)) && mails2.some(x => toContact(x, C1e)) && mails2.some(x => toContact(x, C6e)), JSON.stringify({ r, subjects: mails2.map(subj) }));

    // A -> B -> A: move back to the original slot. The occurrence is :3 — never the retired :1 keys.
    const prop2 = await callRoute('booking-action.js', req({ body: { action: 'reschedule', demo_id: demoId, new_date: D, new_time: T }, cookies: { dh_retailer_session: staffCookie } }));
    const acc2 = await callRoute('brand-account.js', req({ body: { action: 'reschedule-respond', demo_id: demoId, decision: 'accept', proposal_version: prop2.body && prop2.body.proposal_version }, cookies: { dh_brand_session: brandCookie } }));
    ok('A -> B -> A: proposed and accepted back to the original slot', prop2.statusCode === 200 && acc2.statusCode === 200, `${prop2.statusCode} ${acc2.statusCode}`);
    const row3 = await bookingRow();
    ok('bookings is back on slot A at revision 3', row3 && row3.demo_date === D && row3.demo_time === T && row3.schedule_revision === 3, JSON.stringify(row3));
    await runWorkerRoute();
    const rem3 = await deliveries(`&occurrence_key=eq.${bookingId}:3&kind=eq.reminder`);
    const rem1 = await deliveries(`&occurrence_key=eq.${bookingId}:1&kind=eq.reminder`);
    ok('occurrence :3 has its own pending reminder rows for slot A...', rem3.filter(r => r.status === 'pending').length === 6, JSON.stringify(rem3.map(r => [who(r.recipient_id), r.offset_key, r.status])));
    ok('...with dedupe keys distinct from the :1 rows for the SAME date/time (a destination alone is not an identity)', rem3.every(r => !rem1.some(o => o.dedupe_key === r.dedupe_key)) && rem1.length >= 5);
    ok('occurrence :2 rows were retired as skipped "rescheduled"', (await deliveries(`&occurrence_key=eq.${bookingId}:2&kind=eq.reminder`)).every(r => r.status !== 'pending'));
    n = spy.calls.resend.length;
    r = await dispatchDue(b, { now: reminderWindow('d3', s1, LA).due_at });
    ok('the :3 d3 reminder for slot A fires (C1 and C6) even though a :1 d3 for the same instant was sent before', r.accepted === 2 && mailsSince(n).length === 2, JSON.stringify(r));
  }

  // =========================================================================
  console.log('\n— 5: cancel -> "Demo cancelled" to on_cancelled contacts only; queued reminders retired —');
  // =========================================================================
  {
    const n0 = spy.calls.resend.length;
    const cx = await callRoute('booking-action.js', req({ body: { booking_id: bookingId, action: 'cancel', force_refund: true, reason: 'Store closed for inventory' }, cookies: { dh_retailer_session: staffCookie } }));
    ok('cancel succeeds', cx.statusCode === 200 && cx.body && cx.body.ok === true, `${cx.statusCode} ${JSON.stringify(cx.body).slice(0, 200)}`);
    const routeMails = mailsSince(n0);
    ok('the brand still got its own cancellation email from the route', routeMails.some(m => subj(m).includes('was cancelled') && !subj(m).includes('Demo cancelled:')), JSON.stringify(routeMails.map(subj)));
    ok('the route itself emailed no store contact', anyToContacts(routeMails, ALL).length === 0);
    const row = await bookingRow();
    ok('bookings.cancel_reason carries the retailer\'s reason (not appended to the brand\'s notes)', row && row.status === 'cancelled' && row.cancel_reason === 'Store closed for inventory', JSON.stringify(row));
    const ev = await events('&kind=eq.demo_cancelled');
    ok('exactly one demo_cancelled event, carrying the reason', ev.length === 1 && ev[0].transition_id === `${bookingId}:cancelled` && ev[0].payload && ev[0].payload.cancel_reason === 'Store closed for inventory', JSON.stringify(ev));
    const stillPending = (await deliveries()).filter(r => ['pending', 'claimed'].includes(r.status) && r.kind !== 'demo_cancelled');
    // :3 had six pending rows; the two d3 rows were dispatched above, so four were still queued.
    ok('every queued reminder was retired in the cancel transaction (four :3 rows skipped booking_cancelled)', stillPending.length === 0 && (await deliveries('&status=eq.skipped&skip_reason=eq.booking_cancelled')).length === 4, JSON.stringify({ stillPending, retired: (await deliveries('&status=eq.skipped&skip_reason=eq.booking_cancelled')).map(r => [who(r.recipient_id), r.offset_key]) }));

    const n1 = spy.calls.resend.length;
    const w = await runWorkerRoute();
    const mails = mailsSince(n1);
    const canc = withSubject(mails, 'Demo cancelled:');
    ok('worker run -> 200; "Demo cancelled" to C1, C4, C5, C6 (on_cancelled on) — not C2 (off), C3, CX', w.statusCode === 200 && canc.length === 4 && [C1e, C4e, C5e, C6e].every(e => canc.some(m => toContact(m, e))) && !mails.some(m => toContact(m, C2e) || toContact(m, C3e) || toContact(m, CXe)), `${w.statusCode} ${JSON.stringify(mails.map(subj))}`);
    ok('the notice carries the reason', /Store closed for inventory/.test(canc[0] ? canc[0].html : ''));
    ok('the notice does NOT carry the owner reason as "notes from the brand"', !/Notes from the brand<\/td>[\s\S]{0,300}?Cancelled:/.test(canc[0] ? canc[0].html : ''));

    const n2 = spy.calls.resend.length;
    const r = await dispatchDue(b, { now: reminderWindow('morning_of', demoStartUtc(D, T, LA), LA).due_at });
    ok('a cancelled demo gets no further reminders', r.claimed === 0 && r.accepted === 0 && spy.calls.resend.length === n2, JSON.stringify(r));
  }

  // =========================================================================
  console.log('\n— 6: worker auth, admin write guard (normalized prefs), tenant scope, timezone validation —');
  // =========================================================================
  {
    const hbBefore = (await hbRows()).length;
    const sbBefore = spy.calls.supabase;
    const none = await callRoute('notification-worker.js', req({ method: 'GET' }));
    ok('no Authorization -> 401', none.statusCode === 401 && none.body && none.body.error === 'unauthorized', `${none.statusCode}`);
    const wrong = await callRoute('notification-worker.js', req({ method: 'GET', headers: { authorization: 'Bearer nope' } }));
    ok('wrong secret -> 401', wrong.statusCode === 401, `${wrong.statusCode}`);
    ok('refused calls touched the database not at all and wrote no heartbeat', spy.calls.supabase === sbBefore && (await hbRows()).length === hbBefore);

    const patch = (id, body, cookie = staffCookie) => callRoute('admin.js', req({ method: 'PATCH', query: { table: 'internal_contacts', id }, body, cookies: { dh_retailer_session: cookie } }));
    const bad1 = await patch(C1, { notification_prefs: { on_confirmed: true, reminders: ['2w'] } });
    ok('admin PATCH with an unknown offset -> 400 invalid_notification_prefs', bad1.statusCode === 400 && /invalid_notification_prefs/.test(String(bad1.body)), `${bad1.statusCode} ${String(bad1.body).slice(0, 120)}`);
    const bad1b = await patch(C1, { notification_prefs: { reminders: ['1d'] } });
    ok('admin PATCH with a legacy offset spelling -> 400 (vocabulary is w1/d3/d1/d<N>/morning_of/h1)', bad1b.statusCode === 400, `${bad1b.statusCode}`);
    const bad2 = await patch(C1, { notification_prefs: { on_confirmed: 'yes' } });
    ok('admin PATCH with a non-boolean flag -> 400', bad2.statusCode === 400 && /invalid_notification_prefs/.test(String(bad2.body)), `${bad2.statusCode}`);
    const bad3 = await patch(C1, { notification_prefs: { custom_days: 45 } });
    ok('admin PATCH with custom_days 45 -> 400', bad3.statusCode === 400 && /invalid_notification_prefs/.test(String(bad3.body)), `${bad3.statusCode}`);
    const good = await patch(C1, { notification_prefs: { on_confirmed: true, on_cancelled: true, on_rescheduled: false, reminders: ['w1', 'h1', 'd1'], custom_days: 12 } });
    ok('admin PATCH with a valid shape -> 2xx', good.statusCode >= 200 && good.statusCode < 300, `${good.statusCode} ${String(good.body).slice(0, 120)}`);
    const saved = one(await db(`internal_contacts?id=eq.${C1}&select=notification_prefs`));
    ok('the prefs were persisted NORMALIZED: custom 12 folded into reminders as d12, sorted, no custom_days key', saved && saved.notification_prefs && sameJson(saved.notification_prefs, { on_confirmed: true, on_cancelled: true, on_rescheduled: false, reminders: ['d12', 'w1', 'd1', 'h1'] }), JSON.stringify(saved));
    const dup = await patch(C1, { notification_prefs: { reminders: ['d1', 'd1'], custom_days: 1 } });
    const saved2 = one(await db(`internal_contacts?id=eq.${C1}&select=notification_prefs`));
    ok('equivalent offsets collapse on write: d1 + d1 + custom 1 -> ["d1"]', dup.statusCode < 300 && saved2 && JSON.stringify(saved2.notification_prefs.reminders) === JSON.stringify(['d1']), JSON.stringify(saved2));

    // Bulk apply scope: the UI only iterates this retailer's contacts, and the server refuses a
    // cross-tenant write anyway.
    const cross = await patch(CX, { notification_prefs: DEFAULTS });
    ok('a staff PATCH on ANOTHER retailer\'s store contact is refused (403/404), so bulk apply cannot cross tenants', cross.statusCode === 403 || cross.statusCode === 404, `${cross.statusCode} ${String(cross.body).slice(0, 120)}`);
    const cxSaved = one(await db(`internal_contacts?id=eq.${CX}&select=notification_prefs`));
    ok('the other retailer\'s contact is unchanged', cxSaved && sameJson(cxSaved.notification_prefs, DEFAULTS), JSON.stringify(cxSaved));

    const tzBad = await callRoute('admin.js', req({ method: 'PATCH', query: { table: 'retailers', id: retailerId }, body: { timezone: 'PST' }, cookies: { dh_retailer_session: staffCookie } }));
    ok('retailers.timezone: an invalid zone is refused (400 invalid_timezone)', tzBad.statusCode === 400 && /invalid_timezone/.test(String(tzBad.body)), `${tzBad.statusCode} ${String(tzBad.body).slice(0, 120)}`);
    const tzOk = await callRoute('admin.js', req({ method: 'PATCH', query: { table: 'retailers', id: retailerId }, body: { timezone: 'America/New_York' }, cookies: { dh_retailer_session: staffCookie } }));
    ok('retailers.timezone: a valid IANA zone is accepted', tzOk.statusCode >= 200 && tzOk.statusCode < 300 && one(await db(`retailers?id=eq.${retailerId}&select=timezone`)).timezone === 'America/New_York', `${tzOk.statusCode}`);
  }

  // =========================================================================
  console.log('\n— 7: rendered samples (redacted) — the staging journey cannot be run (no deployed staging site) —');
  // =========================================================================
  {
    const show = (label, m) => {
      if (!m) { console.log(`  (no ${label} sample captured)`); return; }
      console.log(`\n  ===== ${label} =====\n  SUBJECT: ${redact(subj(m))}\n  TO: ${JSON.stringify(m.to)}\n  BODY (text):\n` + redact(textOf(m.html)).split('\n').map(l => '    ' + l).join('\n'));
    };
    show('CONFIRMED (to C1)', confirmedSample);
    show('REMINDER d3 (to C1)', reminderSample);
    ok('samples captured for the report', !!confirmedSample && !!reminderSample);
  }
} finally {
  console.log('\n— teardown —');
  for (const gid of [...new Set(groups)]) {
    const allocs = (await db(`payment_allocations?payment_group_id=eq.${gid}&select=id`)).body || [];
    for (const a of allocs) {
      const reqs = (await db(`refund_requests?payment_allocation_id=eq.${a.id}&select=id`)).body || [];
      for (const rq of reqs) await db(`reconciliation_cases?refund_request_id=eq.${rq.id}`, { method: 'DELETE' });
      await db(`refund_requests?payment_allocation_id=eq.${a.id}`, { method: 'DELETE' });
      await db(`refund_operations?payment_allocation_id=eq.${a.id}`, { method: 'DELETE' });
    }
    await db(`booking_fulfillments?payment_group_id=eq.${gid}`, { method: 'DELETE' });
    await db(`reconciliation_cases?payment_group_id=eq.${gid}`, { method: 'DELETE' });
    await db(`payment_attempts?payment_group_id=eq.${gid}`, { method: 'DELETE' });
    await db(`payment_allocations?payment_group_id=eq.${gid}`, { method: 'DELETE' });
    await db(`payment_groups?id=eq.${gid}`, { method: 'DELETE' });
  }
  for (const [t, id] of bin) {
    if (t !== 'bookings') continue;
    await db(`notification_deliveries?booking_id=eq.${id}`, { method: 'DELETE' });
    await db(`notification_events?booking_id=eq.${id}`, { method: 'DELETE' });
    await db(`demos?booking_id=eq.${id}`, { method: 'DELETE' });
    await db(`booking_fulfillments?booking_id=eq.${id}`, { method: 'DELETE' });
  }
  for (const [t, id] of bin.reverse()) await db(`${t}?id=eq.${id}`, { method: 'DELETE' });
  await db(`cron_heartbeat?cron_name=eq.notification-worker&ran_at=gte.${encodeURIComponent(startIso)}`, { method: 'DELETE' });
  spy.restore();
}
process.exit(summary('store contact notifications') ? 0 : 1);
