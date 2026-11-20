// api/_brand-identity.js (David, 2026-10-17; Codex BK-4): THE brand identity boundary.
//
// A brand session used to resolve to { brandId, email } and nothing more, so anyone with a session row was the
// brand. With the designated booker (0097) a session resolves to an identity context:
//
//   { brandId, email, memberId, role }        role: 'owner' | 'booker'
//
// Resolution reads the session row, the brand's own email and the LIVE membership row on every request:
//   * email == brands.email            -> owner (the canonical owner row; backfilled if an old brand lacks one)
//   * accepted brand_members booker row -> booker
//   * anything else (pending, revoked, no row, brand gone) -> 401, and the session row is deleted
// A revoked booker therefore loses access on the next request, not at cookie expiry. Store failures fail CLOSED
// (503 auth_unavailable), never open.
//
// requireRole(ctx, ...roles) is the one place a route says who may do what. Default is deny: a route that does
// not call it for a booker-capable action is a bug the matrix test (tests/brand_booker_matrix.test.mjs) catches.
import { getBinding } from './_env.js';
import { getSessionToken } from './_cookies.js';
import { FLAGS } from './_flags.js';

async function rest(path, opts = {}) {
  const b = await getBinding();
  return fetch(`${b.supabaseUrl}/rest/v1/${path}`, { ...opts, headers: { apikey: b.serviceKey, Authorization: `Bearer ${b.serviceKey}`, 'Content-Type': 'application/json', ...(opts.headers || {}) } });
}
const enc = encodeURIComponent;
const norm = (e) => String(e == null ? '' : e).trim().toLowerCase();

// 0121: 'manager' is the "Full access" level. It does everything the owner does except the few owner-only actions
// a route names with requireOwner (who has access, the owner sign-in itself). 'booker' is "Booking only".
export const ROLES = Object.freeze({ OWNER: 'owner', BOOKER: 'booker', MANAGER: 'manager' });

// Resolve a session token to an identity context. Returns { ok:true, ...ctx } or { ok:false, status, error }.
export async function resolveBrandIdentity(sessionToken) {
  const token = String(sessionToken || '').trim();
  if (!token) return { ok: false, status: 401, error: 'sign in to continue' };
  let session;
  try {
    const r = await rest(`brand_account_sessions?session_token=eq.${enc(token)}&select=id,brand_id,email,expires_at&limit=1`);
    if (!r.ok) return { ok: false, status: 503, error: 'auth_unavailable' };
    const rows = await r.json();
    session = Array.isArray(rows) ? rows[0] : null;
  } catch (_) { return { ok: false, status: 503, error: 'auth_unavailable' }; }
  if (!session) return { ok: false, status: 401, error: 'invalid session' };
  const exp = Date.parse(session.expires_at);
  if (!Number.isFinite(exp) || exp <= Date.now()) return { ok: false, status: 401, error: 'session expired' };
  const email = norm(session.email);
  let brand, member;
  try {
    const [bR, mR] = await Promise.all([
      rest(`brands?id=eq.${enc(session.brand_id)}&select=id,email,contact_name&limit=1`),
      email ? rest(`brand_members?brand_id=eq.${enc(session.brand_id)}&email=eq.${enc(email)}&status=neq.revoked&select=id,role,status,email,name&limit=1`) : null,
    ]);
    if (!bR.ok || (mR && !mR.ok)) return { ok: false, status: 503, error: 'auth_unavailable' };
    brand = (await bR.json())[0] || null;
    member = mR ? ((await mR.json())[0] || null) : null;
  } catch (_) { return { ok: false, status: 503, error: 'auth_unavailable' }; }
  if (!brand) return await refuse(session, 'brand missing');
  const ownerEmail = norm(brand.email);
  if (email && email === ownerEmail) {
    // The canonical owner. An old brand may lack its owner row; 0097 backfills, this covers a brand created between.
    let memberId = member && member.role === 'owner' ? member.id : null;
    if (!memberId) {
      try {
        const r = await rest('brand_members', { method: 'POST', headers: { Prefer: 'return=representation,resolution=ignore-duplicates' }, body: JSON.stringify({ brand_id: brand.id, email: ownerEmail, name: brand.contact_name || null, role: 'owner', status: 'accepted', accepted_at: new Date().toISOString() }) });
        if (r.ok) { const rows = await r.json(); memberId = Array.isArray(rows) && rows[0] ? rows[0].id : null; }
        if (!memberId) {
          const again = await rest(`brand_members?brand_id=eq.${enc(brand.id)}&email=eq.${enc(ownerEmail)}&role=eq.owner&select=id&limit=1`);
          if (again.ok) { const rows = await again.json(); memberId = rows[0] ? rows[0].id : null; }
        }
      } catch (_) { /* the owner still signs in; attribution falls back to the brand */ }
    }
    return { ok: true, brandId: brand.id, email, memberId, role: ROLES.OWNER, name: (member && member.name) || brand.contact_name || null, sessionId: session.id };
  }
  if (member && member.role === 'booker' && member.status === 'accepted') {
    return { ok: true, brandId: brand.id, email, memberId: member.id, role: ROLES.BOOKER, name: member.name || null, sessionId: session.id };
  }
  if (member && member.role === 'manager' && member.status === 'accepted') {
    // 0121: Full access exists only while the multi-brand switch is on. With the switch off the person keeps a
    // working sign-in at the narrower level (never the wider one), so turning the switch off ends no session.
    const role = FLAGS.multiBrandAccess ? ROLES.MANAGER : ROLES.BOOKER;
    return { ok: true, brandId: brand.id, email, memberId: member.id, role, name: member.name || null, sessionId: session.id };
  }
  return await refuse(session, 'not a member');
}

