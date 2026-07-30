// api/_csrf.js — same-origin enforcement for every cookie-authenticated mutation.
//
// Codex finding B: a `checkOrigin()` helper already existed in api/_session.js and NO handler
// called it. Same shape as the binding guard nothing invoked and the static rules that could not
// see — a control that exists, reads as protection, and is not wired to anything.
//
// WHY THIS IS NEEDED AT ALL, given SameSite=Lax cookies:
//   * Lax is a good default but not a complete defence. It permits cross-site top-level GETs,
//     and browsers differ on edge cases (redirect chains, some older versions treat certain
//     POST navigations leniently).
//   * Lax says nothing about SAME-SITE-but-different-origin requests. A sibling origin —
//     another subdomain, or a preview deployment on the same registrable domain — is same-site,
//     so its requests carry the cookie. Codex specifically required sibling-origin denial.
// So the cookie attribute and this check defend different things and both are required.
//
// ORDER OF EVIDENCE, strongest first:
//   1. Sec-Fetch-Site: set by the browser, unforgeable by page script. `same-origin` passes.
//   2. Origin header: present on all cross-origin requests and on same-origin POSTs.
//   3. Referer: fallback for the rare request with neither of the above.
// If none of the three is present on a mutation, we DENY. A request that reveals nothing about
// where it came from is not a request we should mutate state for.

import { link } from './_env.js';

export class CsrfError extends Error {
  constructor(code, detail) { super(code); this.name = 'CsrfError'; this.code = code; this.detail = detail || null; }
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function originOf(url) {
  try { const u = new URL(String(url)); return u.origin; } catch { return null; }
}

// Returns { ok:true } or { ok:false, reason, detail }.
export function checkSameOrigin(req, binding) {
  const method = String(req.method || 'GET').toUpperCase();
  if (SAFE_METHODS.has(method)) return { ok: true, reason: 'safe_method' };

  // link() THROWS BindingError when siteOrigin is unset — it does not return a falsy value.
  // Letting that propagate would turn a missing configuration into an unhandled 500 from inside
  // whatever handler called us, instead of the controlled denial this function is supposed to
  // produce. Fail closed, and say so.
  let expected = null;
  try { expected = originOf(link(binding, '/')); } catch { expected = null; }
  if (!expected) return { ok: false, reason: 'site_origin_not_configured' };

  const h = req.headers || {};

  // 1. Fetch metadata — browser-set, not script-settable.
  const fetchSite = String(h['sec-fetch-site'] || '').toLowerCase();
  if (fetchSite) {
    if (fetchSite === 'same-origin') return { ok: true, reason: 'sec_fetch_site' };
    // 'same-site' is NOT sufficient: a sibling subdomain is same-site and must be denied.
    return { ok: false, reason: 'cross_origin', detail: { sec_fetch_site: fetchSite } };
  }

  // 2. Origin.
  const origin = h.origin ? originOf(h.origin) : null;
  if (origin) {
    if (origin === expected) return { ok: true, reason: 'origin' };
    return { ok: false, reason: 'origin_mismatch' };
  }

  // 3. Referer.
  const referer = h.referer ? originOf(h.referer) : null;
  if (referer) {
    if (referer === expected) return { ok: true, reason: 'referer' };
    return { ok: false, reason: 'referer_mismatch' };
  }

  // Nothing to judge by. Deny — this is a mutation.
  return { ok: false, reason: 'no_origin_evidence' };
}

// Handler guard. Call immediately after the binding guard, BEFORE reading a session or touching
// any state. Returns true when the request may proceed; when it returns false the response has
// already been sent.
export function requireSameOrigin(req, res, binding) {
  const r = checkSameOrigin(req, binding);
  if (r.ok) return true;
  // Redacted: reason code only. No origin values, no session, no body.
  console.warn('CSRF_DENIED', JSON.stringify({
    reason: r.reason, method: req.method, target: binding && binding.targetName,
  }));
  res.setHeader('Cache-Control', 'no-store');
  res.status(403).json({ error: 'cross_origin_denied' });
  return false;
}

// The ONLY permitted exemptions, per Codex: requests authenticated by a signature or a shared
// secret rather than by a cookie. These carry no cookie, so CSRF does not apply to them —
// but they must prove identity another way, which their own handlers already enforce.
//
// Named explicitly so adding an exemption is a visible, reviewable act.
export const CSRF_EXEMPT_REASONS = Object.freeze({
  STRIPE_WEBHOOK: 'stripe_signature_verified',
  AUTHENTICATED_CRON: 'cron_secret_verified',
});

export function noteCsrfExemption(reason) {
  if (!Object.values(CSRF_EXEMPT_REASONS).includes(reason)) {
    throw new Error(`unrecognised CSRF exemption: ${reason}`);
  }
  return true;
}
