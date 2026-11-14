// tests/pay_link_identity.test.mjs: the saved payment link on the booking page is bound to who and what it was
// opened for. Offline: the page's own functions are extracted from r/gus/index.html and run as they are against a
// mocked sessionStorage, fetch and a minimal document. No Stripe call, no database, no network.
// (Codex final closeout 2026-11-14, "Required fix for the saved payment link" and its acceptance tests.)
//
//   OLD CODE       the mismatch is first reproduced on the page as it was at 75310cd (read from git when available)
//   CART           cart A's link is never followed for cart B; a changed or overlapping set never reuses it;
//                  the same set in another order (or letter case) is the same set
//   CUSTOMER       another signed-in customer, or nobody signed in: the link is neither offered nor followed
//   STORE          no reuse across stores
//   STORAGE        an old record without identity, a malformed, incomplete, too-old or future-dated record, and
//                  storage that throws or does not exist: no crash, no navigation
//   RESUME         a matching open session is resumed as the same session, with one request and no second link
//   BOTH REFUSALS  attempt_in_progress and already_in_checkout obey the same checks
//   NOTICE         the notice (after a cancel return, a reload, the Back button, a cached page) uses the same checks,
//                  shows at most once, and its click checks again at click time
//   PAID           the paid return and a terminal answer clear the saved link
//
// Run from the repository root:  node tests/pay_link_identity.test.mjs   (no credentials needed)
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import vm from 'node:vm';

let _pass = 0, _fail = 0;
const ok = (n, c, d) => { if (c) { _pass++; console.log('  ok   ' + n); } else { _fail++; console.log('  FAIL ' + n + (d ? ' ' + d : '')); } };

const PAGE = readFileSync(resolve('r/gus/index.html'), 'utf8');

function extractFn(src, name) {
  const i = src.indexOf(`function ${name}(`);
  if (i < 0) throw new Error('page function not found: ' + name);
  const open = src.indexOf('{', src.indexOf(')', i));
  let depth = 0, j = open;
  for (; j < src.length; j++) { if (src[j] === '{') depth++; else if (src[j] === '}') { depth--; if (depth === 0) break; } }
  return src.slice(i, j + 1);
}
function linkBlock(src) {
  const start = src.indexOf('        function payLinkKey()');
  const end = src.indexOf('        async function applyBookingCode()', start);
  if (!(start > 0 && end > start)) throw new Error('saved payment link block not found');
  return src.slice(start, end);
}

// booking ids as the database makes them
const A1 = '11111111-1111-4111-8111-111111111111', A2 = '22222222-2222-4222-8222-222222222222', A3 = '33333333-3333-4333-8333-333333333333';
const B1 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const URL_A = 'https://checkout.stripe.com/c/pay/cs_test_sessionA#frag', SID_A = 'cs_test_sessionA';
const URL_B = 'https://checkout.stripe.com/c/pay/cs_test_sessionB#frag', SID_B = 'cs_test_sessionB';
const CUST_X = { profile: { id: 'brand-x-0001', email: 'never-stored@example.test' }, me: { member_id: 'member-x-1', email: 'never-stored@example.test' } };
const CUST_Y = { profile: { id: 'brand-y-0002' }, me: { member_id: 'member-y-1' } };

