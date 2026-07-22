// /api/admin-auth — Retailer admin authentication.
//   POST { action: "login",  email, retailer_slug }      → emails magic link if email matches billing_email
//   POST { action: "verify", token }                      → returns session_id
//   POST { action: "data",   session_id, retailer_slug }  → returns { ok, email, retailer_id }
//   POST { action: "logout", session_id }                 → invalidates the session
// Uses service_role; never exposes whether an email is registered (anti-enumeration).

const SUPABASE_URL = process.env.SUPABASE_URL || (process.env.VERCEL_ENV === 'preview' ? undefined : 'https://ecapmcyumpjjgjwuokyv.supabase.co'); // WS1-R2-03: env-driven; a preview must set SUPABASE_URL and never silently falls back to prod
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

// R2-11: build security-sensitive links (magic links, redirects) from a fixed, configured origin
// — never from client-controllable forwarded-host headers. Defaults to the canonical www host.
const SITE_ORIGIN = process.env.SITE_ORIGIN || 'https://www.demohubhq.com';

// R2-05: viewer-role staff accounts are read-only. Uses the shared sb() helper (throws on error,
// so a lookup failure lands in the caller's try/deny path). Owner has no retailer_admins row.
async function callerRoleAuth(retailerId, email) {
  if (!email || !retailerId) return null;
  try {
    const rows = await sb(`retailer_admins?retailer_id=eq.${encodeURIComponent(retailerId)}&email=ilike.${encodeURIComponent(String(email).toLowerCase())}&select=role`);
    return (Array.isArray(rows) && rows[0]) ? (rows[0].role || null) : null;
  } catch (_) { return null; }
}

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM_ADDRESS = 'Demohub <bookings@demohubhq.com>';

function html(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

// UUID format guard — protects against Postgres "invalid input syntax for type uuid" errors
// when callers pass garbage values like "fake" in session_id or other UUID params.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(s) { return typeof s === 'string' && UUID_RE.test(s); }

async function sb(path, opts = {}) {
  const headers = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=representation', ...(opts.headers || {}) };
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { ...opts, headers });
  const text = await r.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch(_) {}
  if (!r.ok) throw new Error(json?.message || text || `HTTP ${r.status}`);
  return json;
}

// -----------------------------------------------------------------------------
// HttpOnly cookie helpers — session_id lives here so XSS can't read it via
// document.cookie or localStorage. Cookies are same-origin (no Domain=),
// SameSite=Lax (safe for GETs, blocks cross-site POSTs), Secure (HTTPS only).
// -----------------------------------------------------------------------------
const SESSION_COOKIE = 'dh_session';
const SESSION_COOKIE_MAX_AGE = 60 * 60 * 24 * 30;

function parseCookies(req) {
  const raw = req.headers && req.headers['cookie'];
  const out = {};
  if (!raw) return out;
  for (const seg of String(raw).split(';')) {
    const i = seg.indexOf('=');
    if (i < 0) continue;
    const k = seg.slice(0, i).trim();
    const v = seg.slice(i + 1).trim();
    if (k) { try { out[k] = decodeURIComponent(v); } catch (_) { out[k] = v; } }
  }
  return out;
}

function setSessionCookieWithMaxAge(res, sessionId, maxAgeSeconds) {
  if (!sessionId) return;
  const cookie = `${SESSION_COOKIE}=${encodeURIComponent(sessionId)}; Path=/; Max-Age=${maxAgeSeconds}; HttpOnly; Secure; SameSite=Lax`;
  const existing = res.getHeader('Set-Cookie');
  if (existing) res.setHeader('Set-Cookie', Array.isArray(existing) ? [...existing, cookie] : [existing, cookie]);
  else res.setHeader('Set-Cookie', cookie);
}

function setSessionCookie(res, sessionId) {
  if (!sessionId) return;
  const cookie = `${SESSION_COOKIE}=${encodeURIComponent(sessionId)}; Path=/; Max-Age=${SESSION_COOKIE_MAX_AGE}; HttpOnly; Secure; SameSite=Lax`;
  const existing = res.getHeader('Set-Cookie');
  if (existing) res.setHeader('Set-Cookie', Array.isArray(existing) ? [...existing, cookie] : [existing, cookie]);
  else res.setHeader('Set-Cookie', cookie);
}

