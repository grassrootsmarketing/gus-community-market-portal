// tests/multi_brand_offline.test.mjs (0121, 2026-11-19): one person, many brands. No database, no network.
//   1. the switch: MULTI_BRAND_ACCESS_ENABLED is on only for the literal "true", and the operator snapshot reports it
//   2. the role gate: Full access stands in for the owner, except where a route asks for the owner strictly
//   3. the stale-tab check: a page showing another brand is refused; the header can never widen access
//   4. the route wiring: which actions are public, which are owner-only, which are POST only; the password lookup
//   5. the migration: the old one-identity indexes go, one-owned-brand stays, every new function is service-role only
//   6. the pages: picker, switcher, "Booking for" line, and an approval page that decides nothing by being opened
//   7. the shared email card
import { readFileSync } from 'node:fs';
let pass = 0, fail = 0;
const ok = (n, c, d) => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n + (d ? ' ' + d : '')); } };
const read = (p) => readFileSync(p, 'utf8');

// ---- 1. the switch
{
  const { FLAGS, flagSnapshot } = await import('../api/_flags.js');
  const saved = process.env.MULTI_BRAND_ACCESS_ENABLED;
  const seen = {};
  for (const v of [undefined, '', 'false', 'TRUE', 'True', ' true', 'true ', '1', 'yes', 'true']) {
    if (v === undefined) delete process.env.MULTI_BRAND_ACCESS_ENABLED; else process.env.MULTI_BRAND_ACCESS_ENABLED = v;
    seen[String(v)] = FLAGS.multiBrandAccess;
  }
  ok('1a. off for unset, empty, "false", upper case, padded and look-alike values; on only for the literal "true"', Object.entries(seen).every(([k, v]) => v === (k === 'true')), JSON.stringify(seen));
  process.env.MULTI_BRAND_ACCESS_ENABLED = 'true';
  const onSnap = flagSnapshot().multiBrandAccess;
  delete process.env.MULTI_BRAND_ACCESS_ENABLED;
  ok('1b. the operator snapshot reports the effective value, read at request time', onSnap === true && flagSnapshot().multiBrandAccess === false);
  if (saved === undefined) delete process.env.MULTI_BRAND_ACCESS_ENABLED; else process.env.MULTI_BRAND_ACCESS_ENABLED = saved;
}

// ---- 2 and 3. the identity boundary
{
  const { ROLES, requireRole, requireOwner, bookingBelongsTo, brandHeaderMismatch } = await import('../api/_brand-identity.js');
  const ctx = (role) => ({ ok: true, brandId: '11111111-1111-4111-8111-111111111111', email: 'p@fixture.test', memberId: 'm1', role });
  ok('2a. three roles: owner, booker (Booking only), manager (Full access)', ROLES.OWNER === 'owner' && ROLES.BOOKER === 'booker' && ROLES.MANAGER === 'manager');
  ok('2b. Full access passes a gate that lists the owner', requireRole(ctx('manager'), 'owner') === null && requireRole(ctx('owner'), 'owner') === null);
  ok('2c. Booking only does not pass an owner gate', (requireRole(ctx('booker'), 'owner') || {}).status === 403);
  ok('2d. Full access does not pass a gate that lists only the booker', (requireRole(ctx('manager'), 'booker') || {}).status === 403);
  ok('2e. the strict owner gate refuses Full access and Booking only, and passes the owner', requireOwner(ctx('owner')) === null && (requireOwner(ctx('manager')) || {}).status === 403 && requireOwner(ctx('manager')).body.error === 'owner_only' && (requireOwner(ctx('booker')) || {}).status === 403);
  ok('2f. a refused or missing identity stays refused by both gates', (requireOwner({ ok: false, status: 401 }) || {}).status === 401 && (requireRole(null, 'owner') || {}).status === 401);
  ok('2g. Full access manages every booking of the brand; Booking only manages its own', bookingBelongsTo(ctx('manager'), { booked_by_member_id: 'someone-else' }) === true && bookingBelongsTo(ctx('booker'), { booked_by_member_id: 'someone-else' }) === false && bookingBelongsTo(ctx('booker'), { booked_by_member_id: 'm1' }) === true);
  const h = (v) => ({ headers: v === undefined ? {} : { 'x-dh-brand': v } });
  ok('3a. the mismatch helper only speaks for a well-formed brand that differs (missing or malformed brands are the business of tests/multi_brand_stale_page.test.mjs, part 2)', brandHeaderMismatch(h(undefined), ctx('owner')) === false);
  ok('3b. the page shows the session\'s brand (any letter case): allowed', brandHeaderMismatch(h('11111111-1111-4111-8111-111111111111'), ctx('owner')) === false && brandHeaderMismatch(h('11111111-1111-4111-8111-111111111111'.toUpperCase()), ctx('owner')) === false);
  ok('3c. the page shows another brand: refused', brandHeaderMismatch(h('22222222-2222-4222-8222-222222222222'), ctx('owner')) === true);
  ok('3d. the header never turns a refused identity into an allowed one', brandHeaderMismatch(h('22222222-2222-4222-8222-222222222222'), { ok: false }) === false);
}

