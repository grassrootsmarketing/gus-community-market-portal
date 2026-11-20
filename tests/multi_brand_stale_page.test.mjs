// tests/multi_brand_stale_page.test.mjs (2026-11-19; Codex multi-brand review, findings 1 and 2). No database, no network.
//
// Part 1 runs the REAL shared page script (brand/brands.js) in a small stand-in for the browser and records every
// request it lets out. The reviewed candidate (80039a1) failed S1: after the picker read a brand list naming brand B,
// the next save from a page still showing brand A was stamped B.
//   S1  picker refresh naming another brand: the page is blocked; the next save is not sent and is never stamped B
//   S2  a switch in another tab whose notice never arrives: caught before the next request is built
//   S3  the notice arrives (storage event): blocked
//   S4  this page switches, and another action fires immediately: held, not sent
//   S5  an answer still in flight when the page is blocked or switches is discarded, not handed to the page
//   S6  a background save after the block is not sent
//   S7  the four recovery actions still go out from a blocked page
//   S8  the stamp is fixed once: a second guard for another brand reloads the page instead of retargeting it
//   S9  the server saying brand_changed or brand_context_required blocks the page
//   S10 a refused switch lifts the pause; a page that never called guard is left alone
// Part 2 is the server rule (api/_brand-identity.js): which requests must name their brand, with the switch on and off.
// Part 3 is the wiring of the routes that book, pay, sign and save.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
let pass = 0, fail = 0;
const ok = (n, c, d) => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n + (d ? ' ' + d : '')); } };
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SRC = readFileSync(process.env.BRANDS_JS || 'brand/brands.js', 'utf8');

// ---- a browser stand-in: enough DOM for the script, a recording network, storage shared between "tabs"
function tab(shared, { listActive = A, switchOk = true, respond = null } = {}) {
  const sent = []; const els = new Map(); const listeners = {}; let reloads = 0;
  const el = (tagName) => { const e = { tagName, id: '', className: '', style: {}, children: [], _html: '', textContent: '',
    set innerHTML(v) { this._html = String(v); }, get innerHTML() { return this._html; },
    appendChild(c) { this.children.push(c); if (c.id) els.set(c.id, c); return c; }, remove() { if (this.id) els.delete(this.id); },
    querySelector() { return stub(); }, querySelectorAll() { return []; }, addEventListener() {}, setAttribute() {}, getAttribute() { return null; }, classList: { add() {}, remove() {}, toggle() {} }, focus() {} }; return e; };
  const stub = () => el('x');
  const doc = { head: el('head'), body: el('body'), createElement: (t) => el(t), getElementById: (id) => els.get(id) || null, addEventListener() {}, removeEventListener() {} };
  const storage = { getItem: (k) => (k in shared.data ? shared.data[k] : null), setItem: (k, v) => { shared.data[k] = String(v); for (const t of shared.tabs) if (t !== api) t.fire('storage', { key: k, newValue: String(v) }); } };
  const c = { Headers, Request, Response, console, JSON, Promise, Object, String, Date, decodeURIComponent, document: doc, localStorage: storage,
    location: { origin: 'https://example.test', pathname: '/brand/dashboard', reload() { reloads++; } } };
  c.window = c;
  c.addEventListener = (ev, fn) => { (listeners[ev] = listeners[ev] || []).push(fn); };
  let hold = null;   // set to a function to keep the next network answer pending
  c.fetch = (url, init) => {
    let body = {}; try { body = JSON.parse((init && init.body) || '{}'); } catch (_) {}
    const action = (/[?&]action=([^&]+)/.exec(String(url)) || [])[1] || body.action || '';
    const rec = { url: String(url), action, brand: new Headers((init && init.headers) || {}).get('X-DH-Brand') };
    sent.push(rec);
    const answer = () => {
      if (respond) { const r = respond(rec); if (r) return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'Content-Type': 'application/json' } }); }
      if (action === 'brand-list') return new Response(JSON.stringify({ ok: true, multi_brand: true, active_brand_id: api.listActive, brands: [], invites: [] }), { status: 200 });
      if (action === 'brand-switch') return new Response(JSON.stringify(api.switchOk ? { ok: true, brand_id: body.brand_id } : { error: 'brand_not_allowed' }), { status: api.switchOk ? 200 : 403 });
      return new Response(JSON.stringify({ ok: true, echoed: action }), { status: 200 });
    };
    if (hold) { const h = hold; hold = null; return new Promise((res) => h(() => res(answer()))); }
    return Promise.resolve(answer());
  };
  const api = { c, sent, listActive, switchOk, get reloads() { return reloads; }, holdNext(fn) { hold = fn; }, fire(ev, arg) { for (const fn of (listeners[ev] || [])) fn(arg); },
    blocked: () => !!els.get('dhBrandsBlocked'), save: (extra = {}) => c.fetch('/api/brand-account', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'profile-update', company_name: 'draft', ...extra }) }),
    post: (action, extra = {}) => c.fetch('/api/brand-account', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, ...extra }) }) };
  shared.tabs.push(api);
  vm.createContext(c); vm.runInContext(SRC, c);
  return api;
}
const world = () => ({ data: {}, tabs: [] });
const picker = (t) => t.c.DHBrands.renderPicker(t.c.document.createElement('div'), { allowRequest: false });
const sentSaves = (t) => t.sent.filter(s => s.action === 'profile-update');

