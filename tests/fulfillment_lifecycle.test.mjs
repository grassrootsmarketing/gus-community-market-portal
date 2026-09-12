// tests/fulfillment_lifecycle.test.mjs — Codex "Release B — third closure review" (2026-09-11), C1–C4.
//
// Real isolated database (demohub-rebuild-check) + the shipped handlers in-process with provider
// spies. Writes financial tables (payment_groups / attempts / allocations, refunds) so it carries the
// same safety gate as the ledger suites: LEDGER_TARGET_REF + ALLOW_STAGING_LEDGER_TESTS=yes.
//
//   C1  a held-stage worker overtaken by a capture cannot complete the paid generation; the paid work
//       is claimable at once and finishes with the right booking state (+ one demo when confirmed);
//       no stale hold notice; expiry before completion is superseded; capture replay is idempotent;
//       projection_anomalies() reports stranded paid bookings and lying terminal rows.
//   C2  A: cancel/decline of an authorized hold = 200 (the release applied the terminal state; the
//          transition converges with already_applied), metadata set, one PI cancel, no refund, replay
//          refused truthfully; manual confirm of a hold with auto-confirm OFF and ON (capture-side
//          confirm is not rejected as a capacity conflict, one demo).
//       B: decline whose refund succeeded and whose transition is then logically refused by a
//          concurrent confirm -> 409 that SAYS the refund was submitted + ONE deduplicated case.
//   C3  a pending-target payment job whose mail failed, then a manual confirmation: the retry reports
//       already_advanced (done, no downgrade, one demo, no extra mail); after a cancel it is superseded.
//   C4  the snapshot helper refuses incomplete / partial / reversed successful reads (pure unit).
import pg from 'pg';
import crypto from 'node:crypto';
import { callRoute, req, installSpy, ENV, ok, summary } from './_route.mjs';
import { _resetBindingCache } from '../api/_env.js';

const SB_URL_RAW = process.env.SB_URL, SB_KEY = process.env.SB_KEY, SB_DB_URL = process.env.SB_DB_URL;
if (!SB_URL_RAW || !SB_KEY || !SB_DB_URL) { console.error('SB_URL, SB_KEY and SB_DB_URL required'); process.exit(2); }
const SB_URL = SB_URL_RAW.replace(/\/+$/, '').replace(/\/rest\/v1$/, '') + '/rest/v1';
const H = { apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY, 'Content-Type': 'application/json' };
const RUN = 'lifecycle-' + Date.now().toString(36);

// Pinned ledger fixtures (tests/_seed_ledger_fixtures.mjs)
const KEEPS_RETAILER = '8cf80c18-ff37-4c32-8154-dcdd90486942';
const KEEPS_VENUE    = '35301125-8921-4bb2-a7d5-aac777e2e76e';
const BRAND1         = '7f044529-1aba-417a-9b39-ea55f846d06d';
const AMT = 3000;

