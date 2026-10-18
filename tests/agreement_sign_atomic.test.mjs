// tests/agreement_sign_atomic.test.mjs (2026-10-18, Codex rev4 review item 2): the owner's agreement to a store's policies
// is bound to the text displayed and written atomically (migration 0102, agreement_sign()). Runs the REAL exported
// api/booking.js handler against demohub-rebuild-check with synthetic fixtures. Covers: the hash is required; a stale
// hash is refused without writing; a correct hash supersedes and inserts in one step; a retry replays the same row; a
// store edit between display and signing is refused with the CURRENT text; concurrent signers produce exactly one live
// row; a booker cannot sign; a refused attempt leaves the prior agreement unchanged.
import { installSpy, callRoute, req, ok, summary, uniq, ENV } from './_route.mjs';
process.env.BRAND_INVITE_ENABLED = 'true'; ENV.BRAND_INVITE_ENABLED = 'true';

const SB = process.env.SB_URL, KEY = process.env.SB_KEY;
const H = { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json', Prefer: 'return=representation' };
const db = async (path, opts = {}) => { const r = await fetch(`${SB}/rest/v1/${path}`, { ...opts, headers: { ...H, ...(opts.headers || {}) } }); const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch (_) {} return { ok: r.ok, status: r.status, body: j, text: t }; };
const one = (r) => (r && Array.isArray(r.body) ? r.body[0] : null);
const bin = []; const track = (t, id) => { if (id) bin.push([t, id]); return id; };
installSpy();
const acct = (body, cookie) => callRoute('brand-account.js', req({ body, cookies: cookie ? { dh_brand_session: cookie } : {} }));
const bookingRoute = (body, cookie) => callRoute('booking.js', req({ body, cookies: cookie ? { dh_brand_session: cookie } : {} }));

const slug = uniq('ag');
const retailerId = track('retailers', one(await db('retailers', { method: 'POST', body: JSON.stringify({ slug, name: 'Agreement Fixture Market', verification_status: 'approved', billing_email: `${slug}@fixture.test`, demo_policy: 'Policy text A: arrive early.', cancellation_policy: 'Cancel text A.' }) })).id);
const ownerEmail = `${uniq('agowner')}@fixture.test`;
const brandId = track('brands', one(await db('brands', { method: 'POST', body: JSON.stringify({ email: ownerEmail, company_name: 'Agreement Brand Co', contact_name: 'Olive Owner', phone: '555-0199', is_verified: true }) })).id);
const ownerTok = one(await db('brand_account_tokens', { method: 'POST', body: JSON.stringify({ brand_id: brandId, email: ownerEmail, token: 'tk-' + uniq('ao'), expires_at: new Date(Date.now() + 36e5).toISOString() }) }));
const ownerCookie = (await acct({ action: 'verify', token: ownerTok.token })).cookie('dh_brand_session');
// a booker of this brand, accepted, with a session minted directly (the acceptance flow is covered elsewhere)
const bookerEmail = `${uniq('agbooker')}@fixture.test`;
const memberId = track('brand_members', one(await db('brand_members', { method: 'POST', body: JSON.stringify({ brand_id: brandId, email: bookerEmail, role: 'booker', status: 'accepted', accepted_at: new Date().toISOString(), terms_accepted_at: new Date().toISOString(), terms_version: '2026-06-29' }) })).id);
const bookerToken = 'sess-' + uniq('agb') + uniq('x');
track('brand_account_sessions', one(await db('brand_account_sessions', { method: 'POST', body: JSON.stringify({ brand_id: brandId, session_token: bookerToken, email: bookerEmail, expires_at: new Date(Date.now() + 36e5).toISOString() }) })).id);
ok('fixtures: owner session and booker membership exist', !!ownerCookie && !!memberId);

const rows = async () => (await db(`brand_retailer_agreements?brand_id=eq.${brandId}&retailer_id=eq.${retailerId}&select=id,policy_hash,superseded_at,superseded_by,demo_policy_snapshot,signed_name,expires_at&order=signed_at.asc`)).body || [];
const live = async () => (await rows()).filter(r => !r.superseded_at);
const check = async (cookie) => bookingRoute({ action: 'agreement-check', retailer_slug: slug }, cookie);
const sign = async (hash, cookie, name = 'Olive Owner') => bookingRoute({ action: 'agreement-sign', retailer_slug: slug, signed_name: name, ...(hash === undefined ? {} : { policy_hash: hash }) }, cookie);

try {
  console.log('\n:: display, then sign against what was displayed ::');
  const c1 = await check(ownerCookie);
  const hashA = c1.body && c1.body.policies && c1.body.policies.policy_hash;
  ok('1 agreement-check hands the owner the current text and its hash; nothing is signed yet', c1.statusCode === 200 && c1.body.has_active === false && /^[0-9a-f]{64}$/.test(hashA || '') && /Policy text A/.test(c1.body.policies.demo_policy), JSON.stringify(c1.body).slice(0, 200));
  const noHash = await sign(undefined, ownerCookie);
  ok('2 signing without the displayed hash is refused (400 policy_hash_required) and writes nothing', noHash.statusCode === 400 && noHash.body.error === 'policy_hash_required' && (await rows()).length === 0, JSON.stringify(noHash.body));
  const stale = await sign('0'.repeat(64), ownerCookie);
  ok('3 a hash that does not match the current text is refused (409 policy_changed) with the current text and hash, and writes nothing', stale.statusCode === 409 && stale.body.error === 'policy_changed' && stale.body.policies && stale.body.policies.policy_hash === hashA && /Policy text A/.test(stale.body.policies.demo_policy) && (await rows()).length === 0, JSON.stringify(stale.body).slice(0, 200));
  const first = await sign(hashA, ownerCookie);
  const r1 = await rows();
  ok('4 the displayed hash signs: one live row whose snapshot is the displayed text and whose hash is the displayed hash', first.statusCode === 200 && first.body.ok && !first.body.replay && r1.length === 1 && !r1[0].superseded_at && r1[0].policy_hash === hashA && /Policy text A/.test(r1[0].demo_policy_snapshot) && r1[0].id === first.body.agreement_id, JSON.stringify({ first: first.body, rows: r1.length }));
  const again = await sign(hashA, ownerCookie);
  ok('5 a lost response retried with the same hash replays the same agreement: no second row', again.statusCode === 200 && again.body.replay === true && again.body.agreement_id === first.body.agreement_id && (await rows()).length === 1, JSON.stringify(again.body));
  ok('6 agreement-check now reports the agreement as active', (await check(ownerCookie)).body.has_active === true);

  console.log('\n:: the store edits its policies while the owner is reading ::');
  await db(`retailers?id=eq.${retailerId}`, { method: 'PATCH', body: JSON.stringify({ demo_policy: 'Policy text B: new rule about ice.' }) });
  const staleB = await sign(hashA, ownerCookie);
  const afterStale = await rows();
  ok('7 signing with the hash of text A after the store moved to text B is refused with text B and its hash; the A agreement stays live and unchanged', staleB.statusCode === 409 && staleB.body.error === 'policy_changed' && /Policy text B/.test(staleB.body.policies.demo_policy) && staleB.body.policies.policy_hash !== hashA && afterStale.length === 1 && !afterStale[0].superseded_at && afterStale[0].policy_hash === hashA, JSON.stringify({ s: staleB.statusCode, rows: afterStale.map(r => [r.policy_hash.slice(0, 8), r.superseded_at]) }));
  const hashB = staleB.body.policies.policy_hash;
  const signB = await sign(hashB, ownerCookie, 'Olive Owner');
  const r2 = await rows();
  const liveNow = r2.filter(r => !r.superseded_at);
  ok('8 signing text B supersedes A and inserts B in one step: exactly one live row (B), A superseded and linked to B', signB.statusCode === 200 && signB.body.ok && liveNow.length === 1 && liveNow[0].policy_hash === hashB && r2.find(r => r.policy_hash === hashA).superseded_by === liveNow[0].id && !!r2.find(r => r.policy_hash === hashA).superseded_at, JSON.stringify(r2.map(r => [r.policy_hash.slice(0, 8), !!r.superseded_at, !!r.superseded_by])));

  console.log('\n:: concurrent signers, one live row ::');
  await db(`retailers?id=eq.${retailerId}`, { method: 'PATCH', body: JSON.stringify({ demo_policy: 'Policy text C: concurrency.' }) });
  const hashC = (await check(ownerCookie)).body.policies.policy_hash;
  const twins = await Promise.all([0, 1, 2, 3, 4, 5].map(() => sign(hashC, ownerCookie)));
  const r3 = await rows();
  const liveC = r3.filter(r => !r.superseded_at);
  ok('9 six concurrent signs with the same displayed hash all succeed, exactly one new row is written and exactly one row is live', twins.every(t => t.statusCode === 200 && t.body.ok) && twins.filter(t => !t.body.replay).length === 1 && r3.filter(r => r.policy_hash === hashC).length === 1 && liveC.length === 1 && liveC[0].policy_hash === hashC, JSON.stringify({ statuses: twins.map(t => [t.statusCode, !!t.body.replay]), rowsC: r3.filter(r => r.policy_hash === hashC).length, live: liveC.length }));
  ok('10 the two superseded rows are linked forward and only the newest is live', r3.length === 3 && r3.filter(r => r.superseded_by).length === 2 && new Set(r3.map(r => r.id)).size === 3);

  console.log('\n:: a booker cannot sign ::');
  const bk = await sign(hashC, bookerToken);
  ok('11 a booker\'s direct sign attempt is refused (403 role_not_allowed) and nothing changes', bk.statusCode === 403 && bk.body.error === 'role_not_allowed' && (await rows()).length === 3 && (await live()).length === 1, JSON.stringify(bk.body));
  const bkCheck = await check(bookerToken);
  ok('12 a booker\'s agreement-check reads the owner\'s current agreement as active and says the booker cannot sign', bkCheck.statusCode === 200 && bkCheck.body.has_active === true && bkCheck.body.policies.can_sign === false, JSON.stringify(bkCheck.body).slice(0, 160));
} finally {
  for (const [t, id] of bin.reverse()) {
    if (t === 'brands') { await db(`brand_retailer_agreements?brand_id=eq.${id}`, { method: 'DELETE' }); await db(`brand_account_sessions?brand_id=eq.${id}`, { method: 'DELETE' }); await db(`brand_account_tokens?brand_id=eq.${id}`, { method: 'DELETE' }); await db(`brand_members?brand_id=eq.${id}`, { method: 'DELETE' }); }
    if (t === 'brand_members' || t === 'brand_account_sessions') continue;   // removed with the brand
    await db(`${t}?id=eq.${id}`, { method: 'DELETE' });
  }
}
summary('agreement sign (0102)');