// One page instance. `storage` may be shared between instances to model one browser tab.
function makePage({ src = PAGE, slug = 'gus', cust = CUST_X, pending = [], outcomes = [], answer = { ok: false, body: { error: 'attempt_in_progress' } }, storage = new Map(), brokenStorage = null } = {}) {
  const redirects = [], requests = [];
  const body = { children: [] };
  const mkEl = (tag) => {
    const el = { tag, id: '', children: [], style: {}, dataset: {}, attrs: {}, textContent: '', onclick: null, href: null,
      setAttribute(k, v) { this.attrs[k] = v; }, removeAttribute(k) { delete this.attrs[k]; if (k === 'href') this.href = null; },
      appendChild(c) { this.children.push(c); c.parent = this; return c; },
      remove() { const p = this.parent; if (p) p.children = p.children.filter(x => x !== this); this.parent = null; } };
    return el;
  };
  const document = { body: { children: body.children, appendChild(c) { body.children.push(c); c.parent = { get children() { return body.children; }, set children(v) { body.children.length = 0; body.children.push(...v); } }; return c; } },
    createElement: mkEl, getElementById(id) { return body.children.find(c => c.id === id) || null; } };
  const sessionStorage = brokenStorage === 'missing' ? undefined
    : brokenStorage === 'throws' ? { getItem() { throw new Error('storage unavailable'); }, setItem() { throw new Error('storage unavailable'); }, removeItem() { throw new Error('storage unavailable'); } }
    : { getItem: (k) => (storage.has(k) ? storage.get(k) : null), setItem: (k, v) => { storage.set(k, String(v)); }, removeItem: (k) => { storage.delete(k); } };
  const win = { _brandProfile: cust ? cust.profile : null, _brandMe: cust ? cust.me : null, _pendingPaidIds: pending.slice(), location: { assign: (u) => redirects.push(u) } };
  const state = { answer };
  const c = { window: win, location: { pathname: '/r/' + slug + '/' }, sessionStorage, document, console, Date, JSON, Number, String, Array, Promise,
    setTimeout: () => 0,
    loadOutcomes: () => ({ paid: outcomes.map(id => ({ id })), free: [], recovery: [] }),
    fetch: async (url, options) => { requests.push(JSON.parse(options.body)); return { ok: !!state.answer.ok, json: async () => state.answer.body }; } };
  vm.createContext(c);
  let code = linkBlock(src);
  try { code += '\n' + extractFn(src, 'showCancelledBanner'); } catch (_) { /* older page shapes are run without the notice */ }
  vm.runInContext(code, c);
  return { c, win, storage, redirects, requests, body, state,
    setCustomer(cu) { win._brandProfile = cu ? cu.profile : null; win._brandMe = cu ? cu.me : null; },
    setPending(ids) { win._pendingPaidIds = ids.slice(); },
    link() { return { textContent: '', style: {}, attrs: { href: '#' }, onclick: () => {}, removeAttribute(k) { delete this.attrs[k]; } }; } };
}
const okAnswer = (url, sid, ids) => ({ ok: true, url, session_id: sid, payment_group_id: 'group-' + sid, booking_ids: ids });
const noticeLink = (p) => { const n = p.c.document.getElementById('unpaidNotice'); return n ? n.children.find(x => x.tag === 'a') || null : null; };

// ---------------------------------------------------------------------------------------------------------------
console.log('\n· OLD CODE: the mismatch is reproduced on the page as it was at 75310cd');
{
  let old = null;
  try { old = execFileSync('git', ['show', '75310cd:r/gus/index.html'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }); } catch (_) { old = null; }
  if (!old) console.log('  note git history is not available here; the old-code reproduction is skipped (it is recorded in the closure note)');
  else {
    const p = makePage({ src: old, pending: ['booking-B'] });
    p.c.rememberPayLink('https://checkout.stripe.com/c/pay/session-A');
    await p.c.payPendingBookings(p.link());
    ok('old page: the retry asks the server for booking-B', JSON.stringify(p.requests) === JSON.stringify([{ booking_ids: ['booking-B'] }]));
    ok('old page: and then navigates to the cached session-A (the defect)', JSON.stringify(p.redirects) === JSON.stringify(['https://checkout.stripe.com/c/pay/session-A']));
  }
}

