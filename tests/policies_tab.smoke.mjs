// Policies tab (2026-09-23) — targeted save/reload smoke for the two cards that moved: cancellation policy and demo
// conduct policy. Real exported handlers against the TEST database; synthetic fixtures. Also checks the markup:
// both cards and the setup nudge carry data-tab="policiesSection", the tab is in the controller list, and the
// cancellation radios are no longer inside Booking preferences.
import { readFileSync } from 'node:fs';
import { callRoute, req, ok, summary, uniq } from './_route.mjs';

const SB = process.env.SB_URL, KEY = process.env.SB_KEY;
const H = { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json', Prefer: 'return=representation' };
const db = async (path, opts = {}) => { const r = await fetch(`${SB}/rest/v1/${path}`, { ...opts, headers: { ...H, ...(opts.headers || {}) } }); const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch (_) {} return { ok: r.ok, status: r.status, body: j }; };
const one = (r) => (r && Array.isArray(r.body) ? r.body[0] : null);
const bin = []; const track = (t, id) => { if (id) bin.push([t, id]); return id; };

console.log('\n— markup —');
{ const html = readFileSync(new URL('../r/gus/admin/index.html', import.meta.url), 'utf8');
  ok('Policies tab link exists (desktop + mobile) and is in the tab controller list', /data-section="policiesSection">Policies<\/a>/.test(html) && /mobileNavGo\(event, 'policiesSection', 'Policies'\)/.test(html) && /'billingSection','policiesSection','settingsSection'\]/.test(html));
  ok('cancellation policy card, demo conduct policy card and the setup nudge are routed to the Policies tab', /id="cancellationPolicyCard" data-tab="policiesSection"/.test(html) && /id="demoPolicyCard" data-tab="policiesSection"/.test(html) && /id="policySetupCallout" data-tab="policiesSection"/.test(html) && /querySelectorAll\('\.settings-card, #policySetupCallout'\)/.test(html));
  const prefs = html.slice(html.indexOf('id="bookingPrefsCard"'), html.indexOf('id="bookingCodesCard"'));
  ok('the cancellation radios are no longer inside Booking preferences', !/name="cancellationMode"/.test(prefs) && /name="cancellationMode"/.test(html.slice(html.indexOf('id="cancellationPolicyCard"'), html.indexOf('id="demoPolicyCard"'))));
  ok('saving the cancellation choice reports on the Policies card too', /const status2 = document\.getElementById\('cancellationPolicyStatus'\)/.test(html) && /id="cancellationPolicyStatus"/.test(html)); }

console.log('\n— save / reload through the real routes —');
const slug = uniq('pt');
const retailerId = track('retailers', one(await db('retailers', { method: 'POST', body: JSON.stringify({ slug, name: 'Policies Fixture', billing_email: `${slug}@fixture.test`, billing_tier: 'pro', billing_status: 'active', platform_keeps_all: true, timezone: 'America/Los_Angeles', auto_confirm_bookings: true, cancellation_mode: 'refundable' }) })).id);
const staffEmail = `staff-${slug}@fixture.test`;
track('retailer_admins', one(await db('retailer_admins', { method: 'POST', body: JSON.stringify({ retailer_id: retailerId, email: staffEmail, email_normalized: staffEmail, name: 'P Staff', role: 'owner' }) })).id);
const tok = one(await db('admin_tokens', { method: 'POST', body: JSON.stringify({ email: staffEmail, retailer_id: retailerId }) }));
const cookie = (await callRoute('admin-auth.js', req({ body: { action: 'verify', token: tok.token } }))).cookie('dh_retailer_session');
const admin = async (method, query, body) => { const r = await callRoute('admin.js', req({ method, query, body, cookies: { dh_retailer_session: cookie } })); if (typeof r.body === 'string') { try { r.body = JSON.parse(r.body); } catch (_) {} } return r; };
try {
  // the same PATCH the Cancellation policy card issues (saveBookingPrefs -> /api/admin?table=retailers&id=...)
  const p1 = await admin('PATCH', { table: 'retailers', id: retailerId }, { auto_confirm_bookings: true, cancellation_mode: 'non_refundable' });
  const g1 = { statusCode: 200, body: { retailer: one(await db(`retailers?id=eq.${retailerId}&select=cancellation_mode,cancellation_policy,demo_policy`)) } };
  ok('cancellation policy: save non_refundable, reload shows non_refundable AND the non-refundable sentence (written by the server with the mode)', p1.statusCode === 200 && g1.statusCode === 200 && g1.body.retailer && g1.body.retailer.cancellation_mode === 'non_refundable' && /not refunded/.test(g1.body.retailer.cancellation_policy || ''), `${p1.statusCode} ${g1.statusCode} ${g1.body && g1.body.retailer && g1.body.retailer.cancellation_mode}`);
  const p2 = await admin('PATCH', { table: 'retailers', id: retailerId }, { cancellation_mode: 'refundable' });
  const g2 = { body: { retailer: one(await db(`retailers?id=eq.${retailerId}&select=cancellation_mode`)) } };
  ok('cancellation policy: back to refundable (the 72-hour rule), reload agrees', p2.statusCode === 200 && g2.body.retailer.cancellation_mode === 'refundable');
  // the demo conduct policy text (saveDemoPolicy -> PATCH retailers.demo_policy)
  const text = 'Policies tab smoke ' + slug + ': set up 15 minutes early; sample only from sealed stock.';
  const p3 = await admin('PATCH', { table: 'retailers', id: retailerId }, { demo_policy: text });
  const g3 = { body: { retailer: one(await db(`retailers?id=eq.${retailerId}&select=demo_policy`)) } };
  ok('demo conduct policy: save custom text, reload returns exactly that text', p3.statusCode === 200 && g3.body.retailer.demo_policy === text, `${p3.statusCode} ${String(g3.body.retailer && g3.body.retailer.demo_policy).slice(0, 60)}`);
  const bad = await admin('PATCH', { table: 'retailers', id: retailerId }, { cancellation_mode: 'free_for_all' });
  // 2026-10-18: the gap recorded here on 2026-09-23 (any value accepted) is closed; only the two modes the server reads
  // may be written (api/admin.js, isCancellationMode).
  ok('an unknown cancellation_mode is refused 400 invalid_cancellation_mode', bad.statusCode === 400 && bad.body && bad.body.error === 'invalid_cancellation_mode', `${bad.statusCode} ${JSON.stringify(bad.body).slice(0, 120)}`);
  const contra = await admin('PATCH', { table: 'retailers', id: retailerId }, { cancellation_mode: 'refundable', cancellation_policy: 'Our own wording.' });
  ok('a sentence that is not the standard one for the mode is refused 400 policy_text_mismatch', contra.statusCode === 400 && contra.body && contra.body.error === 'policy_text_mismatch', `${contra.statusCode}`);
  await admin('PATCH', { table: 'retailers', id: retailerId }, { cancellation_mode: 'refundable' });
} finally { for (const [t, id] of bin.reverse()) await db(`${t}?id=eq.${id}`, { method: 'DELETE' }); }
process.exit(summary('policies tab smoke') ? 0 : 1);