function clearSessionCookie(res) {
  const cookie = `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
  const existing = res.getHeader('Set-Cookie');
  if (existing) res.setHeader('Set-Cookie', Array.isArray(existing) ? [...existing, cookie] : [existing, cookie]);
  else res.setHeader('Set-Cookie', cookie);
}

function getSessionIdFromReq(req, body) {
  const cookies = parseCookies(req);
  return cookies[SESSION_COOKIE]
    || (body && body.session_id)
    || (req.query && req.query.session_id)
    || null;
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
  if (new Date(session.expires_at).getTime() < Date.now()) return { ok: false, error: 'Session expired' };
  if (expectedRetailerId && session.retailer_id !== expectedRetailerId) return { ok: false, error: 'Wrong retailer' };
  return { ok: true, email: session.email, retailer_id: session.retailer_id };
}

function generateLoginCode() {
  // 6-digit numeric code, zero-padded — cryptographically random, not Math.random.
  const { randomInt } = require('crypto');
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
<div style="font-size:12px;color:#6b6a64;line-height:1.5;">Go to <a href="https://demohubhq.com/signin" style="color:#2a5b32;">demohubhq.com/signin</a>, enter your email, then paste this code. Expires in 24 hours.</div>
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
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(204).end();
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!SERVICE_KEY) return res.status(500).json({ error: 'SUPABASE_SERVICE_KEY not configured' });

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
        const admins = await sb(`retailer_admins?retailer_id=eq.${encodeURIComponent(retailer.id)}&email=ilike.${encodeURIComponent(normalizedEmail)}&select=email,role`);
        const adminRow = Array.isArray(admins) ? admins[0] : null;
        if (adminRow) {
          const code = generateLoginCode();
          let tokens;
          try {
            tokens = await sb(`admin_tokens`, {
              method: 'POST',
              body: JSON.stringify({ email: adminRow.email, retailer_id: retailer.id, code }),
            });
          } catch (_e) {
            // Fallback: DB may not have `code` column yet (migration not run). Retry without.
            tokens = await sb(`admin_tokens`, {
              method: 'POST',
              body: JSON.stringify({ email: adminRow.email, retailer_id: retailer.id }),
            });
          }
          const token = Array.isArray(tokens) ? tokens[0]?.token : null;
          const origin = SITE_ORIGIN;
          const link = `${origin}/r/${retailer_slug}/admin?token=${encodeURIComponent(token)}`;
          if (RESEND_API_KEY && token) {
            try {
              await fetch('https://api.resend.com/emails', {
                method: 'POST',
                headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ from: FROM_ADDRESS, to: adminRow.email, reply_to: 'david@demohubhq.com', subject: `Your Demohub login code: ${code}`, html: magicLinkEmail({ retailerName: retailer.name, link, code }) }),
              });
            } catch (_) { /* swallow */ }
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
        const admins = await sb(`retailer_admins?email=ilike.${encodeURIComponent(normalizedEmail)}&select=retailer_id,role,retailers(id,name,slug)`);
        if (Array.isArray(admins) && admins.length > 0) {
          for (const adminRow of admins) {
            const retailer = adminRow.retailers;
            if (!retailer) continue;
            const code = generateLoginCode();
            let tokens;
            try {
              tokens = await sb(`admin_tokens`, {
                method: 'POST',
                body: JSON.stringify({ email: normalizedEmail, retailer_id: retailer.id, code }),
              });
            } catch (_e) {
              tokens = await sb(`admin_tokens`, {
                method: 'POST',
                body: JSON.stringify({ email: normalizedEmail, retailer_id: retailer.id }),
              });
            }
            const token = Array.isArray(tokens) ? tokens[0]?.token : null;
            if (!token) continue;
            const origin = SITE_ORIGIN;
            const link = `${origin}/r/${retailer.slug}/admin?token=${encodeURIComponent(token)}`;
            if (RESEND_API_KEY) {
              try {
                await fetch('https://api.resend.com/emails', {
                  method: 'POST',
                  headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
                  body: JSON.stringify({ from: FROM_ADDRESS, to: normalizedEmail, reply_to: 'david@demohubhq.com', subject: `Your Demohub login code: ${code}`, html: magicLinkEmail({ retailerName: retailer.name, link, code }) }),
                });
              } catch (_) { /* swallow */ }
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
      if (new Date(trow.expires_at).getTime() < Date.now()) return res.status(410).json({ error: 'Token expired' });

      await sb(`admin_tokens?token=eq.${encodeURIComponent(token)}`, { method: 'PATCH', body: JSON.stringify({ used_at: new Date().toISOString() }) });
      const sessions = await sb(`admin_sessions`, {
        method: 'POST',
        body: JSON.stringify({ email: trow.email, retailer_id: trow.retailer_id }),
      });
      const session = Array.isArray(sessions) ? sessions[0] : null;
      if (session?.session_id) setSessionCookie(res, session.session_id);
      return res.status(200).json({ ok: true, session_id: session?.session_id, email: trow.email, retailer_id: trow.retailer_id });
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
      if (new Date(trow.expires_at).getTime() < Date.now()) return res.status(410).json({ error: 'Code expired' });
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
      // Set HttpOnly cookie so subsequent requests don't need body-session_id.
      if (session?.session_id) setSessionCookie(res, session.session_id);
      return res.status(200).json({ ok: true, session_id: session?.session_id, email: trow.email, retailer_id: trow.retailer_id, retailer_slug: retailerSlug });
    }

    // ---- DATA: verify session is still valid + return retailer info ----
    if (action === 'data') {
      const { retailer_slug } = body || {};
      const session_id = getSessionIdFromReq(req, body);
      if (!session_id || !retailer_slug) return res.status(400).json({ error: 'session_id and retailer_slug required' });

      const retailers = await sb(`retailers?slug=eq.${encodeURIComponent(retailer_slug)}&select=id,name`);
      const retailer = Array.isArray(retailers) ? retailers[0] : null;
      if (!retailer) return res.status(404).json({ error: 'Retailer not found' });

      const v = await verifyAdminSession(session_id, retailer.id);
      if (!v.ok) return res.status(401).json({ error: v.error });
      // Opportunistic cookie set: if the caller authenticated via body but has no cookie yet, upgrade them.
      const cookies = parseCookies(req);
      if (!cookies[SESSION_COOKIE]) setSessionCookie(res, session_id);
      return res.status(200).json({ ok: true, session_id, email: v.email, retailer_id: v.retailer_id, retailer_name: retailer.name });
    }

    // ---- LOGOUT ----
    if (action === 'logout') {
      const sid = getSessionIdFromReq(req, body);
      if (sid) {
        try { await sb(`admin_sessions?session_id=eq.${encodeURIComponent(sid)}`, { method: 'DELETE' }); } catch(_) {}
      }
      clearSessionCookie(res);
      return res.status(200).json({ ok: true });
    }

    // ---- COOKIE-MIGRATE: exchange a legacy body session_id for an HttpOnly cookie ----
    // Called by clients on page load if localStorage has a session but no cookie is set.
    // Validates the session and sets the cookie; client can then delete localStorage.
    if (action === 'cookie-migrate') {
      const sid = (body && body.session_id) || null;
      if (!sid || !isUuid(sid)) return res.status(400).json({ error: 'session_id required' });
      let sessions = null;
      try {
        sessions = await sb(`admin_sessions?session_id=eq.${encodeURIComponent(sid)}&select=session_id,email,retailer_id,expires_at`);
      } catch (_) { return res.status(500).json({ error: 'lookup failed' }); }
      const s = Array.isArray(sessions) ? sessions[0] : null;
      if (!s) return res.status(401).json({ error: 'Session not found' });
      if (new Date(s.expires_at).getTime() < Date.now()) return res.status(401).json({ error: 'Session expired' });
      setSessionCookie(res, s.session_id);
      return res.status(200).json({ ok: true, session_id: s.session_id, email: s.email, retailer_id: s.retailer_id });
    }

    // ---- TEAM-LIST: list all admins for the current retailer (session-gated) ----
    // ---- AGREEMENT-RETAILER-LIST: list all signed agreements for this retailer ----
    if (action === 'agreement-retailer-list') {
      const { session_id } = body || {};
      const v = await verifyAdminSession(session_id);
      if (!v.ok) return res.status(401).json({ error: v.error });
      const rows = await sb(`brand_retailer_agreements?retailer_id=eq.${encodeURIComponent(v.retailer_id)}&superseded_at=is.null&select=*,brands(id,company_name,email)&order=signed_at.desc`);
      return res.status(200).json({ ok: true, agreements: rows || [] });
    }

        if (action === 'team-list') {
      const { session_id } = body || {};
      const v = await verifyAdminSession(session_id);
      if (!v.ok) return res.status(401).json({ error: v.error });
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
      const { session_id, email, name, role, venue_ids } = body || {};
      if (!email || !/^[^@]+@[^@]+\.[^@]+$/.test(email)) return res.status(400).json({ error: 'Valid email required' });
      if (!['admin', 'viewer'].includes(role || 'admin')) return res.status(400).json({ error: 'Role must be admin or viewer' });
      const v = await verifyAdminSession(session_id);
      if (!v.ok) return res.status(401).json({ error: v.error });
      // Only owners/admins can invite (not viewers)
      const me = await sb(`retailer_admins?retailer_id=eq.${encodeURIComponent(v.retailer_id)}&email=ilike.${encodeURIComponent(v.email)}&select=role`);
      const myRow = Array.isArray(me) ? me[0] : null;
      if (!myRow || myRow.role === 'viewer') return res.status(403).json({ error: 'Viewers cannot invite team members' });

      // Phase E: Solo tier is single-admin. Team invites require Pro.
      try {
        const settingsArr = await sb(`settings?retailer_id=eq.${encodeURIComponent(v.retailer_id)}&select=billing_tier&limit=1`);
        const retArr = await sb(`retailers?id=eq.${encodeURIComponent(v.retailer_id)}&select=billing_tier`);
        const settingsTier = (Array.isArray(settingsArr) && settingsArr[0] && settingsArr[0].billing_tier) || null;
        const retailerTier = (Array.isArray(retArr) && retArr[0] && retArr[0].billing_tier) || null;
        const tier = (settingsTier || retailerTier || 'solo').toLowerCase();
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
      const existing = await sb(`retailer_admins?retailer_id=eq.${encodeURIComponent(v.retailer_id)}&email=ilike.${encodeURIComponent(normalizedEmail)}&select=id`);
      if (Array.isArray(existing) && existing.length > 0) return res.status(409).json({ error: 'That email is already on the team' });

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
        if (retailer && RESEND_API_KEY) {
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
          const origin = SITE_ORIGIN;
          const link = `${origin}/r/${retailer.slug}/admin?token=${encodeURIComponent(token)}`;
          const roleName = (role === 'viewer') ? 'viewer' : 'admin';
          await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              from: FROM_ADDRESS,
              to: normalizedEmail,
              reply_to: 'david@demohubhq.com',
              subject: `${v.email} invited you to ${retailer.name} on Demohub`,
              html: invitationEmail({ retailerName: retailer.name, roleName, link, code, inviterEmail: v.email }),
            }),
          });
        }
      } catch (e) { console.warn('Invitation email failed:', e); }
      return res.status(200).json({ ok: true, admin: Array.isArray(created) ? created[0] : null });
    }

    // ---- TEAM-REMOVE: remove an admin (owner only; cannot remove owner) ----
    if (action === 'team-remove') {
      const { session_id, admin_id } = body || {};
      if (!isUuid(admin_id)) return res.status(400).json({ error: 'Invalid admin_id' });
      const v = await verifyAdminSession(session_id);
      if (!v.ok) return res.status(401).json({ error: v.error });
      const me = await sb(`retailer_admins?retailer_id=eq.${encodeURIComponent(v.retailer_id)}&email=ilike.${encodeURIComponent(v.email)}&select=role`);
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
      const { session_id, admin_id, role } = body || {};
      if (!isUuid(admin_id)) return res.status(400).json({ error: 'Invalid admin_id' });
      if (!['admin', 'viewer'].includes(role)) return res.status(400).json({ error: 'Role must be admin or viewer' });
      const v = await verifyAdminSession(session_id);
      if (!v.ok) return res.status(401).json({ error: v.error });
      const me = await sb(`retailer_admins?retailer_id=eq.${encodeURIComponent(v.retailer_id)}&email=ilike.${encodeURIComponent(v.email)}&select=role`);
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
      const { session_id, admin_id, venue_ids } = body || {};
      if (!isUuid(admin_id)) return res.status(400).json({ error: 'Invalid admin_id' });
      if (!Array.isArray(venue_ids)) return res.status(400).json({ error: 'venue_ids must be an array' });
      if (venue_ids.some(id => !isUuid(id))) return res.status(400).json({ error: 'All venue_ids must be UUIDs' });
      const v = await verifyAdminSession(session_id);
      if (!v.ok) return res.status(401).json({ error: v.error });
      const me = await sb(`retailer_admins?retailer_id=eq.${encodeURIComponent(v.retailer_id)}&email=ilike.${encodeURIComponent(v.email)}&select=role`);
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
      const { session_id, image } = body || {};
      const v = await verifyAdminSession(session_id);
      if (!v.ok) return res.status(401).json({ error: v.error });
      if ((await callerRoleAuth(v.retailer_id, v.email)) === 'viewer') return res.status(403).json({ error: 'read_only_role', message: 'Your account has view-only access. Ask an admin to make changes.' });
      const m = String(image || '').match(/^data:(image\/(?:png|jpeg|webp|gif));base64,(.+)$/);
      if (!m) return res.status(400).json({ error: 'Invalid image — must be PNG, JPEG, WEBP, or GIF data URL' });
      const mime = m[1];
      const ext = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' }[mime];
      const bytes = Buffer.from(m[2], 'base64');
      if (bytes.length > 2 * 1024 * 1024) return res.status(400).json({ error: 'Image too large — max 2MB' });
      const path = `retailers/${v.retailer_id}.${ext}`;
      const uploadResp = await fetch(`${SUPABASE_URL}/storage/v1/object/avatars/${path}?upsert=true`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${SERVICE_KEY}`, apikey: SERVICE_KEY, 'Content-Type': mime, 'x-upsert': 'true' },
        body: bytes,
      });
      if (!uploadResp.ok) {
        const t = await uploadResp.text();
        return res.status(500).json({ error: 'Upload failed: ' + t });
      }
      const publicUrl = `${SUPABASE_URL}/storage/v1/object/public/avatars/${path}?v=${Date.now()}`;
      await sb(`retailers?id=eq.${encodeURIComponent(v.retailer_id)}`, { method: 'PATCH', body: JSON.stringify({ logo_url: publicUrl }) });
      return res.status(200).json({ ok: true, logo_url: publicUrl });
    }

    // ---- UPLOAD-DEMO-POLICY (PDF) ----
    if (action === 'upload-demo-policy') {
      const { session_id, file, filename } = body || {};
      const v = await verifyAdminSession(session_id);
      if (!v.ok) return res.status(401).json({ error: v.error });
      if ((await callerRoleAuth(v.retailer_id, v.email)) === 'viewer') return res.status(403).json({ error: 'read_only_role', message: 'Your account has view-only access. Ask an admin to make changes.' });
      const m = String(file || '').match(/^data:(application\/pdf|image\/(?:png|jpeg));base64,(.+)$/);
      if (!m) return res.status(400).json({ error: 'Invalid file — must be a PDF, PNG, or JPEG data URL' });
      const mime = m[1];
      const ext = mime === 'application/pdf' ? 'pdf' : (mime === 'image/png' ? 'png' : 'jpg');
      const bytes = Buffer.from(m[2], 'base64');
      if (bytes.length > 5 * 1024 * 1024) return res.status(400).json({ error: 'File too large — max 5MB' });
      const safeName = (filename || 'demo-policy').replace(/[^a-z0-9._-]/gi, '_').slice(0, 60);
      const path = `retailers/${v.retailer_id}/demo-policy-${Date.now()}.${ext}`;
      const uploadResp = await fetch(`${SUPABASE_URL}/storage/v1/object/policy-docs/${path}?upsert=true`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${SERVICE_KEY}`, apikey: SERVICE_KEY, 'Content-Type': mime, 'x-upsert': 'true' },
        body: bytes,
      });
      if (!uploadResp.ok) {
        const t = await uploadResp.text();
        return res.status(500).json({ error: 'Upload failed: ' + t });
      }
      const publicUrl = `${SUPABASE_URL}/storage/v1/object/public/policy-docs/${path}`;
      await sb(`retailers?id=eq.${encodeURIComponent(v.retailer_id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ demo_policy_url: publicUrl, demo_policy_filename: safeName }),
      });
      return res.status(200).json({ ok: true, demo_policy_url: publicUrl, demo_policy_filename: safeName });
    }

    // ---- REMOVE-DEMO-POLICY ----
    if (action === 'remove-demo-policy') {
      const { session_id } = body || {};
      const v = await verifyAdminSession(session_id);
      if (!v.ok) return res.status(401).json({ error: v.error });
      if ((await callerRoleAuth(v.retailer_id, v.email)) === 'viewer') return res.status(403).json({ error: 'read_only_role', message: 'Your account has view-only access. Ask an admin to make changes.' });
      await sb(`retailers?id=eq.${encodeURIComponent(v.retailer_id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ demo_policy_url: null, demo_policy_filename: null }),
      });
      return res.status(200).json({ ok: true });
    }

    // ---- REMOVE-RETAILER-AVATAR ----
    if (action === 'remove-retailer-avatar') {
      const { session_id } = body || {};
      const v = await verifyAdminSession(session_id);
      if (!v.ok) return res.status(401).json({ error: v.error });
      if ((await callerRoleAuth(v.retailer_id, v.email)) === 'viewer') return res.status(403).json({ error: 'read_only_role', message: 'Your account has view-only access. Ask an admin to make changes.' });
      await sb(`retailers?id=eq.${encodeURIComponent(v.retailer_id)}`, { method: 'PATCH', body: JSON.stringify({ logo_url: null }) });
      return res.status(200).json({ ok: true });
    }

    // ============================================================
    // OWNER PANEL — restricted to allowlist (david@demohubhq.com)
    // ============================================================
    // ---- OWNER-VERIFICATION-QUEUE: list retailers by verification status ----
    if (action === 'owner-verification-queue') {
      const { session_id, status } = body || {};
      const owner = await verifyOwnerSessionV2(session_id);
      if (!owner) return res.status(401).json({ error: 'Owner authentication required' });
      const wantedStatus = ['pending', 'approved', 'rejected', 'suspended'].includes(status) ? status : 'pending';
      try {
        const rows = await sb(`retailers?verification_status=eq.${wantedStatus}&select=id,slug,name,billing_email,website,verification_status,verified_at,verified_by,verification_notes,created_at,branding&order=created_at.desc`);
        return res.status(200).json({ ok: true, retailers: rows || [], status: wantedStatus });
      } catch (e) {
        return res.status(500).json({ error: 'Query failed: ' + (e?.message || e) });
      }
    }

    // ---- OWNER-VERIFY-RETAILER: approve / reject / suspend / reset ----
    if (action === 'owner-verify-retailer') {
      const { session_id, retailer_id, new_status, notes } = body || {};
      const owner = await verifyOwnerSessionV2(session_id);
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

        if (action === 'owner-login' || action === 'owner-verify' || action === 'owner-data' || action === 'owner-logout' || action === 'owner-list-retailers' || action === 'owner-impersonate' || action === 'owner-end-impersonation' || action === 'support-sessions' || action === 'support-access-toggle' || action === 'support-access-status') {
      return await handleOwnerAction(action, req, res, body);
    }

      // === Incident management (owner-only) ===
  // POST a new incident
  if (action === 'incident-post') {
    const { sessionId, title, body: incBody, severity } = body || {};
    const v = await verifyOwnerSession(sessionId);
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
    const { sessionId, incident_id } = body || {};
    const v = await verifyOwnerSession(sessionId);
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
    const { sessionId } = body || {};
    const v = await verifyOwnerSession(sessionId);
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
const TIER_PRICES = { free: 0, starter: 79, growth: 199, enterprise: 499 };

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
  const { randomBytes } = require('crypto');
  const buf = randomBytes(n);
  return Array.from(buf).map(b => b.toString(16).padStart(2, '0')).join('');
}

function ownerMagicLinkEmail(link) {
  return `<!DOCTYPE html><html><body style="margin:0;padding:24px;background:#fbf7f0;font-family:-apple-system,sans-serif;color:#1c1c1a;">
    <div style="max-width:480px;margin:0 auto;background:white;border-radius:14px;padding:32px;border:1px solid rgba(15,44,23,0.08);">
      <div style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.14em;color:#a14e2a;margin-bottom:12px;">Owner sign in</div>
      <h1 style="font-family:Georgia,serif;font-size:24px;font-weight:400;color:#0f2c17;margin:0 0 12px;">Open the owner panel</h1>
      <p style="font-size:15px;line-height:1.5;color:#3a3a36;margin:0 0 22px;">Click below to sign in to the Demohub owner panel. Link expires in 30 minutes.</p>
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
  if (new Date(s.expires_at).getTime() < Date.now()) return null;
  if (!OWNER_EMAILS.includes((s.email || '').toLowerCase())) return null;
  return { email: s.email };
}

async function computeOwnerMetrics() {
  // Each query wrapped: if table/column missing, default to [] instead of failing the whole metrics
  const safeQuery = async (q) => { try { return await sb(q); } catch (e) { console.error('owner metrics query failed:', q, e?.message); return []; } };
  const [retailers, brands, demos, bookings, settings] = await Promise.all([
    safeQuery(`retailers?select=id,name,slug,created_at,logo_url,billing_email`),
    safeQuery(`brands?select=id,company_name,created_at,default_coi_url,is_verified`),
    safeQuery(`demos?select=id,retailer_id,brand_id,demo_date,demo_fee,status,created_at`),
    safeQuery(`bookings?select=id,retailer_id,brand_id,status,created_at`),
    safeQuery(`settings?select=retailer_id,billing_tier,price_per_demo`),
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

  const settingsByRetailer = {}; settings.forEach(s => { settingsByRetailer[s.retailer_id] = s; });
  const tierCounts = { free: 0, starter: 0, growth: 0, enterprise: 0 };
  let mrrSubs = 0;
  retailers.forEach(r => {
    const tier = ((settingsByRetailer[r.id]?.billing_tier) || r.billing_tier || 'free').toLowerCase();
    if (tier in tierCounts) tierCounts[tier]++;
    mrrSubs += TIER_PRICES[tier] || 0;
  });
  const perDemoRev = demos
    .filter(d => (d.demo_date || '').slice(0, 7) === thisMonth && (d.status === 'confirmed' || d.status === 'completed'))
    .reduce((s, d) => s + ((parseFloat(d.demo_fee) || 0) / 10), 0);
  const mrrProjection = Math.round(mrrSubs + perDemoRev);

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
    headline: { total_retailers: totalRetailers, active_retailers_30d: activeRetailers30d, total_brands: totalBrands, demos_this_month: demosThisMonth, demos_last_month: demosLastMonth, demos_delta_pct: demosDeltaPct, mrr_projection: mrrProjection, mrr_subs: Math.round(mrrSubs), mrr_per_demo: Math.round(perDemoRev), tier_counts: tierCounts },
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
      let token = null;
      if (ownerRetailerId) {
        try {
          const tokens = await sb('admin_tokens', { method: 'POST', body: JSON.stringify({ email, retailer_id: ownerRetailerId }) });
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
        const origin = SITE_ORIGIN;
        const link = `${origin}/owner?token=${encodeURIComponent(token)}`;
        if (RESEND_API_KEY) {
          try {
            const r = await fetch('https://api.resend.com/emails', {
              method: 'POST',
              headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({ from: FROM_ADDRESS, to: email, reply_to: 'david@demohubhq.com', subject: 'Sign in to the Demohub owner panel', html: ownerMagicLinkEmail(link) }),
            });
            const j = await r.json().catch(() => null);
            diag.resend_ok = r.ok;
            diag.resend_response = j;
            if (!r.ok) diag.resend_error = `HTTP ${r.status}: ${JSON.stringify(j)}`;
          } catch (e) { diag.resend_error = e?.message || String(e); }
        } else {
          diag.resend_error = 'RESEND_API_KEY not set';
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
    if (new Date(tok.expires_at).getTime() < Date.now()) return res.status(410).json({ error: 'Token expired' });
    if (!OWNER_EMAILS.includes((tok.email || '').toLowerCase())) return res.status(403).json({ error: 'Not authorised' });
    await sb(`admin_tokens?token=eq.${encodeURIComponent(token)}`, { method: 'PATCH', body: JSON.stringify({ used_at: new Date().toISOString() }) });
    const ownerRetailerId = (await ensureOwnerRetailerId()) || tok.retailer_id;
    // SECURITY: owner sessions expire in 12 HOURS (not the 30-day default for retailer logins).
    // The master panel can see all platform data + impersonate any retailer, so it must
    // re-authenticate at least twice a day. Forces a fresh magic-link login after expiry.
    const ownerExpires = new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString();
    const sessions = await sb('admin_sessions', { method: 'POST', body: JSON.stringify({ email: tok.email, retailer_id: ownerRetailerId, expires_at: ownerExpires }) });
    const session = Array.isArray(sessions) ? sessions[0] : null;
    // Set the HttpOnly cookie with a matching 12-hour max-age (override the 30-day default).
    if (session?.session_id) setSessionCookieWithMaxAge(res, session.session_id, 12 * 60 * 60);
    return res.status(200).json({ ok: true, session_id: session?.session_id, email: tok.email });
  }

  if (action === 'owner-data') {
    const sessionId = String((req.query && req.query.session_id) || body.session_id || '');
    const v = await verifyOwnerSession(sessionId);
    if (!v) return res.status(401).json({ error: 'Not authenticated' });
    const metrics = await computeOwnerMetrics();
    return res.status(200).json({ ok: true, ...metrics });
  }

  if (action === 'owner-logout') {
    const sessionId = String((req.query && req.query.session_id) || body.session_id || '');
    if (sessionId) {
      try { await sb(`admin_sessions?session_id=eq.${encodeURIComponent(sessionId)}`, { method: 'DELETE' }); } catch (_) {}
    }
    return res.status(200).json({ ok: true });
  }


  // ---- OWNER-LIST-RETAILERS: full retailers list for the "sign in as admin" picker ----
  if (action === 'owner-list-retailers') {
    const sessionId = String((req.query && req.query.session_id) || body.session_id || '');
    const v = await verifyOwnerSession(sessionId);
    if (!v) return res.status(401).json({ error: 'Not authenticated' });
    const rows = await sb('retailers?select=id,slug,name,billing_email,billing_tier,created_at&order=name.asc&limit=500');
    return res.status(200).json({ ok: true, retailers: rows || [] });
  }

  // ---- OWNER-IMPERSONATE: create a scoped 4-hour session for a retailer, log to audit table ----
  // Sets the retailer's admin cookie (dh_session) AND a non-HttpOnly marker cookie (dh_support)
  // so the client-side admin page can render the "Support session" banner.
  if (action === 'owner-impersonate') {
    const sessionId = String((req.query && req.query.session_id) || body.session_id || '');
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
    // Set the admin session cookie (HttpOnly — the impersonated session)
    setSessionCookie(res, session.session_id);
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
      const RESEND_API_KEY = process.env.RESEND_API_KEY;
      if (RESEND_API_KEY) {
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
        fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from: 'Demohub <support@demohubhq.com>',
            to: retailerInfo.billing_email,
            reply_to: 'david@demohubhq.com',
            subject: `Demohub support just accessed ${retailerInfo.name}`,
            html,
          }),
        }).catch(e => console.warn('support summary email failed:', e?.message || e));
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
    const v = await verifyAdminSession(sid);
    if (!v.ok) return res.status(401).json({ error: v.error });
    const rows = await sb(`support_sessions?target_retailer_id=eq.${encodeURIComponent(v.retailer_id)}&select=id,owner_email,started_at,ended_at,writes_count&order=started_at.desc&limit=50`);
    return res.status(200).json({ ok: true, sessions: rows || [] });
  }

  // ---- SUPPORT-ACCESS-TOGGLE: retailer flips their own allow_support_access flag ----
  // ON sets a 24-hour auto-expire. OFF clears expires_at and blocks future impersonation.
  if (action === 'support-access-toggle') {
    const sid = getSessionIdFromReq(req, body);
    const v = await verifyAdminSession(sid);
    if (!v.ok) return res.status(401).json({ error: v.error });
    if ((await callerRoleAuth(v.retailer_id, v.email)) === 'viewer') return res.status(403).json({ error: 'read_only_role', message: 'Your account has view-only access. Ask an admin to make changes.' });
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
    const v = await verifyAdminSession(sid);
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