async function refuse(session, why) {
  try { await rest(`brand_account_sessions?id=eq.${enc(session.id)}`, { method: 'DELETE' }); } catch (_) {}
  return { ok: false, status: 401, error: why };
}

// 0121: with several brands behind one sign-in, a page left open in one tab can be showing brand A while the person has
// switched the session to brand B in another tab. Pages send the brand they are SHOWING in the X-DH-Brand header
// (brand/brands.js guard). The header never grants anything: the session and the role stay the authority, and the
// header can only make the server refuse.
//
// Codex multi-brand review, finding 2: a valid session for brand B does not show that the person MEANT to act for B
// from the page in front of them. So a request that changes something for a brand must SAY which brand its page shows.
//
// Handback review, R1: that safety rule is NOT the same thing as the feature being available. Switching the feature off
// stops new switching and narrows Full access; it does not end sessions or remove memberships, so a session can still
// be on brand B while an old page shows brand A. The rule is therefore in force when ANY of these holds:
//   1. BRAND_CONTEXT_REQUIRED is on        (the policy switch; set with or before the feature, kept on through rollback)
//   2. MULTI_BRAND_ACCESS_ENABLED is on    (the feature)
//   3. the signed-in person can reach more than one brand, read from the database for this request
//      (so the protection does not depend on anyone remembering switch 1, and survives every restart and deploy)
// Outcomes:
//   * a well-formed brand that is not the session's            -> brand_changed            (always)
//   * no brand, or a malformed one, on a mutation, rule in force -> brand_context_required
//   * reads, and the documented recovery actions                -> pass (the first load of a page; listing, switching,
//     signing out)
//   * rule not in force (neither switch, a person with one brand): a mutation without a brand behaves as before this
//     release. That is the only compatibility case kept, and it cannot reach a second brand because there is none.
const BRAND_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const BRAND_CHANGED_BODY = Object.freeze({ error: 'brand_changed', message: 'You switched to another brand in a different tab. Reload this page to continue.' });
export const BRAND_CONTEXT_REQUIRED_BODY = Object.freeze({ error: 'brand_context_required', message: 'Reload this page to continue. It was opened before an update, so it cannot say which brand this is for. Nothing was changed.' });
const shownBrand = (req) => { const raw = req && req.headers ? String(req.headers['x-dh-brand'] || '').trim().toLowerCase() : ''; return BRAND_UUID.test(raw) ? raw : null; };
// The part that needs no database: null when the request may proceed as far as the two switches are concerned.
export function brandContextProblem(req, ctx, { mutation = false } = {}) {
  if (!ctx || !ctx.ok) return null;                      // authorization is decided elsewhere, first
  const shown = shownBrand(req);
  if (shown) return String(ctx.brandId).toLowerCase() === shown ? null : BRAND_CHANGED_BODY;
  if (mutation && (FLAGS.brandContextRequired || FLAGS.multiBrandAccess)) return BRAND_CONTEXT_REQUIRED_BODY;   // absent or malformed
  return null;
}
export function brandHeaderMismatch(req, ctx) { return brandContextProblem(req, ctx) === BRAND_CHANGED_BODY; }

