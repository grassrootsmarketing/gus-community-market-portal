// tests/payment_receipts.test.mjs :: brand payment receipts (0091 + api/_notification-outbox.js RECEIPT_KINDS,
// api/_notification-mail.js receiptMessage, api/brand-account.js 'data'.payments + 'receipt-resend').
//
// Real test database + the outbox functions in-process with a recording mailer (exact provider request,
// headers included) and a stubbed Stripe charge lookup. Writes financial tables through the shipped
// ledger RPCs (checkout_claim_group / register_payment_attempt / apply_verified_payment), so it carries
// the same safety gate as the ledger suites: LEDGER_TARGET_REF + ALLOW_STAGING_LEDGER_TESTS=yes.
//
//   R1  the ledger apply writes exactly ONE payment_receipt event per payment group (transition_id = the
//       group id), carrying the verified amount; a webhook replay (idempotent apply) writes no second event;
//       an abandoned checkout (group claimed, never paid) writes nothing.
//   R2  fan-out: one delivery per brand account contact, recipient_kind 'brand', retailer_id carried,
//       booking_id NULL, stable dedupe key; a second fan-out inserts nothing.
//   R3  dispatch: the receipt lists the LEDGER total and every demo the payment covered (date, venue,
//       per-demo amount), the store, the card summary and Stripe link from the charge lookup, the paid
//       date; provider key = delivery id; frozen payload; one provider call.
//   R4  a refunded group still receives its receipt (the payment happened); a missing group is skipped.
//   R5  portal: 'data' lists the payment with its demos and a RECORDED paid date; 'receipt-resend' queues a
//       copy (event '<gid>:resend:<ms>' with the requesting contact recorded), refuses a foreign group (404),
//       a non-contact session (403), throttles a repeat (429); the copy fans out to the REQUESTER ONLY and is
//       delivered through the same path with the "copy" framing (Codex PR-4 / PR-6).
//   R6  concurrency: 20 simultaneous resend requests for one payment yield exactly ONE event; the rest are
//       throttled with a consistent answer (0092 advisory lock + database-time cooldown).
//
// Run from the repository root with test-database creds + ledger opt-in:
//   LEDGER_TARGET_REF=<ref> ALLOW_STAGING_LEDGER_TESTS=yes node tests/payment_receipts.test.mjs
import crypto from 'node:crypto';
import { callRoute, req, ok, summary, uniq, ENV } from './_route.mjs';
import { HOURLY } from './_fixture_availability.mjs';
import { getBinding } from '../api/_env.js';
import { sendMail } from '../api/_mail.js';
import { fanOutEvents, claimDue, processClaimed, receiptHooks, RECEIPT_KINDS } from '../api/_notification-outbox.js';