console.log('\n· CART: a link is used only for the exact set of demos it was opened for');
{
  const p = makePage({ pending: [B1] });
  ok('the link for cart A is saved', p.c.rememberPayLink(okAnswer(URL_A, SID_A, [A1]), [A1]) === true);
  const a = p.link();
  await p.c.payPendingBookings(a);
  ok('retry for cart B asks the server for cart B', JSON.stringify(p.requests) === JSON.stringify([{ booking_ids: [B1] }]));
  ok('retry for cart B never navigates to cart A\'s link', p.redirects.length === 0, JSON.stringify(p.redirects));
  ok('the plain refusal is shown instead', /A payment page is already open for these demos/.test(a.textContent) && !('href' in a.attrs) && a.onclick === null);
  ok('Codex\'s own scenario (non-id booking names): no navigation', await (async () => { const q = makePage({ pending: ['booking-B'] }); q.c.rememberPayLink({ ok: true, url: 'https://checkout.stripe.com/c/pay/session-A' }, ['booking-A']); await q.c.payPendingBookings(q.link()); return q.redirects.length === 0 && q.requests.length === 1; })());
}
{
  const p = makePage({ pending: [A2.toUpperCase(), A1] });
  p.c.rememberPayLink(okAnswer(URL_A, SID_A, [A1, A2]), [A1, A2]);
  await p.c.payPendingBookings(p.link());
  ok('the same set in another order and letter case is the same set: resumes the matching link', JSON.stringify(p.redirects) === JSON.stringify([URL_A]));
  ok('with one request and no second link', p.requests.length === 1);
  ok('a repeated id does not make a different set', !!p.c.recallPayLink([A1, A2, A1]));
}
{
  const p = makePage();
  p.c.rememberPayLink(okAnswer(URL_A, SID_A, [A1, A2]), [A1, A2]);
  ok('a smaller, overlapping set does not reuse the link', p.c.recallPayLink([A1]) === null);
  ok('a larger, overlapping set does not reuse the link', p.c.recallPayLink([A1, A2, A3]) === null);
  ok('a different set of the same size does not reuse the link', p.c.recallPayLink([A1, A3]) === null);
  ok('an empty or missing set never matches', p.c.recallPayLink([]) === null && p.c.recallPayLink(undefined) === null && p.c.recallPayLink(null) === null);
  ok('a set holding something that is not a booking id never matches', p.c.recallPayLink([A1, A2, 'x']) === null && p.c.recallPayLink([A1, '']) === null);
  ok('the link is still there for its own set', !!p.c.recallPayLink([A2, A1]));
  ok('a new payment page replaces the saved one, nothing is inherited', p.c.rememberPayLink(okAnswer(URL_B, SID_B, [B1]), [B1]) === true && p.c.recallPayLink([A1, A2]) === null && p.c.recallPayLink([B1]).url === URL_B);
}

console.log('\n· SAVING: only a successful answer for the submitted set, from a signed-in customer');
{
  const p = makePage();
  ok('not saved when the address is not a Stripe Checkout address', p.c.rememberPayLink(okAnswer('https://example.test/pay/' + SID_A, SID_A, [A1]), [A1]) === false && p.storage.size === 0);
  ok('not saved when the server answered for a different set than was submitted', p.c.rememberPayLink(okAnswer(URL_A, SID_A, [A1, A2]), [A1]) === false && p.storage.size === 0);
  ok('not saved when the address does not carry the session the server named', p.c.rememberPayLink(okAnswer(URL_A, 'cs_test_other', [A1]), [A1]) === false && p.storage.size === 0);
  ok('not saved when the submitted set is malformed', p.c.rememberPayLink(okAnswer(URL_A, SID_A, ['nope']), ['nope']) === false && p.storage.size === 0);
  p.setCustomer(null);
  ok('not saved when nobody is signed in', p.c.rememberPayLink(okAnswer(URL_A, SID_A, [A1]), [A1]) === false && p.storage.size === 0);
  p.setCustomer(CUST_X);
  p.c.rememberPayLink(okAnswer(URL_A, SID_A, [A1]), [A1]);
  const key = [...p.storage.keys()][0], rec = JSON.parse(p.storage.get(key));
  ok('the storage key names the store only', key === 'dh_paylink_v2_gus');
  ok('the record is version 2 and carries store, customer ids, the set, session and group', rec.v === 2 && rec.store === 'gus' && rec.cust === 'brand-x-0001|member-x-1' && JSON.stringify(rec.ids) === JSON.stringify([A1]) && rec.checkout === SID_A && rec.group === 'group-' + SID_A);
  ok('no email address and no token is stored', !/@/.test(key + p.storage.get(key)) && !/never-stored/.test(p.storage.get(key)));
}

