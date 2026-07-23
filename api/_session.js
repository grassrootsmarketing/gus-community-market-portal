// api/_session.js — F5-06: session/membership/CSRF/owner hardening.
// - a session is only valid if the member STILL has a live membership (removal takes effect);
// - removing/downgrading a member revokes their sessions immediately;
// - owner authority requires an owner-shaped session, not just an allowlisted email;
// - cookie-authenticated mutations must come from an allowed Origin (CSRF).

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const OWNER_EMAILS = ['david@demohubhq.com', 'davidmichaelheiser@gmail.com'];
const OWNER_SLUG = '__owner__';

function rest(path, opts = {}) {
  return fetch(`${SUPABASE_URL}/rest/v1/${path}`, { ...opts, headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json', ...(opts.headers || {}) } });
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

// CSRF: cookie-authenticated mutations must originate from an allowed site origin.
export function checkOrigin(req, allowedOrigins) {
  const o = (req.headers && (req.headers.origin || (req.headers.referer && new URL(req.headers.referer).origin))) || null;
  if (!o) return false;
  return allowedOrigins.includes(o);
}
