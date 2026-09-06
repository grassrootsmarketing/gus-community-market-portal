// tests/store_contact_notifications.test.mjs — store contacts (internal_contacts) hear about a demo
// when it is CONFIRMED, get reminders before it, and are told when it is cancelled or rescheduled.
// Never when a brand merely books or pays.
//
// Every assertion goes through a REAL exported handler against the real test database
// (tests/_route.mjs; Stripe and Resend spied). Mail is contained: every recipient is the sink, and a
// message's intended recipient is read off the containment banner in its body.
//
// Fixtures: retailer R (America/Los_Angeles, manual confirm) with venues V1, V2; store contacts
//   C1  V1 only, new-contact defaults (confirmed/cancelled/rescheduled ON, reminders 3d + 1d + morning_of)
//   C2  every venue, reminders ['1h'] only, on_cancelled OFF
//   C3  V2 only, defaults (must never hear about a V1 demo)
// a brand with an approved COI, and one paid booking at V1 driven through /api/book -> /api/checkout
// -> a signed checkout.session.completed -> /api/booking-action confirm.
//
// Reminders are proven by walking the cron (api/demo-reminders.js) through its `?now=` override —
// allowed only with CRON_SECRET and a non-production binding (the harness is VERCEL_ENV=preview).
//
// Run from the repository root with test-database creds:  node tests/store_contact_notifications.test.mjs
import { createHmac } from 'node:crypto';
import { installSpy, callRoute, req, rawReq, ok, summary, uniq, ENV } from './_route.mjs';
import { demoStartUtc, reminderSendAt, slotKey, dateLabel } from '../api/_local-time.js';
import { notifyStoreContactsConfirmed } from '../api/_staff-mail.js';
import { getBinding } from '../api/_env.js';

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

const spy = installSpy();
// Mail helpers: a message is "to" a contact when the containment banner names that address.
const mailsSince = (n) => spy.calls.resend.slice(n);
const toContact = (m, email) => String(m.html || '').includes(email);
const subj = (m) => String(m.subject || '');
const staffMails = (mails, phrase) => mails.filter(m => subj(m).includes(phrase));
const anyToContacts = (mails, emails) => mails.filter(m => emails.some(e => toContact(m, e)));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const slug = uniq('nt');
const retailerId = track('retailers', one(await db('retailers', { method: 'POST', body: JSON.stringify({
  slug, name: 'Notify Fixture Market', billing_email: `${slug}@fixture.test`, billing_tier: 'pro', billing_status: 'active',
  platform_keeps_all: true, timezone: LA, auto_confirm_bookings: false, cancellation_mode: 'refundable' }) })).id);
const V1 = track('venues', one(await db('venues', { method: 'POST', body: JSON.stringify({ retailer_id: retailerId, name: 'Notify Main', address: '12 Notify Ave, Portland, OR', demo_fee: 30 }) })).id);
const V2 = track('venues', one(await db('venues', { method: 'POST', body: JSON.stringify({ retailer_id: retailerId, name: 'Notify Annex', address: '99 Annex Rd', demo_fee: 30 }) })).id);

const staffEmail = `staff-${slug}@fixture.test`;
track('retailer_admins', one(await db('retailer_admins', { method: 'POST', body: JSON.stringify({ retailer_id: retailerId, email: staffEmail, email_normalized: staffEmail, name: 'Notify Staff', role: 'admin' }) })).id);
const staffTok = one(await db('admin_tokens', { method: 'POST', body: JSON.stringify({ email: staffEmail, retailer_id: retailerId }) }));
const staffCookie = (await callRoute('admin-auth.js', req({ body: { action: 'verify', token: staffTok.token } }))).cookie('dh_retailer_session');

const C1e = `c1-${slug}@fixture.test`, C2e = `c2-${slug}@fixture.test`, C3e = `c3-${slug}@fixture.test`;
const DEFAULTS = { on_confirmed: true, on_cancelled: true, on_rescheduled: true, reminders: ['3d', '1d', 'morning_of'], custom_days: null };
const mkContact = async (name, email, venue_ids, prefs) => track('internal_contacts', one(await db('internal_contacts', { method: 'POST', body: JSON.stringify({ retailer_id: retailerId, name, role: 'Store lead', email, venue_ids, notification_prefs: prefs }) })).id);
const C1 = await mkContact('Contact One', C1e, [V1], DEFAULTS);
const C2 = await mkContact('Contact Two', C2e, [], { on_confirmed: true, on_cancelled: false, on_rescheduled: true, reminders: ['1h'], custom_days: null });
const C3 = await mkContact('Contact Three', C3e, [V2], DEFAULTS);
const ALL = [C1e, C2e, C3e];

