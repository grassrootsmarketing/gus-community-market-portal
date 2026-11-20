// api/_booking-identity.js, F5-05: booking + agreement identity comes from the AUTHENTICATED
// brand session, never from a submitted email. Stops "book as another brand / use their COI"
// (LG-01) and stops the agreement-record disclosure.

import { getBinding } from './_env.js';
import { getSessionToken } from './_cookies.js';
import { resolveBrandIdentity, brandContextCheck } from './_brand-identity.js';

async function rest(path) {
  const b = await getBinding();
  return fetch(`${b.supabaseUrl}/rest/v1/${path}`, { headers: { apikey: b.serviceKey, Authorization: `Bearer ${b.serviceKey}` } });
}

// The authoritative identity resolver. Returns {ok, brandId, email} from the session ALONE.
//
// Codex finding B: "from the session alone" was already the rule for the EMAIL, but the session
// itself was accepted from body.session_token / body.session_id as well as the cookie. Booking and
// agreement signing are the actions this resolver gates, so a session that can arrive in a request
// body is a session that can be replayed out of any log or proxy that recorded that body.
// opts.mutation: true on the routes that book, pay or sign (0121, Codex finding 2 and R1): they must be told which brand
// the page shows whenever the brand-context rule is in force (see api/_brand-identity.js: the policy switch, the
// feature switch, or a person with several brands), and a missing, malformed or different brand is refused before any
// write or provider call. Reads pass without it.
export async function requireBrandSession(req, _body, opts = {}) {
  // 0097 (Codex BK-4): the session resolves through the identity boundary, which checks the LIVE membership on
  // every request and adds { memberId, role }. The { ok, brandId, email } shape every caller reads is unchanged.
  const token = getSessionToken(req, 'brand');
  if (!token) return { ok: false, status: 401, error: 'sign in to book' };
  const ctx = await resolveBrandIdentity(token);
  // 0121: a page still showing another brand (the person switched in a different tab) is refused, never booked.
  const problem = await brandContextCheck(req, ctx, { mutation: opts.mutation === true });
  if (problem) return { ok: false, status: 409, error: problem.error, message: problem.message };
  return ctx;
}

// Agreement status for the AUTHENTICATED brand only. Returns booleans + reason, never the
// stored agreement record (no signed name/email/IP disclosure).
export async function agreementStatus(brandId, retailerId, currentPolicyHash) {
  const r = await rest(`brand_retailer_agreements?brand_id=eq.${encodeURIComponent(brandId)}&retailer_id=eq.${encodeURIComponent(retailerId)}&superseded_at=is.null&select=policy_hash,expires_at&order=signed_at.desc&limit=1`);
  const a = r.ok ? (await r.json())[0] : null;
  if (!a) return { has_active: false, needs_re_sign: true, reason: 'never_signed' };
  if (Number.isFinite(Date.parse(a.expires_at)) && Date.parse(a.expires_at) < Date.now()) return { has_active: false, needs_re_sign: true, reason: 'expired' };
  if (a.policy_hash !== currentPolicyHash) return { has_active: false, needs_re_sign: true, reason: 'policy_changed' };
  return { has_active: true, needs_re_sign: false };
}