console.log('\n· CUSTOMER: another customer, or nobody signed in');
{
  const p = makePage({ pending: [A1], outcomes: [A1] });
  p.c.rememberPayLink(okAnswer(URL_A, SID_A, [A1]), [A1]);
  p.setCustomer(null);
  ok('signed out: the link is not returned', p.c.recallPayLink([A1]) === null);
  ok('signed out: the notice is not shown on a plain load', p.c.unpaidNoticePlan(false).show === false);
  const cancelPlan = p.c.unpaidNoticePlan(true);
  ok('signed out after a cancel return: a notice without any link or retry', cancelPlan.show === true && cancelPlan.url === null && cancelPlan.retry === false);
  await p.c.payPendingBookings(p.link());
  ok('signed out: a refused retry does not navigate to the saved link', p.redirects.length === 0);
  p.setCustomer(CUST_Y);
  ok('another customer in the same tab: the link is not returned', p.c.recallPayLink([A1]) === null);
  ok('and the previous customer\'s record is removed', p.storage.size === 0);
  ok('another customer: the notice plan offers no address', p.c.unpaidNoticePlan(false).show === false && p.c.unpaidNoticePlan(true).url === null);
  await p.c.payPendingBookings(p.link());
  ok('another customer: a refused retry does not navigate anywhere', p.redirects.length === 0);
  p.setCustomer(CUST_X);
  ok('the first customer coming back does not get the removed link either', p.c.recallPayLink([A1]) === null);
}
{
  const p = makePage({ pending: [A1] });
  p.c.rememberPayLink(okAnswer(URL_A, SID_A, [A1]), [A1]);
  p.setCustomer({ profile: { id: 'brand-x-0001' }, me: { member_id: 'member-x-2' } });
  ok('another member of the same brand account is another customer', p.c.recallPayLink([A1]) === null);
}
{
  const src = PAGE, i = src.indexOf('window.brandPublicSignOut = async function()');
  const body = src.slice(i, src.indexOf('};', i));
  ok('the page\'s sign-out forgets the saved link and removes the notice', i > 0 && /forgetPayLink\(\)/.test(body) && /unpaidNotice/.test(body) && /_brandProfile = null/.test(body));
  ok('the page decides a visible notice again after the session is read', /renderBrandAuthUi\(\);\s*\n\s*syncUnpaidNotice\(\);/.test(src));
}

console.log('\n· STORE: no reuse across stores');
{
  const storage = new Map();
  const gus = makePage({ slug: 'gus', storage });
  gus.c.rememberPayLink(okAnswer(URL_A, SID_A, [A1]), [A1]);
  const other = makePage({ slug: 'other-market', storage, pending: [A1] });
  ok('another store\'s page does not see the link', other.c.recallPayLink([A1]) === null);
  storage.set('dh_paylink_v2_other-market', storage.get('dh_paylink_v2_gus'));   // even if the record sat under this store's key
  ok('a record naming another store is not used', other.c.recallPayLink([A1]) === null);
  await other.c.payPendingBookings(other.link());
  ok('and a refused retry there does not navigate', other.redirects.length === 0);
  ok('the first store still has its own link', !!gus.c.recallPayLink([A1]));
}

console.log('\n· STORAGE: old, malformed, incomplete, too-old records and unavailable storage');
{
  const now = Date.now();
  const good = { v: 2, url: URL_A, at: now, store: 'gus', cust: 'brand-x-0001|member-x-1', ids: [A1], checkout: SID_A, group: 'g' };
  const cases = [
    ['an old record with only an address and a time', JSON.stringify({ url: URL_A, at: now })],
    ['text that is not JSON', '{not json'],
    ['a JSON value that is not a record', '"' + URL_A + '"'],
    ['null', 'null'],
    ['a record without a version', JSON.stringify({ ...good, v: undefined })],
    ['a record of an unknown version', JSON.stringify({ ...good, v: 3 })],
    ['a record without a customer', JSON.stringify({ ...good, cust: '' })],
    ['a record without a store', JSON.stringify({ ...good, store: '' })],
    ['a record whose set is not a list', JSON.stringify({ ...good, ids: A1 })],
    ['a record whose set is empty', JSON.stringify({ ...good, ids: [] })],
    ['a record whose set holds a non-id', JSON.stringify({ ...good, ids: ['booking-A'] })],
    ['a record whose set is not in canonical order', JSON.stringify({ ...good, ids: [A2, A1] })],
    ['a record with an address that is not Stripe Checkout', JSON.stringify({ ...good, url: 'https://evil.example.test/c/pay/' + SID_A })],
    ['a record whose address does not carry its session', JSON.stringify({ ...good, checkout: 'cs_test_other' })],
    ['a record without a time', JSON.stringify({ ...good, at: 'soon' })],
    ['a record older than 23 hours', JSON.stringify({ ...good, at: now - 24 * 3600 * 1000 })],
    ['a record dated in the future', JSON.stringify({ ...good, at: now + 3600 * 1000 })],
  ];
  for (const [name, raw] of cases) {
    const ids = name.includes('canonical order') ? [A1, A2] : [A1];
    const p = makePage({ pending: ids, outcomes: ids });
    p.storage.set('dh_paylink_v2_gus', raw);
    let threw = false, got; try { got = p.c.recallPayLink(ids); } catch (_) { threw = true; }
    await p.c.payPendingBookings(p.link());
    ok(name + ': not used, no crash, no navigation, and discarded', !threw && got === null && p.redirects.length === 0 && !p.storage.has('dh_paylink_v2_gus') && p.c.unpaidNoticePlan(false).show === false);
  }
  const legacy = makePage({ pending: [A1], outcomes: [A1] });
  legacy.storage.set('dh_paylink_gus', JSON.stringify({ url: URL_A, at: now }));   // the key the old page wrote
  ok('the old page\'s own record under its old key is never trusted', legacy.c.recallPayLink([A1]) === null && legacy.c.unpaidNoticePlan(false).show === false);
  ok('and it is removed', !legacy.storage.has('dh_paylink_gus'));
  for (const mode of ['throws', 'missing']) {
    const p = makePage({ pending: [A1], outcomes: [A1], brokenStorage: mode });
    let threw = false; try { p.c.rememberPayLink(okAnswer(URL_A, SID_A, [A1]), [A1]); p.c.recallPayLink([A1]); p.c.forgetPayLink(); p.c.unpaidNoticePlan(true); p.c.showCancelledBanner(false); } catch (_) { threw = true; }
    await p.c.payPendingBookings(p.link());
    ok('storage that ' + (mode === 'throws' ? 'throws' : 'does not exist') + ': no crash and no navigation', !threw && p.redirects.length === 0);
  }
}

