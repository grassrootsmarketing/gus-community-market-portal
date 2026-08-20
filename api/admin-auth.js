// /api/admin-auth — Retailer admin authentication.
//   POST { action: "login",  email, retailer_slug }      → emails magic link if email matches billing_email
//   POST { action: "verify", token }                      → sets dh_retailer_session cookie
//   POST { action: "data",   retailer_slug }              → returns { ok, email, retailer_id }
//   POST { action: "logout" }                             → invalidates the session
// Sessions are carried ONLY in HttpOnly cookies: dh_retailer_session for staff,
// dh_owner_session for the platform owner. No action returns a session secret in its response
// body, and none accepts one from a body or query string (Codex finding B).
// Uses service_role; never exposes whether an email is registered (anti-enumeration).

import { randomBytes, randomInt } from 'node:crypto';
import { getBinding, sendBindingFailure } from './_env.js';
import { sendMailQuietly, link as siteLink } from './_mail.js';
import {
  setSessionCookie as setRoleCookie,
  clearSessionCookie as clearRoleCookie,
  clearAllSessionCookies,
  getSessionToken,
  readCookies as parseCookies,
} from './_cookies.js';
import { requireSameOrigin } from './_csrf.js';
import { signedCoiUrl } from './_coi-storage.js';

// admin-auth is both a route AND a helper module imported by other routes (api/booking.js), so the
// binding is resolved lazily by bind() — the exported guards work even when this file's own handler
// was not the entry point. _b is what the in-handler storage calls read.
let _b = null;
async function bind() { _b = await getBinding(); return _b; }

// R2-11: build security-sensitive links (magic links, redirects) from a fixed, configured origin
// — never from client-controllable forwarded-host headers. The origin comes from the validated
// binding (siteLink), so it can never default to production from a preview deployment.

// R2-05: viewer-role staff accounts are read-only. Uses the shared sb() helper (throws on error,
// so a lookup failure lands in the caller's try/deny path). Owner has no retailer_admins row.
async function callerRoleAuth(retailerId, email) {
  if (!email || !retailerId) return null;
  try {
    const rows = await sb(`retailer_admins?retailer_id=eq.${encodeURIComponent(retailerId)}&email_normalized=eq.${encodeURIComponent(String(email).trim().toLowerCase())}&select=role`);
    return (Array.isArray(rows) && rows[0]) ? (rows[0].role || null) : null;
  } catch (_) { return null; }
}

const FROM_ADDRESS = 'Demohub <bookings@demohubhq.com>';