const brandEmail = `${uniq('brand')}@fixture.test`;
const brandId = track('brands', one(await db('brands', { method: 'POST', body: JSON.stringify({
  email: brandEmail, company_name: 'Notify Brand Co', contact_name: 'Rep Person', phone: '555-0199', is_verified: true,
  default_coi_url: 'brands/notify.pdf', default_coi_expires: dayP(400), coi_verification_status: 'approved', needs_electricity: true }) })).id);
const brandTok = one(await db('brand_account_tokens', { method: 'POST', body: JSON.stringify({ brand_id: brandId, email: brandEmail, token: 'tk-' + uniq('n'), expires_at: new Date(Date.now() + 36e5).toISOString() }) }));
const brandCookie = (await callRoute('brand-account.js', req({ body: { action: 'verify', token: brandTok.token } }))).cookie('dh_brand_session');

const D = dayP(20), T = '11:00 AM';
const groups = [];
let bookingId = null, demoId = null;

const notifRows = async (filter = '') => (await db(`demo_notifications?booking_id=eq.${bookingId}&select=contact_id,kind,sent_at,claimed_at${filter}&order=claimed_at.asc`)).body || [];
const hbRows = async () => (await db(`cron_heartbeat?cron_name=eq.demo-reminders&ran_at=gte.${encodeURIComponent(startIso)}&select=outcome,summary&order=ran_at.asc`)).body || [];
const runCron = (nowIso, extra = {}) => callRoute('demo-reminders.js', req({ method: 'GET', query: nowIso ? { now: nowIso } : {}, headers: CRON, ...extra }));