// Can this person reach more than one brand? Their own brand (brands.email) plus every ACCEPTED access to another.
// Read fresh; a failed read answers true (fail closed: the request is asked to reload, never let through unsure).
export async function personHasSeveralBrands(email) {
  const e = norm(email);
  if (!e) return false;
  try {
    const [bR, mR] = await Promise.all([
      rest(`brands?email=eq.${enc(e)}&select=id&limit=1`),
      rest(`brand_members?email=eq.${enc(e)}&status=eq.accepted&role=in.(booker,manager)&select=brand_id&limit=25`),
    ]);
    if (!bR.ok || !mR.ok) return true;
    const own = (await bR.json())[0] || null;
    const ids = new Set((await mR.json()).map((m) => String(m.brand_id)));
    if (own) ids.add(String(own.id));
    return ids.size > 1;
  } catch (_) { return true; }
}

// THE check every brand route calls. Null = proceed; otherwise the 409 body to answer with.
export async function brandContextCheck(req, ctx, { mutation = false } = {}) {
  const problem = brandContextProblem(req, ctx, { mutation });
  if (problem || !mutation || !ctx || !ctx.ok || shownBrand(req)) return problem;
  // A mutation with no usable brand, and neither switch on: in force only for a person with several brands.
  return (await personHasSeveralBrands(ctx.email)) ? BRAND_CONTEXT_REQUIRED_BODY : null;
}

// Request-level helper: cookie only, never a body or query field.
export async function requireBrandIdentity(req, opts = {}) {
  const ctx = await resolveBrandIdentity(getSessionToken(req, 'brand'));
  const problem = await brandContextCheck(req, ctx, opts);
  if (problem) return { ok: false, status: 409, error: problem.error, message: problem.message };
  return ctx;
}

// The role gate. Returns null when allowed, else a { status, body } the route sends as is.
export function requireRole(ctx, ...roles) {
  if (!ctx || !ctx.ok) return { status: (ctx && ctx.status) || 401, body: { error: (ctx && ctx.error) || 'sign in to continue' } };
  if (!roles.length || roles.includes(ctx.role)) return null;
  // 0121: Full access stands in for the owner wherever a route lists 'owner'. The owner-only exceptions call
  // requireOwner below instead.
  if (ctx.role === ROLES.MANAGER && roles.includes(ROLES.OWNER)) return null;
  return { status: 403, body: { error: 'role_not_allowed', message: ctx.role === ROLES.BOOKER ? 'Your booking access does not include this. Ask the brand account owner.' : 'Not allowed for this account.' } };
}

// The strict gate: the brand's owner and nobody else (who has access, the owner sign-in and password).
export function requireOwner(ctx) {
  if (!ctx || !ctx.ok) return { status: (ctx && ctx.status) || 401, body: { error: (ctx && ctx.error) || 'sign in to continue' } };
  if (ctx.role === ROLES.OWNER) return null;
  // Booking only keeps the answer it has always had (role_not_allowed); Full access gets its own code and sentence.
  if (ctx.role !== ROLES.MANAGER) return { status: 403, body: { error: 'role_not_allowed', message: ctx.role === ROLES.BOOKER ? 'Your booking access does not include this. Ask the brand account owner.' : 'Not allowed for this account.' } };
  return { status: 403, body: { error: 'owner_only', message: 'Only the brand account owner can do this.' } };
}

// Ownership of a booking for a booker: the row's booked_by_member_id must be this member. Owners own everything.
export function bookingBelongsTo(ctx, booking) {
  if (!ctx || !ctx.ok || !booking) return false;
  if (ctx.role === ROLES.OWNER || ctx.role === ROLES.MANAGER) return true;
  return !!(ctx.memberId && booking.booked_by_member_id && String(booking.booked_by_member_id) === String(ctx.memberId));
}