// ---- 4. the route wiring
const api = read('api/brand-account.js');
{
  const set = (name) => { const m = new RegExp('const ' + name + ' = new Set\\(\\[([\\s\\S]*?)\\]\\);').exec(api); return m ? m[1] : ''; };
  const strict = set('STRICT_OWNER_ACTIONS'), pub = set('PUBLIC_ACTIONS'), postOnly = set('BOOKER_MUTATING_ACTIONS');
  ok('4a. who has access and the owner password are strictly the owner\'s', ['booker-designate', 'booker-resend', 'booker-revoke', 'booker-status', 'access-set-level', 'access-request-answer', 'set-password'].every(a => strict.includes("'" + a + "'")), strict);
  ok('4b. the strict gate runs before the role table', /STRICT_OWNER_ACTIONS\.has\(action\) \? requireOwner\(ctx\) : null\) \|\| requireRole\(ctx, \.\.\.allowed\)/.test(api));
  ok('4c. only the two token-bound request actions are public; switching, accepting, leaving and asking need a session', pub.includes("'access-request-view'") && pub.includes("'access-request-decide'") && !/brand-switch|brand-list|access-accept|access-leave|'access-request'|access-set-level|access-request-answer/.test(pub));
  ok('4d. every action that changes something is POST only (a link opened by a mail scanner is a GET)', ['brand-switch', 'access-accept', 'access-leave', 'access-request', 'access-request-decide', 'access-request-answer', 'access-set-level'].every(a => postOnly.includes("'" + a + "'")), postOnly);
  ok('4e. every new action is refused while the switch is off', ['brand-switch', 'access-accept', 'access-leave', 'access-request', 'access-request-view', 'access-request-decide', 'access-request-answer'].every(a => new RegExp("if \\(action === '" + a + "'\\) \\{\\s*\\n\\s*if \\(!multiOn\\(\\)\\) return multiOff\\(\\);").test(api)) && /if \(action === 'access-set-level'\) \{\s*\n\s*if \(!multiOn\(\)\) return jsonResp\(res, 404/.test(api));
  ok('4f. password sign-in reads the OWNER row only (never another brand the email has access to)', /brand_members\?email=eq\.\$\{encodeURIComponent\(email\)\}&role=eq\.owner&select=brand_id,email,brands\(password_hash\)/.test(api));
  ok('4g. the switch rotates the session: new cookie set, old token dropped from the cache', /rpc\/brand_session_switch/.test(api) && /_ctxCache\.delete\(oldToken\);\s*\n\s*setBrandSessionCookie\(res, newToken\);/.test(api));
  ok('4h. the request reply is one generic body for every outcome that would reveal an account', /if \(out\.outcome !== 'ok'\) return jsonResp\(res, 200, GENERIC\);/.test(api) && /return jsonResp\(res, 200, GENERIC\);\s*\n\s*\}/.test(api));
  ok('4i. the request token is hashed before it is stored or looked up, and never returned', /p_token_hash: requestHash\(token\)/.test(api) && !/jsonResp\(res, \d+, \{[^}]*\btoken\b[^}]*\}\)/.test(api.slice(api.indexOf("if (action === 'access-request')"), api.indexOf("if (action === 'logout')"))));
  ok('4j. the brand-context check runs for every signed-in action except listing, switching and signing out', /const BRAND_CONTEXT_EXEMPT = new Set\(\['brand-list', 'brand-switch', 'logout', 'logout-everywhere'\]\);/.test(api) && /if \(!BRAND_CONTEXT_EXEMPT\.has\(action\)\) \{/.test(api));
  const signup = read('api/brand-signup.js');
  ok('4k. sign-in adds the picker data only while the switch is on, after the session is issued for the default brand', /if \(FLAGS\.multiBrandAccess\) \{/.test(signup) && signup.indexOf('setBrandCookie(res, token);') < signup.indexOf("rpc('brand_access_list'") && /choose: brands\.length > 1 \|\| invites\.length > 0/.test(signup));
  const bi = read('api/_booking-identity.js');
  ok('4l. booking, checkout and agreement signing run the brand-context check too', /const problem = await brandContextCheck\(req, ctx, \{ mutation: opts\.mutation === true \}\);\s*\n\s*if \(problem\) return \{ ok: false, status: 409/.test(bi));
  const idn = read('api/_brand-identity.js');
  ok('4m. with the switch off a Full access member resolves as Booking only (rollback narrows, never widens)', /const role = FLAGS\.multiBrandAccess \? ROLES\.MANAGER : ROLES\.BOOKER;/.test(idn));
}

// ---- 5. the migration
{
  const sql = read('supabase/migrations/0121_multi_brand_access.sql');
  ok('5a. the one-identity and one-booker indexes are dropped; one owned brand per email is kept', /DROP INDEX IF EXISTS brand_members_one_identity_idx;/.test(sql) && /DROP INDEX IF EXISTS brand_members_one_booker_idx;/.test(sql) && /CREATE UNIQUE INDEX IF NOT EXISTS brand_members_one_owned_brand_idx ON brand_members \(lower\(email\)\) WHERE role = 'owner';/.test(sql));
  ok('5b. the role domain is owner, booker, manager', /CHECK \(role IN \('owner','booker','manager'\)\)/.test(sql));
  const fns = [...sql.matchAll(/CREATE OR REPLACE FUNCTION (?:public\.)?([a-z_]+)\(/g)].map(m => m[1]).filter(n => n !== 'brand_members_owner_defaults');
  const revoked = (n) => new RegExp('REVOKE ALL ON FUNCTION (?:public\\.)?' + n + '\\([^)]*\\) FROM public, anon, authenticated;\\s*\\nGRANT EXECUTE ON FUNCTION (?:public\\.)?' + n + '\\([^)]*\\) TO service_role;').test(sql);
  ok('5c. every callable function is revoked from public roles and granted to the service role only (' + fns.length + ' functions)', fns.length >= 14 && fns.every(revoked), fns.filter(n => !revoked(n)).join(','));
  ok('5d. the requests table is closed to the browser roles', /ALTER TABLE brand_access_requests ENABLE ROW LEVEL SECURITY;\s*\nREVOKE ALL ON brand_access_requests FROM public, anon, authenticated;/.test(sql));
  ok('5e. the switch off path keeps the 0097 rules inside the grant function', /IF NOT coalesce\(p_multi, false\) THEN/.test(sql) && /RETURN jsonb_build_object\('outcome', 'email_in_use'\);/.test(sql) && /'booker_already_designated'/.test(sql));
  ok('5f. a request is decided under the brand lock, once, unexpired, and only for the owner it was sent to', /FROM brands WHERE id = v_r\.brand_id FOR UPDATE;/.test(sql) && /IF v_r\.status <> 'pending' THEN RETURN jsonb_build_object\('outcome', 'already_decided'/.test(sql) && /IF v_r\.expires_at <= now\(\) THEN RETURN jsonb_build_object\('outcome', 'expired'\);/.test(sql) && /lower\(coalesce\(v_b\.email, ''\)\) <> lower\(v_r\.owner_email\)/.test(sql));
  ok('5g. the switch checks the session\'s own email against ownership or ACCEPTED access', /status = 'accepted' AND role IN \('booker','manager'\) FOR SHARE;/.test(sql) && /DELETE FROM brand_account_sessions WHERE id = v_s\.id;/.test(sql));
  ok('5h. sign-in still resolves the OWN brand first and never accepts a pending invitation', sql.indexOf("SELECT id INTO v_brand_id FROM brands WHERE lower(email) = v_email LIMIT 1;") > 0 && /RETURN jsonb_build_object\('outcome','invite_pending'/.test(sql));
  const sql2 = read('supabase/migrations/0122_multi_brand_access_corrections.sql');
  ok('5j. 0122: one email lock, taken first by every writer of a brand identity, and by the insert trigger for a direct write', /pg_advisory_xact_lock\(hashtextextended\('demohub\.brand_identity:' \|\| lower\(btrim\(coalesce\(p_email, ''\)\)\), 0\)\)/.test(sql2)
    && sql2.indexOf('PERFORM _brand_identity_lock(v_email);') < sql2.indexOf('SELECT * INTO v_b FROM brands WHERE id = p_brand_id FOR UPDATE;') && (sql2.match(/PERFORM _brand_identity_lock\(/g) || []).length === 4 && /direct_member_write_refused/.test(sql2) && !/^\s*(begin|commit);\s*$/im.test(sql2));
  ok('5i. no transaction control and no bare SELECT in the file (applied in one transaction with its ledger row)', !/^\s*(begin|commit);\s*$/im.test(sql));
}

// ---- 6. the pages
{
  const js = read('brand/brands.js'), dash = read('brand/dashboard/index.html'), signin = read('brand/signin/index.html'), booking = read('r/gus/index.html'), approve = read('brand/approve/index.html'), accept = read('brand/accept/index.html');
  ok('6a. the three pages load the one shared picker script', [dash, signin, booking].every(s => /<script src="\/brand\/brands\.js"><\/script>/.test(s)));
  ok('6b. the picker lists what the server says and marks the own brand', /action: 'brand-list'/.test(js) && /b\.is_own \? '<span class="dhb-chip own">Yours<\/span>'/.test(js) && /Your own brand account/.test(js));
  ok('6c. switching is one server call, then a reload', /api\(\{ action: 'brand-switch', brand_id: brandId \}\)/.test(js) && /else location\.reload\(\);/.test(js));
  ok('6d. the page stamps its API calls with the brand it shows and stops when the server says the brand changed', /h\.set\('X-DH-Brand', state\.pageBrand\)/.test(js) && /j\.error === 'brand_changed' \|\| j\.error === 'brand_context_required'\)\) blockPage\(\)/.test(js) && /You switched brand in another tab/.test(js));
  ok('6e. the script keeps no session or token in browser storage (only the id of the brand a tab shows, to tell other tabs)', (js.match(/localStorage\.setItem\(/g) || []).length === 2 && (js.match(/localStorage\.setItem\(KEY, /g) || []).length === 2 && !/sessionStorage|document\.cookie/.test(js));
  ok('6f. sign-in shows the picker when the server asks, and goes straight in otherwise', /if \(j\.choose && window\.DHBrands\) \{/.test(signin) && /Which brand are you working on\?/.test(signin) && /window\.location\.href = '\/brand\/dashboard';/.test(signin));
  ok('6g. the portal header names the active brand and mounts the switcher; a phone gets the band under the header', /mountSwitcher\(document\.getElementById\('brandSwitcherSlot'\), _data, \{ label: 'Working on' \}\)/.test(dash) && /id="brandForBand"/.test(dash) && /@media \(max-width:760px\) \{ #brandSwitcherSlot \{ display:none; \} #brandForBand\.on \{ display:block; \} \}/.test(dash));
  ok('6h. the owner sees People with access with two levels; Full access never sees that card', /People with access/.test(dash) && /const accessCard = full \? '' :/.test(dash) && /<strong>Booking only<\/strong>/.test(dash) && /<strong>Full access<\/strong>/.test(dash));
  ok('6i. the booking page says "Booking for" on the landing strip, the booking view and the booking form, with a switch link', ['bookingForLine"', 'bookingForLineLanding"', 'bookingForLineModal"'].every(id => booking.includes('id="' + id)) && /prefix: 'Booking for'/.test(booking) && /Switch brand/.test(js));
  ok('6j. switching with demos already picked asks first, because they were picked for the other brand', /Switching brand clears the/.test(booking));
  ok('6k. the earlier "Booking as" sentence is kept on the booking form', /'Booking as ' \+ bp\.company_name/.test(booking));
  const decideCalls = approve.split("action: 'access-request-decide'").length - 1;
  ok('6l. the approval page only reads on load; the one decide call sits behind the two buttons', decideCalls === 1 && approve.indexOf("action: 'access-request-view'") < approve.indexOf('const answer = async') && approve.indexOf("action: 'access-request-decide'") > approve.indexOf('const answer = async') && /\$\('approveBtn'\)\.addEventListener\('click', \(\) => answer\('approve'\)\)/.test(approve));
  ok('6m. the approval page sends no cookies, takes the token out of the address bar and sends no referrer', /credentials: 'omit'/.test(approve) && /history\.replaceState\(null, '', location\.pathname\)/.test(approve) && /<meta name="referrer" content="no-referrer">/.test(approve));
  ok('6n. the acceptance page words a Full access invitation as Full access', /if \(b\.level === 'full'\) \{/.test(accept));
  ok('6o. fonts: Fraunces headlines, Hanken Grotesk text, Plus Jakarta Sans wordmark on the new page and dialog', /font-family:'Fraunces',Georgia,serif/.test(approve) && /'Hanken Grotesk'/.test(approve) && /'Plus Jakarta Sans'/.test(approve) && /"Fraunces",Georgia,serif/.test(js) && /"Hanken Grotesk"/.test(js));
  ok('6p. no em dashes in the new or touched files', ![js, dash, signin, booking, approve, accept, api, read('api/brand-signup.js'), read('api/_brand-identity.js'), read('supabase/migrations/0121_multi_brand_access.sql')].some(s => /—/.test(s)));
}

// ---- 7. the shared email card
{
  const { actionEmail } = await import('../api/_code-email.js');
  const html = actionEmail({ eyebrow: 'Access request', heading: 'A <b>rep</b> asks', paragraphs: ['First & second', '', 'Third "quoted"'], button: { label: 'Review the request', url: 'https://example.test/brand/approve?t=abc&x=1' }, note: 'Nobody gets access unless you approve.', reason: 'Why you got this.' });
  ok('7a. text is escaped, empty paragraphs are dropped, the button carries the link', /A &lt;b&gt;rep&lt;\/b&gt; asks/.test(html) && /First &amp; second/.test(html) && /Third &quot;quoted&quot;/.test(html) && (html.match(/<p style="font-size:15px/g) || []).length === 2 && /href="https:\/\/example\.test\/brand\/approve\?t=abc&amp;x=1"/.test(html));
  ok('7b. the same branded card as the code emails: dark green header, the Demohub mark and wordmark', /background:#0f2c17/.test(html) && />demohub</.test(html) && /<svg width="36" height="36"/.test(html));
  ok('7c. no six digits in a row anywhere in the card (code-reading tests must find real codes first)', !/\d{6}/.test(actionEmail({ eyebrow: 'x', heading: 'y', paragraphs: ['z'], button: null })));
  ok('7d. no button without a link', !/<a href/.test(actionEmail({ eyebrow: 'x', heading: 'y', paragraphs: ['z'], button: null })));
}

console.log(`\none person, many brands, offline: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