console.log('\n· RESUME and BOTH REFUSALS: the same checks for attempt_in_progress and already_in_checkout');
for (const code of ['attempt_in_progress', 'already_in_checkout']) {
  const p = makePage({ pending: [A1], answer: { ok: false, body: { error: code } } });
  p.c.rememberPayLink(okAnswer(URL_A, SID_A, [A1]), [A1]);
  await p.c.payPendingBookings(p.link());
  ok(code + ': a matching open session is resumed as the same session', JSON.stringify(p.redirects) === JSON.stringify([URL_A]) && p.requests.length === 1);
  const q = makePage({ pending: [B1], answer: { ok: false, body: { error: code } } });
  q.c.rememberPayLink(okAnswer(URL_A, SID_A, [A1]), [A1]);
  const a = q.link();
  await q.c.payPendingBookings(a);
  ok(code + ': a different cart is not sent to the saved link', q.redirects.length === 0 && /already open/.test(a.textContent));
  const r = makePage({ pending: [A1], answer: { ok: false, body: { error: code } } });
  r.c.rememberPayLink(okAnswer(URL_A, SID_A, [A1]), [A1]);
  r.setCustomer(CUST_Y);
  await r.c.payPendingBookings(r.link());
  ok(code + ': a different customer is not sent to the saved link', r.redirects.length === 0);
}
{
  const p = makePage({ pending: [A1], answer: { ok: true, body: okAnswer(URL_A, SID_A, [A1]) } });
  await p.c.payPendingBookings(p.link());
  ok('a successful checkout saves the link for the set it submitted, then navigates', JSON.stringify(p.redirects) === JSON.stringify([URL_A]) && p.c.recallPayLink([A1]).url === URL_A);
  p.setPending([A1, A2]);   // the page's pending set changes afterwards
  ok('a later change of the page\'s pending set does not alter what the link is bound to', p.c.recallPayLink([A1, A2]) === null && !!p.c.recallPayLink([A1]));
  ok('the page\'s booking flow saves with the submitted set too', /rememberPayLink\(checkoutJson, unpaid\)/.test(PAGE) && /body: JSON\.stringify\(\{ booking_ids: unpaid \}\)/.test(PAGE));
}

