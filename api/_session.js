// api/_session.js — F5-06: session/membership/CSRF/owner hardening.
// - a session is only valid if the member STILL has a live membership (removal takes effect);
// - removing/downgrading a member revokes their sessions immediately;
// - owner authority requires an owner-shaped session, not just an allowlisted email;
// - CSRF moved to api/_csrf.js (the helper here was never called by anything).

import { getBinding } from './_env.js';

const OWNER_EMAILS = ['david@demohubhq.com', 'davidmichaelheiser@gmail.com'];
const OWNER_SLUG = '__owner__';

async function rest(path, opts = {}) {
  const b = await getBinding();
  return fetch(`${b.supabaseUrl}/rest/v1/${path}`, { ...opts, headers: { apikey: b.serviceKey, Authorization: `Bearer ${b.serviceKey}`, 'Content-Type': 'application/json', ...(opts.headers || {}) } });
}

export async function membershipFor(retailerId, email) {
  const e = String(email || '').trim().toLowerCase();
  const r = await rest(`retailer_admins?retailer_id=eq.${encodeURIComponent(retailerId)}&select=email,role`);
  const rows = r.ok ? await r.json() : [];
  return rows.find(m => String(m.email || '').trim().toLowerCase() === e) || null;
}

// Immediately invalidate every session for a member (call on removal or role downgrade).
export async function revokeSessionsFor(retailerId, email) {
  const e = String(email || '').trim().toLowerCase();
  await rest(`admin_sessions?retailer_id=eq.${encodeURIComponent(retailerId)}&email=ilike.${encodeURIComponent(e)}`, { method: 'DELETE' });
}

// Strict session verify: valid + unexpired + (owner OR live membership). Fails closed.
export async function verifyAdminSessionStrict(sessionId) {
  if (!sessionId) return { ok: false, status: 401, error: 'no session' };
  let s;
  try { const r = await rest(`admin_sessions?session_id=eq.${encodeURIComponent(sessionId)}&select=*`); s = r.ok ? (await r.json())[0] : null; }
  catch (_) { return { ok: false, status: 503, error: 'auth unavailable' }; }
  if (!s) return { ok: false, status: 401, error: 'invalid session' };
  const exp = Date.parse(s.expires_at);
  if (!Number.isFinite(exp) || exp <= Date.now()) return { ok: false, status: 401, error: 'session expired' };
  const email = String(s.email || '').trim().toLowerCase();

  // owner: allowlisted email AND owner-shaped session (null retailer or the __owner__ system retailer)
  if (OWNER_EMAILS.includes(email)) {
    let owner = !s.retailer_id;
    if (!owner && s.retailer_id) {
      try { const rr = await rest(`retailers?id=eq.${encodeURIComponent(s.retailer_id)}&select=slug`); const row = rr.ok ? (await rr.json())[0] : null; owner = row && row.slug === OWNER_SLUG; } catch (_) { return { ok: false, status: 503, error: 'auth unavailable' }; }
    }
    if (owner) return { ok: true, isOwner: true, retailerId: s.retailer_id, email, role: 'owner' };
  }
  // ordinary staff: REQUIRE a live membership (removed/downgraded members are denied)
  const m = await membershipFor(s.retailer_id, email);
  if (!m) return { ok: false, status: 403, error: 'no access for this account' };
  return { ok: true, isOwner: false, retailerId: s.retailer_id, email, role: m.role };
}

// CSRF: REMOVED. This file used to export checkOrigin(allowedOrigins) and NOT ONE route called
// it — the control existed, read as protection, and was wired to nothing. api/_csrf.js replaces
// it with requireSameOrigin(), which is invoked by every cookie-authenticated route and covered by
// tests/session_transport.test.mjs.
//
// It is deleted rather than kept alongside the working version for two reasons. A second CSRF
// helper in the tree is something a future change can reach for, and this one was weaker: it
// consulted only Origin and Referer, ignored Sec-Fetch-Site, took its allowlist as an argument
// (so each caller could pass a different one), and derived the expected origin from nothing —
// meaning a caller passing a list containing a sibling subdomain would have accepted it.