console.log(':: part 1: the page script ::');
{ // S1
  const t = tab(world(), { listActive: B });
  t.c.DHBrands.guard(A, 'Brand A');
  const first = await t.save(); const n1 = sentSaves(t).length;
  await picker(t);                              // the session is on B (switched elsewhere, no notice received)
  const second = await t.save();
  const saves = sentSaves(t);
  ok('S1a before anything changes, a save is stamped with the brand the page shows', first.status === 200 && n1 === 1 && saves[0].brand === A);
  ok('S1b a brand list naming another brand BLOCKS the page', t.blocked() === true);
  ok('S1c the next save is not sent at all, and nothing from this page is ever stamped with the other brand', saves.length === 1 && second.status === 409 && (await second.json()).error === 'brand_changed' && !t.sent.some(s => s.brand === B), JSON.stringify(t.sent));
  ok('S1d the page still reports the brand it was loaded for', t.c.DHBrands.pageBrand() === A && t.c.DHBrands.isBlocked() === true);
}
{ // S2: another tab switched; this tab got no storage event (the value just changed underneath)
  const w = world(); const t = tab(w);
  t.c.DHBrands.guard(A, 'Brand A');
  w.data.dh_active_brand = B + '|' + Date.now();            // written by the other tab; no event delivered here
  const r = await t.save();
  ok('S2 a switch elsewhere with NO notice is caught before the next request is built: not sent, page blocked', sentSaves(t).length === 0 && r.status === 409 && t.blocked() === true);
}
{ // S3: the notice arrives
  const w = world(); const t1 = tab(w), t2 = tab(w);
  t1.c.DHBrands.guard(A, 'Brand A');
  t2.c.DHBrands.guard(B, 'Brand B');                        // the second tab loads as B: it announces B
  ok('S3 a tab that loads on another brand tells the others, and the stale one is blocked', t1.blocked() === true && t2.blocked() === false);
  const r = await t1.save();
  ok('S3b and the stale tab sends nothing afterwards', sentSaves(t1).length === 0 && r.status === 409);
}
{ // S4: explicit switch, then an immediate action
  const t = tab(world());
  t.c.DHBrands.guard(A, 'Brand A');
  let release; t.holdNext((go) => { release = go; });
  const sw = t.c.DHBrands.switchTo(B, { onSwitched() {} });  // in flight
  const during = await t.save();
  release(); await sw;
  const after = await t.save({ note: 'right after the switch' });
  ok('S4a a save fired while the switch is in flight is held (not sent)', during.status === 409 && sentSaves(t).length === 0);
  ok('S4b a save fired right after a successful switch is held too: the page still shows the old brand until it reloads', after.status === 409 && sentSaves(t).length === 0 && !t.sent.some(s => s.brand === B));
  ok('S4c the switch request itself went out, stamped with the page\'s own brand', t.sent.filter(s => s.action === 'brand-switch').length === 1 && t.sent.find(s => s.action === 'brand-switch').brand === A);
}
{ // S5: an answer in flight when the page is blocked
  const w = world(); const t = tab(w);
  t.c.DHBrands.guard(A, 'Brand A');
  let release; t.holdNext((go) => { release = go; });
  const pending = t.post('data');                           // sent as A, answer pending
  t.fire('storage', { key: 'dh_active_brand', newValue: B + '|1' });
  release();
  const r = await pending; const j = await r.json();
  ok('S5a an answer that arrives after the block is discarded, never handed to the page to draw', r.status === 409 && j.error === 'brand_changed' && j.refused_in_page === true && j.echoed === undefined, JSON.stringify(j));
  const t2 = tab(world()); t2.c.DHBrands.guard(A, 'Brand A');
  let rel2; t2.holdNext((go) => { rel2 = go; });
  const p2 = t2.post('data');
  const sw = t2.c.DHBrands.switchTo(B, { onSwitched() {} });
  rel2(); const r2 = await p2; await sw;
  ok('S5b the same for an answer in flight across this page\'s own switch', r2.status === 409 && (await r2.json()).refused_in_page === true);
}
{ // S6 + S7
  const t = tab(world(), { listActive: B });
  t.c.DHBrands.guard(A, 'Brand A');
  await picker(t);
  await Promise.all([t.save({ autosave: 1 }), t.save({ autosave: 2 }), t.post('upload-coi'), t.c.fetch('/api/book', { method: 'POST', body: '{}' }), t.c.fetch('/api/checkout', { method: 'POST', body: '{}' })]);
  ok('S6 background saves, an upload, a booking and a checkout from the blocked page are not sent', t.sent.every(s => s.action === 'brand-list'), JSON.stringify(t.sent.map(s => s.action || s.url)));
  await t.post('brand-list'); await t.post('logout'); await t.c.fetch('/api/brand-account?action=logout-everywhere', { method: 'POST', body: '{}' }); await t.post('brand-switch', { brand_id: A });
  const rec = t.sent.map(s => s.action);
  ok('S7 listing brands, switching and signing out still go out from a blocked page (how it recovers)', ['logout', 'logout-everywhere', 'brand-switch'].every(a => rec.includes(a)) && rec.filter(a => a === 'brand-list').length === 2, rec.join(','));
  const other = await t.c.fetch('https://cdn.example.test/x.js');
  ok('S7b requests that are not this site\'s API are never touched', other.status === 200 && t.sent[t.sent.length - 1].brand === null);
}
{ // S8
  const t = tab(world());
  t.c.DHBrands.guard(A, 'Brand A'); t.c.DHBrands.guard(A, 'Brand A');
  const same = t.reloads;
  t.c.DHBrands.guard(B, 'Brand B');
  const r = await t.save();
  ok('S8 the stamp is fixed once: guarding the same brand again does nothing, another brand reloads the page and holds its requests', same === 0 && t.reloads === 1 && t.c.DHBrands.pageBrand() === A && r.status === 409 && sentSaves(t).length === 0);
}
{ // S9
  for (const code of ['brand_changed', 'brand_context_required']) {
    const t = tab(world(), { respond: (rec) => rec.action === 'profile-update' ? { status: 409, body: { error: code } } : null });
    t.c.DHBrands.guard(A, 'Brand A');
    const r = await t.save();
    const again = await t.save();
    ok(`S9 the server answering ${code} blocks the page; the next save is not sent`, r.status === 409 && t.blocked() === true && again.status === 409 && sentSaves(t).length === 1);
  }
  const t = tab(world(), { respond: (rec) => rec.action === 'profile-update' ? { status: 409, body: { error: 'products_conflict' } } : null });
  t.c.DHBrands.guard(A, 'Brand A'); await t.save();
  ok('S9b an ordinary 409 (a product list conflict) does not block the page', t.blocked() === false);
}
{ // S10
  const t = tab(world(), { switchOk: false });
  t.c.DHBrands.guard(A, 'Brand A');
  const sw = await t.c.DHBrands.switchTo(B, { onSwitched() { throw new Error('must not be called'); } });
  const r = await t.save();
  ok('S10a a refused switch lifts the pause: the page keeps working for the brand it shows', sw.ok === false && r.status === 200 && sentSaves(t).length === 1 && sentSaves(t)[0].brand === A && t.blocked() === false);
  const u = tab(world(), { listActive: B });
  await picker(u); const r2 = await u.save();
  ok('S10b a page that never called guard (the sign-in page) is not blocked and not stamped', r2.status === 200 && u.blocked() === false && u.sent[u.sent.length - 1].brand === null);
}

