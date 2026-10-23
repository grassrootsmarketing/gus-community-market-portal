// tests/store_calendar_admin_wiring.test.mjs: the admin side of the shareable store calendar, offline (source checks of
// the shipped files, the way tests/admin_cancel_wiring.test.mjs guards the cancel dialog). Proves the Settings box
// exists and is wired to the three actions, that rotation asks for confirmation, that the revealed link is copied
// from an input the server filled, that the route gates the actions to owners and admins, that the page is
// rewritten for every store slug, and that the public page carries its privacy metadata.
// Run from the repository root:  node tests/store_calendar_admin_wiring.test.mjs   (no credentials needed)
import { readFileSync } from 'node:fs';
let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n + (d ? ' ' + d : '')); } };
const admin = readFileSync('r/gus/admin/index.html', 'utf8');
const route = readFileSync('api/admin-auth.js', 'utf8');
const data = readFileSync('api/store-calendar.js', 'utf8');
const page = readFileSync('r/gus/calendar/index.html', 'utf8');
const vercel = JSON.parse(readFileSync('vercel.json', 'utf8'));
const migration = readFileSync('supabase/migrations/0111_store_calendar_links.sql', 'utf8');

console.log(':: admin Settings box ::');
ok('the Staff calendar links box exists inside the calendar feed card and loads with Settings', /id="staffCalendarGroup"/.test(admin) && /id="staffCalendarLinks"/.test(admin) && /function loadSettings\(\) \{[^\n]*loadStaffCalendarLinks\(\)/.test(admin));
ok('the box explains: view only, no sign-in, copy at creation, rotate retires', /view-only web page/.test(admin) && /No sign-in, no accounts, no contact details/.test(admin) && /Copy a link when you create it; it is not shown again/.test(admin) && /Rotate makes the old link stop working/.test(admin));
ok('list, issue and revoke are the three actions the box calls, and nothing else of this kind', /staffCalApi\('store-calendar-links'\)/.test(admin) && /staffCalApi\('store-calendar-link-issue', \{ venue_id: venueId \}\)/.test(admin) && /staffCalApi\('store-calendar-link-revoke', \{ venue_id: venueId \}\)/.test(admin) && (admin.match(/store-calendar-link-[a-z]+/g) || []).every(a => ['store-calendar-link-issue', 'store-calendar-link-revoke'].includes(a)));
ok('rotating and stopping ask for confirmation first; creating does not', /rotating && !window\.confirm\('Rotate this link\?/.test(admin) && /window\.confirm\('Stop sharing this calendar\?/.test(admin));
ok('the revealed link is rendered escaped into a readonly input with a copy-now warning and a Copy button', /Copy this link now\. It is not shown again\./.test(admin) && /readonly value="' \+ _esc\(j\.link_url\)/.test(admin) && /copyStaffCalendarLink\(this\)/.test(admin));
ok('names from the server are escaped before they reach the DOM', /_esc\(s\.venue_name\)/.test(admin) && /_esc\(s\.issued_by\)/.test(admin));
ok('a viewer sees a plain sentence, not an error, when the route answers insufficient_role', /insufficient_role' \? 'Only owners and admins manage staff calendar links\.'/.test(admin));

console.log('\n:: admin-auth route ::');
ok('the three actions share one branch gated to owner and admin through requireRetailerMembership', /action === 'store-calendar-links' \|\| action === 'store-calendar-link-issue' \|\| action === 'store-calendar-link-revoke'/.test(route) && /requireRetailerMembership\(session_id, null, \['owner', 'admin'\]\)/.test(route));
ok('issue mints a 256-bit token and stores only its hash; the URL carries the secret in the fragment', /mintToken\(\)/.test(route) && /p_token_hash: hashToken\(token\)/.test(route) && /\/calendar#k=\$\{token\}/.test(route));
ok('a venue id is shape-checked and must belong to the store before any function runs', /bad_venue/.test(route) && /venue_not_in_retailer/.test(route));
ok('the list never selects the hash', /store_calendar_links\?retailer_id=eq\.[^`]*select=venue_id,issued_at,issued_by_email,last_used_at/.test(route) && !/select=[^`]*token_hash/.test(route));

console.log('\n:: data route and page ::');
ok('the data route accepts the token only as a bearer header and answers one neutral 401', /tokenFromRequest\(req\)/.test(data) && !/req\.query[^\n]*token/.test(data) && (data.match(/link_invalid/g) || []).length >= 3);
ok('private-data headers are set before any branch', /privateHeaders\(res\);\s*\n\s*if \(req\.method === 'OPTIONS'\)/.test(data) && /no-store/.test(data) && /no-referrer/.test(data) && /noindex, nofollow, noarchive/.test(data));
ok('confirmed only, scope from the credential, a retired location kills its link, a bounded window', /status=eq\.confirmed/.test(data) && /link\.venue_id \? `&venue_id=eq\./.test(data) && /active=eq\.true/.test(data) && /resolveRange\(req\.query/.test(data));
ok('the page is noindex and no-referrer, moves the secret out of the address bar, and sends it as a bearer header', /<meta name="robots" content="noindex, nofollow, noarchive">/.test(page) && /<meta name="referrer" content="no-referrer">/.test(page) && /history\.replaceState\(null, '', location\.pathname\)/.test(page) && /Authorization: 'Bearer ' \+ token/.test(page) && /credentials: 'omit'/.test(page));
ok('the page has no admin controls and says so', !/booking-action|admin-auth|action: '|window.confirm/.test(page.split('<script>')[1] || '') && /cannot change anything/.test(page));
ok('every store slug is rewritten to the page, ahead of the booking page rewrite', vercel.rewrites.findIndex(r => r.source === '/r/:slug/calendar') > -1 && vercel.rewrites.findIndex(r => r.source === '/r/:slug/calendar') < vercel.rewrites.findIndex(r => r.source === '/r/:slug'));

console.log('\n:: migration 0111 ::');
ok('one table, a hash-shape check, one active link per scope, RLS on, anon and authenticated revoked', /CREATE TABLE IF NOT EXISTS public\.store_calendar_links/.test(migration) && /token_hash ~ '\^\[0-9a-f\]\{64\}\$'/.test(migration) && /store_calendar_links_one_active_per_scope/.test(migration) && /ENABLE ROW LEVEL SECURITY/.test(migration) && /REVOKE ALL ON public\.store_calendar_links FROM public, anon, authenticated/.test(migration));
ok('issue revokes the scope and inserts in one statement block; the venue must belong to the retailer; functions are service_role only', /UPDATE public\.store_calendar_links SET revoked_at = now\(\)[\s\S]*INSERT INTO public\.store_calendar_links/.test(migration) && /venue_not_in_retailer/.test(migration) && (migration.match(/GRANT EXECUTE ON FUNCTION.*TO service_role;/g) || []).length === 3 && (migration.match(/REVOKE ALL ON FUNCTION.*FROM public, anon, authenticated;/g) || []).length === 3);
ok('no em dash in any of the shipped files', ![admin, route, data, page, migration].some(s => /—/.test(s)));

console.log(`\nstore calendar admin wiring: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