function html(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

// UUID format guard — protects against Postgres "invalid input syntax for type uuid" errors
// when callers pass garbage values like "fake" in session_id or other UUID params.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(s) { return typeof s === 'string' && UUID_RE.test(s); }

async function sb(path, opts = {}) {
  const b = await bind();
  const headers = { apikey: b.serviceKey, Authorization: `Bearer ${b.serviceKey}`, 'Content-Type': 'application/json', Prefer: 'return=representation', ...(opts.headers || {}) };
  const r = await fetch(`${b.supabaseUrl}/rest/v1/${path}`, { ...opts, headers });
  const text = await r.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch(_) {}
  if (!r.ok) throw new Error(json?.message || text || `HTTP ${r.status}`);
  return json;
}

// -----------------------------------------------------------------------------
// Session transport — api/_cookies.js is the single implementation.
//
// Codex finding B. This file previously carried its own copy of the cookie helpers, and so did
// api/admin.js, api/booking-action.js and api/brand-account.js — four hand-rolled copies of the
// same attribute string. api/booking.js and api/refund-booking.js parsed the cookie with an
// inline regex instead. Four copies plus two regexes is six places for one of them to drift.
//
// TWO ROLES ARE NOW DISTINCT COOKIES:
//   dh_retailer_session — retailer staff, and the session an owner assumes when impersonating
//   dh_owner_session    — the platform owner
// Before this change the owner panel carried its session in the QUERY STRING (see owner-data,
// owner-logout, owner-list-retailers, owner-impersonate below), so the credential for the account
// that can read all platform data and impersonate any retailer was landing in browser history,
// Referer headers and Vercel's access logs. Impersonation then wrote dh_session — the retailer
// cookie — which is why the two had to be separated before impersonation could be made safe.
// -----------------------------------------------------------------------------

const OWNER_SESSION_MAX_AGE = 12 * 60 * 60;      // 12h — matches the DB expiry set in owner-verify
const RETAILER_SESSION_MAX_AGE = 60 * 60 * 24 * 30;
const IMPERSONATION_MAX_AGE = 4 * 60 * 60;       // 4h — matches the DB expiry in owner-impersonate

function setSessionCookie(res, sessionId, maxAgeSeconds = RETAILER_SESSION_MAX_AGE) {
  if (!sessionId) return;
  setRoleCookie(res, 'retailer', sessionId, maxAgeSeconds);
}

function clearSessionCookie(res) { clearRoleCookie(res, 'retailer'); }

// Retailer/staff session. Cookie only — no body, no query string.
function getSessionIdFromReq(req, _body) {
  return getSessionToken(req, 'retailer');
}

// Owner session. Separate cookie, so an owner who is impersonating a retailer still holds their
// own session and end-impersonation does not have to reconstruct it.
function getOwnerSessionIdFromReq(req) {
  return getSessionToken(req, 'owner');
}

// Reusable helper: verify a session_id is valid for a given retailer_id.
// Exported so /api/admin and /api/booking-action can re-use it.
export async function verifyAdminSession(session_id, expectedRetailerId) {
  if (!session_id) return { ok: false, error: 'No session' };
  if (!isUuid(session_id)) return { ok: false, error: 'Invalid session' };
  let sessions;
  try {
    sessions = await sb(`admin_sessions?session_id=eq.${encodeURIComponent(session_id)}&select=*`);
  } catch (_) {
    return { ok: false, error: 'Invalid session' };
  }
  const session = Array.isArray(sessions) ? sessions[0] : null;
  if (!session) return { ok: false, error: 'Invalid session' };
  { const _e = Date.parse(String(session.expires_at || '')); if (!Number.isFinite(_e) || _e <= Date.now()) return { ok: false, error: 'Session expired' }; }
  if (expectedRetailerId && session.retailer_id !== expectedRetailerId) return { ok: false, error: 'Wrong retailer' };
  return { ok: true, email: session.email, retailer_id: session.retailer_id };
}

// Strict retailer-staff check for MUTATIONS (P0-1): valid session + LIVE membership + allowed role.
// retailer_admins has no disabled flag — a removed staffer's row is deleted, so absence == removed.
export async function verifyRetailerStaff(session_id, retailerId, allowedRoles = ['owner', 'admin', 'manager']) {
  const s = await verifyAdminSession(session_id, retailerId);
  if (!s.ok) return { ok: false, status: 401, error: s.error };
  // P0-1B: EXACT normalized-email identity (never ILIKE — `_`/`%` are SQL wildcards and legal in
  // email local parts). email_normalized is UNIQUE per (retailer_id, email_normalized) via 0025.
  // Venue-scope model (P0-1C, Model 2): owner/admin/manager are RETAILER-WIDE mutating roles;
  // only viewer may be venue-scoped and viewer cannot mutate — so no per-venue check is needed on
  // this mutation path. The P0-8 authz cutover enforces "no scoped mutating membership" at write time.
  const en = String(s.email || '').trim().toLowerCase();
  let rows;
  try {
    rows = await sb(`retailer_admins?retailer_id=eq.${encodeURIComponent(retailerId)}&email_normalized=eq.${encodeURIComponent(en)}&select=role`);
  } catch (_) {
    return { ok: false, status: 503, error: 'membership_check_unavailable' }; // fail closed
  }
  const m = Array.isArray(rows) && rows[0];
  if (!m) return { ok: false, status: 403, error: 'not_a_member' };            // removed staff
  const role = String(m.role || '').toLowerCase();
  if (!allowedRoles.includes(role)) return { ok: false, status: 403, error: 'insufficient_role' }; // viewer, etc.
  return { ok: true, email: s.email, retailerId, role };
}

// Shared membership guard for EVERY retailer action (P0-1/P0-8): valid session + live EXACT
// membership + closed role domain, fail-closed. Returns retailer_id/email (drop-in for the old
// verifyAdminSession shape) PLUS role + venueIds so callers don't do a second fail-open lookup.
export async function requireRetailerMembership(session_id, expectedRetailerId = null, allowedRoles = null) {
  const s = await verifyAdminSession(session_id, expectedRetailerId);
  if (!s.ok) return { ok: false, status: 401, error: s.error };
  const en = String(s.email || '').trim().toLowerCase();
  let rows;
  try {
    rows = await sb(`retailer_admins?retailer_id=eq.${encodeURIComponent(s.retailer_id)}&email_normalized=eq.${encodeURIComponent(en)}&select=id,role,venue_ids`);
  } catch (_) { return { ok: false, status: 503, error: 'membership_check_unavailable' }; }
  const m = Array.isArray(rows) && rows[0];
  if (!m) return { ok: false, status: 403, error: 'no_membership' };
  const role = String(m.role || '').toLowerCase();
  const CLOSED_ROLES = ['owner', 'admin', 'manager', 'viewer']; // editor retired (0027)
  if (!CLOSED_ROLES.includes(role)) return { ok: false, status: 403, error: 'unknown_role' };
  if (allowedRoles && !allowedRoles.includes(role)) return { ok: false, status: 403, error: 'insufficient_role' };
  return { ok: true, status: 200, retailer_id: s.retailer_id, email: s.email, role, venueIds: Array.isArray(m.venue_ids) ? m.venue_ids : [], membershipId: m.id };
}

function generateLoginCode() {
  // 6-digit numeric code, zero-padded — cryptographically random, not Math.random.
  const n = randomInt(0, 1000000);
  return String(n).padStart(6, '0');
}

function invitationEmail({ retailerName, roleName, link, code, inviterEmail }) {
  const codeDisplay = code || '';
  return `<!DOCTYPE html><html><body style="margin:0;padding:24px;background:#fbf7f0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,sans-serif;color:#1c1c1a;">
<table align="center" cellpadding="0" cellspacing="0" style="max-width:520px;margin:0 auto;background:white;border-radius:16px;overflow:hidden;border:1px solid rgba(15,44,23,0.08);">
<tr><td style="padding:28px 32px;background:#0f2c17;">
<table cellpadding="0" cellspacing="0"><tr>
<td style="padding-right:12px;vertical-align:middle;">
<svg width="36" height="36" viewBox="0 0 72 72" xmlns="http://www.w3.org/2000/svg"><circle cx="36" cy="36" r="36" fill="#0f2c17"/><circle cx="36" cy="40" r="18" fill="#ed682f"/><rect x="34.5" y="14" width="3" height="10" rx="1.2" fill="#fbf3e0"/><path d="M37 17 Q45 14 48 20 Q44 22 38 21 Q35 19 37 17 Z" fill="#87b08e"/></svg>
</td><td style="font-weight:800;font-size:22px;color:#fbf7f0;letter-spacing:-0.04em;">demohub</td>
</tr></table>
</td></tr>
<tr><td style="padding:36px;">
<div style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.14em;color:#a14e2a;margin-bottom:14px;">You've been invited</div>
<h1 style="font-family:Georgia,serif;font-size:24px;font-weight:500;color:#0f2c17;margin:0 0 14px;line-height:1.25;">Join ${html(retailerName)}'s Demohub team</h1>
<p style="font-size:15px;line-height:1.6;color:#3a3a36;margin:0 0 22px;">${inviterEmail ? html(inviterEmail) + ' invited you' : 'You were invited'} to help manage ${html(retailerName)}'s demo schedule on Demohub as a <strong style="color:#0f2c17;">${html(roleName || 'team member')}</strong>. Accept below to get started.</p>
<p style="margin:0 0 26px;"><a href="${html(link)}" style="background:#0f2c17;color:white;padding:14px 28px;border-radius:10px;text-decoration:none;font-weight:600;display:inline-block;font-size:15px;">Accept invitation &rarr;</a></p>
<div style="border-top:1px solid rgba(15,44,23,0.08);padding-top:22px;margin-top:6px;">
<div style="font-size:13px;color:#6b6a64;font-weight:600;margin-bottom:10px;">Or use a code:</div>
<div style="font-family:'SF Mono',Menlo,Consolas,monospace;font-size:32px;font-weight:700;color:#0f2c17;letter-spacing:0.08em;line-height:1;padding:14px 0;background:#f9f7f2;border-radius:8px;text-align:center;margin-bottom:10px;">${codeDisplay}</div>
<div style="font-size:12px;color:#6b6a64;line-height:1.5;">Go to <a href="${siteLink(_b, '/signin')}" style="color:#2a5b32;">demohubhq.com/signin</a>, enter your email, then paste this code. Expires in 24 hours.</div>
</div>
</td></tr>
<tr><td style="padding:20px 32px;background:#fbf7f0;border-top:1px solid rgba(15,44,23,0.06);font-size:12px;color:#6b6a64;text-align:center;line-height:1.5;">Demohub LLC &middot; 6700 Fallbrook Ave #125, West Hills, CA 91307<br>If you don't recognize this invitation, you can safely ignore this email.</td></tr>
</table></body></html>`;
}

function magicLinkEmail({ retailerName, link, code }) {
  const codeDisplay = code || '';
  return `<!DOCTYPE html><html><body style="margin:0;padding:24px;background:#fbf7f0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,sans-serif;color:#1c1c1a;">
<table align="center" cellpadding="0" cellspacing="0" style="max-width:520px;margin:0 auto;background:white;border-radius:16px;overflow:hidden;border:1px solid rgba(15,44,23,0.08);">
<tr><td style="padding:28px 32px;background:#0f2c17;">
<table cellpadding="0" cellspacing="0"><tr>
<td style="padding-right:12px;vertical-align:middle;">
<svg width="36" height="36" viewBox="0 0 72 72" xmlns="http://www.w3.org/2000/svg"><circle cx="36" cy="36" r="36" fill="#0f2c17"/><circle cx="36" cy="40" r="18" fill="#ed682f"/><rect x="34.5" y="14" width="3" height="10" rx="1.2" fill="#fbf3e0"/><path d="M37 17 Q45 14 48 20 Q44 22 38 21 Q35 19 37 17 Z" fill="#87b08e"/></svg>
</td><td style="font-weight:800;font-size:22px;color:#fbf7f0;letter-spacing:-0.04em;">demohub</td>
</tr></table>
</td></tr>
<tr><td style="padding:44px 36px 20px;text-align:center;">
<div style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.14em;color:#a14e2a;margin-bottom:14px;">Sign in to</div>
<h1 style="font-family:Georgia,serif;font-size:24px;font-weight:500;color:#0f2c17;margin:0 0 28px;">${html(retailerName)}</h1>
<div style="font-size:13px;color:#6b6a64;margin-bottom:10px;">Your login code</div>
<div style="font-family:'SF Mono',Menlo,Consolas,monospace;font-size:48px;font-weight:700;color:#0f2c17;letter-spacing:0.12em;line-height:1;padding:20px 0;border-top:1px solid rgba(15,44,23,0.08);border-bottom:1px solid rgba(15,44,23,0.08);margin-bottom:14px;">${codeDisplay}</div>
<div style="font-size:12px;color:#6b6a64;">This code expires in 20 minutes.</div>
</td></tr>
<tr><td style="padding:0 36px 32px;text-align:center;">
<p style="font-size:13px;color:#6b6a64;line-height:1.5;margin:14px 0 18px;">Or use the direct link below to sign in without entering the code:</p>
<p style="margin:0 0 20px;"><a href="${html(link)}" style="background:#0f2c17;color:white;padding:12px 22px;border-radius:10px;text-decoration:none;font-weight:600;display:inline-block;font-size:14px;">Sign in &rarr;</a></p>
<p style="font-size:12px;color:#6b6a64;line-height:1.5;margin:0;">If you didn't request this, ignore this email &mdash; no action will be taken.</p>
</td></tr>
<tr><td style="padding:20px 32px;background:#fbf7f0;border-top:1px solid rgba(15,44,23,0.06);font-size:12px;color:#6b6a64;text-align:center;line-height:1.5;">Demohub LLC &middot; 6700 Fallbrook Ave #125, West Hills, CA 91307<br>You're receiving this because someone requested a sign-in link for an admin email at this address.</td></tr>
</table></body></html>`;
}


// Rate limit keyed on an explicit identifier (email) rather than the IP. Used to cap
// login-code guesses per account, which IP-based limits cannot do once IPs are spoofed.
async function checkRateLimitByKey(fullKey, maxPerHour) {
  try {
    const windowStart = new Date(Math.floor(Date.now() / 3600000) * 3600000).toISOString();
    const existing = await sb(`rate_limit?bucket_key=eq.${encodeURIComponent(fullKey)}&window_start=eq.${encodeURIComponent(windowStart)}&select=id,count`);
    const row = Array.isArray(existing) && existing[0];
    if (row && row.count >= maxPerHour) return { allowed: false };
    if (row) await sb(`rate_limit?id=eq.${row.id}`, { method: 'PATCH', body: JSON.stringify({ count: row.count + 1 }) });
    else await sb('rate_limit', { method: 'POST', body: JSON.stringify({ bucket_key: fullKey, window_start: windowStart, count: 1 }) });
    return { allowed: true };
  } catch (e) {
    console.error('per-key rate limit failed — denying:', e?.message || e);
    return { allowed: false, error: 'rate_limit_unavailable' };
  }
}

async function checkRateLimit(req, bucketKey, maxPerHour) {
  try {
    // x-real-ip is set by Vercel and not client-overridable; the LAST x-forwarded-for hop is
    // the one Vercel appends. Never trust cf-connecting-ip here — we are not behind Cloudflare,
    // so it is purely attacker-supplied and was a complete rate-limit bypass.
    const xff = (req.headers['x-forwarded-for'] || '').toString().split(',').map(x => x.trim()).filter(Boolean);
    const ip = req.headers['x-real-ip'] || xff[xff.length - 1] || req.socket?.remoteAddress || 'unknown';
    const key = bucketKey + ':' + ip;
    const windowStart = new Date(Math.floor(Date.now() / 3600000) * 3600000).toISOString();
    const existing = await sb(`rate_limit?bucket_key=eq.${encodeURIComponent(key)}&window_start=eq.${encodeURIComponent(windowStart)}&select=id,count`);
    const row = Array.isArray(existing) && existing[0];
    if (row && row.count >= maxPerHour) return { allowed: false };
    if (row) await sb(`rate_limit?id=eq.${row.id}`, { method: 'PATCH', body: JSON.stringify({ count: row.count + 1 }) });
    else await sb('rate_limit', { method: 'POST', body: JSON.stringify({ bucket_key: key, window_start: windowStart, count: 1 }) });
    return { allowed: true };
  } catch (e) {
    // Fail-CLOSED for auth write paths (magic-link request, code verification):
    // an unavailable rate-limiter must NOT translate into unlimited requests.
    console.error('admin-auth rate limit check failed — denying request:', e?.message || e);
    return { allowed: false, error: 'rate_limit_unavailable' };
  }
}

export default async function handler(req, res) {
  // Same-origin only. The previous handler answered every preflight with
  // Access-Control-Allow-Origin: '*', advertising a cross-origin API. That wildcard could never
  // actually carry credentials (browsers refuse '*' with cookies), so it granted nothing and
  // only obscured the fact that this route is same-origin by design.
  if (req.method === 'OPTIONS') {
    res.setHeader('Allow', 'POST');
    return res.status(204).end();
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  try { await bind(); } catch (e) { return sendBindingFailure(res, e); }

  // Codex finding B: every action on this route is a POST that either creates a session or acts
  // under one, so the same-origin check belongs here — once, before any action dispatch, before
  // the body is read. api/_session.js exported a checkOrigin() helper that no route ever called;
  // this is that control actually wired in. No exemption: this route has no webhook and no cron.
  if (!requireSameOrigin(req, res, _b)) return;

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const action = body?.action;

    // ---- LOGIN: request a magic link ----
    // Multi-admin: matches against retailer_admins table (multiple users per retailer).
    if (action === 'login') {
      const rl = await checkRateLimit(req, 'admin-login', 30);
      if (!rl.allowed) return res.status(429).json({ error: 'Too many magic-link requests from this IP. Try again later.' });
      const { email, retailer_slug } = body || {};
      if (!email || !retailer_slug) return res.status(400).json({ error: 'email and retailer_slug required' });
      if (!/^[^@]+@[^@]+\.[^@]+$/.test(email)) return res.status(400).json({ error: 'Invalid email' });
      const rlLoginEmail = await checkRateLimitByKey('admin-login-email:' + String(email).toLowerCase().slice(0, 64), 20);
      if (!rlLoginEmail.allowed) return res.status(429).json({ error: 'Too many magic-link requests for this email. Try again later.' });

      const retailers = await sb(`retailers?slug=eq.${encodeURIComponent(retailer_slug)}&select=id,name`);
      const retailer = Array.isArray(retailers) ? retailers[0] : null;

      // Always respond 200 to prevent enumeration. Only actually send if email is in retailer_admins.
      if (retailer) {
        const normalizedEmail = email.toLowerCase().trim();
        const admins = await sb(`retailer_admins?retailer_id=eq.${encodeURIComponent(retailer.id)}&email_normalized=eq.${encodeURIComponent(normalizedEmail)}&select=email,role`);
        const adminRow = Array.isArray(admins) ? admins[0] : null;
        if (adminRow) {
          const code = generateLoginCode();
          let tokens;
          try {
            tokens = await sb(`admin_tokens`, {
              method: 'POST',
              body: JSON.stringify({ email: String(adminRow.email).trim().toLowerCase(), retailer_id: retailer.id, code }),
            });
          } catch (_e) {
            // Fallback: DB may not have `code` column yet (migration not run). Retry without.
            tokens = await sb(`admin_tokens`, {
              method: 'POST',
              body: JSON.stringify({ email: String(adminRow.email).trim().toLowerCase(), retailer_id: retailer.id }),
            });
          }
          const token = Array.isArray(tokens) ? tokens[0]?.token : null;
          const link = siteLink(_b, `/r/${retailer_slug}/admin?token=${encodeURIComponent(token)}`);
          if (_b.resendApiKey && token) {
            await sendMailQuietly({ from: FROM_ADDRESS, to: adminRow.email, replyTo: 'david@demohubhq.com', subject: `Your Demohub login code: ${code}`, html: magicLinkEmail({ retailerName: retailer.name, link, code }) }, { binding: _b });
          }
        }
      }
      return res.status(200).json({ ok: true });
    }

    // ---- EMAIL-LOGIN: send magic link(s) by email only — auto-routes to right retailer(s) ----
    if (action === 'email-login') {
      const rl = await checkRateLimit(req, 'admin-email-login', 30);
      if (!rl.allowed) return res.status(429).json({ error: 'Too many magic-link requests from this IP. Try again later.' });
      const { email } = body || {};
      if (!email) return res.status(400).json({ error: 'email required' });
      if (!/^[^@]+@[^@]+\.[^@]+$/.test(email)) return res.status(400).json({ error: 'Invalid email' });
      const rlEmailLoginHard = await checkRateLimitByKey('admin-email-login-email:' + String(email).toLowerCase().slice(0, 64), 20);
      if (!rlEmailLoginHard.allowed) return res.status(429).json({ error: 'Too many magic-link requests for this email. Try again later.' });

      const normalizedEmail = email.toLowerCase().trim();

      // Always respond 200 to prevent enumeration. Send 1 link per retailer this email admins.
      try {
        const admins = await sb(`retailer_admins?email_normalized=eq.${encodeURIComponent(normalizedEmail)}&select=email,retailer_id,role,retailers(id,name,slug)`);
        if (Array.isArray(admins) && admins.length > 0) {
          for (const adminRow of admins) {
            const retailer = adminRow.retailers;
            if (!retailer) continue;
            const code = generateLoginCode();
            let tokens;
            try {
              tokens = await sb(`admin_tokens`, {
                method: 'POST',
                body: JSON.stringify({ email: String(adminRow.email).trim().toLowerCase(), retailer_id: retailer.id, code }),
              });
            } catch (_e) {
              tokens = await sb(`admin_tokens`, {
                method: 'POST',
                body: JSON.stringify({ email: String(adminRow.email).trim().toLowerCase(), retailer_id: retailer.id }),
              });
            }
            const token = Array.isArray(tokens) ? tokens[0]?.token : null;
            if (!token) continue;
            const link = siteLink(_b, `/r/${retailer.slug}/admin?token=${encodeURIComponent(token)}`);
            if (_b.resendApiKey) {
              await sendMailQuietly({ from: FROM_ADDRESS, to: adminRow.email, replyTo: 'david@demohubhq.com', subject: `Your Demohub login code: ${code}`, html: magicLinkEmail({ retailerName: retailer.name, link, code }) }, { binding: _b });
            }
          }
        }
      } catch (_) { /* swallow to prevent enumeration */ }

      return res.status(200).json({ ok: true });
    }

    // ---- VERIFY: exchange token for session ----
    if (action === 'verify') {
      const { token } = body || {};
      if (!token) return res.status(400).json({ error: 'token required' });
      const tokens = await sb(`admin_tokens?token=eq.${encodeURIComponent(token)}&select=*`);
      const trow = Array.isArray(tokens) ? tokens[0] : null;
      if (!trow) return res.status(404).json({ error: 'Token not found' });
      if (trow.used_at) return res.status(409).json({ error: 'Token already used' });
      { const _e = Date.parse(String(trow.expires_at || '')); if (!Number.isFinite(_e) || _e <= Date.now()) return res.status(410).json({ error: 'Token expired' }); }

      // P0-1: re-verify the exact live membership still exists at exchange time (removal/race safe).
      { const _en = String(trow.email || '').trim().toLowerCase();
        const _m = await sb(`retailer_admins?retailer_id=eq.${encodeURIComponent(trow.retailer_id)}&email_normalized=eq.${encodeURIComponent(_en)}&select=role`);
        if (!Array.isArray(_m) || !_m[0]) return res.status(403).json({ error: 'membership_revoked' }); }
      await sb(`admin_tokens?token=eq.${encodeURIComponent(token)}`, { method: 'PATCH', body: JSON.stringify({ used_at: new Date().toISOString() }) });
      const sessions = await sb(`admin_sessions`, {
        method: 'POST',
        body: JSON.stringify({ email: trow.email, retailer_id: trow.retailer_id }),
      });
      const session = Array.isArray(sessions) ? sessions[0] : null;
      if (!session?.session_id) return res.status(500).json({ error: 'Could not start session' });
      setSessionCookie(res, session.session_id);
      // No session_id in the body. The cookie is the session; anything that also puts it in the
      // response is handing it to page script, analytics and any error reporter on the page.
      return res.status(200).json({ ok: true, email: trow.email, retailer_id: trow.retailer_id });
    }

    // ---- VERIFY-CODE: exchange 6-digit code for session ----
    if (action === 'verify-code') {
      const email = String(body?.email || '').trim().toLowerCase();
      const code = String(body?.code || '').replace(/\D/g, '').trim();
      if (!email || !code || code.length !== 6) return res.status(400).json({ error: 'Email and 6-digit code required' });
      // Two independent caps. The per-EMAIL one is the real defense: it cannot be bypassed
      // by forging IPs, so it caps guesses against any single account.
      const rlIp = await checkRateLimit(req, 'verify-code', 60);
      const rlEmail = await checkRateLimitByKey('verify-code-email:' + email, 12);
      if (!rlIp.allowed || !rlEmail.allowed) {
        if (rlIp.error === 'rate_limit_unavailable' || rlEmail.error === 'rate_limit_unavailable') {
          return res.status(503).json({ error: 'rate_limit_unavailable', message: 'Try again in a moment.' });
        }
        return res.status(429).json({ error: 'Too many attempts. Try again in an hour.' });
      }
      const rows = await sb(`admin_tokens?email=eq.${encodeURIComponent(email)}&code=eq.${encodeURIComponent(code)}&used_at=is.null&select=*&order=created_at.desc&limit=1`);
      const trow = Array.isArray(rows) ? rows[0] : null;
      if (!trow) return res.status(404).json({ error: 'Invalid code' });
      { const _e = Date.parse(String(trow.expires_at || '')); if (!Number.isFinite(_e) || _e <= Date.now()) return res.status(410).json({ error: 'Code expired' }); }
      // P0-1: re-verify the exact live membership still exists at exchange time.
      { const _en = String(trow.email || '').trim().toLowerCase();
        const _m = await sb(`retailer_admins?retailer_id=eq.${encodeURIComponent(trow.retailer_id)}&email_normalized=eq.${encodeURIComponent(_en)}&select=role`);
        if (!Array.isArray(_m) || !_m[0]) return res.status(403).json({ error: 'membership_revoked' }); }
      await sb(`admin_tokens?token=eq.${encodeURIComponent(trow.token)}`, { method: 'PATCH', body: JSON.stringify({ used_at: new Date().toISOString() }) });
      const sessions = await sb(`admin_sessions`, {
        method: 'POST',
        body: JSON.stringify({ email: trow.email, retailer_id: trow.retailer_id }),
      });
      const session = Array.isArray(sessions) ? sessions[0] : null;
      let retailerSlug = null;
      if (trow.retailer_id) {
        try {
          const rt = await sb(`retailers?id=eq.${encodeURIComponent(trow.retailer_id)}&select=slug`);
          retailerSlug = Array.isArray(rt) && rt[0]?.slug || null;
        } catch(_){}
      }
      if (!session?.session_id) return res.status(500).json({ error: 'Could not start session' });
      setSessionCookie(res, session.session_id);
      return res.status(200).json({ ok: true, email: trow.email, retailer_id: trow.retailer_id, retailer_slug: retailerSlug });
    }

    // ---- DATA: verify session is still valid + return retailer info ----
    if (action === 'data') {
      const { retailer_slug } = body || {};
      const session_id = getSessionIdFromReq(req, body);
      if (!session_id) return res.status(401).json({ error: 'Not authenticated' });
      if (!retailer_slug) return res.status(400).json({ error: 'retailer_slug required' });

      const retailers = await sb(`retailers?slug=eq.${encodeURIComponent(retailer_slug)}&select=id,name`);
      const retailer = Array.isArray(retailers) ? retailers[0] : null;
      if (!retailer) return res.status(404).json({ error: 'Retailer not found' });

      const v = await requireRetailerMembership(session_id, retailer.id);
      if (!v.ok) return res.status(v.status).json({ error: v.error });
      // The opportunistic "authenticated via body, so upgrade them to a cookie" branch is gone
      // with the body path itself — a cookie is now the only way to have got here.
      return res.status(200).json({ ok: true, email: v.email, retailer_id: v.retailer_id, retailer_name: retailer.name });
    }

    // ---- LOGOUT ----
    if (action === 'logout') {
      const sid = getSessionIdFromReq(req, body);
      if (sid) {
        try { await sb(`admin_sessions?session_id=eq.${encodeURIComponent(sid)}`, { method: 'DELETE' }); } catch(_) {}
      }
      // Clear ALL role cookies. If an owner is mid-impersonation, logging out must not leave
      // their owner session live behind the retailer session they just discarded.
      clearAllSessionCookies(res);
      return res.status(200).json({ ok: true });
    }

    // ---- COOKIE-MIGRATE: REMOVED ----
    // This action existed to accept a session_id from a request body and hand back an HttpOnly
    // cookie, so pages holding a session in localStorage could migrate. Codex finding B: remove
    // the legacy compatibility paths, there is no real user data to preserve. Keeping it would
    // have preserved exactly the primitive the rest of this change removes — an endpoint that
    // accepts a session secret from a request body. The localStorage writes that fed it are
    // deleted from r/gus/admin/index.html and brand/verify/index.html in the same commit.

    // ---- TEAM-LIST: list all admins for the current retailer (session-gated) ----
    // ---- AGREEMENT-RETAILER-LIST: list all signed agreements for this retailer ----
    if (action === 'agreement-retailer-list') {
      const v = await requireRetailerMembership(getSessionIdFromReq(req, body));
      if (!v.ok) return res.status(v.status).json({ error: v.error });
      const rows = await sb(`brand_retailer_agreements?retailer_id=eq.${encodeURIComponent(v.retailer_id)}&superseded_at=is.null&select=*,brands(id,company_name,email)&order=signed_at.desc`);
      return res.status(200).json({ ok: true, agreements: rows || [] });
    }

        if (action === 'team-list') {
      const v = await requireRetailerMembership(getSessionIdFromReq(req, body));
      if (!v.ok) return res.status(v.status).json({ error: v.error });
      const admins = await sb(`retailer_admins?retailer_id=eq.${encodeURIComponent(v.retailer_id)}&select=*&order=created_at`);
      // For each admin, flag whether they've ever signed in (admin_sessions exists).
      // Used by UI to render a "Pending invite" badge for invited-but-never-signed-in members.
      try {
        const sessions = await sb(`admin_sessions?retailer_id=eq.${encodeURIComponent(v.retailer_id)}&select=email&limit=1000`);
        const seenEmails = new Set((Array.isArray(sessions) ? sessions : []).map(s => (s.email || '').toLowerCase()));
        for (const a of (admins || [])) {
          a.has_signed_in = seenEmails.has((a.email || '').toLowerCase());
        }
      } catch (e) { /* non-fatal — UI just shows everyone as accepted */ }
      return res.status(200).json({ ok: true, admins, your_email: v.email });
    }

    // ---- TEAM-INVITE: add a new admin (owner/admin only) ----
    if (action === 'team-invite') {
      const { email, name, role, venue_ids } = body || {};
      const session_id = getSessionIdFromReq(req, body);
      if (!email || !/^[^@]+@[^@]+\.[^@]+$/.test(email)) return res.status(400).json({ error: 'Valid email required' });
      if (!['admin', 'viewer'].includes(role || 'admin')) return res.status(400).json({ error: 'Role must be admin or viewer' });
      const v = await requireRetailerMembership(session_id);
      if (!v.ok) return res.status(v.status).json({ error: v.error });
      // Only owners/admins can invite (not viewers)
      const me = await sb(`retailer_admins?retailer_id=eq.${encodeURIComponent(v.retailer_id)}&email_normalized=eq.${encodeURIComponent(String(v.email).trim().toLowerCase())}&select=role`);
      const myRow = Array.isArray(me) ? me[0] : null;
      if (!myRow || !['owner', 'admin'].includes(String(myRow.role || '').toLowerCase())) return res.status(403).json({ error: 'insufficient_role', message: 'Only owners and admins can invite team members.' });

      // Phase E: Solo tier is single-admin. Team invites require Pro.
      try {
        // settings has no billing_tier column and never has, so the "settings first, then
        // retailers" precedence this used to implement could not have worked — the first query
        // 400s on an unknown column and the catch swallows it, meaning EVERY retailer read as
        // 'solo' and every team invite was refused with plan_upgrade_required.
        // Migration 0054 removed the identical fiction from enforce_venue_limit(). retailers is
        // the one place a tier is actually stored.
        const retArr = await sb(`retailers?id=eq.${encodeURIComponent(v.retailer_id)}&select=billing_tier`);
        const tier = ((Array.isArray(retArr) && retArr[0] && retArr[0].billing_tier) || 'solo').toLowerCase();
        if (tier === 'solo' || tier === 'free') {
          return res.status(402).json({
            error: 'plan_upgrade_required',
            message: 'Adding team members requires Pro. Solo stores are single-admin. Upgrade to invite staff.',
            tier,
            upgrade_url: '/pricing',
          });
        }
      } catch (e) { console.warn('tier check for team-invite:', e && e.message); }

      const normalizedEmail = email.toLowerCase().trim();
      // Check dup
      const existing = await sb(`retailer_admins?retailer_id=eq.${encodeURIComponent(v.retailer_id)}&email_normalized=eq.${encodeURIComponent(normalizedEmail)}&select=id`);
      if (Array.isArray(existing) && existing.length > 0) return res.status(409).json({ error: 'That email is already on the team' });

      // Defect D: a viewer's venue scope must belong to THIS retailer (parity with team-update-scope).
      if ((role || 'admin') === 'viewer' && Array.isArray(venue_ids) && venue_ids.length > 0) {
        if (venue_ids.some(id => !isUuid(id))) return res.status(400).json({ error: 'All venue_ids must be UUIDs' });
        const _vlist = venue_ids.map(id => encodeURIComponent(id)).join(',');
        const _vok = await sb(`venues?id=in.(${_vlist})&retailer_id=eq.${encodeURIComponent(v.retailer_id)}&select=id`);
        if (!Array.isArray(_vok) || _vok.length !== venue_ids.length) return res.status(400).json({ error: 'One or more venues do not belong to this retailer' });
      }

      // Enforce limit: owners + admins capped at 10 per retailer. Viewers unlimited (calendar sync only).
      const ADMIN_CAP = 999;
      if ((role || 'admin') === 'admin') {
        const editors = await sb(`retailer_admins?retailer_id=eq.${encodeURIComponent(v.retailer_id)}&role=in.(owner,admin)&select=id`);
        if (Array.isArray(editors) && editors.length >= ADMIN_CAP) {
          return res.status(409).json({ error: `Admin limit reached (${ADMIN_CAP}). Remove someone or invite as Viewer instead.` });
        }
      }

      const created = await sb(`retailer_admins`, {
        method: 'POST',
        body: JSON.stringify({
          retailer_id: v.retailer_id,
          email: normalizedEmail,
          name: name || null,
          role: role || 'admin',
          invited_by_email: v.email,
          // Phase D: viewers can be scoped to specific venues. Empty = all.
          venue_ids: (role === 'viewer' && Array.isArray(venue_ids)) ? venue_ids : [],
        }),
      });
      // Send invitation email with magic link
      try {
        const retailers = await sb(`retailers?id=eq.${encodeURIComponent(v.retailer_id)}&select=name,slug`);
        const retailer = Array.isArray(retailers) ? retailers[0] : null;
        if (retailer && _b.resendApiKey) {
          const code = generateLoginCode();
          let tokens;
          try {
            tokens = await sb(`admin_tokens`, {
              method: 'POST',
              body: JSON.stringify({ email: normalizedEmail, retailer_id: v.retailer_id, code }),
            });
          } catch (_e) {
            tokens = await sb(`admin_tokens`, {
              method: 'POST',
              body: JSON.stringify({ email: normalizedEmail, retailer_id: v.retailer_id }),
            });
          }
          const token = Array.isArray(tokens) ? tokens[0]?.token : null;
          const link = siteLink(_b, `/r/${retailer.slug}/admin?token=${encodeURIComponent(token)}`);
          const roleName = (role === 'viewer') ? 'viewer' : 'admin';
          await sendMailQuietly({
            from: FROM_ADDRESS,
            to: normalizedEmail,
            replyTo: 'david@demohubhq.com',
            subject: `${v.email} invited you to ${retailer.name} on Demohub`,
            html: invitationEmail({ retailerName: retailer.name, roleName, link, code, inviterEmail: v.email }),
          }, { binding: _b });
        }
      } catch (e) { console.warn('Invitation email failed:', e); }
      return res.status(200).json({ ok: true, admin: Array.isArray(created) ? created[0] : null });
    }

    // ---- TEAM-REMOVE: remove an admin (owner only; cannot remove owner) ----
    if (action === 'team-remove') {
      const { admin_id } = body || {};
      const session_id = getSessionIdFromReq(req, body);
      if (!isUuid(admin_id)) return res.status(400).json({ error: 'Invalid admin_id' });
      const v = await requireRetailerMembership(session_id);
      if (!v.ok) return res.status(v.status).json({ error: v.error });
      const me = await sb(`retailer_admins?retailer_id=eq.${encodeURIComponent(v.retailer_id)}&email_normalized=eq.${encodeURIComponent(String(v.email).trim().toLowerCase())}&select=role`);
      const myRow = Array.isArray(me) ? me[0] : null;
      if (!myRow || (myRow.role !== 'owner' && myRow.role !== 'admin')) {
        return res.status(403).json({ error: 'Only owners and admins can remove team members' });
      }

      const target = await sb(`retailer_admins?id=eq.${encodeURIComponent(admin_id)}&select=*`);
      const targetRow = Array.isArray(target) ? target[0] : null;
      if (!targetRow) return res.status(404).json({ error: 'Member not found' });
      if (targetRow.retailer_id !== v.retailer_id) return res.status(403).json({ error: 'Wrong retailer' });
      if (targetRow.role === 'owner') return res.status(400).json({ error: 'Cannot remove the owner' });
      // Self-safety: admins can't remove themselves (avoids accidental self-lockout)
      if ((targetRow.email || '').toLowerCase() === (v.email || '').toLowerCase()) {
        return res.status(400).json({ error: 'You can\'t remove yourself. Ask another owner or admin to remove you.' });
      }

      await sb(`retailer_admins?id=eq.${encodeURIComponent(admin_id)}`, { method: 'DELETE' });
      // Also revoke any active sessions for this email
      try { await sb(`admin_sessions?email=eq.${encodeURIComponent(targetRow.email)}&retailer_id=eq.${encodeURIComponent(v.retailer_id)}`, { method: 'DELETE' }); } catch (_) {}
      return res.status(200).json({ ok: true });
    }

    // ---- TEAM-UPDATE-ROLE: change a member's role (owner only) ----
    if (action === 'team-update-role') {
      const { admin_id, role } = body || {};
      const session_id = getSessionIdFromReq(req, body);
      if (!isUuid(admin_id)) return res.status(400).json({ error: 'Invalid admin_id' });
      if (!['admin', 'viewer'].includes(role)) return res.status(400).json({ error: 'Role must be admin or viewer' });
      const v = await requireRetailerMembership(session_id);
      if (!v.ok) return res.status(v.status).json({ error: v.error });
      const me = await sb(`retailer_admins?retailer_id=eq.${encodeURIComponent(v.retailer_id)}&email_normalized=eq.${encodeURIComponent(String(v.email).trim().toLowerCase())}&select=role`);
      const myRow = Array.isArray(me) ? me[0] : null;
      if (!myRow || (myRow.role !== 'owner' && myRow.role !== 'admin')) {
        return res.status(403).json({ error: 'Only owners and admins can change roles' });
      }

      const target = await sb(`retailer_admins?id=eq.${encodeURIComponent(admin_id)}&select=*`);
      const targetRow = Array.isArray(target) ? target[0] : null;
      if (!targetRow || targetRow.retailer_id !== v.retailer_id) return res.status(404).json({ error: 'Member not found' });
      if (targetRow.role === 'owner') return res.status(400).json({ error: 'Cannot change owner role' });
      // Self-safety: admins can't demote themselves
      if ((targetRow.email || '').toLowerCase() === (v.email || '').toLowerCase()) {
        return res.status(400).json({ error: 'You can\'t change your own role. Ask another owner or admin to change it.' });
      }
      // Cap check: promoting viewer -> admin must respect 10-admin limit
      if (role === 'admin' && targetRow.role !== 'admin') {
        const ADMIN_CAP = 999;
        const editors = await sb(`retailer_admins?retailer_id=eq.${encodeURIComponent(v.retailer_id)}&role=in.(owner,admin)&select=id`);
        if (Array.isArray(editors) && editors.length >= ADMIN_CAP) {
          return res.status(409).json({ error: `Admin limit reached (${ADMIN_CAP}). Remove an admin first.` });
        }
      }
      await sb(`retailer_admins?id=eq.${encodeURIComponent(admin_id)}`, { method: 'PATCH', body: JSON.stringify({ role }) });
      return res.status(200).json({ ok: true });
    }

    // ---- TEAM-UPDATE-SCOPE: Phase D — set which venues a viewer can see ----
    if (action === 'team-update-scope') {
      const { admin_id, venue_ids } = body || {};
      const session_id = getSessionIdFromReq(req, body);
      if (!isUuid(admin_id)) return res.status(400).json({ error: 'Invalid admin_id' });
      if (!Array.isArray(venue_ids)) return res.status(400).json({ error: 'venue_ids must be an array' });
      if (venue_ids.some(id => !isUuid(id))) return res.status(400).json({ error: 'All venue_ids must be UUIDs' });
      const v = await requireRetailerMembership(session_id);
      if (!v.ok) return res.status(v.status).json({ error: v.error });
      const me = await sb(`retailer_admins?retailer_id=eq.${encodeURIComponent(v.retailer_id)}&email_normalized=eq.${encodeURIComponent(String(v.email).trim().toLowerCase())}&select=role`);
      const myRow = Array.isArray(me) ? me[0] : null;
      if (!myRow || (myRow.role !== 'owner' && myRow.role !== 'admin')) {
        return res.status(403).json({ error: 'Only owners and admins can change scope' });
      }
      const target = await sb(`retailer_admins?id=eq.${encodeURIComponent(admin_id)}&select=*`);
      const targetRow = Array.isArray(target) ? target[0] : null;
      if (!targetRow || targetRow.retailer_id !== v.retailer_id) return res.status(404).json({ error: 'Member not found' });
      if (targetRow.role !== 'viewer') return res.status(400).json({ error: 'Scope only applies to viewers' });
      // Verify each venue_id belongs to this retailer (prevents cross-retailer scope injection)
      if (venue_ids.length > 0) {
        const idList = venue_ids.map(id => encodeURIComponent(id)).join(',');
        const venues = await sb(`venues?id=in.(${idList})&retailer_id=eq.${encodeURIComponent(v.retailer_id)}&select=id`);
        if (!Array.isArray(venues) || venues.length !== venue_ids.length) {
          return res.status(400).json({ error: 'One or more venues do not belong to this retailer' });
        }
      }
      await sb(`retailer_admins?id=eq.${encodeURIComponent(admin_id)}`, { method: 'PATCH', body: JSON.stringify({ venue_ids }) });
      return res.status(200).json({ ok: true, venue_ids });
    }

    // ---- UPLOAD-RETAILER-AVATAR: retailer admin uploads/replaces their store logo ----
    if (action === 'upload-retailer-avatar') {
      const { image } = body || {};
      const session_id = getSessionIdFromReq(req, body);
      const v = await requireRetailerMembership(session_id);
      if (!v.ok) return res.status(v.status).json({ error: v.error });
      if (!['owner', 'admin', 'manager'].includes(String(v.role || '').toLowerCase())) return res.status(403).json({ error: 'read_only_role', message: 'Your account has view-only access. Ask an admin to make changes.' });
      const m = String(image || '').match(/^data:(image\/(?:png|jpeg|webp|gif));base64,(.+)$/);
      if (!m) return res.status(400).json({ error: 'Invalid image — must be PNG, JPEG, WEBP, or GIF data URL' });
      const mime = m[1];
      const ext = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' }[mime];
      const bytes = Buffer.from(m[2], 'base64');
      if (bytes.length > 2 * 1024 * 1024) return res.status(400).json({ error: 'Image too large — max 2MB' });
      const path = `retailers/${v.retailer_id}.${ext}`;
      const uploadResp = await fetch(`${_b.supabaseUrl}/storage/v1/object/avatars/${path}?upsert=true`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${_b.serviceKey}`, apikey: _b.serviceKey, 'Content-Type': mime, 'x-upsert': 'true' },
        body: bytes,
      });
      if (!uploadResp.ok) {
        const t = await uploadResp.text();
        return res.status(500).json({ error: 'Upload failed: ' + t });
      }
      const publicUrl = `${_b.supabaseUrl}/storage/v1/object/public/avatars/${path}?v=${Date.now()}`;
      await sb(`retailers?id=eq.${encodeURIComponent(v.retailer_id)}`, { method: 'PATCH', body: JSON.stringify({ logo_url: publicUrl }) });
      return res.status(200).json({ ok: true, logo_url: publicUrl });
    }

    // ---- UPLOAD-DEMO-POLICY (PDF) ----
    if (action === 'upload-demo-policy') {
      const { file, filename } = body || {};
      const session_id = getSessionIdFromReq(req, body);
      const v = await requireRetailerMembership(session_id);
      if (!v.ok) return res.status(v.status).json({ error: v.error });
      if (!['owner', 'admin', 'manager'].includes(String(v.role || '').toLowerCase())) return res.status(403).json({ error: 'read_only_role', message: 'Your account has view-only access. Ask an admin to make changes.' });
      const m = String(file || '').match(/^data:(application\/pdf|image\/(?:png|jpeg));base64,(.+)$/);
      if (!m) return res.status(400).json({ error: 'Invalid file — must be a PDF, PNG, or JPEG data URL' });
      const mime = m[1];
      const ext = mime === 'application/pdf' ? 'pdf' : (mime === 'image/png' ? 'png' : 'jpg');
      const bytes = Buffer.from(m[2], 'base64');
      if (bytes.length > 5 * 1024 * 1024) return res.status(400).json({ error: 'File too large — max 5MB' });
      const safeName = (filename || 'demo-policy').replace(/[^a-z0-9._-]/gi, '_').slice(0, 60);
      const path = `retailers/${v.retailer_id}/demo-policy-${Date.now()}.${ext}`;
      const uploadResp = await fetch(`${_b.supabaseUrl}/storage/v1/object/policy-docs/${path}?upsert=true`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${_b.serviceKey}`, apikey: _b.serviceKey, 'Content-Type': mime, 'x-upsert': 'true' },
        body: bytes,
      });
      if (!uploadResp.ok) {
        const t = await uploadResp.text();
        return res.status(500).json({ error: 'Upload failed: ' + t });
      }
      const publicUrl = `${_b.supabaseUrl}/storage/v1/object/public/policy-docs/${path}`;
      await sb(`retailers?id=eq.${encodeURIComponent(v.retailer_id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ demo_policy_url: publicUrl, demo_policy_filename: safeName }),
      });
      return res.status(200).json({ ok: true, demo_policy_url: publicUrl, demo_policy_filename: safeName });
    }

    // ---- REMOVE-DEMO-POLICY ----
    if (action === 'remove-demo-policy') {
      const v = await requireRetailerMembership(getSessionIdFromReq(req, body));
      if (!v.ok) return res.status(v.status).json({ error: v.error });
      if (!['owner', 'admin', 'manager'].includes(String(v.role || '').toLowerCase())) return res.status(403).json({ error: 'read_only_role', message: 'Your account has view-only access. Ask an admin to make changes.' });
      await sb(`retailers?id=eq.${encodeURIComponent(v.retailer_id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ demo_policy_url: null, demo_policy_filename: null }),
      });
      return res.status(200).json({ ok: true });
    }

    // ---- REMOVE-RETAILER-AVATAR ----
    if (action === 'remove-retailer-avatar') {
      const v = await requireRetailerMembership(getSessionIdFromReq(req, body));
      if (!v.ok) return res.status(v.status).json({ error: v.error });
      if (!['owner', 'admin', 'manager'].includes(String(v.role || '').toLowerCase())) return res.status(403).json({ error: 'read_only_role', message: 'Your account has view-only access. Ask an admin to make changes.' });
      await sb(`retailers?id=eq.${encodeURIComponent(v.retailer_id)}`, { method: 'PATCH', body: JSON.stringify({ logo_url: null }) });
      return res.status(200).json({ ok: true });
    }

    // ============================================================
    // OWNER PANEL — restricted to allowlist (david@demohubhq.com)
    // ============================================================
    // ---- OWNER-VERIFICATION-QUEUE: list retailers by verification status ----
    if (action === 'owner-verification-queue') {
      const { status } = body || {};
      const owner = await verifyOwnerSession(getOwnerSessionIdFromReq(req))   /* was verifyOwnerSessionV2 — never defined */;
      if (!owner) return res.status(401).json({ error: 'Owner authentication required' });
      const wantedStatus = ['pending', 'approved', 'rejected', 'suspended'].includes(status) ? status : 'pending';
      try {
        const rows = await sb(`retailers?verification_status=eq.${wantedStatus}&select=id,slug,name,billing_email,verification_status,verified_at,verified_by,verification_notes,created_at,branding&order=created_at.desc`  /* `website` removed: it is a column on brands, not retailers */);
        return res.status(200).json({ ok: true, retailers: rows || [], status: wantedStatus });
      } catch (e) {
        return res.status(500).json({ error: 'Query failed: ' + (e?.message || e) });
      }
    }

    // ========================================================================
    // OWNER COI REVIEW — Codex v6 launch blocker.
    //
    // Before these three actions existed, an uploaded certificate could not be approved by
    // anyone: AI verification is off for the closed launch, so a real upload lands
    // 'pending', and the canonical rule in api/_coi-policy.js accepts only
    // 'passed'/'approved'. There was no route between those two facts.
    //
    // Built on the EXISTING platform-owner session, per Codex's instruction not to invent
    // another authentication system. Every action re-verifies the owner cookie; none of
    // them trusts a body or query parameter for identity.
    // ========================================================================

    // ---- OWNER-COI-QUEUE: the newest un-reviewed record per brand ----
    if (action === 'owner-coi-queue') {
      const owner = await verifyOwnerSession(getOwnerSessionIdFromReq(req));
      if (!owner) return res.status(401).json({ error: 'Owner authentication required' });
      try {
        // Only review-relevant metadata. No raw document URL is returned here -- viewing is
        // a separate, deliberately separate action, so the queue cannot become a way to
        // enumerate durable certificate links.
        // QUEUE STARVATION -- Codex v6-FINAL B3. This used to take the newest 200 raw
        // unreviewed rows and THEN dedupe by brand, so one brand uploading 200 times hid
        // every other brand from the operator. Query the authoritative CURRENT pointers
        // instead: at most one review item per brand, by construction.
        const brandRows = await sb('brands?current_coi_verification_id=not.is.null&coi_verification_status=in.(pending,flagged)&select=current_coi_verification_id&limit=500');
        const currentIds = (Array.isArray(brandRows) ? brandRows : [])
          .map(b => b && b.current_coi_verification_id).filter(Boolean);
        const rows = currentIds.length
          ? await sb(`coi_verifications?id=in.(${currentIds.join(',')})&review_decision=is.null&removed_at=is.null&superseded_at=is.null&select=id,brand_id,status,insurer_name,insured_name,policy_expiry,gl_each_occurrence,flags,created_at&order=created_at.desc`)
          : [];
        const list = Array.isArray(rows) ? rows : [];
        // Newest record per brand: an older pending row is superseded by a newer upload and
        // approving it would be the stale case 0058 refuses anyway.
        const seen = new Set();
        const latest = [];
        for (const r of list) { if (r && r.brand_id && !seen.has(r.brand_id)) { seen.add(r.brand_id); latest.push(r); } }
        let brands = [];
        if (latest.length) {
          const ids = latest.map(r => r.brand_id).join(',');
          brands = await sb(`brands?id=in.(${ids})&select=id,company_name,email,default_coi_url,default_coi_expires,coi_verification_status`) || [];
        }
        const byId = {}; for (const b of brands) byId[b.id] = b;
        return res.status(200).json({ ok: true, queue: latest.map(r => ({
          ...r,
          // `stale` tells the reviewer up front that this record no longer describes the
          // brand's current certificate, rather than letting them read it and then be
          // refused at the point of approval.
          stale: !!(byId[r.brand_id] && byId[r.brand_id].default_coi_url !== undefined &&
                    byId[r.brand_id].default_coi_url !== (r.coi_url ?? byId[r.brand_id].default_coi_url)),
          brand: byId[r.brand_id] ? {
            id: byId[r.brand_id].id, company_name: byId[r.brand_id].company_name,
            email: byId[r.brand_id].email, coi_verification_status: byId[r.brand_id].coi_verification_status,
            default_coi_expires: byId[r.brand_id].default_coi_expires,
          } : null,
        })) });
      } catch (e) {
        return res.status(500).json({ error: 'Query failed: ' + (e?.message || e) });
      }
    }

    // ---- OWNER-COI-VIEW: short-lived signed URL for the exact document under review ----
    if (action === 'owner-coi-view') {
      const owner = await verifyOwnerSession(getOwnerSessionIdFromReq(req));
      if (!owner) return res.status(401).json({ error: 'Owner authentication required' });
      const { verification_id } = body || {};
      if (!isUuid(verification_id)) return res.status(400).json({ error: 'Invalid verification_id' });
      try {
        const rows = await sb(`coi_verifications?id=eq.${encodeURIComponent(verification_id)}&select=id,brand_id,storage_path,coi_url,removed_at,superseded_at,review_decision`);
        const rec = Array.isArray(rows) ? rows[0] : null;
        if (!rec) return res.status(404).json({ error: 'verification record not found' });

        // Codex v6-FINAL B1/B2: view the bytes belonging to THIS verification, and refuse
        // anything that is not the brand's current reviewable document. Previously this
        // signed whatever path the record held, which — while uploads shared one path —
        // meant viewing an old record displayed the newest bytes.
        if (rec.removed_at) return res.status(410).json({ error: 'removed', message: 'That certificate was removed by the brand.' });
        if (rec.superseded_at) return res.status(409).json({ error: 'superseded', message: 'A newer certificate has been uploaded. Review that one instead.' });

        const bRows = await sb(`brands?id=eq.${encodeURIComponent(rec.brand_id)}&select=current_coi_verification_id`);
        const cur = Array.isArray(bRows) && bRows[0] ? bRows[0].current_coi_verification_id : null;
        if (cur !== rec.id) return res.status(409).json({ error: 'not_current', message: 'That record is not the brand\'s current certificate.' });

        const storedPath = rec.storage_path || rec.coi_url;
        if (!storedPath) return res.status(404).json({ error: 'this record has no document' });
        // A storage PATH is stored, never a public URL. The signed link is minted per
        // request and expires in two minutes, so nothing durable is ever handed out.
        const key = String(storedPath).replace(/^.*\/coi-docs\//, '');
        const url = await signedCoiUrl(key, 120);
        return res.status(200).json({ ok: true, verification_id, url, expires_in: 120 });
      } catch (e) {
        return res.status(500).json({ error: 'Could not produce a viewing link' });
      }
    }

    // ---- OWNER-COI-REVIEW: approve or reject, atomically, via 0058 ----
    if (action === 'owner-coi-review') {
      const owner = await verifyOwnerSession(getOwnerSessionIdFromReq(req));
      if (!owner) return res.status(401).json({ error: 'Owner authentication required' });
      const { verification_id, decision, notes, expiry } = body || {};
      if (!isUuid(verification_id)) return res.status(400).json({ error: 'Invalid verification_id' });
      if (decision !== 'approved' && decision !== 'rejected') {
        return res.status(400).json({ error: 'decision must be approved or rejected' });
      }
      // Coverage expiry is REVIEWER-owned (LG-11 removed brand self-service; the AI parser is
      // optional). An approval must carry the certificate's expiry or the brand ends up
      // approved-but-never-covered: coiCovered() requires a date, so booking/capture would refuse.
      let expiryDate = null;
      if (decision === 'approved') {
        if (!expiry || !/^\d{4}-\d{2}-\d{2}$/.test(String(expiry))) {
          return res.status(400).json({ error: 'expiry_required', message: 'Enter the policy expiry date (YYYY-MM-DD) from the certificate.' });
        }
        expiryDate = String(expiry);
        if (expiryDate <= new Date().toISOString().slice(0, 10)) {
          return res.status(400).json({ error: 'expiry_in_past', message: 'That certificate is already expired — reject it instead.' });
        }
      }
      const trimmed = notes == null ? null : String(notes).slice(0, 2000);
      try {
        // The RPC does the whole review in ONE transaction and owns the staleness rule.
        // Doing it here as two PATCHes could leave a brand approved while the row describing
        // the approved document had already been replaced.
        const r = await fetch(`${_b.supabaseUrl}/rest/v1/rpc/review_coi_verification`, {
          method: 'POST',
          headers: { apikey: _b.serviceKey, Authorization: `Bearer ${_b.serviceKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ p_verification_id: verification_id, p_decision: decision,
                                 p_reviewer: owner.email, p_notes: trimmed,
                                 // P0-4: the reviewer-confirmed expiry commits inside the review
                                 // transaction (0067). No separate best-effort PATCH — the decision
                                 // and the coverage date it is about can no longer disagree.
                                 p_expiry: expiryDate }),
        });
        const txt = await r.text();
        if (!r.ok) {
          // A stale approval is a legitimate refusal, not a server fault, and the reviewer
          // needs to be told which one it was.
          // 0060 makes reviews immutable, so a second decision is refused BEFORE staleness
          // is even considered. The operator needs to know which refusal they hit: one
          // means "look at the newer upload", the other means "this was already decided".
          // Collapsing both into a generic 400 tells them nothing.
          if (/already decided/i.test(txt)) {
            return res.status(409).json({ error: 'already_decided',
              message: 'This certificate has already been decided. A new decision requires a new upload from the brand.' });
          }
          if (/removed record/i.test(txt)) {
            return res.status(410).json({ error: 'removed',
              message: 'That certificate was removed by the brand.' });
          }
          if (/stale review/i.test(txt)) {
            return res.status(409).json({ error: 'stale_review',
              message: 'This record no longer describes the brand\'s current certificate. Re-open the queue and review the latest upload.' });
          }
          if (/not found/i.test(txt)) return res.status(404).json({ error: 'verification record not found' });
          return res.status(400).json({ error: 'review_failed' });
        }
        let row = null; try { const j = JSON.parse(txt); row = Array.isArray(j) ? j[0] : j; } catch (_) {}
        // Provisional holds: an APPROVED COI resolves this brand's held bookings on AUTO-CONFIRM
        // retailers — capture each hold now (charge -> confirmed + demo + emails via the shared
        // pipeline). Manual-confirm retailers keep the hold until they confirm in their inbox
        // (confirm is what captures there). Best-effort: a capture hiccup never fails the review —
        // the booking simply stays held and the retailer/sweep path picks it up.
        let capturedHolds = 0;
        if (decision === 'approved') {
          try {
            const vRows = await sb(`coi_verifications?id=eq.${encodeURIComponent(verification_id)}&select=brand_id`);
            const brandId = Array.isArray(vRows) && vRows[0] ? vRows[0].brand_id : null;
            // P0-4: brands.default_coi_expires is now written INSIDE review_coi_verification (0067),
            // in the same transaction as the decision — the separate best-effort PATCH that used to
            // live here is gone. The per-date coverage read below therefore sees the reviewer's date.
            if (brandId) {
              const held = await sb(`bookings?brand_id=eq.${encodeURIComponent(brandId)}&status=eq.held&payment_status=eq.authorized&select=id,status,payment_status,payment_intent_id,retailer_id,demo_date`) || [];
              if (held.length) {
                const retailerIds = [...new Set(held.map(b => b.retailer_id))];
                const rRows = await sb(`retailers?id=in.(${retailerIds.map(encodeURIComponent).join(',')})&select=id,auto_confirm_bookings`) || [];
                const autoById = new Map(rRows.map(r => [r.id, !!r.auto_confirm_bookings]));
                // Re-read the brand's COI fields for the per-date coverage check — approving THIS
                // certificate doesn't mean it covers every held demo's date (a cert can expire
                // before a far-future booking). Capture only demos the approved COI actually covers,
                // matching the manual-confirm path's coiCovered gate. Uncovered holds wait for a
                // retailer decision or the 24h sweep.
                const { coiCovered } = await import('./_coi-coverage.js');
                let coiBrand = null;
                try {
                  const br2 = await sb(`brands?id=eq.${encodeURIComponent(brandId)}&select=default_coi_url,default_coi_expires,coi_verification_status`);
                  coiBrand = Array.isArray(br2) ? br2[0] : null;
                } catch (_) {}
                const { captureHeldBooking } = await import('./_provisional.js');
                for (const b of held) {
                  if (!autoById.get(b.retailer_id)) continue;
                  if (!coiCovered(coiBrand || {}, b.demo_date).covered) continue;   // date not covered — don't charge
                  const r2 = await captureHeldBooking(b);
                  if (r2.ok) capturedHolds++;
                  else console.warn('post-approval hold capture failed for', b.id, r2.stage, r2.error);
                }
              }
            }
          } catch (e) { console.warn('post-approval hold sweep skipped:', (e && e.message) || e); }
        }
        return res.status(200).json({ ok: true, verification_id, decision,
          reviewed_by: owner.email, reviewed_at: row && row.reviewed_at ? row.reviewed_at : null,
          captured_holds: capturedHolds || undefined });
      } catch (e) {
        return res.status(500).json({ error: 'review_failed' });
      }
    }

    // ---- OWNER-VERIFY-RETAILER: approve / reject / suspend / reset ----
    if (action === 'owner-verify-retailer') {
      const { retailer_id, new_status, notes } = body || {};
      const owner = await verifyOwnerSession(getOwnerSessionIdFromReq(req))   /* was verifyOwnerSessionV2 — never defined */;
      if (!owner) return res.status(401).json({ error: 'Owner authentication required' });
      if (!isUuid(retailer_id)) return res.status(400).json({ error: 'Invalid retailer_id' });
      if (!['pending', 'approved', 'rejected', 'suspended'].includes(new_status)) {
        return res.status(400).json({ error: 'new_status must be pending, approved, rejected, or suspended' });
      }
      const patch = {
        verification_status: new_status,
        verification_notes: notes || null,
      };
      if (new_status === 'approved') {
        patch.verified_at = new Date().toISOString();
        patch.verified_by = owner.email;
      } else if (new_status === 'pending') {
        patch.verified_at = null;
        patch.verified_by = null;
      }
      try {
        await sb(`retailers?id=eq.${encodeURIComponent(retailer_id)}`, { method: 'PATCH', body: JSON.stringify(patch) });
        return res.status(200).json({ ok: true, retailer_id, new_status });
      } catch (e) {
        return res.status(500).json({ error: 'Update failed: ' + (e?.message || e) });
      }
    }

        if (action === 'owner-login' || action === 'owner-verify' || action === 'owner-verify-code' || action === 'owner-data' || action === 'owner-logout' || action === 'owner-list-retailers' || action === 'owner-impersonate' || action === 'owner-end-impersonation' || action === 'support-sessions' || action === 'support-access-toggle' || action === 'support-access-status') {
      return await handleOwnerAction(action, req, res, body);
    }

      // === Incident management (owner-only) ===
  // POST a new incident
  if (action === 'incident-post') {
    const { title, body: incBody, severity } = body || {};
    const v = await verifyOwnerSession(getOwnerSessionIdFromReq(req));
    if (!v) return res.status(401).json({ error: 'Owner auth required' });
    if (!title || String(title).trim().length < 3) return res.status(400).json({ error: 'title required' });
    const sev = ['minor','major','maintenance'].includes(severity) ? severity : 'minor';
    const created = await sb('status_incidents', {
      method: 'POST',
      body: JSON.stringify({ title: String(title).trim(), body: incBody || null, severity: sev }),
    });
    return res.status(200).json({ ok: true, incident: Array.isArray(created) ? created[0] : null });
  }

  // Resolve an active incident
  if (action === 'incident-resolve') {
    const { incident_id } = body || {};
    const v = await verifyOwnerSession(getOwnerSessionIdFromReq(req));
    if (!v) return res.status(401).json({ error: 'Owner auth required' });
    if (!incident_id) return res.status(400).json({ error: 'incident_id required' });
    await sb(`status_incidents?id=eq.${encodeURIComponent(incident_id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ resolved_at: new Date().toISOString() }),
    });
    return res.status(200).json({ ok: true });
  }

  // List incidents (owner sees both active + resolved)
  if (action === 'incident-list') {
    const v = await verifyOwnerSession(getOwnerSessionIdFromReq(req));
    if (!v) return res.status(401).json({ error: 'Owner auth required' });
    const rows = await sb(`status_incidents?select=*&order=started_at.desc&limit=50`);
    return res.status(200).json({ ok: true, incidents: rows || [] });
  }

return res.status(400).json({ error: 'Unknown action' });
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
}

// ============================================================
// OWNER PANEL helpers (gated to OWNER_EMAILS allowlist)
// Reuses admin_sessions + admin_tokens tables. Owner sessions have retailer_id = NULL.
// ============================================================
const OWNER_EMAILS = ['david@demohubhq.com', 'davidmichaelheiser@gmail.com'];
const TIER_PRICES = { free: 0, solo: 0, starter: 0, growth: 0, pro: 29.99, enterprise: 499 };

// Ensures a sentinel "system" retailer exists for owner tokens/sessions
// (works around admin_tokens.retailer_id and admin_sessions.retailer_id being NOT NULL)
async function ensureOwnerRetailerId() {
  try {
    const existing = await sb('retailers?slug=eq.__owner__&select=id&limit=1');
    if (Array.isArray(existing) && existing[0]) return existing[0].id;
  } catch (_) {}
  try {
    const created = await sb('retailers', {
      method: 'POST',
      body: JSON.stringify({ slug: '__owner__', name: 'Demohub Owner (system)', billing_email: 'david@demohubhq.com', branding: {} })
    });
    if (Array.isArray(created) && created[0]) return created[0].id;
  } catch (_) {}
  return null;
}

function randomToken(n = 32) {
  // Use Node's crypto — throw if unavailable rather than fall back to Math.random,
  // which is a predictable PRNG unsuitable for auth tokens.
  const buf = randomBytes(n);
  return Array.from(buf).map(b => b.toString(16).padStart(2, '0')).join('');
}

function ownerMagicLinkEmail(link, code) {
  const codeBlock = code ? `
      <div style="font-size:13px;color:#6b6a64;margin:0 0 8px;">Your login code</div>
      <div style="font-size:34px;font-weight:800;letter-spacing:0.18em;color:#0f2c17;font-family:'SFMono-Regular',Menlo,Monaco,Consolas,monospace;margin:0 0 16px;">${html(String(code))}</div>
      <p style="font-size:14px;line-height:1.5;color:#6b6a64;margin:0 0 22px;">Enter it on the sign-in screen, or use the link below. Expires in 30 minutes.</p>`
    : `<p style="font-size:15px;line-height:1.5;color:#3a3a36;margin:0 0 22px;">Click below to sign in to the Demohub owner panel. Link expires in 30 minutes.</p>`;
  return `<!DOCTYPE html><html><body style="margin:0;padding:24px;background:#fbf7f0;font-family:-apple-system,sans-serif;color:#1c1c1a;">
    <div style="max-width:480px;margin:0 auto;background:white;border-radius:14px;padding:32px;border:1px solid rgba(15,44,23,0.08);">
      <div style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.14em;color:#a14e2a;margin-bottom:12px;">Owner sign in</div>
      <h1 style="font-family:Georgia,serif;font-size:24px;font-weight:400;color:#0f2c17;margin:0 0 12px;">Open the owner panel</h1>
      ${codeBlock}
      <a href="${html(link)}" style="display:inline-block;background:#0f2c17;color:white;padding:14px 26px;border-radius:99px;text-decoration:none;font-weight:600;">Sign in &rarr;</a>
    </div>
  </body></html>`;
}

function monthKey(d) { return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0'); }

async function verifyOwnerSession(sessionId) {
  if (!sessionId || !isUuid(sessionId)) return null;
  let sessions;
  try {
    sessions = await sb(`admin_sessions?session_id=eq.${encodeURIComponent(sessionId)}&select=email,retailer_id,expires_at`);
  } catch (_) { return null; }
  const s = Array.isArray(sessions) ? sessions[0] : null;
  if (!s) return null;
  { const _e = Date.parse(String(s.expires_at || '')); if (!Number.isFinite(_e) || _e <= Date.now()) return null; }
  if (!OWNER_EMAILS.includes((s.email || '').toLowerCase())) return null;
  return { email: s.email };
}

async function computeOwnerMetrics() {
  // Each query wrapped: if table/column missing, default to [] instead of failing the whole metrics
  const safeQuery = async (q) => { try { return await sb(q); } catch (e) { console.error('owner metrics query failed:', q, e?.message); return []; } };
  const [retailers, brands, demos, bookings, settings] = await Promise.all([
    safeQuery(`retailers?select=id,name,slug,created_at,logo_url,billing_email,billing_tier,billing_status,stripe_subscription_id`),
    safeQuery(`brands?select=id,company_name,created_at,default_coi_url,is_verified`),
    safeQuery(`demos?select=id,retailer_id,brand_id,demo_date,demo_fee,status,created_at`),
    safeQuery(`bookings?select=id,retailer_id,brand_id,status,payment_status,amount_paid,paid_at,created_at`),
    // settings has neither billing_tier nor price_per_demo. demo_fee is the real per-demo
    // price column; tier lives on retailers. safeQuery swallowed the 400, so this row of the
    // owner metrics silently contributed nothing.
    safeQuery(`settings?select=retailer_id,demo_fee`),
  ]);
  const now = new Date();
  const thisMonth = monthKey(now);
  const lastMonthDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const lastMonth = monthKey(lastMonthDate);
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const sixtyDaysAgo = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000);
  const seventyTwoHoursAgo = new Date(now.getTime() - 72 * 60 * 60 * 1000);

  const totalRetailers = retailers.length;
  const totalBrands = brands.length;
  const activeRetailerIds = new Set();
  demos.forEach(d => { if (d.created_at && new Date(d.created_at) >= thirtyDaysAgo) activeRetailerIds.add(d.retailer_id); });
  bookings.forEach(b => { if (b.created_at && new Date(b.created_at) >= thirtyDaysAgo) activeRetailerIds.add(b.retailer_id); });
  const activeRetailers30d = activeRetailerIds.size;

  const demosThisMonth = demos.filter(d => (d.demo_date || '').slice(0, 7) === thisMonth).length;
  const demosLastMonth = demos.filter(d => (d.demo_date || '').slice(0, 7) === lastMonth).length;
  const demosDeltaPct = demosLastMonth === 0 ? (demosThisMonth > 0 ? 100 : 0) : Math.round(((demosThisMonth - demosLastMonth) / demosLastMonth) * 100);

  // Real tiers are solo/pro/enterprise (solo = free). Only ACTIVE paid subscriptions count toward
  // MRR — a comped Pro retailer (pro tier, no active subscription) is not recurring revenue.
  const tierCounts = { solo: 0, pro: 0, enterprise: 0 };
  let mrrSubs = 0, paidRetailers = 0;
  retailers.forEach(r => {
    let tier = (r.billing_tier || 'solo').toLowerCase();
    if (tier === 'free') tier = 'solo';
    if (tier in tierCounts) tierCounts[tier]++;
    const st = (r.billing_status || '').toLowerCase();
    const active = st === 'active' || st === 'trialing';
    if (active && (TIER_PRICES[tier] || 0) > 0) { mrrSubs += TIER_PRICES[tier]; paidRetailers++; }
  });
  const conversionPct = totalRetailers > 0 ? Math.round((paidRetailers / totalRetailers) * 1000) / 10 : 0;
  // GMV = demo fees processed on PAID bookings; platform revenue = flat $5/booking service fee.
  const PLATFORM_FEE = 5;
  const paidBookings = bookings.filter(b => b.payment_status === 'paid');
  const paidThisMonth = paidBookings.filter(b => (b.paid_at || '').slice(0, 7) === thisMonth);
  const gmvMonth = paidThisMonth.reduce((s, b) => s + (Number(b.amount_paid || 0) / 100), 0);
  const gmvAll = paidBookings.reduce((s, b) => s + (Number(b.amount_paid || 0) / 100), 0);
  const platformFeeMonth = paidThisMonth.length * PLATFORM_FEE;
  const takeRatePct = (gmvMonth + platformFeeMonth) > 0 ? Math.round((platformFeeMonth / (gmvMonth + platformFeeMonth)) * 1000) / 10 : 0;
  const mrrProjection = Math.round(mrrSubs);

  const months = [];
  for (let i = 11; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    months.push({ key: monthKey(d), label: d.toLocaleString('en-US', { month: 'short' }) });
  }
  const retailerSignups = months.map(m => ({ month: m.key, label: m.label, count: retailers.filter(r => (r.created_at || '').slice(0, 7) === m.key).length }));
  const brandSignups = months.map(m => ({ month: m.key, label: m.label, count: brands.filter(b => (b.created_at || '').slice(0, 7) === m.key).length }));
  const demosPerMonth = months.map(m => ({ month: m.key, label: m.label, count: demos.filter(d => (d.demo_date || '').slice(0, 7) === m.key).length }));

  const retailerDemoCount = {};
  demos.forEach(d => { if ((d.demo_date || '').slice(0, 7) === thisMonth) retailerDemoCount[d.retailer_id] = (retailerDemoCount[d.retailer_id] || 0) + 1; });
  const retailerMap = Object.fromEntries(retailers.map(r => [r.id, r]));
  const topRetailers = Object.entries(retailerDemoCount).sort((a, b) => b[1] - a[1]).slice(0, 10)
    .map(([rid, count]) => ({ id: rid, name: retailerMap[rid]?.name || 'Unknown', slug: retailerMap[rid]?.slug || '', demos_this_month: count }));

  const brandActivity = {};
  demos.forEach(d => { if (d.brand_id && d.created_at && new Date(d.created_at) >= thirtyDaysAgo) brandActivity[d.brand_id] = (brandActivity[d.brand_id] || 0) + 1; });
  const brandMap = Object.fromEntries(brands.map(b => [b.id, b]));
  const topBrands = Object.entries(brandActivity).sort((a, b) => b[1] - a[1]).slice(0, 10)
    .map(([bid, count]) => ({ id: bid, name: brandMap[bid]?.company_name || 'Unknown', activity_30d: count }));

  const pendingStuck = bookings
    .filter(b => b.status === 'pending' && b.created_at && new Date(b.created_at) < seventyTwoHoursAgo)
    .map(b => ({
      id: b.id,
      retailer_name: retailerMap[b.retailer_id]?.name || 'Unknown',
      retailer_slug: retailerMap[b.retailer_id]?.slug || '',
      brand_name: brandMap[b.brand_id]?.company_name || 'Unknown',
      created_at: b.created_at,
      hours_pending: Math.round((now - new Date(b.created_at)) / (60 * 60 * 1000)),
    }))
    .sort((a, b) => b.hours_pending - a.hours_pending)
    .slice(0, 20);

  const brandsWithoutCoi = brands.filter(b => !b.default_coi_url).slice(0, 25).map(b => ({ id: b.id, name: b.company_name, created_at: b.created_at }));
  const dormantRetailers = retailers.filter(r => !activeRetailerIds.has(r.id)).slice(0, 25).map(r => ({ id: r.id, name: r.name, slug: r.slug, last_active: null }));
  const brandLastDemo = {};
  demos.forEach(d => { if (d.brand_id) { const c = d.created_at; if (!brandLastDemo[d.brand_id] || c > brandLastDemo[d.brand_id]) brandLastDemo[d.brand_id] = c; } });
  const inactiveBrands = brands.filter(b => !brandLastDemo[b.id] || new Date(brandLastDemo[b.id]) < sixtyDaysAgo).slice(0, 25)
    .map(b => ({ id: b.id, name: b.company_name, last_active: brandLastDemo[b.id] || null }));

  return {
    generated_at: new Date().toISOString(),
    headline: { total_retailers: totalRetailers, active_retailers_30d: activeRetailers30d, total_brands: totalBrands, demos_this_month: demosThisMonth, demos_last_month: demosLastMonth, demos_delta_pct: demosDeltaPct, mrr_subs: Math.round(mrrSubs * 100) / 100, mrr_projection: mrrProjection, paid_retailers: paidRetailers, conversion_pct: conversionPct, gmv_month: Math.round(gmvMonth * 100) / 100, gmv_all: Math.round(gmvAll * 100) / 100, take_rate_pct: takeRatePct, tier_counts: tierCounts },
    trends: { retailer_signups: retailerSignups, brand_signups: brandSignups, demos_per_month: demosPerMonth },
    tables: { top_retailers: topRetailers, top_brands: topBrands, pending_stuck: pendingStuck },
    watchlist: { brands_without_coi: brandsWithoutCoi, dormant_retailers: dormantRetailers, inactive_brands_60d: inactiveBrands },
  };
}

async function handleOwnerAction(action, req, res, body) {
  if (action === 'owner-login') {
    const email = String(body.email || '').trim().toLowerCase();
    if (!email || !/^[^@]+@[^@]+\.[^@]+$/.test(email)) return res.status(400).json({ error: 'Valid email required' });
    // DH-14: rate-limit before doing any work or sending mail — otherwise a caller can drain the
    // Resend quota and flood the owner inbox. Uniform 200 either way to avoid leaking the cap.
    const rlOwnerIp = await checkRateLimit(req, 'owner-login-ip', 10);
    const rlOwnerEmail = await checkRateLimitByKey('owner-login-email:' + email.slice(0, 64), 10);
    if (!rlOwnerIp.allowed || !rlOwnerEmail.allowed) return res.status(200).json({ ok: true });
    const diag = { allowlisted: false, system_retailer_id: null, insert_ok: false, insert_error: null, insert_response: null, token_found: false, resend_ok: false, resend_error: null, resend_response: null };
    if (OWNER_EMAILS.includes(email)) {
      diag.allowlisted = true;
      const ownerRetailerId = await ensureOwnerRetailerId();
      diag.system_retailer_id = ownerRetailerId;
      let token = null; const code = generateLoginCode();
      if (ownerRetailerId) {
        try {
          const tokens = await sb('admin_tokens', { method: 'POST', body: JSON.stringify({ email, retailer_id: ownerRetailerId, code }) });
          diag.insert_ok = true;
          diag.insert_response = Array.isArray(tokens) ? tokens[0] : tokens;
          token = Array.isArray(tokens) ? tokens[0]?.token : null;
        } catch (e) {
          diag.insert_error = e?.message || String(e);
        }
      } else {
        diag.insert_error = 'Could not ensure system retailer';
      }
      diag.token_found = !!token;
      if (token) {
        const link = siteLink(_b, `/owner?token=${encodeURIComponent(token)}`);
        if (_b.resendApiKey) {
          const r = await sendMailQuietly({ from: FROM_ADDRESS, to: email, replyTo: 'david@demohubhq.com', subject: 'Sign in to the Demohub owner panel', html: ownerMagicLinkEmail(link, code) }, { binding: _b });
          diag.resend_ok = !!r.ok;
          if (!r.ok) diag.resend_error = r.code || 'mail_send_failed';
        } else {
          diag.resend_error = 'mail provider not configured';
        }
      }
    }
    // Always return the same opaque response — never a token, link, or diagnostics.
    // (A previous debug branch returned a valid owner login link to any caller.)
    return res.status(200).json({ ok: true });
  }

  if (action === 'owner-verify') {
    const token = String(body.token || '').trim();
    if (!token) return res.status(400).json({ error: 'Missing token' });
    const tokens = await sb(`admin_tokens?token=eq.${encodeURIComponent(token)}&select=*`);
    const tok = Array.isArray(tokens) ? tokens[0] : null;
    if (!tok) return res.status(404).json({ error: 'Token not found' });
    if (tok.used_at) return res.status(409).json({ error: 'Token already used' });
    { const _e = Date.parse(String(tok.expires_at || '')); if (!Number.isFinite(_e) || _e <= Date.now()) return res.status(410).json({ error: 'Token expired' }); }
    if (!OWNER_EMAILS.includes((tok.email || '').toLowerCase())) return res.status(403).json({ error: 'Not authorised' });
    await sb(`admin_tokens?token=eq.${encodeURIComponent(token)}`, { method: 'PATCH', body: JSON.stringify({ used_at: new Date().toISOString() }) });
    const ownerRetailerId = (await ensureOwnerRetailerId()) || tok.retailer_id;
    // SECURITY: owner sessions expire in 12 HOURS (not the 30-day default for retailer logins).
    // The master panel can see all platform data + impersonate any retailer, so it must
    // re-authenticate at least twice a day. Forces a fresh magic-link login after expiry.
    const ownerExpires = new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString();
    const sessions = await sb('admin_sessions', { method: 'POST', body: JSON.stringify({ email: tok.email, retailer_id: ownerRetailerId, expires_at: ownerExpires }) });
    const session = Array.isArray(sessions) ? sessions[0] : null;
    if (!session?.session_id) return res.status(500).json({ error: 'Could not start session' });
    // The OWNER cookie, max-age matching the 12-hour DB expiry above. Distinct from the retailer
    // cookie, so starting an impersonation no longer overwrites the owner's own session.
    setRoleCookie(res, 'owner', session.session_id, OWNER_SESSION_MAX_AGE);
    return res.status(200).json({ ok: true, email: tok.email });
  }

  // Parallel to owner-verify but keyed on the 6-digit code (consistent with the retailer admin
  // login). Same 2x OWNER_EMAILS allowlist check, same 12h owner session + owner cookie — so the
  // owner can type the code instead of clicking the magic link, which works in any window/device.
  if (action === 'owner-verify-code') {
    const email = String(body.email || '').trim().toLowerCase();
    const code = String(body.code || '').replace(/\D/g, '').trim();
    if (!email || code.length !== 6) return res.status(400).json({ error: 'Email and 6-digit code required' });
    const rlIp = await checkRateLimit(req, 'owner-verify-code', 20);
    const rlEmail = await checkRateLimitByKey('owner-verify-code-email:' + email.slice(0, 64), 10);
    if (!rlIp.allowed || !rlEmail.allowed) return res.status(429).json({ error: 'Too many attempts. Try again in an hour.' });
    if (!OWNER_EMAILS.includes(email)) return res.status(403).json({ error: 'Not authorised' });
    const rows = await sb(`admin_tokens?email=eq.${encodeURIComponent(email)}&code=eq.${encodeURIComponent(code)}&used_at=is.null&select=*&order=created_at.desc&limit=1`);
    const tok = Array.isArray(rows) ? rows[0] : null;
    if (!tok) return res.status(404).json({ error: 'Invalid code' });
    { const _e = Date.parse(String(tok.expires_at || '')); if (!Number.isFinite(_e) || _e <= Date.now()) return res.status(410).json({ error: 'Code expired' }); }
    if (!OWNER_EMAILS.includes((tok.email || '').toLowerCase())) return res.status(403).json({ error: 'Not authorised' });
    await sb(`admin_tokens?token=eq.${encodeURIComponent(tok.token)}`, { method: 'PATCH', body: JSON.stringify({ used_at: new Date().toISOString() }) });
    const ownerRetailerId = (await ensureOwnerRetailerId()) || tok.retailer_id;
    const ownerExpires = new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString();
    const sessions = await sb('admin_sessions', { method: 'POST', body: JSON.stringify({ email: tok.email, retailer_id: ownerRetailerId, expires_at: ownerExpires }) });
    const session = Array.isArray(sessions) ? sessions[0] : null;
    if (!session?.session_id) return res.status(500).json({ error: 'Could not start session' });
    setRoleCookie(res, 'owner', session.session_id, OWNER_SESSION_MAX_AGE);
    return res.status(200).json({ ok: true, email: tok.email });
  }

  if (action === 'owner-data') {
    const sessionId = getOwnerSessionIdFromReq(req);
    const v = await verifyOwnerSession(sessionId);
    if (!v) return res.status(401).json({ error: 'Not authenticated' });
    const metrics = await computeOwnerMetrics();
    return res.status(200).json({ ok: true, ...metrics });
  }

  if (action === 'owner-logout') {
    const sessionId = getOwnerSessionIdFromReq(req);
    if (sessionId) {
      try { await sb(`admin_sessions?session_id=eq.${encodeURIComponent(sessionId)}`, { method: 'DELETE' }); } catch (_) {}
    }
    // Previously this deleted the row and cleared no cookie, because the owner session was never
    // in a cookie to clear. Clear every role: an owner logging out mid-impersonation must not
    // leave the impersonated retailer session usable.
    clearAllSessionCookies(res);
    return res.status(200).json({ ok: true });
  }


  // ---- OWNER-LIST-RETAILERS: full retailers list for the "sign in as admin" picker ----
  if (action === 'owner-list-retailers') {
    const sessionId = getOwnerSessionIdFromReq(req);
    const v = await verifyOwnerSession(sessionId);
    if (!v) return res.status(401).json({ error: 'Not authenticated' });
    const rows = await sb('retailers?select=id,slug,name,billing_email,billing_tier,created_at&order=name.asc&limit=500');
    return res.status(200).json({ ok: true, retailers: rows || [] });
  }

  // ---- OWNER-IMPERSONATE: create a scoped 4-hour session for a retailer, log to audit table ----
  // Sets the retailer's admin cookie (dh_retailer_session) AND a non-HttpOnly marker cookie
  // so the client-side admin page can render the "Support session" banner.
  if (action === 'owner-impersonate') {
    const sessionId = getOwnerSessionIdFromReq(req);
    const owner = await verifyOwnerSession(sessionId);
    if (!owner) return res.status(401).json({ error: 'Owner authentication required' });
    const retailer_id = String((body && body.retailer_id) || '');
    if (!isUuid(retailer_id)) return res.status(400).json({ error: 'Invalid retailer_id' });
    const rArr = await sb(`retailers?id=eq.${encodeURIComponent(retailer_id)}&select=id,slug,name,billing_email,allow_support_access,support_access_expires_at`);
    const r = Array.isArray(rArr) ? rArr[0] : null;
    if (!r) return res.status(404).json({ error: 'Retailer not found' });
    // Owner-override model: the platform owner (verified above via OWNER_EMAILS + owner
    // session) can access any retailer's admin directly. No customer-consent toggle required
    // at this stage. Access is still recorded in support_sessions below for transparency,
    // so a per-customer consent gate can be layered back on later without re-plumbing.
    // Create the impersonation session with a 4-hour expiry
    const impersonationExpires = new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString();
    const sessions = await sb('admin_sessions', {
      method: 'POST',
      body: JSON.stringify({
        email: r.billing_email || owner.email,
        retailer_id: r.id,
        expires_at: impersonationExpires,
      }),
    });
    const session = Array.isArray(sessions) ? sessions[0] : null;
    if (!session) return res.status(500).json({ error: 'Failed to create impersonation session' });
    // Log to support_sessions audit table (best-effort — don't fail the impersonation if this errors)
    try {
      const _xff = (req.headers['x-forwarded-for'] || '').toString().split(',').map(x => x.trim()).filter(Boolean);
      const ip = req.headers['x-real-ip'] || _xff[_xff.length - 1] || null;  // audit log; not cf-connecting-ip
      const ua = String(req.headers['user-agent'] || '').slice(0, 500);
      await sb('support_sessions', {
        method: 'POST',
        body: JSON.stringify({
          owner_email: owner.email,
          target_retailer_id: r.id,
          target_session_id: session.session_id,
          ip_address: ip,
          user_agent: ua,
        }),
      });
    } catch (e) {
      console.warn('support_sessions log failed (impersonation still proceeds):', e?.message || e);
    }
    // The RETAILER cookie only. The owner's own session stays in dh_owner_session, untouched.
    // That is the point of splitting them: before this, impersonation overwrote the single
    // dh_session cookie, so the retailer-scoped session became the only session the owner held,
    // and any owner-only path reading that cookie would have been reading a retailer session.
    setSessionCookie(res, session.session_id, IMPERSONATION_MAX_AGE);
    // Set a non-HttpOnly marker cookie so client JS can render the banner + Exit button
    const markerVal = encodeURIComponent(JSON.stringify({ owner: owner.email, retailer: r.name, started: new Date().toISOString() }));
    const markerCookie = `dh_support=${markerVal}; Path=/; Max-Age=14400; Secure; SameSite=Lax`;
    const existing = res.getHeader('Set-Cookie');
    if (existing) res.setHeader('Set-Cookie', Array.isArray(existing) ? [...existing, markerCookie] : [existing, markerCookie]);
    else res.setHeader('Set-Cookie', markerCookie);
    return res.status(200).json({
      ok: true,
      retailer_slug: r.slug,
      retailer_name: r.name,
      admin_url: `/r/${r.slug}/admin`,
    });
  }

  // ---- OWNER-END-IMPERSONATION: clear the impersonation session + cookies ----
  if (action === 'owner-end-impersonation') {
    // The session being ended is the IMPERSONATED retailer session, from the retailer cookie.
    // The owner cookie is deliberately left alone so the owner lands back on the owner panel
    // still signed in — previously there was no owner cookie to preserve.
    const sid = getSessionIdFromReq(req, body);
    let summaryRow = null;
    let retailerInfo = null;
    if (sid) {
      // Fetch the support_sessions row + retailer info BEFORE marking ended so we can
      // include duration + writes_count in the summary email.
      try {
        const rows = await sb(`support_sessions?target_session_id=eq.${encodeURIComponent(sid)}&ended_at=is.null&select=id,owner_email,started_at,writes_count,target_retailer_id&limit=1`);
        summaryRow = Array.isArray(rows) ? rows[0] : null;
        if (summaryRow) {
          const retRows = await sb(`retailers?id=eq.${encodeURIComponent(summaryRow.target_retailer_id)}&select=name,billing_email`);
          retailerInfo = Array.isArray(retRows) ? retRows[0] : null;
        }
      } catch (_) {}
      // Mark ended
      try { await sb(`support_sessions?target_session_id=eq.${encodeURIComponent(sid)}&ended_at=is.null`, {
        method: 'PATCH',
        body: JSON.stringify({ ended_at: new Date().toISOString() }),
      }); } catch (_) {}
      try { await sb(`admin_sessions?session_id=eq.${encodeURIComponent(sid)}`, { method: 'DELETE' }); } catch (_) {}
    }
    // Fire-and-forget summary email to retailer
    if (summaryRow && retailerInfo && retailerInfo.billing_email) {
      const startedAt = new Date(summaryRow.started_at);
      const endedAt = new Date();
      const mins = Math.max(1, Math.round((endedAt - startedAt) / 60000));
      const writes = summaryRow.writes_count || 0;
      if (_b.resendApiKey) {
        const html = `<!DOCTYPE html><html><body style="margin:0;padding:24px;background:#fbf7f0;font-family:-apple-system,sans-serif;color:#1c1c1a;">
          <div style="max-width:520px;margin:0 auto;background:white;border-radius:16px;padding:32px;border:1px solid rgba(15,44,23,0.08);">
            <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.12em;color:#a14e2a;margin-bottom:10px;">Support session ended</div>
            <h1 style="font-family:Georgia,serif;font-size:22px;font-weight:500;color:#0f2c17;margin:0 0 14px;">Demohub support just accessed your account.</h1>
            <p style="font-size:15px;color:#3a3a36;margin:0 0 16px;line-height:1.55;"><strong>${summaryRow.owner_email}</strong> signed in to <strong>${retailerInfo.name}</strong> as your admin.</p>
            <table cellpadding="0" cellspacing="0" style="width:100%;background:#f9f7f2;border-radius:10px;margin-bottom:22px;">
              <tr><td style="padding:12px 16px;font-size:11px;text-transform:uppercase;letter-spacing:0.08em;color:#6b6a64;font-weight:600;">Duration</td><td style="padding:12px 16px;text-align:right;color:#0f2c17;font-weight:600;font-size:14px;">${mins} min</td></tr>
              <tr><td style="padding:12px 16px;font-size:11px;text-transform:uppercase;letter-spacing:0.08em;color:#6b6a64;font-weight:600;border-top:1px solid #ede3d0;">Changes made</td><td style="padding:12px 16px;text-align:right;color:#0f2c17;font-weight:600;font-size:14px;border-top:1px solid #ede3d0;">${writes}</td></tr>
              <tr><td style="padding:12px 16px;font-size:11px;text-transform:uppercase;letter-spacing:0.08em;color:#6b6a64;font-weight:600;border-top:1px solid #ede3d0;">Started</td><td style="padding:12px 16px;text-align:right;color:#3a3a36;font-size:13px;border-top:1px solid #ede3d0;">${startedAt.toLocaleString('en-US')}</td></tr>
            </table>
            <p style="font-size:13px;color:#6b6a64;line-height:1.55;margin:0 0 8px;">Full activity log is in your admin under Settings &rarr; Demohub support activity.</p>
            <p style="font-size:12px;color:#6b6a64;line-height:1.55;margin:0;">To prevent future support access, toggle 'Allow Demohub support access' OFF in Settings.</p>
          </div>
        </body></html>`;
        sendMailQuietly({
          from: 'Demohub <support@demohubhq.com>',
          to: retailerInfo.billing_email,
          replyTo: 'david@demohubhq.com',
          subject: `Demohub support just accessed ${retailerInfo.name}`,
          html,
        }, { binding: _b }).catch(e => console.warn('support summary email failed:', e?.message || e));
      }
    }
    clearSessionCookie(res);
    const clearMarker = `dh_support=; Path=/; Max-Age=0; Secure; SameSite=Lax`;
    const existing = res.getHeader('Set-Cookie');
    if (existing) res.setHeader('Set-Cookie', Array.isArray(existing) ? [...existing, clearMarker] : [existing, clearMarker]);
    else res.setHeader('Set-Cookie', clearMarker);
    return res.status(200).json({ ok: true });
  }

  // ---- SUPPORT-SESSIONS: retailer views their own support-session audit log ----
  // Reads via retailer admin session (any admin of that retailer). Not owner-only.
  if (action === 'support-sessions') {
    const sid = getSessionIdFromReq(req, body);
    const v = await requireRetailerMembership(sid);
    if (!v.ok) return res.status(401).json({ error: v.error });
    const rows = await sb(`support_sessions?target_retailer_id=eq.${encodeURIComponent(v.retailer_id)}&select=id,owner_email,started_at,ended_at,writes_count&order=started_at.desc&limit=50`);
    return res.status(200).json({ ok: true, sessions: rows || [] });
  }

  // ---- SUPPORT-ACCESS-TOGGLE: retailer flips their own allow_support_access flag ----
  // ON sets a 24-hour auto-expire. OFF clears expires_at and blocks future impersonation.
  if (action === 'support-access-toggle') {
    const sid = getSessionIdFromReq(req, body);
    const v = await requireRetailerMembership(sid);
    if (!v.ok) return res.status(401).json({ error: v.error });
    if (!['owner', 'admin', 'manager'].includes(String(v.role || '').toLowerCase())) return res.status(403).json({ error: 'read_only_role', message: 'Your account has view-only access. Ask an admin to make changes.' });
    const enabled = body && body.enabled === true;
    const patch = enabled
      ? { allow_support_access: true, support_access_expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() }
      : { allow_support_access: false, support_access_expires_at: null };
    await sb(`retailers?id=eq.${encodeURIComponent(v.retailer_id)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    });
    return res.status(200).json({ ok: true, allow_support_access: enabled, expires_at: patch.support_access_expires_at });
  }

  // ---- SUPPORT-ACCESS-STATUS: retailer reads their own toggle state (for the UI toggle) ----
  if (action === 'support-access-status') {
    const sid = getSessionIdFromReq(req, body);
    const v = await requireRetailerMembership(sid);
    if (!v.ok) return res.status(401).json({ error: v.error });
    const rows = await sb(`retailers?id=eq.${encodeURIComponent(v.retailer_id)}&select=allow_support_access,support_access_expires_at`);
    const r = Array.isArray(rows) ? rows[0] : null;
    const expired = r && r.support_access_expires_at && new Date(r.support_access_expires_at).getTime() < Date.now();
    return res.status(200).json({
      ok: true,
      allow_support_access: !!(r && r.allow_support_access) && !expired,
      expires_at: r && r.support_access_expires_at,
      expired,
    });
  }

  return res.status(400).json({ error: 'Unknown owner action' });
}