console.log('\n:: part 2: the server rule ::');
{
  const { brandContextProblem, brandHeaderMismatch } = await import('../api/_brand-identity.js');
  const ctx = { ok: true, brandId: B, email: 'p@fixture.test', role: 'owner' };
  const req = (v) => ({ headers: v === undefined ? {} : { 'x-dh-brand': v } });
  const code = (r) => (r ? r.error : null);
  const saved = process.env.MULTI_BRAND_ACCESS_ENABLED;
  const table = {};
  for (const flag of ['on', 'off']) {
    if (flag === 'on') process.env.MULTI_BRAND_ACCESS_ENABLED = 'true'; else delete process.env.MULTI_BRAND_ACCESS_ENABLED;
    for (const [name, v] of [['missing', undefined], ['empty', ''], ['malformed', 'not-a-uuid'], ['half', B.slice(0, 20)], ['other', A], ['match', B], ['MATCH', B.toUpperCase()]]) {
      table[`${flag}/${name}/mutation`] = code(brandContextProblem(req(v), ctx, { mutation: true }));
      table[`${flag}/${name}/read`] = code(brandContextProblem(req(v), ctx, { mutation: false }));
    }
  }
  if (saved === undefined) delete process.env.MULTI_BRAND_ACCESS_ENABLED; else process.env.MULTI_BRAND_ACCESS_ENABLED = saved;
  const want = (k) => {
    const [flag, name, kind] = k.split('/');
    if (name === 'other') return 'brand_changed';
    if (name === 'match' || name === 'MATCH') return null;
    return (flag === 'on' && kind === 'mutation') ? 'brand_context_required' : null;
  };
  const wrong = Object.keys(table).filter(k => table[k] !== want(k));
  ok('P1 switch ON: a mutation with no brand, an empty one or a malformed one is refused (the old page after an A to B switch)', ['missing', 'empty', 'malformed', 'half'].every(n => table[`on/${n}/mutation`] === 'brand_context_required'), JSON.stringify(table));
  ok('P2 a well-formed brand that is not the session\'s is refused always: switch on or off, mutation or read', ['on', 'off'].every(f => ['mutation', 'read'].every(k => table[`${f}/other/${k}`] === 'brand_changed')));
  ok('P3 only the matching brand proceeds (any letter case)', ['on', 'off'].every(f => ['mutation', 'read'].every(k => table[`${f}/match/${k}`] === null && table[`${f}/MATCH/${k}`] === null)));
  ok('P4 switch OFF: a request with no brand behaves as it does today (deliberate compatibility)', ['missing', 'empty', 'malformed'].every(n => table[`off/${n}/mutation`] === null && table[`off/${n}/read`] === null));
  ok('P5 a read with no brand passes with the switch on (the first load of a page)', table['on/missing/read'] === null);
  ok('P6 the whole table matches the rule (28 cases)', wrong.length === 0 && Object.keys(table).length === 28, wrong.join(','));
  process.env.MULTI_BRAND_ACCESS_ENABLED = 'true';
  const unauth = [brandContextProblem(req(B), { ok: false, status: 401 }, { mutation: true }), brandContextProblem(req(undefined), null, { mutation: true })];
  if (saved === undefined) delete process.env.MULTI_BRAND_ACCESS_ENABLED; else process.env.MULTI_BRAND_ACCESS_ENABLED = saved;
  ok('P7 the brand check never speaks for an identity that was refused: authorization is decided first, on its own', unauth.every(x => x === null) && brandHeaderMismatch(req(A), { ok: false }) === false);
}