// SAFETY GATE — identical policy to the ledger suites.
{
  const host = (SB_URL_RAW || '').replace(/^https?:\/\//, '').split('.')[0];
  const die = (m) => { console.error('REFUSING TO RUN:', m); process.exit(2); };
  const allowed = (process.env.LEDGER_TARGET_REF || '').split(',').map(s => s.trim()).filter(Boolean);
  if (['ecapmcyumpjjgjwuokyv', 'eubbgurdwqmwqduamwhn', 'dkgjvsstbgnhcfboqqnd'].includes(host)) die('SB_URL points at a DENIED (production) project: ' + host);
  if (!allowed.length) die('LEDGER_TARGET_REF is not set');
  if (!allowed.includes(host)) die('SB_URL project ' + host + ' is not in LEDGER_TARGET_REF');
  if (process.env.ALLOW_STAGING_LEDGER_TESTS !== 'yes') die('ALLOW_STAGING_LEDGER_TESTS=yes is required');
  if (!SB_DB_URL.includes(host)) die('SB_DB_URL must point at the same project as SB_URL');
  console.log('safety: target project ' + host + ' allowlisted, opt-in present\n');
}

async function rest(path, opts = {}) {
  const r = await fetch(`${SB_URL}/${path}`, { ...opts, headers: { ...H, Prefer: 'return=representation', ...(opts.headers || {}) } });
  const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch (_) {}
  return { ok: r.ok, status: r.status, json: j, text: t };
}
async function rpc(fn, args) {
  const r = await fetch(`${SB_URL}/rpc/${fn}`, { method: 'POST', headers: H, body: JSON.stringify(args) });
  const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch (_) {}
  return { ok: r.ok, status: r.status, json: j, text: t };
}
const one = (j) => Array.isArray(j) ? j[0] : j;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const ctl = new pg.Client({ connectionString: SB_DB_URL, ssl: { rejectUnauthorized: false }, application_name: 'lifecycle-ctl' });
await ctl.connect();
const q = async (sql, params) => (await ctl.query(sql, params)).rows;
const row1 = async (sql, params) => (await q(sql, params))[0] || null;

const created = { bookings: [], groups: [], caseKeys: [] };
let seedN = 0; const DAY0 = Math.floor(Math.random() * 200);
function uniqueSlot() { const d = new Date(Date.UTC(2027, 0, 5)); d.setUTCDate(d.getUTCDate() + DAY0 + seedN); seedN++; return d.toISOString().slice(0, 10); }
function uniqueTime() { return `${6 + (seedN % 16)}:00`; }
async function seedBooking({ status = 'held', payment_status = 'unpaid' } = {}) {
  const resp = await rest('bookings', { method: 'POST', body: JSON.stringify({
    retailer_id: KEEPS_RETAILER, venue_id: KEEPS_VENUE, brand_id: BRAND1, brand_name: 'Lifecycle ' + RUN,
    contact_name: 'Lifecycle Tester', contact_email: `${RUN}@fixture.test`, product: 'Samples',
    demo_date: uniqueSlot(), demo_time: uniqueTime(), status, payment_status,
  }) });
  const b = one(resp.json);
  if (!b || !b.id) throw new Error('seedBooking failed: ' + resp.status + ' ' + (resp.text || '').slice(0, 200));
  created.bookings.push(b.id);
  return b;
}
async function claimGroup(bookingIds) {
  const c = await rpc('checkout_claim_group', { p_brand_id: BRAND1, p_retailer_id: KEEPS_RETAILER, p_booking_ids: bookingIds, p_platform_keeps_all: true, p_connect_account_id: null, p_platform_fee_cents: 0 });
  const r = one(c.json); if (!r || !r.payment_group_id) throw new Error('claim failed: ' + c.text.slice(0, 200));
  created.groups.push(r.payment_group_id); return r.payment_group_id;
}
async function attempt(gid, tag) {
  const sess = `cs_${RUN}_${tag}`, pi = `pi_${RUN}_${tag}`, ch = `ch_${RUN}_${tag}`;
  await rpc('register_payment_attempt', { p_group_id: gid, p_session_id: sess, p_payment_intent: pi, p_hash: 'h-' + tag, p_schema: 1 });
  return { sess, pi, ch };
}
// a held booking all the way to AUTHORIZED (funds held, $0 captured, held-stage outbox row)
async function authorize(tag) {
  const b = await seedBooking({ status: 'held' });
  const gid = await claimGroup([b.id]);
  const { sess, pi, ch } = await attempt(gid, tag);
  const a = one((await rpc('apply_verified_authorization', { p_session_id: sess, p_payment_intent: pi, p_charge: ch, p_amount: AMT, p_currency: 'usd' })).json);
  if (!a || a.outcome !== 'applied') throw new Error('authorize failed: ' + JSON.stringify(a));
  return { b, gid, sess, pi, ch };
}
const capture = (sess, pi, ch) => rpc('apply_verified_payment', { p_session_id: sess, p_payment_intent: pi, p_charge: ch, p_amount: AMT, p_currency: 'usd', p_connect_dest: null, p_on_behalf_of: null, p_application_fee: null, p_transfer_id: null, p_fee_id: null });
// a PAID booking awaiting manual confirmation (pending-target outbox row, not yet drained)
async function paidUndrained(tag) {
  const b = await seedBooking({ status: 'pending_payment' });
  const gid = await claimGroup([b.id]);
  const { sess, pi, ch } = await attempt(gid, tag);
  const c = one((await capture(sess, pi, ch)).json);
  if (!c || c.outcome !== 'applied') throw new Error('capture failed: ' + JSON.stringify(c));
  return { b, gid, sess, pi, ch };
}
const booking = (id) => row1(`SELECT id, status, payment_status, payment_intent_id, cancelled_at, cancel_reason, refund_id, paid_at FROM bookings WHERE id = $1`, [id]);
const outbox = (id) => row1(`SELECT target_status, status, generation, lease_owner, attempts, demo_created, emails_sent, last_error FROM booking_fulfillments WHERE booking_id = $1`, [id]);
const demos = (id) => q(`SELECT id, status FROM demos WHERE booking_id = $1 ORDER BY created_at`, [id]);
const audit = async (id) => (await q(`SELECT reason FROM projection_anomalies($1) WHERE booking_id = $2`, [KEEPS_RETAILER, id])).map(r => r.reason);
const setAutoConfirm = (v) => rest(`retailers?id=eq.${KEEPS_RETAILER}`, { method: 'PATCH', body: JSON.stringify({ auto_confirm_bookings: v }) });
const capturedPi = (pi, ch) => ({ id: pi, object: 'payment_intent', status: 'succeeded', latest_charge: ch, amount: AMT, amount_received: AMT, currency: 'usd' });
const canceledPi = (pi) => ({ id: pi, object: 'payment_intent', status: 'canceled', amount: AMT, amount_received: 0, currency: 'usd' });

process.env = { ...ENV }; _resetBindingCache();
const spy = installSpy();
const ful = await import('../api/_fulfillment.js?t=' + Date.now());
const stripeCalls = (re) => spy.calls.stripe.filter(c => re.test(c.url)).length;

let staffCookie = null; const staffEmail = `staff-${RUN}@fixture.test`;
let brandCoiBefore = null;
try {
  const pre = await row1(`SELECT to_regprocedure('public.complete_fulfillment(uuid,text,boolean,boolean,boolean,text,integer)') AS c7, to_regprocedure('public.complete_fulfillment(uuid,text,boolean,boolean,boolean,text)') AS c6,
                                 (SELECT count(*) FROM information_schema.columns WHERE table_name = 'booking_fulfillments' AND column_name = 'generation')::int AS gen`);
  ok('preflight: 0078 applied (7-arg complete_fulfillment, 6-arg gone, generation column)', pre.c7 && !pre.c6 && pre.gen === 1, JSON.stringify(pre));
  await setAutoConfirm(false);

  // retailer session for the shipped route
  await rest('retailer_admins', { method: 'POST', body: JSON.stringify({ retailer_id: KEEPS_RETAILER, email: staffEmail, email_normalized: staffEmail, name: 'Lifecycle Staff', role: 'admin' }) });
  const tok = one((await rest('admin_tokens', { method: 'POST', body: JSON.stringify({ email: staffEmail, retailer_id: KEEPS_RETAILER }) })).json);
  staffCookie = (await callRoute('admin-auth.js', req({ body: { action: 'verify', token: tok.token } }))).cookie('dh_retailer_session');
  ok('fixtures: retailer session', !!staffCookie);
  const route = (body) => callRoute('booking-action.js', req({ body, cookies: { dh_retailer_session: staffCookie } }));

  // ===========================================================================================
  console.log('\n— C1: a held-stage worker overtaken by a capture cannot complete the paid generation —');
  {
    const A = await authorize('c1a');
    ok('C1: authorization creates the held-stage outbox row at generation 1', (await outbox(A.b.id)).target_status === 'held' && (await outbox(A.b.id)).generation === 1);
    const claimed = one((await rpc('claim_fulfillments', { p_owner: 'old-worker', p_lease_seconds: 300, p_limit: 50, p_group: A.gid })).json);
    const rowA = (Array.isArray(claimed) ? claimed : [claimed]).find(r => r && r.booking_id === A.b.id);
    ok('C1: the claim returns the generation (1) with the held work', rowA && rowA.generation === 1 && rowA.target_status === 'held', JSON.stringify(rowA));
    // the old worker is "in flight" (parked before completion); the capture lands now
    const cap = one((await capture(A.sess, A.pi, A.ch)).json);
    const after = await outbox(A.b.id);
    ok('C1: capture applied and RE-ISSUED the row as generation 2, pending, lease dropped, attempts reset', cap.outcome === 'applied' && after.generation === 2 && after.status === 'pending' && after.target_status === 'pending' && after.lease_owner === null && after.attempts === 0 && after.demo_created === false, JSON.stringify(after));
    const stale = (await rpc('complete_fulfillment', { p_booking_id: A.b.id, p_owner: 'old-worker', p_demo: true, p_emails: true, p_done: true, p_err: null, p_generation: 1 })).json;
    const afterStale = await outbox(A.b.id);
    ok('C1: the old worker\'s completion (generation 1) is REFUSED and changes nothing', stale === false && afterStale.status === 'pending' && afterStale.generation === 2 && afterStale.demo_created === false, JSON.stringify({ stale, afterStale }));
    // the old worker's actual JavaScript, resumed after the capture: no hold notice, nothing recorded
    spy.calls.resend.length = 0;
    const oldRun = await ful.runFulfillment({ ...rowA }, 'old-worker');
    ok('C1: the resumed old worker sends NO hold-placed notice and records nothing (stale generation)', spy.calls.resend.length === 0 && oldRun.recorded === false && /superseded:hold_no_longer_active/.test(oldRun.error || '') && /record:stale_claim/.test(oldRun.error || ''), JSON.stringify(oldRun));
    ok('C1: no demo exists for the paid-but-not-yet-promoted booking (nothing was faked)', (await demos(A.b.id)).length === 0);
    // audit: stranded beyond the in-flight interval, and a lying terminal row
    await q(`UPDATE bookings SET paid_at = now() - interval '20 minutes' WHERE id = $1`, [A.b.id]);
    ok('C1: projection_anomalies() reports paid_booking_not_promoted past the 15-minute in-flight interval', (await audit(A.b.id)).includes('paid_booking_not_promoted'), JSON.stringify(await audit(A.b.id)));
    await q(`UPDATE booking_fulfillments SET status = 'done' WHERE booking_id = $1`, [A.b.id]);
    ok('C1: a terminal outbox row for a still-held paid booking is reported (fulfillment_done_but_booking_not_promoted)', (await audit(A.b.id)).includes('fulfillment_done_but_booking_not_promoted'));
    await q(`UPDATE booking_fulfillments SET status = 'pending' WHERE booking_id = $1`, [A.b.id]);
    // the paid generation is claimable at once and finishes
    spy.calls.resend.length = 0;
    const drained = await ful.drainFulfillments({ limit: 10, group: A.gid });
    const bA = await booking(A.b.id), oA = await outbox(A.b.id);
    ok('C1: a fresh drain claims generation 2 and finishes it: booking pending/paid, row done, one payment notice', drained.completed === 1 && bA.status === 'pending' && bA.payment_status === 'paid' && oA.status === 'done' && oA.generation === 2 && spy.calls.resend.length === 1, JSON.stringify({ drained, bA: bA.status, oA, mails: spy.calls.resend.length }));
    ok('C1: the audit is clean for that booking once promoted', (await audit(A.b.id)).length === 0, JSON.stringify(await audit(A.b.id)));
    const replay = one((await capture(A.sess, A.pi, A.ch)).json);
    ok('C1: replaying the capture is idempotent and does not re-issue the generation', /idempotent|applied/.test(replay.outcome || '') && (await outbox(A.b.id)).generation === 2 && (await outbox(A.b.id)).status === 'done', JSON.stringify({ replay: replay.outcome, o: await outbox(A.b.id) }));

    // auto-confirm target: the paid generation ends with the booking confirmed and exactly one demo
    await setAutoConfirm(true);
    const B = await authorize('c1b');
    const cB = one((await rpc('claim_fulfillments', { p_owner: 'old-worker', p_lease_seconds: 300, p_limit: 50, p_group: B.gid })).json);
    const rowB = (Array.isArray(cB) ? cB : [cB]).find(r => r && r.booking_id === B.b.id);
    await capture(B.sess, B.pi, B.ch);
    ok('C1 (confirmed target): capture re-issues the row with target confirmed, generation 2', (await outbox(B.b.id)).target_status === 'confirmed' && (await outbox(B.b.id)).generation === 2);
    const staleB = (await rpc('complete_fulfillment', { p_booking_id: B.b.id, p_owner: 'old-worker', p_demo: true, p_emails: true, p_done: true, p_err: null, p_generation: rowB.generation })).json;
    spy.calls.resend.length = 0;
    const drainedB = await ful.drainFulfillments({ limit: 10, group: B.gid });
    const bB = await booking(B.b.id), dB = await demos(B.b.id);
    ok('C1 (confirmed target): old completion refused; the drain promotes AND materialises exactly one demo', staleB === false && drainedB.completed === 1 && bB.status === 'confirmed' && dB.length === 1 && dB[0].status === 'confirmed' && (await outbox(B.b.id)).status === 'done', JSON.stringify({ staleB, drainedB, bB: bB.status, dB }));
    ok('C1 (confirmed target): projection audit clean', (await audit(B.b.id)).length === 0);
    await setAutoConfirm(false);

    // expiry before the old worker finishes: this generation is still current -> superseded, recorded
    const C = await authorize('c1c');
    const cC = one((await rpc('claim_fulfillments', { p_owner: 'old-worker', p_lease_seconds: 300, p_limit: 50, p_group: C.gid })).json);
    const rowC = (Array.isArray(cC) ? cC : [cC]).find(r => r && r.booking_id === C.b.id);
    const exp = one((await rpc('apply_authorization_canceled', { p_payment_intent: C.pi, p_target_status: 'expired', p_reason: 'sweep' })).json);
    spy.calls.resend.length = 0;
    const oldC = await ful.runFulfillment({ ...rowC }, 'old-worker');
    const bC = await booking(C.b.id), oC = await outbox(C.b.id);
    ok('C1 (expired before completion): the old worker records a superseded outcome, sends no hold notice, booking stays expired', /applied|idempotent|attempt_canceled/.test(exp.outcome || '') && bC.status === 'expired' && oldC.done === true && oldC.recorded === true && /superseded:hold_no_longer_active:expired/.test(oldC.error || '') && spy.calls.resend.length === 0 && oC.status === 'done', JSON.stringify({ exp: exp.outcome, oldC, bC: bC.status, oC }));
  }

  // ===========================================================================================
  console.log('\n— R4-01: terminal failure is fenced like completion; a stale claim can never park replacement work —');
  {
    const fulfilCase = async (id) => q(`SELECT id, details FROM reconciliation_cases WHERE dedupe_key = $1`, ['fulfil:' + id]);
    const setAttempts = (id, n) => q(`UPDATE booking_fulfillments SET attempts = $2 WHERE booking_id = $1`, [id, n]);
    const claimAs = async (owner, gid, bid, secs = 300) => { const c = one((await rpc('claim_fulfillments', { p_owner: owner, p_lease_seconds: secs, p_limit: 50, p_group: gid })).json); return (Array.isArray(c) ? c : [c]).find(r => r && r.booking_id === bid) || null; };
    // (1) a stale held worker at the retry cap resumes through the FULL drain path after a capture
    await setAutoConfirm(true);
    const A = await authorize('r401a');
    await setAttempts(A.b.id, 5);
    const staleRow = await claimAs('old-worker', A.gid, A.b.id);            // attempts -> 6, generation 1
    ok('R4-01 (1): the stale claim is at the cap on generation 1', staleRow && staleRow.attempts === 6 && staleRow.generation === 1, JSON.stringify(staleRow));
    await capture(A.sess, A.pi, A.ch);                                     // re-issued: generation 2, pending, attempts 0, lease dropped
    const realFetch = globalThis.fetch;
    let staleClaimServed = 0;
    globalThis.fetch = async (url, opts = {}) => {
      // the drain's own claim RPC hands back the OLD claimed object (what a worker that was parked
      // before the capture is still holding); everything else is real
      if (staleClaimServed === 0 && String(url).includes('/rpc/claim_fulfillments')) { staleClaimServed++; return { ok: true, status: 200, text: async () => JSON.stringify([{ ...staleRow }]), json: async () => [{ ...staleRow }] }; }
      return realFetch(url, opts);
    };
    spy.calls.resend.length = 0;
    let staleDrain;
    try { staleDrain = await ful.drainFulfillments({ limit: 10, group: A.gid, maxAttempts: 6 }); } finally { globalThis.fetch = realFetch; }
    const rowA = await outbox(A.b.id);
    ok('R4-01 (1): the stale worker\'s full drain pass changes NOTHING — generation 2 stays pending/claimable, no lease, no case, no hold notice', staleDrain.processed === 1 && staleDrain.completed === 0 && staleDrain.capped === 0 && rowA.status === 'pending' && rowA.generation === 2 && rowA.attempts === 0 && rowA.lease_owner === null && (await fulfilCase(A.b.id)).length === 0 && spy.calls.resend.length === 0, JSON.stringify({ staleDrain, rowA }));
    const realDrain = await ful.drainFulfillments({ limit: 10, group: A.gid, maxAttempts: 6 });
    const bA = await booking(A.b.id), dA = await demos(A.b.id);
    ok('R4-01 (1): the replacement generation then finishes: booking confirmed with exactly one demo, row done', realDrain.completed === 1 && bA.status === 'confirmed' && dA.length === 1 && (await outbox(A.b.id)).status === 'done', JSON.stringify({ realDrain, bA: bA.status, dA }));
    await setAutoConfirm(false);

    // (2) the replacement worker already holds the new lease when the stale worker resumes
    const B = await authorize('r401b');
    const staleB = await claimAs('old-worker', B.gid, B.b.id);
    await capture(B.sess, B.pi, B.ch);
    const freshB = await claimAs('new-worker', B.gid, B.b.id);                // generation 2 lease
    const staleRes = await ful.runFulfillment({ ...staleB }, 'old-worker', { maxAttempts: 1 });
    const rowB = await outbox(B.b.id);
    ok('R4-01 (2): with the new lease held elsewhere, the stale worker (even "exhausted" by its own counters) is a no-op: row still leased to the new worker, generation 2, no case', staleRes.recorded === false && staleRes.outcome === 'stale' && rowB.lease_owner === 'new-worker' && rowB.generation === 2 && rowB.status === 'pending' && (await fulfilCase(B.b.id)).length === 0, JSON.stringify({ staleRes, rowB }));
    const newRes = await ful.runFulfillment({ ...freshB }, 'new-worker');
    ok('R4-01 (2): the new worker completes its generation', newRes.done === true && newRes.recorded === true && newRes.outcome === 'done' && (await outbox(B.b.id)).status === 'done' && (await booking(B.b.id)).status === 'pending', JSON.stringify(newRes));

    // (3) lease takeover within ONE generation: the first worker's late write is refused; the taker finishes
    const C = await authorize('r401c');
    const first = await claimAs('w-first', C.gid, C.b.id, 30);
    await q(`UPDATE booking_fulfillments SET lease_expires_at = now() - interval '1 second' WHERE booking_id = $1`, [C.b.id]);
    const taker = await claimAs('w-taker', C.gid, C.b.id);
    const lateFirst = await ful.runFulfillment({ ...first }, 'w-first');
    ok('R4-01 (3): after a lease takeover the first worker\'s completion is stale (no write), the taker holds the lease', lateFirst.recorded === false && lateFirst.outcome === 'stale' && /lease_w-taker/.test(lateFirst.error || '') && (await outbox(C.b.id)).lease_owner === 'w-taker', JSON.stringify(lateFirst));
    spy.calls.resend.length = 0;
    const takerRes = await ful.runFulfillment({ ...taker }, 'w-taker');
    ok('R4-01 (3): the taker sends the ONE hold notice and completes generation 1', takerRes.done === true && takerRes.outcome === 'done' && spy.calls.resend.length === 1 && (await outbox(C.b.id)).status === 'done', JSON.stringify(takerRes));

    // (4) capture lands between an incomplete progress record and the worker's next write
    const D = await authorize('r401d');
    const dRow = await claimAs('w-d', D.gid, D.b.id);
    const prog = one((await rpc('record_fulfillment', { p_booking_id: D.b.id, p_owner: 'w-d', p_generation: 1, p_demo: false, p_emails: false, p_done: false, p_err: 'partial', p_max_attempts: 6 })).json);
    await capture(D.sess, D.pi, D.ch);                                       // generation 2
    const late = one((await rpc('record_fulfillment', { p_booking_id: D.b.id, p_owner: 'w-d', p_generation: 1, p_demo: true, p_emails: true, p_done: true, p_err: null, p_max_attempts: 6 })).json);
    const rowD = await outbox(D.b.id);
    ok('R4-01 (4): progress was recorded on generation 1; the capture re-issued the row; the worker\'s late "done" is stale and generation 2 is untouched', prog.outcome === 'progress' && late.outcome === 'stale' && /generation_2/.test(late.reason) && rowD.generation === 2 && rowD.status === 'pending' && rowD.demo_created === false && rowD.emails_sent === false, JSON.stringify({ prog, late, rowD }));
    ok('R4-01 (4): the paid generation completes normally afterwards', (await ful.drainFulfillments({ limit: 10, group: D.gid })).completed === 1 && (await outbox(D.b.id)).status === 'done');

    // (5) legitimate exhaustion of the CURRENT generation parks only that work and opens one case; replay adds nothing
    const E = await paidUndrained('r401e');
    await setAttempts(E.b.id, 5);
    const eRow = await claimAs('w-e', E.gid, E.b.id);                        // attempts 6 = cap
    spy.faults.push({ url: 'api.resend.com', method: 'POST', status: 500, message: 'injected_mail_failure', once: true });
    const exhausted = await ful.runFulfillment({ ...eRow }, 'w-e', { maxAttempts: 6 });
    const rowE = await outbox(E.b.id), caseE = await fulfilCase(E.b.id);
    ok('R4-01 (5): a live claim that hits the cap is parked atomically: row failed, lease cleared, ONE fulfillment_failed case naming the generation', exhausted.recorded === true && exhausted.outcome === 'exhausted' && exhausted.case_id && rowE.status === 'failed' && rowE.lease_owner === null && caseE.length === 1 && caseE[0].id === exhausted.case_id && Number(caseE[0].details && caseE[0].details.generation) === 1, JSON.stringify({ exhausted, rowE: [rowE.status, rowE.attempts], caseE: caseE.length }));
    const replayE = await ful.runFulfillment({ ...eRow }, 'w-e', { maxAttempts: 6 });
    ok('R4-01 (5): a replay by the same worker is a stale no-op — still one case, row still failed, booking untouched', replayE.recorded === false && replayE.outcome === 'stale' && (await fulfilCase(E.b.id)).length === 1 && (await outbox(E.b.id)).status === 'failed' && (await booking(E.b.id)).status === 'pending', JSON.stringify(replayE));
    ok('R4-01: the unguarded open_fulfillment_case(uuid,text) no longer exists (no alternate parking path for any deployed code)', (await rpc('open_fulfillment_case', { p_booking_id: E.b.id, p_reason: 'x' })).status >= 400 && (await outbox(E.b.id)).status === 'failed');
    created.caseKeys.push('fulfil:' + E.b.id);
  }

  // ===========================================================================================
  console.log('\n— C2-A: provider-side success followed by the transition: truthful outcomes —');
  {
    // cancel of an authorized hold: the release applies 'cancelled'; the transition converges
    const A = await authorize('c2a');
    spy.fixtures.paymentIntents[A.pi] = canceledPi(A.pi);
    spy.calls.stripe.length = 0; spy.calls.resend.length = 0;
    const r1 = await route({ booking_id: A.b.id, action: 'cancel', reason: 'store closed that day' });
    const bA = await booking(A.b.id);
    ok('C2-A: cancelling an authorized hold is a SUCCESS (200), not 409 state_changed', r1.statusCode === 200 && r1.body && r1.body.ok === true && r1.body.refund_status === 'auth_released' && !r1.body.idempotent, `${r1.statusCode} ${JSON.stringify(r1.body).slice(0, 200)}`);
    ok('C2-A: the booking is cancelled with its metadata (cancelled_at, reason), never refunded', bA.status === 'cancelled' && !!bA.cancelled_at && bA.cancel_reason === 'store closed that day' && bA.refund_id === null, JSON.stringify(bA));
    ok('C2-A: exactly one PaymentIntent cancel, zero refunds, one cancellation email', stripeCalls(/\/cancel$/) === 1 && stripeCalls(/\/refunds/) === 0 && spy.calls.resend.length === 1, JSON.stringify({ stripe: spy.calls.stripe.map(c => c.url.split('/v1/')[1]), mails: spy.calls.resend.length }));
    const r2 = await route({ booking_id: A.b.id, action: 'cancel' });
    ok('C2-A: a replay is refused truthfully (already cancelled) with no further provider call', r2.statusCode === 409 && /already cancelled/.test(String(r2.body && r2.body.error)) && stripeCalls(/\/cancel$/) === 1, `${r2.statusCode} ${JSON.stringify(r2.body).slice(0, 120)}`);
    ok('C2-A: no reconciliation case was opened for the clean release', (await q(`SELECT id FROM reconciliation_cases WHERE dedupe_key = $1`, ['transition:' + A.b.id])).length === 0);

    const D = await authorize('c2a-decline');
    spy.fixtures.paymentIntents[D.pi] = canceledPi(D.pi);
    spy.calls.stripe.length = 0; spy.calls.resend.length = 0;
    const r3 = await route({ booking_id: D.b.id, action: 'decline', reason: 'no room' });
    const bD = await booking(D.b.id);
    ok('C2-A: declining an authorized hold is a SUCCESS too: booking declined, one cancel, no refund, one email', r3.statusCode === 200 && bD.status === 'declined' && stripeCalls(/\/cancel$/) === 1 && stripeCalls(/\/refunds/) === 0 && spy.calls.resend.length === 1, `${r3.statusCode} ${bD.status} ${JSON.stringify(r3.body).slice(0, 120)}`);

    // manual confirmation of a hold (capture): auto-confirm OFF, then ON (capture-side confirm)
    const br = await row1(`SELECT default_coi_url, default_coi_expires, coi_verification_status FROM brands WHERE id = $1`, [BRAND1]);
    brandCoiBefore = br;
    await rest(`brands?id=eq.${BRAND1}`, { method: 'PATCH', body: JSON.stringify({ default_coi_url: 'brands/lifecycle.pdf', default_coi_expires: '2028-12-31', coi_verification_status: 'approved' }) });
    const M = await authorize('c2c');
    spy.fixtures.paymentIntents[M.pi] = capturedPi(M.pi, M.ch);
    spy.calls.stripe.length = 0; spy.calls.resend.length = 0;
    const r4 = await route({ booking_id: M.b.id, action: 'confirm' });
    const bM = await booking(M.b.id), dM = await demos(M.b.id), oM = await outbox(M.b.id);
    ok('C2-A (auto-confirm OFF): confirming a hold captures, promotes, confirms -> 200 with the demo id', r4.statusCode === 200 && r4.body && r4.body.demo_id && bM.status === 'confirmed' && bM.payment_status === 'paid' && dM.length === 1 && dM[0].id === r4.body.demo_id, `${r4.statusCode} ${JSON.stringify(r4.body).slice(0, 160)} ${JSON.stringify({ bM, dM })}`);
    ok('C2-A (auto-confirm OFF): one capture, the outbox row finished as generation 2, payment notice + confirmation sent', stripeCalls(/\/capture$/) === 1 && oM.status === 'done' && oM.generation === 2 && spy.calls.resend.length === 2, JSON.stringify({ o: oM, mails: spy.calls.resend.map(m => m.subject) }));

    await setAutoConfirm(true);
    const N = await authorize('c2d');
    spy.fixtures.paymentIntents[N.pi] = capturedPi(N.pi, N.ch);
    spy.calls.stripe.length = 0; spy.calls.resend.length = 0;
    const r5 = await route({ booking_id: N.b.id, action: 'confirm' });
    const bN = await booking(N.b.id), dN = await demos(N.b.id);
    ok('C2-A (auto-confirm ON): the capture-side drain confirms first; the route converges (already_applied) -> 200, ONE demo, no capacity conflict', r5.statusCode === 200 && r5.body && r5.body.demo_id && !r5.body.idempotent && bN.status === 'confirmed' && dN.length === 1 && dN[0].id === r5.body.demo_id, `${r5.statusCode} ${JSON.stringify(r5.body).slice(0, 160)} demos=${dN.length}`);
    ok('C2-A (auto-confirm ON): one capture; the route still sends its confirmation (this request did the capture)', stripeCalls(/\/capture$/) === 1 && r5.body.email_sent === true, JSON.stringify(spy.calls.resend.map(m => m.subject)));
    await setAutoConfirm(false);
  }

  // ===========================================================================================
  // ===========================================================================================
  console.log('\n— H1: after a successful capture the outcome is truthful, even when the confirmation cannot be verified —');
  {
    const ownerEvents = async (id) => (await q(`SELECT id FROM notification_events WHERE booking_id = $1 AND kind = 'owner_booking_created'`, [id])).length;
    // (a) genuinely full BEFORE the capture: refused up front, zero capture calls, nothing charged
    const F = await authorize('h1-full');
    await q(`INSERT INTO demos (retailer_id, venue_id, brand_id, company_name, contact_name, contact_email, demo_date, demo_time, duration_hours, status, confirmed_at)
             VALUES ($1, $2, $3, 'Blocker', 'Rep', $4, $5, $6, 1, 'confirmed', now())`, [KEEPS_RETAILER, KEEPS_VENUE, BRAND1, RUN + '@fixture.test', F.b.demo_date, F.b.demo_time]);
    spy.fixtures.paymentIntents[F.pi] = capturedPi(F.pi, F.ch);
    spy.calls.stripe.length = 0;
    const rf = await route({ booking_id: F.b.id, action: 'confirm' });
    ok('H1 (a): a slot that is full before the capture is refused with ZERO capture calls and the hold untouched', rf.statusCode === 409 && rf.body && rf.body.error === 'slot_at_capacity' && stripeCalls(/\/capture$/) === 0 && (await booking(F.b.id)).status === 'held', `${rf.statusCode} ${JSON.stringify(rf.body).slice(0, 120)} captures=${stripeCalls(/\/capture$/)}`);
    await q(`DELETE FROM demos WHERE company_name = 'Blocker' AND venue_id = $1 AND demo_date = $2`, [KEEPS_VENUE, F.b.demo_date]);
    ok('H1: an authorized hold has exactly ONE owner_booking_created event (0080)', (await ownerEvents(F.b.id)) === 1);

    // a fetch wrapper that (1) fails the route's OWN confirm transition once, after the capture, and
    // (2) proves the old post-capture read-back is gone
    const realFetch = globalThis.fetch;
    let failConfirmOnce = false, readBacks = 0;
    globalThis.fetch = async (url, opts = {}) => {
      const u = String(url);
      if (u.includes('/rest/v1/bookings?id=eq.') && u.includes('select=status,payment_status') && (opts.method || 'GET') === 'GET') { readBacks++; throw new Error('injected read failure'); }
      if (failConfirmOnce && u.includes('/rpc/booking_transition') && String(opts.body || '').includes('"p_action":"confirm"')) { failConfirmOnce = false; const body = { message: 'injected_transition_failure' }; return { ok: false, status: 500, json: async () => body, text: async () => JSON.stringify(body) }; }
      return realFetch(url, opts);
    };
    try {
      // (b) auto-confirm OFF: capture succeeds, the drain promotes to pending, the route's confirm transition fails
      const G = await authorize('h1-off');
      spy.fixtures.paymentIntents[G.pi] = capturedPi(G.pi, G.ch);
      spy.calls.stripe.length = 0; failConfirmOnce = true;
      const rg = await route({ booking_id: G.b.id, action: 'confirm' });
      const bG = await booking(G.b.id), dG = await demos(G.b.id);
      const caseG = await q(`SELECT id, reason FROM reconciliation_cases WHERE dedupe_key = $1`, ['transition:' + G.b.id]);
      created.caseKeys.push('transition:' + G.b.id);
      ok('H1 (b, auto-confirm OFF): the response is capture_succeeded_confirmation_unverified — captured:true, never a capacity instruction, never "nothing was charged"', rg.statusCode === 500 && rg.body && rg.body.error === 'capture_succeeded_confirmation_unverified' && rg.body.captured === true && !/at capacity|Cannot confirm|nothing was charged/i.test(rg.body.message || '') && /Do not decline it or ask the brand to rebook/.test(rg.body.message || '') && /WAS captured/.test(rg.body.message || ''), `${rg.statusCode} ${JSON.stringify(rg.body).slice(0, 220)}`);
      ok('H1 (b): one capture, zero refunds, the booking is paid and promoted (pending), no demo invented, ONE reconciliation case with the specific reason', stripeCalls(/\/capture$/) === 1 && stripeCalls(/\/refunds/) === 0 && bG.status === 'pending' && bG.payment_status === 'paid' && dG.length === 0 && caseG.length === 1 && caseG[0].reason === 'capture_succeeded_confirmation_unverified' && rg.body.reconciliation_case_id === caseG[0].id, JSON.stringify({ bG: [bG.status, bG.payment_status], dG, caseG }));
      const rg2 = await route({ booking_id: G.b.id, action: 'confirm' });
      ok('H1 (b): a retried confirm converges — 200 with the demo, exactly one demo, no second capture, no second case', rg2.statusCode === 200 && rg2.body.demo_id && (await demos(G.b.id)).length === 1 && stripeCalls(/\/capture$/) === 1 && (await q(`SELECT id FROM reconciliation_cases WHERE dedupe_key = $1`, ['transition:' + G.b.id])).length === 1, `${rg2.statusCode} ${JSON.stringify(rg2.body).slice(0, 120)}`);
      ok('H1 (b): a captured hold still has exactly ONE owner_booking_created event (capture is not a second booking)', (await ownerEvents(G.b.id)) === 1);

      // (c) auto-confirm ON: the capture-side drain confirms and creates the demo; the route's transition fails
      await setAutoConfirm(true);
      const Hh = await authorize('h1-on');
      spy.fixtures.paymentIntents[Hh.pi] = capturedPi(Hh.pi, Hh.ch);
      spy.calls.stripe.length = 0; failConfirmOnce = true;
      const rh = await route({ booking_id: Hh.b.id, action: 'confirm' });
      const bH = await booking(Hh.b.id), dH = await demos(Hh.b.id);
      created.caseKeys.push('transition:' + Hh.b.id);
      ok('H1 (c, auto-confirm ON): unverified outcome reported; the booking is already confirmed with exactly ONE demo; one capture; one case', rh.statusCode === 500 && rh.body.error === 'capture_succeeded_confirmation_unverified' && bH.status === 'confirmed' && dH.length === 1 && stripeCalls(/\/capture$/) === 1 && (await q(`SELECT id FROM reconciliation_cases WHERE dedupe_key = $1`, ['transition:' + Hh.b.id])).length === 1, `${rh.statusCode} ${JSON.stringify(rh.body).slice(0, 160)} demos=${dH.length}`);
      const rh2 = await route({ booking_id: Hh.b.id, action: 'confirm' });
      ok('H1 (c): a retried confirm is refused truthfully up front (already confirmed), still exactly one demo, no capacity conflict', rh2.statusCode === 409 && /already confirmed/.test(String(rh2.body && rh2.body.error)) && (await demos(Hh.b.id)).length === 1 && stripeCalls(/\/capture$/) === 1, `${rh2.statusCode} ${JSON.stringify(rh2.body).slice(0, 120)}`);
      await setAutoConfirm(false);

      // (d) the old read-back is gone: a failing read cannot influence the outcome any more
      const R = await authorize('h1-read');
      spy.fixtures.paymentIntents[R.pi] = capturedPi(R.pi, R.ch);
      spy.calls.stripe.length = 0; readBacks = 0;
      const rr = await route({ booking_id: R.b.id, action: 'confirm' });
      ok('H1 (d): no post-capture status read-back exists (a poisoned read is never consulted); the confirm succeeds with its demo', rr.statusCode === 200 && rr.body.demo_id && readBacks === 0 && (await demos(R.b.id)).length === 1 && stripeCalls(/\/capture$/) === 1, `${rr.statusCode} readBacks=${readBacks}`);
    } finally { globalThis.fetch = realFetch; await setAutoConfirm(false); }
  }

  // ===========================================================================================
  console.log('\n— R4-02: the WHOLE capture outcome is truthful — reads before money, captured / not captured / unknown —');
  {
    const OWNER_EMAIL = 'david@demohubhq.com';
    const cases = (key) => q(`SELECT id, reason, details FROM reconciliation_cases WHERE dedupe_key = $1`, [key]);
    const heldUntouched = async (id) => { const b = await booking(id); return b.status === 'held' && b.payment_status === 'authorized'; };
    const resp = (status, body, text) => ({ ok: status < 400, status, text: async () => text != null ? text : JSON.stringify(body), json: async () => body });
    // one wrapper the cases below configure: fail / empty / malform a required read, lose a Stripe
    // response on the wire. Counted into the spy's Stripe call log so call-count assertions hold.
    const wrap = { venue: null, retailer: null, captureThrow: false, piThrow: false };
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url, opts = {}) => {
      const u = String(url); const m = String(opts.method || 'GET').toUpperCase();
      if (m === 'GET' && u.includes('/rest/v1/venues?id=eq.') && u.includes('select=name,demo_fee') && wrap.venue) { const w = wrap.venue; wrap.venue = null; return w(); }
      if (m === 'GET' && u.includes('/rest/v1/retailers?id=eq.') && u.includes('cancellation_mode') && wrap.retailer) { const w = wrap.retailer; wrap.retailer = null; return w(); }
      if (m === 'POST' && /\/payment_intents\/[^/]+\/capture$/.test(u) && wrap.captureThrow) { wrap.captureThrow = false; spy.calls.stripe.push({ url: u, method: 'POST', body: '' }); throw new Error('socket hang up (capture response lost)'); }
      if (m === 'GET' && /\/payment_intents\/[^/?]+\?/.test(u) && wrap.piThrow && (wrap.piThrow === true || u.includes(encodeURIComponent(wrap.piThrow)))) { wrap.piThrow = false; spy.calls.stripe.push({ url: u, method: 'GET', body: '' }); throw new Error('ECONNRESET (verification unavailable)'); }
      return realFetch(url, opts);
    };
    const fresh = async (tag) => { const X = await authorize(tag); spy.fixtures.paymentIntents[X.pi] = capturedPi(X.pi, X.ch); spy.calls.stripe.length = 0; return X; };
    let coiVid = null, brandCoiRefBefore = null, coiCaseIds = [];
    try {
      // ---- required reads and inputs are settled BEFORE any money moves (rows 1–4 of Codex's table) ----
      const A = await fresh('r402-venue-err');
      wrap.venue = () => resp(503, { message: 'injected venue read failure' });
      const ra = await route({ booking_id: A.b.id, action: 'confirm' });
      ok('R4-02 (1): a failed venue read is refused BEFORE the capture — 503 booking_context_unavailable, zero capture calls, hold untouched, no case', ra.statusCode === 503 && ra.body.error === 'booking_context_unavailable' && /nothing was charged/i.test(ra.body.message) && stripeCalls(/\/capture$/) === 0 && await heldUntouched(A.b.id) && (await cases('capture-unknown:' + A.b.id)).length === 0 && (await cases('transition:' + A.b.id)).length === 0, JSON.stringify(ra.body));
      const B = await fresh('r402-ret-err');
      wrap.retailer = () => resp(503, { message: 'injected retailer read failure' });
      const rb = await route({ booking_id: B.b.id, action: 'confirm' });
      ok('R4-02 (2): a failed retailer read is refused before the capture — zero capture calls, hold untouched', rb.statusCode === 503 && rb.body.error === 'booking_context_unavailable' && stripeCalls(/\/capture$/) === 0 && await heldUntouched(B.b.id), JSON.stringify(rb.body));
      const C = await fresh('r402-venue-empty');
      wrap.venue = () => resp(200, []);
      const rc = await route({ booking_id: C.b.id, action: 'confirm' });
      ok('R4-02 (3): an EMPTY venue read is refused before the capture (no fee source) — zero capture calls', rc.statusCode === 503 && rc.body.error === 'booking_context_unavailable' && stripeCalls(/\/capture$/) === 0 && await heldUntouched(C.b.id), JSON.stringify(rc.body));
      const C2 = await fresh('r402-venue-malformed');
      wrap.venue = () => resp(200, null, '<html>upstream error</html>');
      const rc2 = await route({ booking_id: C2.b.id, action: 'confirm' });
      ok('R4-02 (3b): a MALFORMED venue read (non-JSON body) is refused before the capture — zero capture calls', rc2.statusCode === 503 && rc2.body.error === 'booking_context_unavailable' && stripeCalls(/\/capture$/) === 0 && await heldUntouched(C2.b.id), JSON.stringify(rc2.body));
      const C3 = await fresh('r402-venue-nofee');
      wrap.venue = () => resp(200, [{ name: 'No fee venue', demo_fee: null }]);
      const rc3 = await route({ booking_id: C3.b.id, action: 'confirm' });
      ok('R4-02 (3c): a venue WITHOUT a fee is refused before the capture — 400 venue_missing_fee, zero capture calls', rc3.statusCode === 400 && rc3.body.error === 'venue_missing_fee' && stripeCalls(/\/capture$/) === 0 && await heldUntouched(C3.b.id), JSON.stringify(rc3.body));
      const D = await fresh('r402-bad-fee');
      const rd1 = await route({ booking_id: D.b.id, action: 'confirm', demo_fee: 'not-a-number' });
      const rd2 = await route({ booking_id: D.b.id, action: 'confirm', demo_fee: -5 });
      const rd3 = await route({ booking_id: D.b.id, action: 'confirm', demo_fee: 'Infinity' });
      ok('R4-02 (4): an invalid demo-fee override (NaN / negative / non-finite) is refused BEFORE the capture — 400 venue_missing_fee, zero capture calls', [rd1, rd2, rd3].every(r => r.statusCode === 400 && r.body.error === 'venue_missing_fee' && /nothing was charged/i.test(r.body.message)) && stripeCalls(/\/capture$/) === 0 && await heldUntouched(D.b.id), JSON.stringify([rd1.body, rd2.body, rd3.body]));
      const rd4 = await route({ booking_id: D.b.id, action: 'confirm', demo_fee: 45 });
      ok('R4-02 (4): the same booking then confirms normally with a valid override — one capture, one demo', rd4.statusCode === 200 && rd4.body.demo_id && stripeCalls(/\/capture$/) === 1 && (await demos(D.b.id)).length === 1, JSON.stringify(rd4.body));

      // ---- row 5: the follow-up PaymentIntent retrieval is unavailable after the capture request ----
      const E = await fresh('r402-verify-unavail');
      wrap.piThrow = true;
      const re = await route({ booking_id: E.b.id, action: 'confirm' });
      const caseE = await cases('capture-unknown:' + E.b.id); created.caseKeys.push('capture-unknown:' + E.b.id);
      ok('R4-02 (5): verification unavailable → 502 payment_outcome_unknown: NOT "nothing was charged", NOT captured:true, one recorded case with the PI, hold row untouched, no demo, no transition', re.statusCode === 502 && re.body.error === 'payment_outcome_unknown' && re.body.payment_uncertain === true && re.body.captured === undefined && !/nothing was charged/i.test(re.body.message) && /may have completed/.test(re.body.message) && /Do NOT charge/.test(re.body.message) && re.body.reconciliation_recorded === true && caseE.length === 1 && caseE[0].id === re.body.reconciliation_case_id && caseE[0].reason === 'capture_outcome_unknown' && caseE[0].details.payment_intent_id === E.pi && await heldUntouched(E.b.id) && (await demos(E.b.id)).length === 0 && stripeCalls(/\/capture$/) === 1, JSON.stringify({ body: re.body, caseE }));
      const re2 = await route({ booking_id: E.b.id, action: 'confirm' });
      ok('R4-02 (5): the retry converges once Stripe answers — 200 with the demo, exactly one demo, the same PI-scoped capture key (no new identity), still ONE case', re2.statusCode === 200 && re2.body.demo_id && (await demos(E.b.id)).length === 1 && (await booking(E.b.id)).status === 'confirmed' && spy.calls.stripe.filter(c => /\/capture$/.test(c.url)).length === 2 && (await cases('capture-unknown:' + E.b.id)).length === 1, JSON.stringify(re2.body));
      // the same with auto-confirm ON: the recovery path is the capture-side drain, the route converges as already_applied
      await setAutoConfirm(true);
      const F = await fresh('r402-verify-unavail-auto');
      wrap.piThrow = true;
      const rf = await route({ booking_id: F.b.id, action: 'confirm' });
      created.caseKeys.push('capture-unknown:' + F.b.id);
      const rf2 = await route({ booking_id: F.b.id, action: 'confirm' });
      ok('R4-02 (5, auto-confirm ON): unknown outcome reported and recorded; the retry converges to confirmed with exactly ONE demo and one case', rf.statusCode === 502 && rf.body.error === 'payment_outcome_unknown' && rf.body.reconciliation_recorded === true && rf2.statusCode === 200 && (await booking(F.b.id)).status === 'confirmed' && (await demos(F.b.id)).length === 1 && (await cases('capture-unknown:' + F.b.id)).length === 1, JSON.stringify({ rf: rf.body, rf2: rf2.body }));
      await setAutoConfirm(false);

      // ---- the capture RESPONSE is lost on the wire: Stripe's retrieved state decides, never the request ----
      const G = await fresh('r402-lost-notcaptured');
      spy.fixtures.paymentIntents[G.pi] = { ...capturedPi(G.pi, G.ch), status: 'requires_capture', amount_received: 0 };
      wrap.captureThrow = true;
      const rg = await route({ booking_id: G.b.id, action: 'confirm' });
      ok('R4-02 (6a): capture response lost, Stripe says requires_capture → authoritatively NOT captured: 502 capture_failed, captured:false, "nothing was charged" is TRUE, no case, hold untouched', rg.statusCode === 502 && rg.body.error === 'capture_failed' && rg.body.captured === false && /nothing was charged/.test(rg.body.message) && (await cases('capture-unknown:' + G.b.id)).length === 0 && await heldUntouched(G.b.id) && (await demos(G.b.id)).length === 0, JSON.stringify(rg.body));
      const Hh = await fresh('r402-lost-captured');
      wrap.captureThrow = true;
      const rh = await route({ booking_id: Hh.b.id, action: 'confirm' });
      ok('R4-02 (6b): capture response lost, Stripe says succeeded → treated as CAPTURED: the confirm completes with its demo, one capture request, no case', rh.statusCode === 200 && rh.body.demo_id && (await demos(Hh.b.id)).length === 1 && (await booking(Hh.b.id)).payment_status === 'paid' && stripeCalls(/\/capture$/) === 1 && (await cases('capture-unknown:' + Hh.b.id)).length === 0, JSON.stringify(rh.body));
      const I = await fresh('r402-lost-unknown');
      wrap.captureThrow = true; wrap.piThrow = true;
      const ri = await route({ booking_id: I.b.id, action: 'confirm' });
      created.caseKeys.push('capture-unknown:' + I.b.id);
      const ri2 = await route({ booking_id: I.b.id, action: 'confirm' });
      ok('R4-02 (6c): capture response lost AND verification unavailable → payment_outcome_unknown with one case; the retry converges with one demo', ri.statusCode === 502 && ri.body.error === 'payment_outcome_unknown' && ri.body.reconciliation_recorded === true && ri2.statusCode === 200 && (await demos(I.b.id)).length === 1 && (await cases('capture-unknown:' + I.b.id)).length === 1, JSON.stringify({ ri: ri.body, ri2: ri2.body }));

      // ---- Stripe answers: a 5xx is uncertain (verify decides); a 4xx refusal is definitive ----
      const J = await fresh('r402-5xx');
      spy.faults.push({ url: '/capture', method: 'POST', status: 503, message: 'injected stripe 503', once: true });
      const rj = await route({ booking_id: J.b.id, action: 'confirm' });
      ok('R4-02 (7a): Stripe 5xx on the capture, retrieved PI succeeded → captured: 200 with the demo, no case', rj.statusCode === 200 && rj.body.demo_id && (await demos(J.b.id)).length === 1 && (await cases('capture-unknown:' + J.b.id)).length === 0, JSON.stringify(rj.body));
      const K = await fresh('r402-4xx');
      spy.faults.push({ url: '/capture', method: 'POST', status: 402, message: 'injected: authorization expired', once: true });
      const rk = await route({ booking_id: K.b.id, action: 'confirm' });
      ok('R4-02 (7b): Stripe 4xx refusal → definitive: 502 capture_failed "nothing was charged", NO verification call needed, no case, hold untouched', rk.statusCode === 502 && rk.body.error === 'capture_failed' && rk.body.captured === false && /nothing was charged/.test(rk.body.message) && (await cases('capture-unknown:' + K.b.id)).length === 0 && await heldUntouched(K.b.id), JSON.stringify(rk.body));
      const L = await fresh('r402-processing');
      spy.fixtures.paymentIntents[L.pi] = { ...capturedPi(L.pi, L.ch), status: 'processing', amount_received: 0 };
      const rl = await route({ booking_id: L.b.id, action: 'confirm' });
      created.caseKeys.push('capture-unknown:' + L.b.id);
      ok('R4-02 (7c): a non-terminal PI state (processing) after the capture request is UNKNOWN, not "not charged": payment_outcome_unknown + one case', rl.statusCode === 502 && rl.body.error === 'payment_outcome_unknown' && (await cases('capture-unknown:' + L.b.id)).length === 1 && await heldUntouched(L.b.id), JSON.stringify(rl.body));

      // ---- the case cannot be recorded: say so ----
      const M = await fresh('r402-case-unrecorded');
      wrap.piThrow = true;
      spy.faults.push({ url: '/rpc/_open_case', method: 'POST', status: 500, message: 'injected case write failure', once: true });
      const rm = await route({ booking_id: M.b.id, action: 'confirm' });
      ok('R4-02 (8): when the reconciliation case cannot be recorded the response says so honestly (reconciliation_recorded:false, "could NOT be recorded"), still payment_outcome_unknown', rm.statusCode === 502 && rm.body.error === 'payment_outcome_unknown' && rm.body.reconciliation_recorded === false && rm.body.reconciliation_case_id === null && /could NOT be recorded/.test(rm.body.message) && (await cases('capture-unknown:' + M.b.id)).length === 0, JSON.stringify(rm.body));
      const rm2 = await route({ booking_id: M.b.id, action: 'confirm' });
      ok('R4-02 (8): the retry converges — one demo', rm2.statusCode === 200 && (await demos(M.b.id)).length === 1);

      // ---- the OTHER caller: COI auto-confirm in admin-auth honours the shared contract ----
      {
        const ex = await rest('retailers?slug=eq.__owner__&select=id');
        const ownerRetailerId = (one(ex.json) && one(ex.json).id) || one((await rest('retailers', { method: 'POST', body: JSON.stringify({ slug: '__owner__', name: 'Demohub Owner (system)', billing_email: OWNER_EMAIL }) })).json).id;
        const tok = one((await rest('admin_tokens', { method: 'POST', body: JSON.stringify({ email: OWNER_EMAIL, retailer_id: ownerRetailerId }) })).json);
        const verified = await callRoute('admin-auth.js', req({ body: { action: 'owner-verify', token: tok.token } }));
        const ownerCookie = verified.cookie('dh_owner_session');
        ok('R4-02 (9): setup — owner session', !!ownerCookie, JSON.stringify(verified.body));
        brandCoiRefBefore = await row1(`SELECT current_coi_verification_id FROM brands WHERE id = $1`, [BRAND1]);
        await setAutoConfirm(true);
        const N = await fresh('r402-coi-auto');
        coiVid = crypto.randomUUID();
        const up = await rpc('finalize_coi_upload', { p_brand_id: BRAND1, p_verification_id: coiVid, p_storage_path: `brands/${BRAND1}/${coiVid}.pdf`, p_content_sha256: 'sha-' + coiVid.slice(0, 8), p_expires: null, p_status: 'pending' });
        ok('R4-02 (9): setup — pending COI version for the fixture brand', up.status < 300, JSON.stringify(up.json).slice(0, 200));
        wrap.piThrow = N.pi;   // only THIS hold's verification is unavailable; the sweep also captures the block's other held fixtures
        const rv = await callRoute('admin-auth.js', req({ body: { action: 'owner-coi-review', verification_id: coiVid, decision: 'approved', expiry: '2028-12-31' }, cookies: { dh_owner_session: ownerCookie } }));
        created.caseKeys.push('capture-unknown:' + N.b.id);
        coiCaseIds = Array.isArray(rv.body && rv.body.capture_cases) ? rv.body.capture_cases.filter(Boolean) : [];
        const caseN = await cases('capture-unknown:' + N.b.id);
        ok('R4-02 (9): COI approval with an UNKNOWN capture outcome counts it in uncertain_holds separately from the holds it did capture (the sweep also meets the other held fixtures of this block: unfixtured PIs are UNKNOWN, requires_capture is uncaptured), lists the case, warns the reviewer; the booking stays held/authorized; one case', rv.statusCode === 200 && rv.body.ok === true && rv.body.uncertain_holds >= 1 && Array.isArray(rv.body.capture_cases) && rv.body.capture_cases.includes(caseN[0]?.id) && /may have been charged/.test(rv.body.message) && caseN.length === 1 && await heldUntouched(N.b.id) && spy.calls.stripe.filter(c => c.url.includes(N.pi) && /\/capture$/.test(c.url)).length === 1, JSON.stringify({ body: rv.body, caseN }));
        const rn2 = await route({ booking_id: N.b.id, action: 'confirm' });
        ok('R4-02 (9): a later retailer confirm converges the same hold — confirmed, exactly one demo, still one case', rn2.statusCode === 200 && (await booking(N.b.id)).status === 'confirmed' && (await demos(N.b.id)).length === 1 && (await cases('capture-unknown:' + N.b.id)).length === 1, JSON.stringify(rn2.body));
        await setAutoConfirm(false);
      }
      ok('R4-02: no duplicate captures anywhere in this block — every capture request in the log is a distinct PI or a same-key retry after an unknown outcome', (() => { const byPi = {}; for (const c of spy.calls.stripe) { const m = c.url.match(/payment_intents\/([^/]+)\/capture$/); if (m) byPi[m[1]] = (byPi[m[1]] || 0) + 1; } return Object.values(byPi).every(n => n <= 2); })());
    } finally {
      globalThis.fetch = realFetch; wrap.venue = wrap.retailer = null; wrap.captureThrow = wrap.piThrow = false;
      await setAutoConfirm(false);
      if (coiCaseIds.length) await q(`DELETE FROM reconciliation_cases WHERE id = ANY($1::uuid[])`, [coiCaseIds]).catch(() => {});
      if (coiVid) {
        await rest(`brands?id=eq.${BRAND1}`, { method: 'PATCH', body: JSON.stringify({ current_coi_verification_id: brandCoiRefBefore ? brandCoiRefBefore.current_coi_verification_id : null }) });
        await q(`DELETE FROM notification_events WHERE transition_id LIKE $1`, [coiVid + '%']).catch(() => {});
        await q(`DELETE FROM coi_verifications WHERE id = $1`, [coiVid]).catch(() => {});
      }
    }
  }

  console.log('\n— C2-B: a successful refund followed by a logical refusal is recorded and reported —');
  {
    const P = await paidUndrained('c2b');
    await ful.drainFulfillments({ limit: 10, group: P.gid });
    ok('C2-B: setup — a paid booking awaiting manual confirmation', (await booking(P.b.id)).status === 'pending' && (await booking(P.b.id)).payment_status === 'paid');
    // park the DECLINE at its transition (after its refund step), let a CONFIRM land, then resume
    const realFetch = globalThis.fetch;
    let gate = null, gateResolve = null, hit = 0;
    globalThis.fetch = async (url, opts = {}) => {
      const u = String(url);
      if (gate && u.includes('/rpc/booking_transition') && String(opts.body || '').includes('"p_action":"decline"')) { hit++; await gate; }
      return realFetch(url, opts);
    };
    gate = new Promise(r => { gateResolve = r; });
    spy.calls.stripe.length = 0; spy.calls.resend.length = 0;
    const declining = route({ booking_id: P.b.id, action: 'decline', reason: 'cannot host' });
    for (let i = 0; i < 200 && hit === 0; i++) await sleep(50);
    ok('C2-B: the decline is parked at its transition AFTER its refund was submitted', hit === 1 && stripeCalls(/\/refunds/) === 1, `hit=${hit} refunds=${stripeCalls(/\/refunds/)}`);
    const conf = await route({ booking_id: P.b.id, action: 'confirm' });
    ok('C2-B: meanwhile the confirm applies with its demo', conf.statusCode === 200 && conf.body && conf.body.demo_id, `${conf.statusCode}`);
    gateResolve(); gate = null;
    const dec = await declining;
    globalThis.fetch = realFetch;
    const bP = await booking(P.b.id), dP = await demos(P.b.id);
    const cases = await q(`SELECT id, kind, reason FROM reconciliation_cases WHERE dedupe_key = $1`, ['transition:' + P.b.id]);
    created.caseKeys.push('transition:' + P.b.id);
    ok('C2-B: the decline answers 409 that SAYS the refund was submitted and names ONE reconciliation case', dec.statusCode === 409 && dec.body && dec.body.error === 'state_changed' && dec.body.refund_status === 'submitted' && dec.body.reconciliation_recorded === true && cases.length === 1 && dec.body.reconciliation_case_id === cases[0].id && cases[0].kind === 'settlement_exception' && /refused_after_refund/.test(cases[0].reason), `${dec.statusCode} ${JSON.stringify(dec.body).slice(0, 220)} cases=${JSON.stringify(cases)}`);
    ok('C2-B: the booking and its demo remain confirmed/active (no silent downgrade), exactly one refund call', bP.status === 'confirmed' && dP.length === 1 && dP[0].status === 'confirmed' && stripeCalls(/\/refunds/) === 1, JSON.stringify({ bP: bP.status, dP }));
    ok('C2-B: a replayed decline on the now-confirmed booking is refused up front and opens no second case', (await route({ booking_id: P.b.id, action: 'decline' })).statusCode === 409 && (await q(`SELECT id FROM reconciliation_cases WHERE dedupe_key = $1`, ['transition:' + P.b.id])).length === 1);
  }

  // ===========================================================================================
  console.log('\n— C3: a legitimately advanced booking does not strand the payment-notice retry —');
  {
    const P = await paidUndrained('c3');
    const c1 = one((await rpc('claim_fulfillments', { p_owner: 'w1', p_lease_seconds: 300, p_limit: 50, p_group: P.gid })).json);
    const row = (Array.isArray(c1) ? c1 : [c1]).find(r => r && r.booking_id === P.b.id);
    spy.faults.push({ url: 'api.resend.com', method: 'POST', status: 500, message: 'injected_mail_failure', once: true });
    spy.calls.resend.length = 0;
    const first = await ful.runFulfillment({ ...row }, 'w1');
    const b1 = await booking(P.b.id), o1 = await outbox(P.b.id);
    ok('C3: the promotion applied (booking pending) but the payment notice failed -> not done, retryable, lease released', first.done === false && first.recorded === true && /email_failed|mail_send_failed/.test(first.error || '') && b1.status === 'pending' && o1.status === 'pending' && o1.lease_owner === null, JSON.stringify({ first, b1: b1.status, o1 }));
    const conf = await route({ booking_id: P.b.id, action: 'confirm' });
    ok('C3: the retailer confirms manually in between (200, demo)', conf.statusCode === 200 && conf.body && conf.body.demo_id, `${conf.statusCode}`);
    const c2 = one((await rpc('claim_fulfillments', { p_owner: 'w2', p_lease_seconds: 300, p_limit: 50, p_group: P.gid })).json);
    const row2 = (Array.isArray(c2) ? c2 : [c2]).find(r => r && r.booking_id === P.b.id);
    ok('C3: the retry is claimable (same generation, pending)', row2 && row2.generation === o1.generation && row2.target_status === 'pending', JSON.stringify(row2));
    const mailsBefore = spy.calls.resend.length;
    const second = await ful.runFulfillment({ ...row2 }, 'w2');
    const b2 = await booking(P.b.id), o2 = await outbox(P.b.id), d2 = await demos(P.b.id);
    ok('C3: the retry reports already_advanced: done, recorded, NO downgrade (still confirmed), one demo, no extra mail', second.done === true && second.recorded === true && /already_advanced/.test(second.error || '') && b2.status === 'confirmed' && d2.length === 1 && d2[0].status === 'confirmed' && o2.status === 'done' && spy.calls.resend.length === mailsBefore, JSON.stringify({ second, b2: b2.status, d2, o2, mails: spy.calls.resend.length - mailsBefore }));
    ok('C3: no retry-cap case was opened', (await q(`SELECT id FROM reconciliation_cases WHERE dedupe_key LIKE $1`, ['%' + P.b.id + '%'])).length === 0);
    // a later cancellation, then a replayed job: superseded, the retired demo stays retired
    const can = await route({ booking_id: P.b.id, action: 'cancel', force_refund: true });
    created.caseKeys.push('transition:' + P.b.id);
    const third = await ful.runFulfillment({ ...row2, demo_created: false, emails_sent: false }, 'w3');
    const b3 = await booking(P.b.id), d3 = await demos(P.b.id);
    ok('C3: after a cancel, a replayed job is superseded — no reactivated demo, booking stays cancelled', can.statusCode === 200 && /superseded/.test(third.error || '') && b3.status === 'cancelled' && d3.length === 1 && d3[0].status === 'cancelled', JSON.stringify({ can: can.statusCode, third, b3: b3.status, d3 }));
  }

  // ===========================================================================================
  console.log('\n— C4: the snapshot helper refuses incomplete or inconsistent successful reads —');
  {
    const { fetchBookingSnapshots } = await import('../api/_occurrence.js?t=' + Date.now());
    const idA = '10000000-0000-4000-8000-00000000000a', idB = '10000000-0000-4000-8000-00000000000b';
    const attempt = async (label, rows, ids = [idA], chunk = 100) => {
      let calls = 0;
      try { const m = await fetchBookingSnapshots(async () => { calls++; return { ok: true, json: async () => (Array.isArray(rows[0]) ? rows[calls - 1] : rows) }; }, ids, { chunk }); return { ok: true, m }; }
      catch (e) { return { ok: false, name: e.name, message: e.message, detail: e.detail }; }
    };
    const missing = await attempt('missing', []);
    ok('C4: a successful read that omits a requested booking is snapshot_lookup_incomplete', !missing.ok && /snapshot_lookup_incomplete/.test(missing.message), JSON.stringify(missing));
    const partial = await attempt('partial', [{ id: idA, start_at: '2026-10-12T18:00:00Z', end_at: null }]);
    ok('C4: a partial snapshot (one timestamp) is malformed', !partial.ok && /snapshot_lookup_malformed/.test(partial.message) && /partial/.test(JSON.stringify(partial.detail)), JSON.stringify(partial));
    const reversed = await attempt('reversed', [{ id: idA, start_at: '2026-10-12T18:00:00Z', end_at: '2026-10-12T17:00:00Z' }]);
    ok('C4: end before (or equal to) start is malformed', !reversed.ok && /end_not_after_start/.test(JSON.stringify(reversed.detail)), JSON.stringify(reversed));
    const later = await attempt('later chunk', [[{ id: idA, start_at: '2026-10-12T18:00:00Z', end_at: '2026-10-12T20:00:00Z' }], []], [idA, idB], 1);
    ok('C4: a later chunk that comes back empty is incomplete (the first chunk\'s row does not cover it)', !later.ok && /snapshot_lookup_incomplete/.test(later.message), JSON.stringify(later));
    const explicit = await attempt('explicit legacy', [{ id: idA, start_at: null, end_at: null }]);
    ok('C4: an explicit no-snapshot row (both NULL, from a successful read) is recorded as legacy = null, not missing', explicit.ok && explicit.m.has(idA) && explicit.m.get(idA) === null, JSON.stringify(explicit));
    const healthy = await attempt('healthy', [{ id: idA, start_at: '2026-10-12T18:00:00Z', end_at: '2026-10-12T20:00:00Z', timezone: 'America/Los_Angeles' }, { id: idA, start_at: '2026-10-12T18:00:00Z', end_at: '2026-10-12T20:00:00Z', timezone: 'America/Los_Angeles' }], [idA, idA]);
    ok('C4: healthy rows (duplicates requested once) resolve to one 2-hour snapshot', healthy.ok && healthy.m.size === 1 && (healthy.m.get(idA).end_at - healthy.m.get(idA).start_at) === 7200e3 && healthy.m.get(idA).timezone === 'America/Los_Angeles', JSON.stringify(healthy));
  }
} catch (e) {
  ok('suite ran without an unexpected exception', false, String((e && e.stack) || e).slice(0, 600));
} finally {
  console.log('\n— teardown —');
  try {
    await setAutoConfirm(false);
    if (brandCoiBefore) await rest(`brands?id=eq.${BRAND1}`, { method: 'PATCH', body: JSON.stringify(brandCoiBefore) });
    const del = async (p) => { const d = await rest(p, { method: 'DELETE', headers: { Prefer: 'return=minimal' } }); if (!d.ok) console.log('  teardown: DELETE ' + p + ' -> ' + d.status + ' ' + (d.text || '').slice(0, 120)); };
    for (const k of [...new Set(created.caseKeys)]) await del(`reconciliation_cases?dedupe_key=eq.${encodeURIComponent(k)}`);
    for (const gid of [...new Set(created.groups)]) {
      const allocs = (await rest(`payment_allocations?payment_group_id=eq.${gid}&select=id`)).json || [];
      for (const a of allocs) {
        const reqs = (await rest(`refund_requests?payment_allocation_id=eq.${a.id}&select=id`)).json || [];
        for (const rq of reqs) { await del(`reconciliation_cases?refund_request_id=eq.${rq.id}`); await del(`refund_review_actions?refund_request_id=eq.${rq.id}`); }
        const ops = (await rest(`refund_operations?payment_allocation_id=eq.${a.id}&select=id`)).json || [];
        for (const op of ops) await del(`refund_review_actions?refund_operation_id=eq.${op.id}`);
        await del(`refund_requests?payment_allocation_id=eq.${a.id}`);
        await del(`refund_operations?payment_allocation_id=eq.${a.id}`);
      }
      await del(`booking_fulfillments?payment_group_id=eq.${gid}`);
      await del(`reconciliation_cases?payment_group_id=eq.${gid}`);
      await del(`payment_attempts?payment_group_id=eq.${gid}`);
      await del(`payment_allocations?payment_group_id=eq.${gid}`);
      await del(`payment_groups?id=eq.${gid}`);
    }
    for (const id of [...new Set(created.bookings)]) {
      await del(`demos?booking_id=eq.${id}`);
      await del(`notification_deliveries?booking_id=eq.${id}`);
      await del(`notification_events?booking_id=eq.${id}`);
      await del(`booking_fulfillments?booking_id=eq.${id}`);
      await del(`bookings?id=eq.${id}`);
    }
    await del(`admin_sessions?email=eq.${encodeURIComponent(staffEmail)}`);
    await del(`admin_tokens?email=eq.${encodeURIComponent(staffEmail)}`);
    await del(`retailer_admins?email=eq.${encodeURIComponent(staffEmail)}`);
    const left = await q(`SELECT count(*)::int AS n FROM bookings WHERE brand_name = $1`, ['Lifecycle ' + RUN]);
    ok('teardown: fixture gone', left[0].n === 0, JSON.stringify(left));
  } catch (e) { console.log('teardown error:', (e && e.message) || e); }
  try { await ctl.end(); } catch (_) {}
  spy.restore();
}
process.exit(summary('fulfillment lifecycle (Codex C1–C4)') ? 0 : 1);