console.log('\n· NOTICE: cancel return, reload, Back button and a cached page use the same checks');
{
  const p = makePage({ pending: [], outcomes: [A1] });
  p.c.rememberPayLink(okAnswer(URL_A, SID_A, [A1]), [A1]);
  p.c.showCancelledBanner(false); p.c.showCancelledBanner(false); p.c.showCancelledBanner(true);
  ok('at most one notice is on screen', p.body.children.filter(x => x.id === 'unpaidNotice').length === 1);
  const a = noticeLink(p);
  ok('the notice offers Return to payment without carrying the address on the link', !!a && a.textContent === 'Return to payment' && a.href === '#');
  a.onclick();
  ok('a click with matching customer and demos goes to the saved link', JSON.stringify(p.redirects) === JSON.stringify([URL_A]) && p.requests.length === 0);
  p.setCustomer(CUST_Y); p.redirects.length = 0;
  a.onclick(); await new Promise(r => setTimeout(r, 0));
  ok('a click after the customer changed does not go to it; the server is asked instead', p.redirects.length === 0 && p.requests.length === 1);
  p.c.syncUnpaidNotice();
  ok('deciding the notice again for the new customer removes it', p.body.children.filter(x => x.id === 'unpaidNotice').length === 0);
}
{
  const p = makePage({ pending: [], outcomes: [B1] });
  p.c.rememberPayLink(okAnswer(URL_A, SID_A, [A1]), [A1]);
  p.c.showCancelledBanner(false);
  ok('reload or Back with a link for other demos: no notice', p.body.children.length === 0);
  p.c.showCancelledBanner(true);
  const a = noticeLink(p);
  ok('cancel return with a link for other demos: the notice offers a fresh attempt, not the saved address', !!a && p.c.unpaidNoticePlan(true).url === null && p.c.unpaidNoticePlan(true).retry === true);
  a.onclick(); await new Promise(r => setTimeout(r, 0));
  ok('and its click asks the server for the pending demos without navigating to the other link', p.redirects.length === 0 && JSON.stringify(p.requests) === JSON.stringify([{ booking_ids: [B1] }]));
}
{
  const p = makePage({ pending: [], outcomes: [] });
  p.c.showCancelledBanner(false);
  ok('a plain visit with nothing saved shows no notice', p.body.children.length === 0);
  ok('every notice path on the page waits for the session and goes through the same function',
    /p\.has\('cancelled'\)[\s\S]{0,200}whenBrandSessionKnown\(\(\) => showCancelledBanner\(true\)\)/.test(PAGE)
    && /whenBrandSessionKnown\(\(\) => showCancelledBanner\(false\)\)/.test(PAGE)
    && /addEventListener\('pageshow'[^\n]*e\.persisted[^\n]*whenBrandSessionKnown\(\(\) => showCancelledBanner\(false\)\)/.test(PAGE)
    && /window\._brandSessionLoaded = loadBrandAccountSession\(\);/.test(PAGE));
  ok('no code path reads the saved link without naming the demos it is for', !/recallPayLink\(\s*\)/.test(PAGE));
  ok('no code path saves a bare address', !/rememberPayLink\(\s*[A-Za-z_.]+\s*\)/.test(PAGE));
}

console.log('\n· PAID and TERMINAL: the saved link is cleared');
{
  const p = makePage({ pending: [A1], outcomes: [A1] });
  p.c.rememberPayLink(okAnswer(URL_A, SID_A, [A1]), [A1]);
  p.storage.set('dh_paylink_gus', JSON.stringify({ url: URL_A, at: Date.now() }));
  p.c.forgetPayLink();
  ok('forgetting clears the record and any old-format record', p.storage.size === 0 && p.c.unpaidNoticePlan(false).show === false);
  const paid = PAGE.slice(PAGE.indexOf("if (p.has('paid'))"), PAGE.indexOf("} else if (p.has('cancelled'))"));
  ok('the paid return forgets the saved link before it leaves the page', /forgetPayLink\(\);/.test(paid) && paid.indexOf('forgetPayLink();') < paid.indexOf('window.location.assign('));
  const q = makePage({ pending: [A1], answer: { ok: false, body: { error: 'not_payable_state' } } });
  q.c.rememberPayLink(okAnswer(URL_A, SID_A, [A1]), [A1]);
  const a = q.link();
  await q.c.payPendingBookings(a);
  ok('demos no longer awaiting payment: no navigation, and their saved link is dropped', q.redirects.length === 0 && q.storage.size === 0 && /no longer awaiting payment/.test(a.textContent));
  const r = makePage({ pending: [B1], answer: { ok: false, body: { error: 'not_payable_state' } } });
  r.c.rememberPayLink(okAnswer(URL_A, SID_A, [A1]), [A1]);
  await r.c.payPendingBookings(r.link());
  ok('a terminal answer for other demos leaves an unrelated saved link alone', r.storage.size === 1);
}

console.log(`\n${_pass} passed, ${_fail} failed`);
if (_fail) process.exit(1);