console.log('\n:: part 3: the routes ::');
{
  const read = (p) => readFileSync(p, 'utf8');
  const acct = read('api/brand-account.js');
  const exempt = (/const BRAND_CONTEXT_EXEMPT = new Set\(\[([^\]]*)\]\)/.exec(acct) || [])[1] || '';
  const reads = (/const BRAND_READ_ACTIONS = new Set\(\[([^\]]*)\]\)/.exec(acct) || [])[1] || '';
  ok('R1 brand-account: exactly four actions are exempt and exactly four are reads; every other signed-in action is a mutation by default', exempt.replace(/\s/g, '') === "'brand-list','brand-switch','logout','logout-everywhere'" && reads.replace(/\s/g, '') === "'data','agreement-list','booker-status','claim-status'", exempt + ' | ' + reads);
  ok('R2 brand-account: the check runs inside the signed-in gate, before the role decision and before any action body', /if \(!BRAND_CONTEXT_EXEMPT\.has\(action\)\) \{\s*\n\s*const problem = brandContextProblem\(req, ctx, \{ mutation: !BRAND_READ_ACTIONS\.has\(action\) \}\);\s*\n\s*if \(problem\) return jsonResp\(res, 409, problem\);/.test(acct) && acct.indexOf('brandContextProblem(req, ctx, { mutation: !BRAND_READ_ACTIONS') < acct.indexOf("if (action === 'booking-signup')"));
  ok('R3 booking and checkout ask for the brand before anything else is read or written', /const auth = await requireBrandSession\(req, body, \{ mutation: true \}\);/.test(read('api/book.js')) && /const auth = await requireBrandSession\(req, body, \{ mutation: true \}\);/.test(read('api/checkout.js')));
  const booking = read('api/booking.js');
  ok('R4 signing a store agreement asks for the brand; a brand refusal is answered 409, not "sign in"', /const _sAuth = await requireBrandSession\(req, body, \{ mutation: true \}\);[^\n]*\n\s*if \(!_sAuth\.ok && _sAuth\.status === 409\) return res\.status\(409\)/.test(booking) && /if \(!_bAuth\.ok && _bAuth\.status === 409\) return res\.status\(409\)/.test(booking));
  const js = read('brand/brands.js');
  ok('R5 the page script never reassigns the page brand and never reads it from a brand list', (js.match(/state\.pageBrand = /g) || []).length === 1 && !/state\.activeId/.test(js) && /h\.set\('X-DH-Brand', state\.pageBrand\)/.test(js));
  ok('R6 the three brand pages load the script; the sign-in page names the brand on its one follow-up save', [read('brand/dashboard/index.html'), read('r/gus/index.html'), read('brand/signin/index.html')].every(s => s.includes('<script src="/brand/brands.js"></script>')) && /'X-DH-Brand': String\(j\.brand_id \|\| ''\)/.test(read('brand/signin/index.html')));
  ok('R7 no brand page sends a brand request by a path the stamp cannot reach (no XMLHttpRequest, no sendBeacon, no form posts to the API)', ![read('brand/dashboard/index.html'), read('r/gus/index.html'), read('brand/signin/index.html')].some(s => /XMLHttpRequest|sendBeacon|<form[^>]*action="\/api/.test(s)));
}

console.log(`\nmulti-brand stale page: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