try {
  ok('fixtures: staff and brand sessions exist', !!staffCookie && !!brandCookie);
  ok('fixtures: three store contacts exist', !!C1 && !!C2 && !!C3);

  // =========================================================================
  console.log('\n— 1: booking and paying send NOTHING to store contacts —');
  // =========================================================================
  {
    const n0 = spy.calls.resend.length;
    const bk = await callRoute('book.js', req({
      body: { retailer_slug: slug, venue_id: V1, demo_date: D, demo_time: T, product: 'Sparkling Yerba',
              product_skus: [{ name: 'Lime Fizz', size: '12 oz', sku: 'LF-12' }, { name: 'Berry Fizz', size: '12 oz', sku: 'BF-12' }] },
      cookies: { dh_brand_session: brandCookie } }));
    bookingId = bk.body && (bk.body.booking_id || bk.body.id || (bk.body.booking && bk.body.booking.id));
    if (bookingId) track('bookings', bookingId);
    ok('a booking was created through /api/book', bk.statusCode === 200 && !!bookingId, `${bk.statusCode} ${JSON.stringify(bk.body).slice(0, 200)}`);
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
    const row = one(await db(`bookings?id=eq.${bookingId}&select=status,payment_status`));
    ok('the booking is paid and PENDING (manual-confirm retailer)', row && row.payment_status === 'paid' && row.status === 'pending', JSON.stringify(row));
    const payMails = mailsSince(n1);
    ok('payment emailed the brand', payMails.some(m => subj(m).includes('Your demo booking at')), JSON.stringify(payMails.map(subj)));
    ok('payment emailed NO store contact', anyToContacts(payMails, ALL).length === 0 && staffMails(payMails, 'Demo confirmed').length === 0, JSON.stringify(payMails.map(subj)));
    ok('no demo_notifications row exists before confirmation', (await notifRows()).length === 0);
  }

  // =========================================================================
  console.log('\n— 2: confirming sends "Demo confirmed" to C1 and C2 (not C3), exactly once —');
  // =========================================================================
  {
    const n0 = spy.calls.resend.length;
    const c = await callRoute('booking-action.js', req({ body: { booking_id: bookingId, action: 'confirm' }, cookies: { dh_retailer_session: staffCookie } }));
    ok('confirm succeeds', c.statusCode === 200 && c.body && c.body.ok === true, `${c.statusCode} ${JSON.stringify(c.body).slice(0, 200)}`);
    demoId = c.body && c.body.demo_id;
    if (demoId) track('demos', demoId);
    const mails = mailsSince(n0);
    const conf = staffMails(mails, 'Demo confirmed:');
    ok('exactly TWO "Demo confirmed" notices went out', conf.length === 2, JSON.stringify(mails.map(subj)));
    ok('C1 (V1 scope) got one', conf.filter(m => toContact(m, C1e)).length === 1);
    ok('C2 (all venues) got one', conf.filter(m => toContact(m, C2e)).length === 1);
    ok('C3 (V2 only) got none', !mails.some(m => toContact(m, C3e)));
    ok('every recipient is the contained sink', mails.every(m => [].concat(m.to).every(a => a === 'sink@fixture.test')));
    const m = conf[0] || { html: '', subject: '' };
    ok('subject: Demo confirmed: <brand> at <location> — <Weekday, Month D>', subj(m) === `[SINK] Demo confirmed: Notify Brand Co at Notify Main — ${dateLabel(D)}`, subj(m));
    const body = String(m.html);
    ok('body has the date', body.includes(dateLabel(D, { year: true })));
    ok('body has the time in the retailer zone', /11:00\s?AM P[DS]T/.test(body), body.match(/11:00[^<]{0,12}/) && body.match(/11:00[^<]{0,12}/)[0]);
    ok('body has the location name and address', body.includes('Notify Main') && body.includes('12 Notify Ave, Portland, OR'));
    ok('body has the brand and product', body.includes('Notify Brand Co') && body.includes('Sparkling Yerba'));
    ok('body lists every SKU (name, size, sku)', body.includes('Lime Fizz') && body.includes('Berry Fizz') && body.includes('LF-12') && body.includes('BF-12') && body.includes('12 oz'));
    ok('body has the electricity line: Yes', /Needs electricity<\/td>[\s\S]{0,200}?<strong>Yes<\/strong>/.test(body));
    ok('body has the brand rep name and phone', body.includes('Rep Person') && body.includes('555-0199'));
    const rows = await notifRows('&kind=eq.confirmed');
    ok('demo_notifications has exactly two sent "confirmed" rows (C1, C2)', rows.length === 2 && rows.every(r => !!r.sent_at) && new Set(rows.map(r => r.contact_id)).size === 2 && rows.every(r => [C1, C2].includes(r.contact_id)), JSON.stringify(rows));

    // Replay: a second confirm through the route is refused by state; the notifier itself (what the
    // auto-confirm outbox would re-run on retry) must send nothing more.
    const n1 = spy.calls.resend.length;
    const again = await callRoute('booking-action.js', req({ body: { booking_id: bookingId, action: 'confirm' }, cookies: { dh_retailer_session: staffCookie } }));
    ok('a second confirm call is refused (already confirmed)', again.statusCode === 409, `${again.statusCode}`);
    const b = await getBinding();
    const replay = await notifyStoreContactsConfirmed(b, bookingId);
    ok('re-running the confirmed notifier targets 2, sends 0, skips 2 (idempotent)', replay.targeted === 2 && replay.sent === 0 && replay.skipped === 2 && replay.failed === 0, JSON.stringify(replay));
    ok('the replay produced no email', spy.calls.resend.length === n1, `${n1} -> ${spy.calls.resend.length}`);
    ok('still exactly two confirmed rows', (await notifRows('&kind=eq.confirmed')).length === 2);
  }

  // =========================================================================
  console.log('\n— 3: reminders fire at the right local instant, once, never after the start —');
  // =========================================================================
  const start = demoStartUtc(D, T, LA);
  const s3d = reminderSendAt('3d', D, T, LA), s1d = reminderSendAt('1d', D, T, LA), sMorn = reminderSendAt('morning_of', D, T, LA), s1h = reminderSendAt('1h', D, T, LA);
  const slot = slotKey(D, T);
  const at = (d, ms = 0) => new Date(d.getTime() + ms).toISOString();
  {
    ok('sanity: 1d reminder is 09:00 local the day before (16:00Z PDT / 17:00Z PST)', /T1[67]:00:00\.000Z$/.test(s1d.toISOString()) && s1d < start, s1d.toISOString());
    ok('sanity: morning_of is 07:00 local on the demo day', /T1[45]:00:00\.000Z$/.test(sMorn.toISOString()) && sMorn.toISOString().slice(0, 10) >= D, sMorn.toISOString());

    let n = spy.calls.resend.length;
    let r = await runCron(at(s3d, -60000));
    ok('one minute before the 3d slot: nothing is due', r.statusCode === 200 && r.body.sent === 0 && r.body.due === 0, JSON.stringify(r.body));
    ok('...and nothing was emailed', spy.calls.resend.length === n);

    n = spy.calls.resend.length;
    r = await runCron(at(s3d));
    ok('at the 3d slot: exactly one reminder sent', r.statusCode === 200 && r.body.sent === 1, JSON.stringify(r.body));
    let mails = mailsSince(n);
    ok('it is "Demo in 3 days" to C1 only', mails.length === 1 && subj(mails[0]).includes('Demo in 3 days:') && toContact(mails[0], C1e), JSON.stringify(mails.map(subj)));
    ok('the reminder body carries the SKUs and electricity line too', /Lime Fizz/.test(mails[0].html) && /Needs electricity/.test(mails[0].html));
    n = spy.calls.resend.length;
    r = await runCron(at(s3d, 5 * 60000));
    ok('a second run in the same window sends nothing (idempotent)', r.statusCode === 200 && r.body.sent === 0 && r.body.skipped === 1 && spy.calls.resend.length === n, JSON.stringify(r.body));

    n = spy.calls.resend.length;
    r = await runCron(at(s1d, -60000));
    ok('one minute before 09:00 the day before: 1d not yet due', r.statusCode === 200 && r.body.sent === 0 && spy.calls.resend.length === n, JSON.stringify(r.body));
    r = await runCron(at(s1d));
    mails = mailsSince(n);
    ok('at 09:00 local the day before: "Demo tomorrow" to C1 exactly once', r.body.sent === 1 && mails.length === 1 && subj(mails[0]).includes('Demo tomorrow:') && toContact(mails[0], C1e), JSON.stringify(mails.map(subj)));
    ok('C2 (1h only) got nothing at the 1d slot', !mails.some(m => toContact(m, C2e)));
    n = spy.calls.resend.length;
    r = await runCron(at(s1d, 60000));
    ok('re-run a minute later: nothing more', r.body.sent === 0 && spy.calls.resend.length === n, JSON.stringify(r.body));

    n = spy.calls.resend.length;
    r = await runCron(at(sMorn));
    mails = mailsSince(n);
    ok('at 07:00 local on the demo day: "Demo today" to C1 exactly once (the 1d, still in grace, is not re-sent)', r.body.sent === 1 && mails.length === 1 && subj(mails[0]).includes('Demo today:') && toContact(mails[0], C1e), JSON.stringify({ body: r.body, subjects: mails.map(subj) }));

    n = spy.calls.resend.length;
    r = await runCron(at(s1h, -60000));
    ok('61 minutes before the start: the 1h reminder is not due', r.body.sent === 0 && spy.calls.resend.length === n, JSON.stringify(r.body));
    r = await runCron(at(s1h));
    mails = mailsSince(n);
    ok('60 minutes before the start: "Demo in 1 hour" to C2 exactly once', r.body.sent === 1 && mails.length === 1 && subj(mails[0]).includes('Demo in 1 hour:') && toContact(mails[0], C2e), JSON.stringify(mails.map(subj)));
    ok('C1 (no 1h) and C3 got nothing', !mails.some(m => toContact(m, C1e) || toContact(m, C3e)));
    n = spy.calls.resend.length;
    r = await runCron(at(s1h, 60000));
    ok('re-run: the 1h reminder is not sent twice', r.body.sent === 0 && spy.calls.resend.length === n, JSON.stringify(r.body));

    n = spy.calls.resend.length;
    r = await runCron(at(start, 60000));
    ok('after the demo has started: nothing fires', r.statusCode === 200 && r.body.sent === 0 && r.body.due === 0 && spy.calls.resend.length === n, JSON.stringify(r.body));

    const rem = await notifRows('&kind=like.reminder*');
    const kinds = rem.map(x => `${x.contact_id === C1 ? 'C1' : x.contact_id === C2 ? 'C2' : '?'}:${x.kind}`).sort();
    ok('demo_notifications holds exactly the four reminder rows, keyed by kind@slot', JSON.stringify(kinds) === JSON.stringify([`C1:reminder:1d@${slot}`, `C1:reminder:3d@${slot}`, `C1:reminder:morning_of@${slot}`, `C2:reminder:1h@${slot}`].sort()) && rem.every(x => !!x.sent_at), JSON.stringify(kinds));
    const hb = await hbRows();
    ok('every cron run so far wrote a "succeeded" heartbeat', hb.length >= 10 && hb.every(h => h.outcome === 'succeeded'), JSON.stringify(hb.map(h => h.outcome)));
  }

  // =========================================================================
  console.log('\n— 4: reschedule -> "Demo rescheduled" to C1 + C2; reminders follow the NEW date —');
  // =========================================================================
  const D2 = dayP(30), T2 = '2:00 PM';
  {
    const prop = await callRoute('booking-action.js', req({ body: { action: 'reschedule', demo_id: demoId, new_date: D2, new_time: T2 }, cookies: { dh_retailer_session: staffCookie } }));
    ok('the retailer proposed a new date', prop.statusCode === 200, `${prop.statusCode} ${JSON.stringify(prop.body).slice(0, 160)}`);
    const n0 = spy.calls.resend.length;
    const acc = await callRoute('brand-account.js', req({ body: { action: 'reschedule-respond', demo_id: demoId, decision: 'accept' }, cookies: { dh_brand_session: brandCookie } }));
    // brand-account.js answers through res.end(json), which the harness mockRes does not capture — the
    // status code plus the moved demos row (asserted below) are the evidence.
    ok('the brand accepted', acc.statusCode === 200, `${acc.statusCode}`);
    const mails = mailsSince(n0);
    const resc = staffMails(mails, 'Demo rescheduled:');
    ok('exactly two "Demo rescheduled" notices: C1 and C2', resc.length === 2 && resc.some(m => toContact(m, C1e)) && resc.some(m => toContact(m, C2e)), JSON.stringify(mails.map(subj)));
    ok('C3 heard nothing', !mails.some(m => toContact(m, C3e)));
    const m = resc[0] || { html: '' };
    ok('the notice shows the old and the new date/time', String(m.html).includes(dateLabel(D, { year: true })) && String(m.html).includes(dateLabel(D2, { year: true })) && /2:00\s?PM/.test(String(m.html)) && /11:00\s?AM/.test(String(m.html)));
    ok('subject names the NEW date', subj(m).includes(`— now ${dateLabel(D2)}`), subj(m));
    const demoRow = one(await db(`demos?id=eq.${demoId}&select=demo_date,demo_time,status`));
    ok('the demos row moved', demoRow && demoRow.demo_date === D2 && demoRow.demo_time === T2 && demoRow.status === 'confirmed', JSON.stringify(demoRow));

    // Old-slot reminders do not fire: at the OLD date's 1d instant nothing is due for the new slot.
    let n = spy.calls.resend.length;
    let r = await runCron(at(s1d));
    ok('at the OLD 1d instant nothing fires for the moved demo', r.statusCode === 200 && r.body.sent === 0 && r.body.due === 0 && spy.calls.resend.length === n, JSON.stringify(r.body));

    // Send failure -> failed heartbeat + 500, claim released; the next clean run sends.
    const s3d2 = reminderSendAt('3d', D2, T2, LA);
    const slot2 = slotKey(D2, T2);
    n = spy.calls.resend.length;
    spy.faults.push({ url: 'api.resend.com', method: 'POST', status: 500, message: 'injected_resend_fault' });
    r = await runCron(at(s3d2));
    spy.faults.length = 0;
    ok('a failed send -> 500 partial_failure with failed:1', r.statusCode === 500 && r.body && r.body.ok === false && r.body.error === 'partial_failure' && r.body.failed === 1 && r.body.sent === 0, `${r.statusCode} ${JSON.stringify(r.body)}`);
    ok('the provider was attempted exactly once', spy.calls.resend.length === n + 1);
    let hb = await hbRows();
    ok("the heartbeat row is 'failed' with partial:true and a first_error", hb.length && hb[hb.length - 1].outcome === 'failed' && hb[hb.length - 1].summary && hb[hb.length - 1].summary.partial === true && /send: 3d/.test(String(hb[hb.length - 1].summary.first_error)), JSON.stringify(hb[hb.length - 1]));
    let claim = await notifRows(`&kind=eq.${encodeURIComponent('reminder:3d@' + slot2)}`);
    ok('the failed send left NO claim behind (released for retry)', claim.length === 0, JSON.stringify(claim));
    n = spy.calls.resend.length;
    r = await runCron(at(s3d2, 60000));
    const mails2 = mailsSince(n);
    ok('the next clean run sends the 3d reminder for the NEW date to C1', r.statusCode === 200 && r.body.sent === 1 && mails2.length === 1 && subj(mails2[0]).includes('Demo in 3 days:') && toContact(mails2[0], C1e) && subj(mails2[0]).includes(dateLabel(D2)), JSON.stringify({ body: r.body, subjects: mails2.map(subj) }));
    claim = await notifRows(`&kind=eq.${encodeURIComponent('reminder:3d@' + slot2)}`);
    ok('the reminder row now exists with sent_at set, keyed to the new slot', claim.length === 1 && !!claim[0].sent_at, JSON.stringify(claim));
    hb = await hbRows();
    ok("the recovery run wrote 'succeeded'", hb[hb.length - 1].outcome === 'succeeded');

    // The new date's 1d reminder is a NEW key — the old date's 1d row does not suppress it.
    const s1d2 = reminderSendAt('1d', D2, T2, LA);
    n = spy.calls.resend.length;
    r = await runCron(at(s1d2));
    const mails3 = mailsSince(n);
    ok('"Demo tomorrow" fires again for the NEW date (fresh key after reschedule)', r.body.sent === 1 && mails3.length === 1 && subj(mails3[0]).includes('Demo tomorrow:') && toContact(mails3[0], C1e) && /2:00\s?PM/.test(mails3[0].html), JSON.stringify({ body: r.body, subjects: mails3.map(subj) }));
    const both = await notifRows('&kind=like.reminder:1d*');
    ok('two distinct 1d rows exist: one per slot', both.length === 2 && new Set(both.map(x => x.kind)).size === 2, JSON.stringify(both.map(x => x.kind)));
  }

  // =========================================================================
  console.log('\n— 5: cancel -> "Demo cancelled" to C1 (on_cancelled) but not C2 (off) or C3 —');
  // =========================================================================
  {
    const n0 = spy.calls.resend.length;
    const cx = await callRoute('booking-action.js', req({ body: { booking_id: bookingId, action: 'cancel', force_refund: true, reason: 'Store closed for inventory' }, cookies: { dh_retailer_session: staffCookie } }));
    ok('cancel succeeds', cx.statusCode === 200 && cx.body && cx.body.ok === true, `${cx.statusCode} ${JSON.stringify(cx.body).slice(0, 200)}`);
    const mails = mailsSince(n0);
    const canc = staffMails(mails, 'Demo cancelled:');
    ok('exactly one "Demo cancelled" notice, to C1', canc.length === 1 && toContact(canc[0], C1e), JSON.stringify(mails.map(subj)));
    ok('C2 (on_cancelled false) and C3 (other venue) got nothing', !mails.some(m => toContact(m, C2e) || toContact(m, C3e)));
    ok('the notice carries the reason', /Store closed for inventory/.test(canc[0] ? canc[0].html : ''));
    ok('the brand still got its own cancellation email', mails.some(m => subj(m).includes('was cancelled') && !subj(m).includes('Demo cancelled:')), JSON.stringify(mails.map(subj)));
    const rows = await notifRows('&kind=eq.cancelled');
    ok('one sent "cancelled" row for C1', rows.length === 1 && rows[0].contact_id === C1 && !!rows[0].sent_at, JSON.stringify(rows));

    const n1 = spy.calls.resend.length;
    const r = await runCron(at(reminderSendAt('morning_of', D2, T2, LA)));
    ok('a cancelled demo gets no further reminders', r.statusCode === 200 && r.body.sent === 0 && r.body.due === 0 && spy.calls.resend.length === n1, JSON.stringify(r.body));
  }

  // =========================================================================
  console.log('\n— 6: cron auth and the admin write guard —');
  // =========================================================================
  {
    const hbBefore = (await hbRows()).length;
    const sbBefore = spy.calls.supabase;
    const none = await callRoute('demo-reminders.js', req({ method: 'GET', query: { now: at(s1d) } }));
    ok('no Authorization -> 401', none.statusCode === 401 && none.body && none.body.error === 'unauthorized', `${none.statusCode}`);
    const wrong = await callRoute('demo-reminders.js', req({ method: 'GET', headers: { authorization: 'Bearer nope' } }));
    ok('wrong secret -> 401', wrong.statusCode === 401, `${wrong.statusCode}`);
    ok('refused calls touched the database not at all and wrote no heartbeat', spy.calls.supabase === sbBefore && (await hbRows()).length === hbBefore);
    const badNow = await runCron('not-a-date');
    ok('an unparseable ?now= is refused with 400', badNow.statusCode === 400 && badNow.body && badNow.body.error === 'invalid_now', `${badNow.statusCode}`);

    const patch = (body) => callRoute('admin.js', req({ method: 'PATCH', query: { table: 'internal_contacts', id: C1 }, body, cookies: { dh_retailer_session: staffCookie } }));
    const bad1 = await patch({ notification_prefs: { on_confirmed: true, reminders: ['2w'] } });
    ok('admin PATCH with an unknown reminder -> 400 invalid_notification_prefs', bad1.statusCode === 400 && /invalid_notification_prefs/.test(String(bad1.body)), `${bad1.statusCode} ${String(bad1.body).slice(0, 120)}`);
    const bad2 = await patch({ notification_prefs: { on_confirmed: 'yes' } });
    ok('admin PATCH with a non-boolean flag -> 400', bad2.statusCode === 400 && /invalid_notification_prefs/.test(String(bad2.body)), `${bad2.statusCode}`);
    const bad3 = await patch({ notification_prefs: { custom_days: 45 } });
    ok('admin PATCH with custom_days 45 -> 400', bad3.statusCode === 400 && /invalid_notification_prefs/.test(String(bad3.body)), `${bad3.statusCode}`);
    const good = await patch({ notification_prefs: { on_confirmed: true, on_cancelled: true, on_rescheduled: false, reminders: ['1w', '1h'], custom_days: 12 } });
    ok('admin PATCH with the stored shape -> 2xx', good.statusCode >= 200 && good.statusCode < 300, `${good.statusCode} ${String(good.body).slice(0, 120)}`);
    const saved = one(await db(`internal_contacts?id=eq.${C1}&select=notification_prefs`));
    ok('the prefs were persisted as sent', saved && saved.notification_prefs && saved.notification_prefs.custom_days === 12 && JSON.stringify(saved.notification_prefs.reminders) === JSON.stringify(['1w', '1h']), JSON.stringify(saved));
  }
} finally {
  console.log('\n— teardown —');
  // FK-safe ledger cleanup first (mirrors cron_heartbeats.test.mjs), then tracked fixtures newest-first.
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
  if (bookingId) {
    await db(`demo_notifications?booking_id=eq.${bookingId}`, { method: 'DELETE' });
    await db(`demos?booking_id=eq.${bookingId}`, { method: 'DELETE' });
    await db(`booking_fulfillments?booking_id=eq.${bookingId}`, { method: 'DELETE' });
  }
  for (const [t, id] of bin.reverse()) await db(`${t}?id=eq.${id}`, { method: 'DELETE' });
  await db(`cron_heartbeat?cron_name=eq.demo-reminders&ran_at=gte.${encodeURIComponent(startIso)}`, { method: 'DELETE' });
  spy.restore();
}
process.exit(summary('store contact notifications') ? 0 : 1);
