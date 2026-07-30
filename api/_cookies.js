// api/_cookies.js — session transport. Cookies only, one per role.
//
// Codex finding B. Before this, sessions were returned in JSON bodies, accepted from query
// strings and request bodies, and stored in localStorage by page JavaScript. Each of those is a
// separate way for a session secret to escape:
//   * a JSON body is readable by any script on the page, and ends up in analytics payloads
//   * a query string lands in browser history, server access logs, and Referer headers
//   * localStorage is readable by any XSS and survives until explicitly cleared
//
// THREE SEPARATE COOKIES, deliberately. Codex required that owner and impersonated-retailer
// sessions not share one cookie. If they did, an owner impersonating a retailer would overwrite
// their own session — and worse, a retailer-scoped session sitting in the owner cookie would be
// read by owner-only code paths as if it were an owner. Distinct names make that impossible to
// express rather than merely unlikely.
//
// HOST-ONLY: no Domain attribute. A cookie scoped to demohubhq.com would be sent to every
// subdomain, so a compromised or third-party subdomain could harvest live sessions. Omitting
// Domain confines each cookie to the exact host that set it.

export const COOKIE = {
  brand:    'dh_brand_session',
  retailer: 'dh_retailer_session',
  owner:    'dh_owner_session',
};

const ROLES = Object.keys(COOKIE);

// SameSite=Lax, not Strict: a magic link arriving from an email client is a cross-site
// top-level GET, and Strict would drop the cookie and break sign-in. Lax still withholds the
// cookie from cross-site POSTs, and every mutation additionally goes through requireSameOrigin().
const BASE_ATTRS = 'Path=/; HttpOnly; Secure; SameSite=Lax';

function assertRole(role) {
  if (!ROLES.includes(role)) throw new Error(`unknown session role: ${role}`);
}

function appendSetCookie(res, value) {
  const existing = res.getHeader ? res.getHeader('Set-Cookie') : null;
  if (!existing) return res.setHeader('Set-Cookie', value);
  const list = Array.isArray(existing) ? existing : [existing];
  return res.setHeader('Set-Cookie', [...list, value]);
}

export function setSessionCookie(res, role, token, maxAgeSeconds = 2592000) {
  assertRole(role);
  if (!token) throw new Error('setSessionCookie: no token');
  appendSetCookie(res, `${COOKIE[role]}=${encodeURIComponent(token)}; ${BASE_ATTRS}; Max-Age=${maxAgeSeconds}`);
}

export function clearSessionCookie(res, role) {
  assertRole(role);
  appendSetCookie(res, `${COOKIE[role]}=; ${BASE_ATTRS}; Max-Age=0`);
}

// Clearing every role at once — used by logout so an impersonation session cannot outlive it.
export function clearAllSessionCookies(res) {
  for (const role of ROLES) clearSessionCookie(res, role);
}

export function readCookies(req) {
  const raw = (req.headers && req.headers.cookie) || '';
  const out = {};
  for (const part of String(raw).split(';')) {
    const i = part.indexOf('=');
    if (i < 1) continue;
    const k = part.slice(0, i).trim();
    if (!k) continue;
    try { out[k] = decodeURIComponent(part.slice(i + 1).trim()); }
    catch { out[k] = part.slice(i + 1).trim(); }
  }
  return out;
}

// THE ONLY way a handler should obtain a session secret.
//
// Deliberately does NOT fall back to req.body or req.query. Codex finding B requires the legacy
// compatibility paths gone, and there is no real user data to preserve — so a transitional
// "accept either" mode would only serve to keep the insecure path alive indefinitely.
export function getSessionToken(req, role) {
  assertRole(role);
  const v = readCookies(req)[COOKIE[role]];
  return v && String(v).trim() ? String(v).trim() : null;
}

// True when a request carries a session secret somewhere it should never appear. Used by tests
// and by a defensive check in handlers, so a regression is loud rather than silent.
export function sessionSecretInWrongPlace(req) {
  const found = [];
  const q = req.query || {};
  const b = (req.body && typeof req.body === 'object') ? req.body : {};
  for (const key of ['session_id', 'session_token', 'sid', 'token']) {
    if (q[key]) found.push(`query.${key}`);
    if (b[key]) found.push(`body.${key}`);
  }
  return found;
}