ENV.NOTIFICATION_WORKER_ENABLED = 'true';
const SB_URL_RAW = process.env.SB_URL, KEY = process.env.SB_KEY;
{ // SAFETY GATE, identical policy to the ledger suites
  const host = (SB_URL_RAW || '').replace(/^https?:\/\//, '').split('.')[0];
  const die = (m) => { console.error('REFUSING TO RUN:', m); process.exit(2); };
  const allowed = (process.env.LEDGER_TARGET_REF || '').split(',').map(s => s.trim()).filter(Boolean);
  if (['ecapmcyumpjjgjwuokyv', 'eubbgurdwqmwqduamwhn', 'dkgjvsstbgnhcfboqqnd'].includes(host)) die('SB_URL points at a DENIED (production) project: ' + host);
  if (!allowed.length) die('LEDGER_TARGET_REF is not set');
  if (!allowed.includes(host)) die('SB_URL project ' + host + ' is not in LEDGER_TARGET_REF');
  if (process.env.ALLOW_STAGING_LEDGER_TESTS !== 'yes') die('ALLOW_STAGING_LEDGER_TESTS=yes is required');
  console.log('safety: target project ' + host + ' allowlisted, opt-in present\n');
}
const SB = SB_URL_RAW;
const H = { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json', Prefer: 'return=representation' };
const db = async (path, opts = {}) => {
  const r = await fetch(`${SB}/rest/v1/${path}`, { ...opts, headers: { ...H, ...(opts.headers || {}) } });
  const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch (_) {}
  return { ok: r.ok, status: r.status, body: j, text: t };
};
const rpc = (fn, args) => db(`rpc/${fn}`, { method: 'POST', body: JSON.stringify(args) });
const one = (r) => (r && Array.isArray(r.body) ? r.body[0] : (r && r.body && !Array.isArray(r.body) ? r.body : null));
const bin = [];
const track = (t, id) => { if (id) bin.push([t, id]); return id; };
const LA = 'America/Los_Angeles';
const RUN = uniq('rcpt');
const dayP = (n) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

function recordingMailer(b) {
  const calls = [];
  const fetchSpy = async (url, opts) => { calls.push({ url, headers: opts.headers, body: JSON.parse(opts.body) }); return { ok: true, status: 200, json: async () => ({ id: 'msg_' + calls.length }), text: async () => '{}' }; };
  return { mailer: (msg, opts) => sendMail(msg, { ...opts, binding: b, fetch: fetchSpy }), calls };
}
const keyOf = (call) => call.headers['Idempotency-Key'] || call.headers['idempotency-key'];

// Fixtures: a platform-keeps-all retailer with one venue at a $30 fee, one brand with a teammate.
const slug = uniq('rcp');
const retailerId = track('retailers', one(await db('retailers', { method: 'POST', body: JSON.stringify({ slug, name: 'Receipt Fixture Market', billing_email: `${slug}@fixture.test`, billing_tier: 'pro', billing_status: 'active', platform_keeps_all: true, timezone: LA, auto_confirm_bookings: false }) })).id);
track('settings', one(await db('settings', { method: 'POST', body: JSON.stringify({ retailer_id: retailerId, demo_fee: 30, demo_duration: '3 hours', advance_booking_days: 14 }) })).id);
const V1 = track('venues', one(await db('venues', { method: 'POST', body: JSON.stringify({ retailer_id: retailerId, name: 'Receipt Main Street', address: '1 Receipt Way', demo_fee: 30, availability: HOURLY }) })).id);
const brandEmail = `${uniq('rbrand')}@fixture.test`;
const brandId = track('brands', one(await db('brands', { method: 'POST', body: JSON.stringify({ email: brandEmail, company_name: 'Receipt Brand Co', contact_name: 'Rep R', phone: '555-0100' }) })).id);
const mateEmail = `${uniq('rmate')}@fixture.test`;
const mateId = track('brand_members', one(await db('brand_members', { method: 'POST', body: JSON.stringify({ brand_id: brandId, email: mateEmail, name: 'Mate R', role: 'member' }) })).id);
const otherBrandId = track('brands', one(await db('brands', { method: 'POST', body: JSON.stringify({ email: `${uniq('obrand')}@fixture.test`, company_name: 'Other Brand Co' }) })).id);
await callRoute('find-retailer.js', req({ body: { action: 'status' } }));
const b = await getBinding();

let hourN = 6;
async function booking(extra = {}) {
  const res = await db('bookings', { method: 'POST', body: JSON.stringify({
    retailer_id: retailerId, venue_id: V1, brand_id: brandId, brand_name: 'Receipt Brand Co', contact_name: 'Rep R', contact_phone: '555-0100', contact_email: brandEmail,
    product: 'Cold Brew', demo_date: dayP(20 + Math.floor(hourN / 16)), demo_time: `${6 + (hourN++ % 16)}:00`, status: 'pending_payment', payment_status: 'unpaid', ...extra }) });
  const row = one(res);
  if (!row) throw new Error('booking insert failed: ' + res.status + ' ' + JSON.stringify(res.body).slice(0, 300));
  track('bookings', row.id);
  return row;
}
const groups = [];
async function claimGroup(bookingIds) {
  const c = await rpc('checkout_claim_group', { p_brand_id: brandId, p_retailer_id: retailerId, p_booking_ids: bookingIds, p_platform_keeps_all: true, p_connect_account_id: null, p_platform_fee_cents: 0 });
  const r = one(c); if (!r || !r.payment_group_id) throw new Error('claim failed: ' + (c.text || '').slice(0, 200));
  groups.push(r.payment_group_id); return r;
}
let attN = 0;
async function attempt(gid) {
  const tag = `${RUN}_${attN++}`; const sess = `cs_${tag}`, pi = `pi_${tag}`, ch = `ch_${tag.replace(/[^A-Za-z0-9]/g, '')}`;
  const r = await rpc('register_payment_attempt', { p_group_id: gid, p_session_id: sess, p_payment_intent: pi, p_hash: 'h-' + tag, p_schema: 1 });
  if (!r.ok) throw new Error('attempt failed: ' + (r.text || '').slice(0, 200));
  return { sess, pi, ch };
}
const capture = (a, amount) => rpc('apply_verified_payment', { p_session_id: a.sess, p_payment_intent: a.pi, p_charge: a.ch, p_amount: amount, p_currency: 'usd', p_connect_dest: null, p_on_behalf_of: null, p_application_fee: null, p_transfer_id: null, p_fee_id: null });
const events = async (gid) => ((await db(`notification_events?kind=eq.payment_receipt&transition_id=like.${gid}*&select=*&order=created_at.asc`)).body || []);
const deliveries = async (gid) => ((await db(`notification_deliveries?kind=eq.payment_receipt&dedupe_key=like.payment_receipt:${gid}*&select=*&order=created_at.asc`)).body || []);
const fan = (now = new Date()) => fanOutEvents(b, { now });
async function claimMine(gid, now = new Date()) {
  const token = crypto.randomUUID();
  const rows = await claimDue(b, { now, batch: 50, claimToken: token });
  const mine = (rows || []).filter(r => r.kind === 'payment_receipt' && String(r.dedupe_key || '').startsWith('payment_receipt:' + gid));
  for (const r of (rows || [])) if (!mine.includes(r)) await db(`notification_deliveries?id=eq.${r.id}`, { method: 'PATCH', body: JSON.stringify({ claim_token: null, lease_until: null, status: r.status === 'claimed' ? 'pending' : r.status }) });
  return { rows: mine, token };
}
// Stubbed charge lookup: records what it was asked for and answers like Stripe would.
const lookups = [];
receiptHooks.chargeLookup = async (_b, chargeId) => { lookups.push(chargeId); return chargeId ? { card: { brand: 'visa', last4: '4242' }, receiptUrl: 'https://pay.stripe.com/receipts/test/' + chargeId } : null; };

try {
  ok('fixtures exist', !!retailerId && !!V1 && !!brandId && !!mateId && !!b && RECEIPT_KINDS.includes('payment_receipt'));

  console.log('\n:: R1 identity: one event per payment, from the verified ledger apply ::');
  const abandoned = await booking();
  const gA = await claimGroup([abandoned.id]);
  await attempt(gA.payment_group_id);
  ok('R1a a claimed-but-unpaid group writes NO receipt event', (await events(gA.payment_group_id)).length === 0);

  const b1 = await booking(), b2 = await booking();
  const g = await claimGroup([b1.id, b2.id]);
  const gid = g.payment_group_id;
  ok('R1b the group total is the ledger sum of two $30 demos', g.total_customer_amount === 6000, JSON.stringify(g));
  const a1 = await attempt(gid);
  const ap = one(await capture(a1, 6000));
  ok('R1c apply_verified_payment applied', ap && ap.outcome === 'applied', JSON.stringify(ap));
  const ev1 = await events(gid);
  ok('R1d exactly one payment_receipt event, transition_id = group id, payload carries the verified amount and charge', ev1.length === 1 && ev1[0].transition_id === gid && ev1[0].payload.amount === 6000 && ev1[0].payload.stripe_charge_id === a1.ch && ev1[0].brand_id === brandId && ev1[0].retailer_id === retailerId && ev1[0].booking_id === null, JSON.stringify(ev1.map(e => [e.transition_id, e.payload])));
  const replay = one(await capture(a1, 6000));
  ok('R1e a webhook replay is idempotent in the ledger and writes no second event', replay && replay.outcome === 'idempotent' && (await events(gid)).length === 1, JSON.stringify(replay));

  console.log('\n:: R2 fan-out ::');
  const f1 = await fan();
  const d1 = await deliveries(gid);
  const emails = d1.map(d => d.recipient_email).sort();
  ok('R2a one delivery per brand account contact (account email + teammate), recipient_kind brand, retailer carried, no booking id', f1.errors.length === 0 && d1.length === 2 && emails.join('|') === [brandEmail, mateEmail].sort().join('|') && d1.every(d => d.recipient_kind === 'brand' && d.retailer_id === retailerId && d.booking_id === null && d.status === 'pending'), JSON.stringify({ errors: f1.errors, d: d1.map(d => [d.recipient_email, d.recipient_kind, d.status]) }));
  ok('R2b stable dedupe keys name the event and the recipient', d1.every(d => d.dedupe_key === `payment_receipt:${gid}:brand:${d.recipient_id}`), JSON.stringify(d1.map(d => d.dedupe_key)));
  await fan();
  ok('R2c a second fan-out inserts nothing', (await deliveries(gid)).length === 2);

  console.log('\n:: R3 dispatch ::');
  {
    const rec = recordingMailer(b);
    const c = await claimMine(gid);
    const primary = c.rows.find(r => r.recipient_email === brandEmail);
    ok('R3a the primary delivery was claimed', !!primary, JSON.stringify(c.rows.map(r => r.recipient_email)));
    const r = await processClaimed(b, primary, { now: new Date(), token: c.token, mailer: rec.mailer });
    const after = (await deliveries(gid)).find(d => d.id === primary.id);
    const html = (after && after.frozen_payload && after.frozen_payload.html) || '';
    ok('R3b accepted; frozen payload to the brand email; provider key = delivery id; ONE provider call', r.outcome === 'accepted' && after.status === 'accepted' && after.frozen_payload.to === brandEmail && after.idempotency_key === after.id && rec.calls.length === 1 && keyOf(rec.calls[0]) === after.id, JSON.stringify({ r, key: rec.calls[0] && keyOf(rec.calls[0]) }));
    ok('R3c subject states the ledger total, the demo count and the store', after.frozen_payload.subject === `Your Demohub receipt: $60.00 USD for 2 demos at Receipt Fixture Market`, after.frozen_payload.subject);
    ok('R3d body lists both demos with their dates, the venue and the per-demo amount, from the ledger allocations', /2 demos covered by this payment/.test(html) && (html.match(/Receipt Main Street/g) || []).length === 2 && (html.match(/>\$30\.00 USD</g) || []).length === 2 && /Cold Brew/.test(html), html.match(/covered by this payment[\s\S]{0,600}/)?.[0]?.slice(0, 400));
    ok('R3e card summary + Stripe receipt link come from the charge lookup, which was asked for the ledger charge id', /Visa ending in 4242/.test(html) && html.includes('https://pay.stripe.com/receipts/test/' + a1.ch) && lookups.includes(a1.ch));
    ok('R3f paid date, billed-to brand, reference, portal CTA, "sent to the account contacts" footer; no em dash', /Paid on<\/td>/.test(html) && /Receipt Brand Co/.test(html) && /Reference<\/td>/.test(html) && /brand\/dashboard#account/.test(html) && /account contacts of/.test(html) && !/::/.test(html) && !/::/.test(after.frozen_payload.subject));
    ok('R3g the original receipt is not framed as a copy', !/copy/i.test(html.match(/<div style="font-size:11px[^>]*>[^<]*</)?.[0] || '') && !/sent again at your request/.test(html));
    // the teammate's copy goes out too, under its own key
    const mate = c.rows.find(r => r.recipient_email === mateEmail);
    const r2 = await processClaimed(b, mate, { now: new Date(), token: c.token, mailer: rec.mailer });
    ok('R3h the teammate receives the same receipt under a different delivery id / provider key', r2.outcome === 'accepted' && rec.calls.length === 2 && keyOf(rec.calls[1]) === mate.id && keyOf(rec.calls[1]) !== keyOf(rec.calls[0]), JSON.stringify(r2));
  }

  console.log('\n:: R4 recheck against the CURRENT ledger row ::');
  {
    const b3 = await booking();
    const g3 = await claimGroup([b3.id]); const gid3 = g3.payment_group_id;
    const a3 = await attempt(gid3);
    one(await capture(a3, 3000));
    await fan();
    // refund the whole thing in the ledger (status flips; the payment still happened)
    const up = await db(`payment_groups?id=eq.${gid3}`, { method: 'PATCH', body: JSON.stringify({ status: 'refunded' }) });
    ok('R4a fixture: group marked refunded', up.ok && one(up) && one(up).status === 'refunded', up.text);
    const rec = recordingMailer(b);
    const c = await claimMine(gid3);
    const primary = c.rows.find(r => r.recipient_email === brandEmail);
    const r = await processClaimed(b, primary, { now: new Date(), token: c.token, mailer: rec.mailer });
    ok('R4b a refunded group still gets its receipt (the payment is a fact), one provider call', r.outcome === 'accepted' && rec.calls.length === 1, JSON.stringify(r));
    ok('R4c no second event was written by the refund transition', (await events(gid3)).length === 1);
    // an event whose group no longer exists is skipped at fan-out, not errored
    const ghost = crypto.randomUUID();
    const ins = await db('notification_events', { method: 'POST', body: JSON.stringify({ retailer_id: retailerId, booking_id: null, brand_id: brandId, kind: 'payment_receipt', transition_id: ghost, payload: { payment_group_id: ghost } }) });
    track('notification_events', one(ins) && one(ins).id);
    const f = await fan();
    const evGhost = one(await db(`notification_events?id=eq.${one(ins).id}&select=fanned_out_at,payload`));
    ok('R4d a receipt event for a missing group is marked fanned out with a reason and yields no delivery', f.errors.length === 0 && evGhost && evGhost.fanned_out_at && evGhost.payload.fanout_note === 'group_missing' && (await deliveries(ghost)).length === 0, JSON.stringify(evGhost));
  }

  console.log('\n:: R5 portal: payments list and resend ::');
  {
    const token = crypto.randomUUID();
    await db('brand_account_sessions', { method: 'POST', body: JSON.stringify({ brand_id: brandId, session_token: token, email: brandEmail, expires_at: new Date(Date.now() + 36e5).toISOString() }) });
    const cookies = { dh_brand_session: token };
    const data = await callRoute('brand-account.js', req({ body: { action: 'data' }, cookies }));
    const pay = (data.body.payments || []).find(p => p.id === gid);
    ok('R5a data lists the payment with the ledger amount, the store and both demos', data.statusCode === 200 && pay && pay.amount === 6000 && pay.status === 'paid' && pay.retailer && pay.retailer.name === 'Receipt Fixture Market' && pay.demos.length === 2 && pay.demos.every(d => d.amount === 3000 && d.venue_name === 'Receipt Main Street' && d.demo_date) && pay.paid_at && pay.itemized === true && !(data.body.truncated || []).includes('payments'), JSON.stringify(pay));
    {
      const att = (await db(`payment_attempts?payment_group_id=eq.${gid}&status=eq.paid&select=paid_at`)).body || [];
      ok('R5a2 the listed paid date is the attempt\'s recorded paid_at, not the group\'s creation time', att.length === 1 && pay.paid_at === att[0].paid_at, JSON.stringify({ listed: pay.paid_at, attempt: att[0] && att[0].paid_at }));
    }
    ok('R5b the refunded payment is listed as refunded', (data.body.payments || []).some(p => p.status === 'refunded'));
    const before = (await events(gid)).length;
    const rs = await callRoute('brand-account.js', req({ body: { action: 'receipt-resend', payment_group_id: gid }, cookies }));
    const evs = await events(gid);
    const resendEv = evs.find(e => e.transition_id !== gid);
    ok('R5c receipt-resend queues ONE resend event (<gid>:resend:<ms>) with the requester recorded', rs.statusCode === 200 && rs.body.ok && rs.body.queued && evs.length === before + 1 && resendEv && /^.+:resend:\d+$/.test(resendEv.transition_id) && resendEv.payload.resend === true && resendEv.payload.payment_group_id === gid && resendEv.payload.requested_by === brandEmail && resendEv.payload.requested_recipient_id === brandId && rs.body.to === brandEmail && rs.body.worker_interval_minutes === 15, JSON.stringify({ status: rs.statusCode, body: rs.body, ev: resendEv && resendEv.payload }));
    const again = await callRoute('brand-account.js', req({ body: { action: 'receipt-resend', payment_group_id: gid }, cookies }));
    ok('R5d a repeat inside 10 minutes is throttled (429) and writes nothing', again.statusCode === 429 && again.body.error === 'receipt_recently_requested' && again.body.retry_after_seconds > 0 && (await events(gid)).length === before + 1, JSON.stringify(again.body));
    // foreign group: another brand's session cannot resend ours
    const otherToken = crypto.randomUUID();
    await db('brand_account_sessions', { method: 'POST', body: JSON.stringify({ brand_id: otherBrandId, session_token: otherToken, email: 'other@fixture.test', expires_at: new Date(Date.now() + 36e5).toISOString() }) });
    const foreign = await callRoute('brand-account.js', req({ body: { action: 'receipt-resend', payment_group_id: gid }, cookies: { dh_brand_session: otherToken } }));
    ok('R5e a different brand gets 404 for our payment (no existence leak, nothing queued)', foreign.statusCode === 404 && (await events(gid)).length === before + 1, JSON.stringify(foreign.body));
    const bad = await callRoute('brand-account.js', req({ body: { action: 'receipt-resend', payment_group_id: 'nope' }, cookies }));
    const unpaid = await callRoute('brand-account.js', req({ body: { action: 'receipt-resend', payment_group_id: gA.payment_group_id }, cookies }));
    const anon = await callRoute('brand-account.js', req({ body: { action: 'receipt-resend', payment_group_id: gid } }));
    ok('R5f bad id 400, unpaid group 409, no session 401', bad.statusCode === 400 && unpaid.statusCode === 409 && unpaid.body.error === 'payment_not_settled' && anon.statusCode === 401, JSON.stringify([bad.statusCode, unpaid.statusCode, unpaid.body, anon.statusCode]));
    const strangerToken = crypto.randomUUID();
    await db('brand_account_sessions', { method: 'POST', body: JSON.stringify({ brand_id: brandId, session_token: strangerToken, email: 'stranger@fixture.test', expires_at: new Date(Date.now() + 36e5).toISOString() }) });
    const stranger = await callRoute('brand-account.js', req({ body: { action: 'receipt-resend', payment_group_id: gid }, cookies: { dh_brand_session: strangerToken } }));
    ok('R5f2 a session whose email is not a current account contact gets 403 and queues nothing', stranger.statusCode === 403 && stranger.body.error === 'requester_not_a_contact' && (await events(gid)).length === before + 1, JSON.stringify(stranger.body));
    // the copy is delivered through the same path, framed as a copy
    await fan();
    const dAll = await deliveries(gid);
    const copies = dAll.filter(d => d.event_id === resendEv.id);
    ok('R5g the resend fans out to the REQUESTER ONLY (one delivery, the account email), keyed on the resend transition', copies.length === 1 && copies[0].recipient_email === brandEmail && copies[0].recipient_id === brandId && copies[0].dedupe_key === `payment_receipt:${resendEv.transition_id}:brand:${brandId}`, JSON.stringify(copies.map(d => [d.recipient_email, d.dedupe_key])));
    const rec = recordingMailer(b);
    const c = await claimMine(gid);
    const copy = c.rows.find(r => r.event_id === resendEv.id && r.recipient_email === brandEmail);
    const r = await processClaimed(b, copy, { now: new Date(), token: c.token, mailer: rec.mailer });
    const after = (await deliveries(gid)).find(d => d.id === copy.id);
    ok('R5h the copy sends with the same figures and the "copy" framing', r.outcome === 'accepted' && after.frozen_payload.subject === `Your Demohub receipt: $60.00 USD for 2 demos at Receipt Fixture Market` && /Payment receipt \(copy\)/.test(after.frozen_payload.html) && /sent again at your request/.test(after.frozen_payload.html), JSON.stringify(r));
    for (const r0 of c.rows) if (r0 !== copy) await db(`notification_deliveries?id=eq.${r0.id}`, { method: 'PATCH', body: JSON.stringify({ claim_token: null, lease_until: null, status: 'pending' }) });
    // a teammate asks for a copy: it goes to the teammate only (a different group, so the cooldown does not apply)
    const mateToken = crypto.randomUUID();
    await db('brand_account_sessions', { method: 'POST', body: JSON.stringify({ brand_id: brandId, session_token: mateToken, email: mateEmail, expires_at: new Date(Date.now() + 36e5).toISOString() }) });
    const gidR = (data.body.payments || []).find(p => p.status === 'refunded').id;
    const mr = await callRoute('brand-account.js', req({ body: { action: 'receipt-resend', payment_group_id: gidR }, cookies: { dh_brand_session: mateToken } }));
    const mateEv = (await events(gidR)).find(e => e.transition_id !== gidR);
    await fan();
    const mateCopies = (await deliveries(gidR)).filter(d => mateEv && d.event_id === mateEv.id);
    ok('R5i a teammate\'s request is recorded with the teammate as recipient and fans out to the teammate only', mr.statusCode === 200 && mr.body.to === mateEmail && mateEv && mateEv.payload.requested_recipient_id === mateId && mateCopies.length === 1 && mateCopies[0].recipient_email === mateEmail, JSON.stringify({ body: mr.body, copies: mateCopies.map(d => d.recipient_email) }));
  }

  console.log('\n:: R6 concurrency: one event however many simultaneous requests ::');
  {
    const b6 = await booking();
    const g6 = await claimGroup([b6.id]); const gid6 = g6.payment_group_id;
    one(await capture(await attempt(gid6), 3000));
    const token = crypto.randomUUID();
    await db('brand_account_sessions', { method: 'POST', body: JSON.stringify({ brand_id: brandId, session_token: token, email: brandEmail, expires_at: new Date(Date.now() + 36e5).toISOString() }) });
    const cookies = { dh_brand_session: token };
    const results = await Promise.all(Array.from({ length: 20 }, () => callRoute('brand-account.js', req({ body: { action: 'receipt-resend', payment_group_id: gid6 }, cookies }))));
    const queued = results.filter(r => r.statusCode === 200 && r.body.queued);
    const throttled = results.filter(r => r.statusCode === 429 && r.body.error === 'receipt_recently_requested' && r.body.retry_after_seconds > 0 && r.body.retry_after_seconds <= 600);
    const evs6 = (await events(gid6)).filter(e => e.transition_id !== gid6);
    ok('R6a 20 concurrent resend requests: exactly ONE queued, 19 throttled with a bounded retry_after, exactly ONE resend event', queued.length === 1 && throttled.length === 19 && evs6.length === 1, JSON.stringify({ queued: queued.length, throttled: throttled.length, other: results.filter(r => r.statusCode !== 200 && r.statusCode !== 429).map(r => [r.statusCode, r.body]), events: evs6.length }));
    const again = await callRoute('brand-account.js', req({ body: { action: 'receipt-resend', payment_group_id: gid6 }, cookies }));
    ok('R6b a later request inside the cooldown is throttled too, still one event', again.statusCode === 429 && (await events(gid6)).filter(e => e.transition_id !== gid6).length === 1, JSON.stringify(again.body));
    const rpcDirect = await fetch(`${SB}/rest/v1/rpc/request_payment_receipt_resend`, { method: 'POST', headers: { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ p_group_id: gid6, p_brand_id: otherBrandId, p_requested_by: 'other@fixture.test', p_cooldown_seconds: 600 }) });
    const rpcOut = await rpcDirect.json();
    ok('R6c the RPC itself refuses a group the given brand does not own (not_found), whatever the caller claims', rpcDirect.ok && rpcOut && rpcOut.outcome === 'not_found', JSON.stringify(rpcOut));
    // The anon role must not be able to call the RPC. Needs the project's anon key in the environment
    // (SUPABASE_ANON_KEY); without it the check is reported as skipped, never as passed.
    const ANON = process.env.SUPABASE_ANON_KEY;
    if (!ANON) ok('R6d SKIPPED: SUPABASE_ANON_KEY not in the environment, anon execution not exercised', true);
    else {
      const anonRpc = await fetch(`${SB}/rest/v1/rpc/request_payment_receipt_resend`, { method: 'POST', headers: { apikey: ANON, Authorization: 'Bearer ' + ANON, 'Content-Type': 'application/json' }, body: JSON.stringify({ p_group_id: gid6, p_brand_id: brandId, p_requested_by: brandEmail, p_cooldown_seconds: 600 }) });
      ok('R6d the anon role cannot execute the RPC', !anonRpc.ok && [401, 403, 404].includes(anonRpc.status), String(anonRpc.status));
    }
  }
} finally {
  // cleanup: deliveries + events by group, then the ledger rows, bookings, sessions, fixtures
  for (const gid of groups) {
    await db(`notification_deliveries?kind=eq.payment_receipt&dedupe_key=like.payment_receipt:${gid}*`, { method: 'DELETE' });
    await db(`notification_events?kind=eq.payment_receipt&transition_id=like.${gid}*`, { method: 'DELETE' });
    await db(`payment_attempts?payment_group_id=eq.${gid}`, { method: 'DELETE' });
    await db(`payment_allocations?payment_group_id=eq.${gid}`, { method: 'DELETE' });
    await db(`payment_groups?id=eq.${gid}`, { method: 'DELETE' });
  }
  for (const [t, id] of bin.reverse()) {
    if (t === 'bookings') { for (const x of ['notification_deliveries', 'notification_events', 'demos', 'booking_fulfillments']) await db(`${x}?booking_id=eq.${id}`, { method: 'DELETE' }); }
    if (t === 'brands') { for (const x of ['brand_account_sessions', 'brand_account_tokens', 'brand_contacts', 'brand_members']) await db(`${x}?brand_id=eq.${id}`, { method: 'DELETE' }); await db(`notification_deliveries?recipient_id=eq.${id}`, { method: 'DELETE' }); await db(`notification_events?brand_id=eq.${id}`, { method: 'DELETE' }); }
    await db(`${t}?id=eq.${id}`, { method: 'DELETE' });
  }
}
summary('payment receipts');
