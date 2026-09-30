// Minimum booking lead time (2026-09-30): the retailer admin's settings PATCH accepts whole days 0..365 and refuses
// anything else, so a blank dropdown can never write NaN/null into the value the booking page enforces.
import { callRoute, req, ok, summary, uniq } from './_route.mjs';

const SB = process.env.SB_URL, KEY = process.env.SB_KEY;
const H = { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json', Prefer: 'return=representation' };
const db = async (path, opts = {}) => { const r = await fetch(`${SB}/rest/v1/${path}`, { ...opts, headers: { ...H, ...(opts.headers || {}) } }); const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch (_) {} return { ok: r.ok, status: r.status, body: j }; };
const one = (r) => (r && Array.isArray(r.body) ? r.body[0] : null);
const J = (r) => { try { return typeof r.body === 'string' ? JSON.parse(r.body) : r.body; } catch (_) { return {}; } };
const bin = []; const track = (t, id) => { if (id) bin.push([t, id]); return id; };

const slug = uniq('lt');
const retailerId = track('retailers', one(await db('retailers', { method: 'POST', body: JSON.stringify({ slug, name: 'Lead Time Market', billing_email: `${slug}@fixture.test`, billing_tier: 'pro', billing_status: 'active', verification_status: 'approved' }) })).id);
const settingsId = track('settings', one(await db('settings', { method: 'POST', body: JSON.stringify({ retailer_id: retailerId, demo_fee: 30, advance_booking_days: 60 }) })).id);
const staffEmail = `staff-${slug}@fixture.test`;
track('retailer_admins', one(await db('retailer_admins', { method: 'POST', body: JSON.stringify({ retailer_id: retailerId, email: staffEmail, email_normalized: staffEmail, name: 'LT Staff', role: 'owner' }) })).id);
const stTok = one(await db('admin_tokens', { method: 'POST', body: JSON.stringify({ email: staffEmail, retailer_id: retailerId }) }));
const staffCookie = (await callRoute('admin-auth.js', req({ body: { action: 'verify', token: stTok.token } }))).cookie('dh_retailer_session');
const patch = (body) => callRoute('admin.js', req({ method: 'PATCH', query: { table: 'settings', id: settingsId }, body, cookies: { dh_retailer_session: staffCookie } }));
const current = async () => one(await db(`settings?id=eq.${settingsId}&select=advance_booking_days`)).advance_booking_days;
try {
  ok('fixture: staff session and a store saved at 60 days', !!staffCookie && (await current()) === 60);
  for (const [label, v] of [['NaN (blank dropdown)', NaN], ['null', null], ['a string', '14'], ['negative', -1], ['366', 366], ['a fraction', 14.5]]) {
    const r = await patch({ advance_booking_days: v });
    ok(`refused: ${label} -> 400 invalid_advance_booking_days, value untouched`, r.statusCode === 400 && J(r).error === 'invalid_advance_booking_days' && (await current()) === 60, `${r.statusCode} ${JSON.stringify(J(r)).slice(0, 100)}`);
  }
  for (const v of [14, 0, 365, 45]) { const r = await patch({ advance_booking_days: v }); ok(`accepted: ${v} days`, r.statusCode < 300 && (await current()) === v, `${r.statusCode}`); }
  const pd = await callRoute('find-retailer.js', req({ body: { action: 'public-data', slug } }));
  ok('the booking page reads the same value (public-data settings.advance_booking_days = 45)', pd.statusCode === 200 && pd.body.settings && pd.body.settings.advance_booking_days === 45);
} finally {
  await db(`admin_sessions?retailer_id=eq.${retailerId}`, { method: 'DELETE' }); await db(`admin_tokens?retailer_id=eq.${retailerId}`, { method: 'DELETE' });
  for (const [t, id] of bin.reverse()) await db(`${t}?id=eq.${id}`, { method: 'DELETE' });
}
process.exit(summary('lead time setting') ? 0 : 1);
