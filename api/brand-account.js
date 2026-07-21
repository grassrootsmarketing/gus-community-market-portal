// /api/brand-account
// Magic-link auth + profile CRUD for cross-retailer brand accounts.
// Actions: signup, login, verify, data, profile-update, demos, logout, cron
// Privacy: NEVER expose brand_id to retailer-side endpoints. All retailer
// admin queries continue to filter by retailer_id only.

const SUPABASE_URL = 'https://ecapmcyumpjjgjwuokyv.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const CRON_SECRET = process.env.CRON_SECRET;
const FROM_EMAIL = 'Demohub <noreply@demohubhq.com>';
const FROM_BOOKINGS = 'Demohub <bookings@demohubhq.com>';
const REPLY_TO = 'david@demohubhq.com';

function jsonResp(res, status, body) {
  res.setHeader('Content-Type', 'application/json');
  res.status(status).end(JSON.stringify(body));
}
function readBody(req) {
  return new Promise((resolve) => {
    if (req.body && typeof req.body === 'object') return resolve(req.body);
    let data = '';
    req.on('data', c => data += c);
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch { resolve({}); } });
  });
}
function escapeText(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function randomToken(n = 32) {
  const buf = new Uint8Array(n);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) crypto.getRandomValues(buf);
  else for (let i = 0; i < n; i++) buf[i] = Math.floor(Math.random() * 256);
  return Array.from(buf).map(b => b.toString(16).padStart(2, '0')).join('');
}
async function sb(path, opts = {}) {
  return fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...opts,
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: opts.method === 'POST' ? 'return=representation' : (opts.headers?.Prefer || ''),
      ...(opts.headers || {}),
    },
  });
}

// -----------------------------------------------------------------------------
// Rate limit — fail-closed. Denies on DB errors so a Supabase blip cannot
// NOTE: these are OUR abuse controls, not Resend's quota. /login is unauthenticated and sends
// email to any address submitted, so an uncapped endpoint lets anyone inbox-bomb a stranger.
// Per-EMAIL caps are the real control; per-IP caps are deliberately loose because mobile
// carriers and offices NAT many legitimate users behind one address. turn
// into an unbounded magic-link-email spam window.
// -----------------------------------------------------------------------------
function clientIpForRateLimit(req) {
  // x-real-ip is set by Vercel and not client-overridable; the LAST x-forwarded-for hop is
  // Vercel's. cf-connecting-ip is NOT trusted — we are not behind Cloudflare, so it is
  // purely attacker-supplied and previously let every rate limit be bypassed.
  const xff = (req.headers['x-forwarded-for'] || '').toString().split(',').map(x => x.trim()).filter(Boolean);
  return req.headers['x-real-ip'] || xff[xff.length - 1] || req.socket?.remoteAddress || 'unknown';
}

// Rate limit keyed ONLY on the given identifier (no IP). This is the unspoofable cap on
// login-code guesses per account — the IP-appended checkRateLimit below cannot provide it.
async function checkRateLimitByKey(fullKey, maxPerHour) {
  try {
    const windowStart = new Date(Math.floor(Date.now() / 3600000) * 3600000).toISOString();
    const existingResp = await sb(`rate_limit?bucket_key=eq.${encodeURIComponent(fullKey)}&window_start=eq.${encodeURIComponent(windowStart)}&select=id,count`);
    const existing = await existingResp.json().catch(() => []);
    const row = Array.isArray(existing) && existing[0];
    if (row && row.count >= maxPerHour) return { allowed: false };
    if (row) await sb(`rate_limit?id=eq.${row.id}`, { method: 'PATCH', body: JSON.stringify({ count: row.count + 1 }) });
    else await sb('rate_limit', { method: 'POST', body: JSON.stringify({ bucket_key: fullKey, window_start: windowStart, count: 1 }) });
    return { allowed: true };
  } catch (e) {
    console.error('brand per-key rate limit failed - denying:', e?.message || e);
    return { allowed: false, error: 'rate_limit_unavailable' };
  }
}

async function checkRateLimit(req, bucketKey, maxPerHour) {
  try {
    const ip = clientIpForRateLimit(req);
    const key = bucketKey + ':' + ip;
    const windowStart = new Date(Math.floor(Date.now() / 3600000) * 3600000).toISOString();
    const existingResp = await sb(`rate_limit?bucket_key=eq.${encodeURIComponent(key)}&window_start=eq.${encodeURIComponent(windowStart)}&select=id,count`);
    const existing = await existingResp.json().catch(() => []);
    const row = Array.isArray(existing) && existing[0];
    if (row && row.count >= maxPerHour) return { allowed: false };
    if (row) await sb(`rate_limit?id=eq.${row.id}`, { method: 'PATCH', body: JSON.stringify({ count: row.count + 1 }) });
    else await sb('rate_limit', { method: 'POST', body: JSON.stringify({ bucket_key: key, window_start: windowStart, count: 1 }) });
    return { allowed: true };
  } catch (e) {
    console.error('brand-account rate limit failed - denying:', e?.message || e);
    return { allowed: false, error: 'rate_limit_unavailable' };
  }
}

// -----------------------------------------------------------------------------
// HttpOnly cookie for BRAND sessions (dh_brand_session, distinct from dh_session
// used by retailers). Same invariants: HttpOnly, Secure, SameSite=Lax.
// -----------------------------------------------------------------------------
const BRAND_SESSION_COOKIE = 'dh_brand_session';
const BRAND_SESSION_COOKIE_MAX_AGE = 60 * 60 * 24 * 30;

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

function setBrandSessionCookie(res, token) {
  if (!token) return;
  const cookie = `${BRAND_SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; Max-Age=${BRAND_SESSION_COOKIE_MAX_AGE}; HttpOnly; Secure; SameSite=Lax`;
  const existing = res.getHeader('Set-Cookie');
  if (existing) res.setHeader('Set-Cookie', Array.isArray(existing) ? [...existing, cookie] : [existing, cookie]);
  else res.setHeader('Set-Cookie', cookie);
}

function clearBrandSessionCookie(res) {
  const cookie = `${BRAND_SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
  const existing = res.getHeader('Set-Cookie');
  if (existing) res.setHeader('Set-Cookie', Array.isArray(existing) ? [...existing, cookie] : [existing, cookie]);
  else res.setHeader('Set-Cookie', cookie);
}

// -----------------------------------------------------------------------------
// Password hashing (Node stdlib scrypt — no npm dependency).
// Storage format: <salt_hex>$<hash_hex>. Salt is 16 bytes, hash is 64 bytes.
// scrypt cost params are Node defaults (N=16384, r=8, p=1).
// -----------------------------------------------------------------------------
async function hashPassword(password) {
  const { randomBytes, scrypt } = require('crypto');
  const salt = randomBytes(16);
  return new Promise((resolve, reject) => {
    scrypt(password, salt, 64, (err, derivedKey) => {
      if (err) return reject(err);
      resolve(salt.toString('hex') + '$' + derivedKey.toString('hex'));
    });
  });
}

async function verifyPassword(password, storedHash) {
  if (!storedHash || typeof storedHash !== 'string' || !storedHash.includes('$')) return false;
  const [saltHex, hashHex] = storedHash.split('$');
  if (!saltHex || !hashHex) return false;
  const { scrypt, timingSafeEqual } = require('crypto');
  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(hashHex, 'hex');
  return new Promise((resolve) => {
    scrypt(password, salt, 64, (err, derivedKey) => {
      if (err) return resolve(false);
      try { resolve(derivedKey.length === expected.length && timingSafeEqual(derivedKey, expected)); }
      catch (_) { resolve(false); }
    });
  });
}

function generateLoginCode() {
  // 6-digit numeric code, zero-padded, cryptographically random.
  const { randomInt } = require('crypto');
  const n = randomInt(0, 1000000);
  return String(n).padStart(6, '0');
}

function getBrandSessionFromReq(req, body) {
  const cookies = parseCookies(req);
  return cookies[BRAND_SESSION_COOKIE]
    || (body && body.session_id)
    || (body && body.session_token)
    || (req.query && req.query.session_id)
    || (req.query && req.query.session_token)
    || null;
}
async function sendMagicLink(email, link, isNew, code) {
  if (!RESEND_API_KEY) { console.warn('RESEND_API_KEY missing — printing link to logs'); console.log('MAGIC LINK:', link, code ? '  CODE:' + code : ''); return; }
  const subject = isNew ? 'Welcome to Demohub — verify your brand account' : 'Sign in to your Demohub brand account';
  const codeBlock = code ? `
      <div style="background:#fbf7f0;border:1.5px solid #ede3d0;border-radius:12px;padding:20px 24px;margin:0 0 24px;text-align:center;">
        <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.12em;color:#a14e2a;margin-bottom:8px;">Your sign-in code</div>
        <div style="font-family:'SFMono-Regular',Menlo,Monaco,Consolas,monospace;font-size:32px;font-weight:700;letter-spacing:0.15em;color:#0f2c17;">${code}</div>
        <div style="font-size:12px;color:#6b6a64;margin-top:10px;">Enter this on the screen where you asked to sign in. Best on a phone, where a link can open in the wrong browser.</div>
      </div>
      <p style="font-size:14px;color:#6b6a64;margin:0 0 14px;text-align:center;">— or —</p>
  ` : '';
  const body = `
    <div style="font-family:-apple-system,sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;color:#1c1c1a;">
      <h1 style="font-family:Georgia,serif;font-weight:400;font-size:28px;margin:0 0 12px;">${isNew ? 'Welcome to Demohub.' : 'Sign in to your brand account.'}</h1>
      <p style="font-size:16px;line-height:1.5;margin:0 0 24px;color:#3a3a36;">${code ? 'Type this code into the tab you already have open. Expires in 30 minutes.' : (isNew ? 'One profile that follows you to every Demohub retailer.' : 'Use the link below to sign in.')} ${code ? '' : 'Link expires in 30 minutes.'}</p>
      ${codeBlock}
      <a href="${link}" style="display:inline-block;background:${code ? 'transparent' : '#0f2c17'};color:${code ? '#2a5b32' : 'white'};${code ? 'border:1.5px solid rgba(15,44,23,0.2);' : ''}padding:${code ? '11px 22px' : '14px 28px'};border-radius:99px;text-decoration:none;font-weight:600;font-size:${code ? '14px' : '15px'};">${code ? 'Or sign in with this link' : (isNew ? 'Verify and continue' : 'Sign in via link')}</a>
      <p style="font-size:13px;color:#6b6a64;margin-top:32px;">If you didn't request this, you can safely ignore the email.</p>
    </div>
  `;
  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: FROM_EMAIL, to: email, subject, html: body, reply_to: REPLY_TO }),
  });
}
async function verifySession(sessionToken) {
  if (!sessionToken) return null;
  const r = await sb(`brand_account_sessions?session_token=eq.${encodeURIComponent(sessionToken)}&select=brand_id,email,expires_at`);
  const rows = await r.json();
  const s = Array.isArray(rows) ? rows[0] : null;
  if (!s) return null;
  if (new Date(s.expires_at).getTime() < Date.now()) return null;
  return s.brand_id;
}
async function verifySessionFull(sessionToken) {
  if (!sessionToken) return null;
  const r = await sb(`brand_account_sessions?session_token=eq.${encodeURIComponent(sessionToken)}&select=brand_id,email,expires_at`);
  const rows = await r.json();
  const s = Array.isArray(rows) ? rows[0] : null;
  if (!s) return null;
  if (new Date(s.expires_at).getTime() < Date.now()) return null;
  return { brand_id: s.brand_id, email: s.email };
}

// ===== Welcome series email templates =====

function brandDay0Email({ first_name, brand_name, example_retailer_url }) {
  const fn = escapeText(first_name || 'there');
  const bn = escapeText(brand_name || 'your brand');
  const ex = escapeText(example_retailer_url || 'https://demohubhq.com/r/gus');
  const htmlBody = `<!DOCTYPE html><html><body style="margin:0;padding:24px;background:#fbf7f0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,sans-serif;color:#1c1c1a;">
<table align="center" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;background:white;border-radius:16px;overflow:hidden;border:1px solid rgba(15,44,23,0.08);">
<tr><td style="padding:28px 32px;background:#0f2c17;">
<table cellpadding="0" cellspacing="0"><tr>
<td style="padding-right:12px;vertical-align:middle;">
<svg width="40" height="40" viewBox="0 0 72 72" xmlns="http://www.w3.org/2000/svg"><circle cx="36" cy="36" r="36" fill="#0f2c17"/><circle cx="36" cy="40" r="18" fill="#ed682f"/><rect x="34.5" y="14" width="3" height="10" rx="1.2" fill="#fbf3e0"/><path d="M37 17 Q45 14 48 20 Q44 22 38 21 Q35 19 37 17 Z" fill="#87b08e"/></svg>
</td><td style="font-weight:800;font-size:24px;color:#fbf7f0;letter-spacing:-0.04em;">demohub</td>
</tr></table>
</td></tr>
<tr><td style="padding:36px 36px 28px;font-size:15px;line-height:1.6;color:#3a3a36;">
<p style="margin:0 0 14px;">Hi ${fn},</p>
<p style="margin:0 0 14px;">You're in. Your ${bn} brand profile is live: <strong><a href="https://demohubhq.com/brand/dashboard" style="color:#2a5b32;">https://demohubhq.com/brand/dashboard</a></strong></p>
<p style="margin:0 0 14px;">Here's the idea: you fill out your info once, and that profile follows you to every Demohub retailer. No more re-typing your COI details into the third clipboard at the third store this month.</p>
<p style="margin:0 0 8px;">Two things to do now so your next booking pre-fills cleanly:</p>
<ol style="margin:0 0 18px;padding-left:22px;">
<li style="margin-bottom:6px;"><strong>Upload your Certificate of Insurance.</strong> It attaches automatically to every demo you book at every Demohub retailer. (Profile &rarr; Compliance &rarr; upload.)</li>
<li style="margin-bottom:6px;"><strong>Fill in the rest of your profile</strong> &mdash; phone, website, product categories, and what you typically demo. (Profile &rarr; Contact + Product.)</li>
</ol>
<p style="margin:0 0 14px;">Once that's done, when you visit a Demohub retailer's booking page &mdash; like <a href="${ex}" style="color:#2a5b32;">${ex}</a> &mdash; your info pre-fills. Hit submit and you're done.</p>
<p style="margin:0 0 14px;">If you have a Demohub retailer you already work with, send them your way and they can confirm your next demo in two clicks.</p>
<p style="margin:0 0 14px;">Free forever for brands. Always.</p>
<p style="margin:0 0 4px;">Welcome,<br>David<br>Demohub</p>
</td></tr>
<tr><td style="padding:20px 32px;background:#fbf7f0;border-top:1px solid rgba(15,44,23,0.06);font-size:12px;color:#6b6a64;text-align:center;">Demohub LLC &middot; 6700 Fallbrook Ave #125, West Hills, CA 91307<br>You\'re receiving this because you have a Demohub account or recently took an action on demohubhq.com.</td></tr>
</table></body></html>`;
  const text = `Hi ${first_name || 'there'},\n\nYou're in. Your ${brand_name || 'your brand'} brand profile is live: https://demohubhq.com/brand/dashboard\n\nHere's the idea: you fill out your info once, and that profile follows you to every Demohub retailer.\n\nTwo things to do now:\n1. Upload your COI (Profile -> Compliance).\n2. Fill in the rest of your profile (Profile -> Contact + Product).\n\nFree forever for brands. Always.\n\nWelcome,\nDavid\nDemohub`;
  const subject = `Welcome to Demohub, ${first_name || 'there'} — one profile for every retailer`;
  return { subject, html: htmlBody, text };
}

function retailerDay3Email({ first_name }) {
  const fn = escapeText(first_name || 'there');
  const htmlBody = `<!DOCTYPE html><html><body style="margin:0;padding:24px;background:#fbf7f0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,sans-serif;color:#1c1c1a;">
<table align="center" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;background:white;border-radius:16px;overflow:hidden;border:1px solid rgba(15,44,23,0.08);">
<tr><td style="padding:28px 32px;background:#0f2c17;">
<table cellpadding="0" cellspacing="0"><tr>
<td style="padding-right:12px;vertical-align:middle;">
<svg width="40" height="40" viewBox="0 0 72 72" xmlns="http://www.w3.org/2000/svg"><circle cx="36" cy="36" r="36" fill="#0f2c17"/><circle cx="36" cy="40" r="18" fill="#ed682f"/><rect x="34.5" y="14" width="3" height="10" rx="1.2" fill="#fbf3e0"/><path d="M37 17 Q45 14 48 20 Q44 22 38 21 Q35 19 37 17 Z" fill="#87b08e"/></svg>
</td><td style="font-weight:800;font-size:24px;color:#fbf7f0;letter-spacing:-0.04em;">demohub</td>
</tr></table>
</td></tr>
<tr><td style="padding:36px 36px 28px;font-size:15px;line-height:1.6;color:#3a3a36;">
<p style="margin:0 0 14px;">Hi ${fn},</p>
<p style="margin:0 0 14px;">It's been a few days since you joined Demohub. Wanted to check in.</p>
<p style="margin:0 0 8px;">A couple of things I see most retailers ask in the first week:</p>
<ul style="margin:0 0 18px;padding-left:22px;">
<li style="margin-bottom:8px;"><strong>"How do I price demos?"</strong> Most start at $30 per slot. You'll see it round to $3 per demo on your Demohub bill &mdash; and you can change it any time, per store.</li>
<li style="margin-bottom:8px;"><strong>"Can I share my booking link on Instagram?"</strong> Yep. Drop the link in your bio or a story &mdash; brands can submit a request without ever calling you.</li>
<li style="margin-bottom:8px;"><strong>"How does the calendar sync work?"</strong> Copy the iCal URL from Settings &rarr; Calendar feed and paste it into Google Calendar, Apple Calendar, or Outlook.</li>
</ul>
<p style="margin:0 0 14px;">If you want a 20-minute walkthrough where I show you how to set up venues, manage team access, and review your first booking, grab a slot here: <a href="https://calendly.com/demohubhq/walkthrough" style="color:#2a5b32;">calendly.com/demohubhq/walkthrough</a></p>
<p style="margin:0 0 14px;">Or just hit reply &mdash; happy to help by email too.</p>
<p style="margin:0 0 4px;">Talk soon,<br>David<br>Demohub</p>
</td></tr>
<tr><td style="padding:20px 32px;background:#fbf7f0;border-top:1px solid rgba(15,44,23,0.06);font-size:12px;color:#6b6a64;text-align:center;">Demohub LLC &middot; 6700 Fallbrook Ave #125, West Hills, CA 91307<br>You\'re receiving this because you have a Demohub account or recently took an action on demohubhq.com.</td></tr>
</table></body></html>`;
  const text = `Hi ${first_name || 'there'},\n\nIt's been a few days since you joined Demohub. Wanted to check in.\n\n- How to price demos: Most start at $30 per slot.\n- Sharing your booking link: drop it in your Instagram bio.\n- Calendar sync: copy the iCal URL from Settings -> Calendar feed.\n\n20-min walkthrough: https://calendly.com/demohubhq/walkthrough\n\nTalk soon,\nDavid\nDemohub`;
  const subject = `${first_name || 'there'} — how's your Demohub setup going?`;
  return { subject, html: htmlBody, text };
}

function brandFirstDemoEmail({ first_name, retailer_name, demo_date }) {
  const fn = escapeText(first_name || 'there');
  const rn = escapeText(retailer_name || 'your retailer');
  const dd = escapeText(demo_date || '');
  const htmlBody = `<!DOCTYPE html><html><body style="margin:0;padding:24px;background:#fbf7f0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,sans-serif;color:#1c1c1a;">
<table align="center" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;background:white;border-radius:16px;overflow:hidden;border:1px solid rgba(15,44,23,0.08);">
<tr><td style="padding:28px 32px;background:#0f2c17;">
<table cellpadding="0" cellspacing="0"><tr>
<td style="padding-right:12px;vertical-align:middle;">
<svg width="40" height="40" viewBox="0 0 72 72" xmlns="http://www.w3.org/2000/svg"><circle cx="36" cy="36" r="36" fill="#0f2c17"/><circle cx="36" cy="40" r="18" fill="#ed682f"/><rect x="34.5" y="14" width="3" height="10" rx="1.2" fill="#fbf3e0"/><path d="M37 17 Q45 14 48 20 Q44 22 38 21 Q35 19 37 17 Z" fill="#87b08e"/></svg>
</td><td style="font-weight:800;font-size:24px;color:#fbf7f0;letter-spacing:-0.04em;">demohub</td>
</tr></table>
</td></tr>
<tr><td style="padding:36px 36px 28px;font-size:15px;line-height:1.6;color:#3a3a36;">
<p style="margin:0 0 14px;">Hi ${fn},</p>
<p style="margin:0 0 14px;">Your first Demohub demo is confirmed &mdash; <strong>${rn}</strong> on <strong>${dd}</strong>. Congrats. That's one slot you didn't have to chase down by email.</p>
<p style="margin:0 0 8px;">A few quick wins now that you're live:</p>
<ul style="margin:0 0 18px;padding-left:22px;">
<li style="margin-bottom:8px;"><strong>Round out your product categories</strong> so retailers searching for what you make can find you.</li>
<li style="margin-bottom:8px;"><strong>Check your COI expiration date</strong> is current &mdash; if it's within 90 days, retailers will flag the booking.</li>
<li style="margin-bottom:8px;"><strong>Sync your demos to your own calendar.</strong> Profile &rarr; Account &rarr; calendar URL.</li>
</ul>
<p style="margin:0 0 14px;">Want to see every Demohub retailer in one place? It's right at the top of your dashboard. Book a second demo while you're there.</p>
<p style="margin:0 0 14px;">Reply to this email with how the demo went &mdash; we love hearing how things land at the floor.</p>
<p style="margin:0 0 4px;">Cheers,<br>David<br>Demohub</p>
</td></tr>
<tr><td style="padding:20px 32px;background:#fbf7f0;border-top:1px solid rgba(15,44,23,0.06);font-size:12px;color:#6b6a64;text-align:center;">Demohub LLC &middot; 6700 Fallbrook Ave #125, West Hills, CA 91307<br>You\'re receiving this because you have a Demohub account or recently took an action on demohubhq.com.</td></tr>
</table></body></html>`;
  const text = `Hi ${first_name || 'there'},\n\nYour first Demohub demo is confirmed — ${retailer_name || 'your retailer'} on ${demo_date || ''}. Congrats.\n\n- Round out your product categories.\n- Check your COI expiration date.\n- Sync your demos to your calendar.\n\nCheers,\nDavid\nDemohub`;
  const subject = `Nice — your first demo at ${retailer_name || 'your retailer'} is locked in`;
  return { subject, html: htmlBody, text };
}

// Process an array in concurrent batches. Each batch runs in parallel,
// batches run sequentially. Keeps us under Resend's 2/sec rate limit while
// fitting inside Vercel Hobby's 10s function timeout.
async function processBatched(items, batchSize, processOne) {
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    await Promise.all(batch.map(processOne));
  }
}

function coiWarningEmail({ tier, first_name, brand_name, expires_label, days_left }) {
  const subjectMap = {
    30: `Your COI expires in 30 days — let's get ahead of it`,
    14: `Reminder: your Demohub COI expires in 2 weeks`,
    3:  `Last call: your COI expires in ${days_left} day${days_left === 1 ? '' : 's'}`,
  };
  const headlineMap = {
    30: `Your COI expires in 30 days`,
    14: `2 weeks until your COI expires`,
    3:  `${days_left} day${days_left === 1 ? '' : 's'} until your COI expires`,
  };
  const body = `Hi ${first_name || 'there'},\n\nQuick heads-up: the Certificate of Insurance on your ${brand_name || 'brand'} Demohub profile expires on ${expires_label}.\n\nRetailers can't accept new demos from brands with an expired COI, and your verified badge disappears the moment it lapses. Take a minute now and you're set:\n\n1. Get an updated COI from your insurer (most brokers can re-issue same-day).\n2. Upload it to your profile: https://demohubhq.com/brand/dashboard#compliance\n3. You're done — every Demohub retailer sees the new doc instantly.\n\nQuestions? Just reply to this email.\n\n— Demohub`;
  const html = `<!doctype html><html><body style="margin:0;padding:0;background:#fbf7f0;font-family:'Plus Jakarta Sans',-apple-system,sans-serif;">
    <div style="max-width:560px;margin:0 auto;padding:40px 24px;">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:32px;">
        <svg width="32" height="32" viewBox="0 0 72 72"><circle cx="36" cy="36" r="36" fill="#0f2c17"/><circle cx="36" cy="40" r="18" fill="#ed682f"/><rect x="34.5" y="14" width="3" height="10" rx="1.2" fill="#fbf3e0"/><path d="M37 17 Q45 14 48 20 Q44 22 38 21 Q35 19 37 17 Z" fill="#87b08e"/></svg>
        <div style="font-weight:800;font-size:18px;letter-spacing:-0.04em;color:#0f2c17;">demohub</div>
      </div>
      <h1 style="font-size:24px;font-weight:700;letter-spacing:-0.025em;color:#0f2c17;margin:0 0 14px;line-height:1.2;">${headlineMap[tier]}</h1>
      <p style="font-size:15px;color:#3a3a36;line-height:1.55;margin:0 0 16px;">Hi ${first_name || 'there'},</p>
      <p style="font-size:15px;color:#3a3a36;line-height:1.55;margin:0 0 16px;">Quick heads-up: the Certificate of Insurance on your <strong>${brand_name || 'brand'}</strong> Demohub profile expires on <strong>${expires_label}</strong>.</p>
      <p style="font-size:15px;color:#3a3a36;line-height:1.55;margin:0 0 24px;">Retailers can't accept new demos from brands with an expired COI, and your <strong>verified badge disappears</strong> the moment it lapses. Take a minute now and you're set for the rest of the policy year.</p>
      <div style="background:white;border:1px solid rgba(15,44,23,0.08);border-radius:10px;padding:18px 22px;margin-bottom:24px;">
        <ol style="margin:0;padding-left:20px;font-size:14px;color:#3a3a36;line-height:1.7;">
          <li>Get an updated COI from your insurer (most brokers can re-issue same-day).</li>
          <li>Upload it to your profile.</li>
          <li>You're done — every Demohub retailer sees the new doc instantly.</li>
        </ol>
      </div>
      <a href="https://demohubhq.com/brand/dashboard#compliance" style="display:inline-block;background:#0f2c17;color:white;padding:14px 24px;border-radius:10px;font-weight:700;font-size:15px;text-decoration:none;">Upload new COI &rarr;</a>
      <p style="font-size:13px;color:#6b6a64;line-height:1.5;margin:28px 0 0;">Questions? Just reply to this email — a human reads everything.</p>
    </div>
  </body></html>`;
  return { subject: subjectMap[tier], html, text: body };
}

function retailerCoiWarningEmail({ tier, retailer_name, brand_name, brand_contact_name, expires_label, days_left, upcoming_demo_label, admin_url }) {
  const subjectMap = {
    30: `${brand_name}'s COI expires in 30 days`,
    14: `Reminder: ${brand_name}'s COI expires in 2 weeks`,
    3:  `Last call: ${brand_name}'s COI expires in ${days_left} day${days_left === 1 ? '' : 's'}`,
  };
  const headlineMap = {
    30: `${brand_name}'s COI expires in 30 days`,
    14: `2 weeks until ${brand_name}'s COI expires`,
    3:  `${days_left} day${days_left === 1 ? '' : 's'} until ${brand_name}'s COI expires`,
  };
  const demoBlock = upcoming_demo_label
    ? `<div style="background:#fff3ed;border-left:4px solid #ed682f;border-radius:8px;padding:14px 18px;margin-bottom:20px;font-size:14px;color:#a14e2a;line-height:1.5;"><strong>Heads up:</strong> you have an upcoming demo with this brand on <strong>${upcoming_demo_label}</strong>. If their COI lapses before then, you may need to reschedule.</div>`
    : '';
  const html = `<!doctype html><html><body style="margin:0;padding:0;background:#fbf7f0;font-family:'Plus Jakarta Sans',-apple-system,sans-serif;">
    <div style="max-width:560px;margin:0 auto;padding:40px 24px;">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:32px;">
        <svg width="32" height="32" viewBox="0 0 72 72"><circle cx="36" cy="36" r="36" fill="#0f2c17"/><circle cx="36" cy="40" r="18" fill="#ed682f"/><rect x="34.5" y="14" width="3" height="10" rx="1.2" fill="#fbf3e0"/><path d="M37 17 Q45 14 48 20 Q44 22 38 21 Q35 19 37 17 Z" fill="#87b08e"/></svg>
        <div style="font-weight:800;font-size:18px;letter-spacing:-0.04em;color:#0f2c17;">demohub</div>
      </div>
      <h1 style="font-size:24px;font-weight:700;letter-spacing:-0.025em;color:#0f2c17;margin:0 0 14px;line-height:1.2;">${headlineMap[tier]}</h1>
      <p style="font-size:15px;color:#3a3a36;line-height:1.55;margin:0 0 14px;">Hi ${retailer_name || 'there'},</p>
      <p style="font-size:15px;color:#3a3a36;line-height:1.55;margin:0 0 18px;">The Certificate of Insurance on file for <strong>${brand_name}</strong>${brand_contact_name ? ' (' + brand_contact_name + ')' : ''} expires on <strong>${expires_label}</strong>.</p>
      ${demoBlock}
      <p style="font-size:15px;color:#3a3a36;line-height:1.55;margin:0 0 22px;">Two things you can do:</p>
      <div style="background:white;border:1px solid rgba(15,44,23,0.08);border-radius:10px;padding:18px 22px;margin-bottom:24px;">
        <ol style="margin:0;padding-left:20px;font-size:14px;color:#3a3a36;line-height:1.7;">
          <li>Reach out to ${brand_name} and ask them to renew their COI before the expiry date.</li>
          <li>Once they upload it, the compliance status updates automatically in your admin.</li>
        </ol>
      </div>
      <a href="${admin_url}" style="display:inline-block;background:#0f2c17;color:white;padding:14px 24px;border-radius:10px;font-weight:700;font-size:15px;text-decoration:none;">Open compliance dashboard &rarr;</a>
      <p style="font-size:13px;color:#6b6a64;line-height:1.5;margin:28px 0 0;">Sent automatically by Demohub. You can adjust notification settings in your admin.</p>
    </div>
  </body></html>`;
  const text = `Hi ${retailer_name || 'there'},\n\nThe COI on file for ${brand_name}${brand_contact_name ? ' (' + brand_contact_name + ')' : ''} expires on ${expires_label}.\n\n${upcoming_demo_label ? `Heads up: you have an upcoming demo with this brand on ${upcoming_demo_label}. If their COI lapses before then, you may need to reschedule.\n\n` : ''}Two things to do:\n1. Reach out to ${brand_name} and ask them to renew before expiry.\n2. Once they upload it, your admin updates automatically.\n\nOpen your compliance dashboard: ${admin_url}\n\n— Demohub`;
  return { subject: subjectMap[tier], html, text };
}

async function sendWelcome({ to, subject, html, text }) {
  if (!RESEND_API_KEY) { console.warn('RESEND_API_KEY missing — skipping welcome to', to); return false; }
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: FROM_BOOKINGS, to, reply_to: REPLY_TO, subject, html, text }),
    });
    return r.ok;
  } catch (e) {
    console.warn('Welcome send failed:', e?.message || e);
    return false;
  }
}

const DEFAULT_DEMO_POLICY = 'Arrive 15 minutes before your slot to set up. Bring your own sampling supplies (cups, napkins, ice if needed). Coordinate with the floor lead on arrival. Keep the demo area clean, present products in branded packaging only, and break down promptly at end of slot. No solicitation outside the demo area.';
const DEFAULT_CANCELLATION_POLICY = 'Cancellations accepted up to 48 hours before the demo. After that, fees are non-refundable. Reschedules are welcome anytime.';

async function sha256Hex(str) {
  const enc = new TextEncoder().encode(str || '');
  const buf = await globalThis.crypto.subtle.digest('SHA-256', enc);
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  const body = await readBody(req);
  const action = (req.query?.action || body.action || '').toString();

  try {
    // ---- BOOKING-SIGNUP: hard-gate account creation at booking time ----
    // Purpose-built for the booking flow. Creates the brand + password + session in one shot.
    // No website required (the retailer already knows the brand; COI/website collected later).
    // If the email already has a password-protected account, tells them to sign in instead.
    if (action === 'booking-signup') {
      const rl = await checkRateLimit(req, 'brand-booking-signup', 45);
      if (!rl.allowed) return jsonResp(res, rl.error === 'rate_limit_unavailable' ? 503 : 429, { error: rl.error || 'too_many_requests', message: 'Too many attempts. Try again shortly.' });
      const email = String(body.email || '').trim().toLowerCase();
      const companyName = String(body.company_name || '').trim();
      const contactName = String(body.contact_name || '').trim() || null;
      const phone = String(body.phone || '').trim() || null;
      const password = String(body.password || '');
      if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return jsonResp(res, 400, { error: 'Valid email required' });
      if (!companyName) return jsonResp(res, 400, { error: 'Brand name required' });
      if (password.length < 8) return jsonResp(res, 400, { error: 'Password must be at least 8 characters' });

      // Cross-role collision: email already a retailer?
      try {
        const dupR = await sb(`retailers?billing_email=eq.${encodeURIComponent(email)}&select=id&limit=1`);
        const dupRows = await dupR.json();
        if (Array.isArray(dupRows) && dupRows.length > 0) {
          return jsonResp(res, 409, { error: 'already_retailer', message: 'This email is a retailer account. Use a different email for your brand.' });
        }
      } catch (_) {}

      // Existing brand?
      const lookupR = await sb(`brands?email=eq.${encodeURIComponent(email)}&select=id,password_hash`);
      const existing = (await lookupR.json())[0];
      let brandId;
      if (existing) {
        // If they already have a password, they must sign in — don't silently overwrite.
        if (existing.password_hash) {
          return jsonResp(res, 409, { error: 'account_exists', message: 'You already have a Demohub account. Sign in to continue.', signin: true });
        }
        // Brand row exists but no password (auto-created from a prior guest booking) — claim it now.
        brandId = existing.id;
        const password_hash = await hashPassword(password);
        const patch = { password_hash, is_verified: true, updated_at: new Date().toISOString() };
        if (companyName) patch.company_name = companyName;
        if (contactName) patch.contact_name = contactName;
        if (phone) patch.phone = phone;
        try { await sb(`brands?id=eq.${brandId}`, { method: 'PATCH', body: JSON.stringify(patch) }); } catch (_) {}
      } else {
        // Brand new — create the brand with password set.
        const password_hash = await hashPassword(password);
        const createR = await sb('brands', {
          method: 'POST',
          body: JSON.stringify({ email, company_name: companyName, contact_name: contactName, phone, password_hash, is_verified: true }),
        });
        const created = await createR.json();
        if (!Array.isArray(created) || !created[0]) { console.error('booking-signup brand insert failed:', JSON.stringify(created)); return jsonResp(res, 500, { error: 'Could not create account. Try again.' }); }
        brandId = created[0].id;
        try {
          await sb('brand_members', { method: 'POST', body: JSON.stringify({ brand_id: brandId, email, role: 'owner', name: contactName }) });
        } catch (_) {}
      }

      // Create session + set HttpOnly cookie so the brand is now signed in for the booking + future visits.
      const sessionToken = randomToken(32);
      const sessionExpires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
      await sb('brand_account_sessions', {
        method: 'POST',
        body: JSON.stringify({ brand_id: brandId, email, session_token: sessionToken, expires_at: sessionExpires }),
      });
      setBrandSessionCookie(res, sessionToken);
      return jsonResp(res, 200, { ok: true, brand_id: brandId, email });
    }

    if (action === 'signup') {
      const rl = await checkRateLimit(req, 'brand-signup', 30);
      if (!rl.allowed) return jsonResp(res, rl.error === 'rate_limit_unavailable' ? 503 : 429, { error: rl.error || 'too_many_requests', message: 'Too many signup attempts. Try again in an hour.' });
      const email = String(body.email || '').trim().toLowerCase();
      const companyName = String(body.company_name || '').trim();
      const contactName = String(body.contact_name || '').trim() || null;
      const phone = String(body.phone || '').trim() || null;
      let website = String(body.website || '').trim() || null;
      if (website && !/^https?:\/\//i.test(website)) website = 'https://' + website;
      const defaultCategories = String(body.default_categories || '').trim() || null;
      if (!email || !companyName) return jsonResp(res, 400, { error: 'Missing email or company name' });
      if (!website) return jsonResp(res, 400, { error: 'Website is required so retailers can verify your brand' });

      // ===== Cross-role collision check: single-profile-per-email =====
      try {
        const dupR = await sb(`retailers?billing_email=eq.${encodeURIComponent(email)}&select=id&limit=1`);
        const dupRows = await dupR.json();
        if (Array.isArray(dupRows) && dupRows.length > 0) {
          return jsonResp(res, 409, {
            error: 'already_retailer',
            message: `This email is already registered as a retailer on Demohub. Each email can only have one account type. Sign in to your retailer admin instead.`,
            signin_url: '/signin?email=' + encodeURIComponent(email),
          });
        }
      } catch (_) { /* fall through */ }

      const lookupR = await sb(`brands?email=eq.${encodeURIComponent(email)}&select=id`);
      const existing = (await lookupR.json())[0];
      let brandId;
      if (existing) {
        brandId = existing.id;
        const patch = { updated_at: new Date().toISOString() };
        if (contactName) patch.contact_name = contactName;
        if (phone) patch.phone = phone;
        if (website) patch.website = website;
        if (defaultCategories) patch.default_categories = defaultCategories;
        try { await sb(`brands?id=eq.${brandId}`, { method: 'PATCH', body: JSON.stringify(patch) }); } catch (_) {}
      } else {
        const createR = await sb('brands', {
          method: 'POST',
          body: JSON.stringify({ email, company_name: companyName, contact_name: contactName, phone, website, default_categories: defaultCategories }),
        });
        const created = await createR.json();
        if (!Array.isArray(created) || !created[0]) return jsonResp(res, 500, { error: 'Failed to create brand' });
        brandId = created[0].id;
        try {
          await sb('brand_members', {
            method: 'POST',
            body: JSON.stringify({ brand_id: brandId, email, role: 'owner', name: contactName }),
          });
        } catch (e) { console.warn('brand_members owner row creation failed:', e); }
      }

      const token = randomToken(24);
      const code = generateLoginCode();
      const expires = new Date(Date.now() + 30 * 60 * 1000).toISOString();
      // Insert the magic-link token AND a 6-digit code, same as the login path. Without the
      // code, a new signup got a link-only email; tapping that link on a phone opens the mail
      // app's in-app browser, so the session lands in a different browser than the one they
      // started in. The code lets them finish in the tab they already have open.
      await Promise.all([
        sb('brand_account_tokens', {
          method: 'POST',
          body: JSON.stringify({ brand_id: brandId, email, token, expires_at: expires }),
        }),
        sb('brand_account_tokens', {
          method: 'POST',
          body: JSON.stringify({ brand_id: brandId, email, token: code, expires_at: expires }),
        }),
      ]);
      const link = `https://demohubhq.com/brand/verify?t=${token}`;
      await sendMagicLink(email, link, !existing, code);

      // Day-0 welcome — only on a brand-new signup. Best-effort, never blocks signup.
      if (!existing) {
        try {
          const firstName = (contactName || '').trim().split(/\s+/)[0] || companyName || 'there';
          const built = brandDay0Email({
            first_name: firstName,
            brand_name: companyName,
            example_retailer_url: 'https://demohubhq.com/r/gus',
          });
          const ok = await sendWelcome({ to: email, subject: built.subject, html: built.html, text: built.text });
          if (ok) {
            try {
              await sb(`brands?id=eq.${encodeURIComponent(brandId)}`, {
                method: 'PATCH',
                body: JSON.stringify({ welcome_day0_sent_at: new Date().toISOString() }),
              });
            } catch (e) { console.warn('brand welcome_day0_sent_at stamp skipped:', e?.message || e); }
          }
        } catch (e) { console.warn('Brand day-0 welcome failed:', e?.message || e); }
      }
      return jsonResp(res, 200, { ok: true });
    }

    // Resolve a login identity by email. brand_members is the auth surface, but brands created
    // via /api/booking (or where the member-row insert silently failed) have no member row. That
    // silently locked those users out: no code was ever sent and login still returned ok:true.
    // Fall back to brands and self-heal by creating the missing owner member row.
    async function resolveBrandMemberByEmail(addr) {
      try {
        const mR = await sb(`brand_members?email=ilike.${encodeURIComponent(addr)}&select=brand_id,email`);
        const m = (await mR.json())[0];
        if (m) return m;
      } catch (_) {}
      try {
        const bR = await sb(`brands?email=ilike.${encodeURIComponent(addr)}&select=id,email,contact_name`);
        const brand = (await bR.json())[0];
        if (!brand) return null;
        try {
          await sb('brand_members', { method: 'POST', body: JSON.stringify({ brand_id: brand.id, email: brand.email, role: 'owner', name: brand.contact_name || null }) });
        } catch (_) { /* already exists or blocked; still let them in */ }
        return { brand_id: brand.id, email: brand.email };
      } catch (_) { return null; }
    }

    if (action === 'login') {
      const email = String(body.email || '').trim().toLowerCase();
      if (!email) return jsonResp(res, 400, { error: 'Missing email' });
      const rlIp = await checkRateLimit(req, 'brand-login-ip', 40);
      if (!rlIp.allowed) return jsonResp(res, rlIp.error === 'rate_limit_unavailable' ? 503 : 429, { error: rlIp.error || 'too_many_requests', message: 'Too many sign-in requests. Try again in an hour.' });
      const rlEmail = await checkRateLimit(req, 'brand-login-email:' + email.slice(0, 64), 15);
      if (!rlEmail.allowed) return jsonResp(res, rlEmail.error === 'rate_limit_unavailable' ? 503 : 429, { error: rlEmail.error || 'too_many_requests', message: 'Too many sign-in requests for this email in the last hour.' });
      // Unspoofable ceiling (no IP in the key): caps login-code emails per address so a
      // forged-IP attacker cannot email-bomb a victim or run up the Resend bill.
      const rlEmailHard = await checkRateLimitByKey('brand-login-email-hard:' + email.slice(0, 64), 20);
      if (!rlEmailHard.allowed) return jsonResp(res, rlEmailHard.error === 'rate_limit_unavailable' ? 503 : 429, { error: rlEmailHard.error || 'too_many_requests', message: 'Too many sign-in requests for this email in the last hour.' });
      const member = await resolveBrandMemberByEmail(email);
      if (member) {
        const token = randomToken(24);
        const code = generateLoginCode();
        const expires = new Date(Date.now() + 30 * 60 * 1000).toISOString();
        // Insert both the magic-link token AND the 6-digit code as separate rows.
        // Verify-code looks up by (token=<code>, email=<email>). Verify (magic-link) looks up by token=<hex>.
        // Both same expires_at; either path marks used_at and invalidates.
        await Promise.all([
          sb('brand_account_tokens', {
            method: 'POST',
            body: JSON.stringify({ brand_id: member.brand_id, email: member.email, token, expires_at: expires }),
          }),
          sb('brand_account_tokens', {
            method: 'POST',
            body: JSON.stringify({ brand_id: member.brand_id, email: member.email, token: code, expires_at: expires }),
          }),
        ]);
        const link = `https://demohubhq.com/brand/verify?t=${token}`;
        // Fire-and-forget email — don't block response on Resend latency
        sendMagicLink(member.email, link, false, code).catch(e => console.warn('brand login email failed:', e?.message || e));
      }
      // Always return ok:true to prevent email enumeration
      return jsonResp(res, 200, { ok: true });
    }

    // ---- VERIFY-CODE: exchange 6-digit code (+ email) for session ----
    // Parallel to admin-auth verify-code but for brand accounts. Rate-limited.
    if (action === 'verify-code') {
      const email = String(body.email || '').trim().toLowerCase();
      const code = String(body.code || '').replace(/\D/g, '').trim();
      if (!email || !code || code.length !== 6) return jsonResp(res, 400, { error: 'Email and 6-digit code required' });
      // Per-IP cap AND an unspoofable per-email cap. The email cap is the real defense:
      // 12 guesses/hour against a 1,000,000 code space with 30-minute codes is hopeless,
      // and it holds no matter how many IPs an attacker forges.
      const rlIp = await checkRateLimit(req, 'brand-verify-code', 60);
      const rlEmail = await checkRateLimitByKey('brand-verify-code-email:' + email.slice(0, 64), 12);
      if (!rlIp.allowed || !rlEmail.allowed) {
        const unavailable = rlIp.error === 'rate_limit_unavailable' || rlEmail.error === 'rate_limit_unavailable';
        return jsonResp(res, unavailable ? 503 : 429, { error: unavailable ? 'rate_limit_unavailable' : 'too_many_requests', message: 'Too many attempts. Try again in an hour.' });
      }
      // Look up by token = code AND email = email (scoped, so 6-digit collisions across brands don't matter)
      const tR = await sb(`brand_account_tokens?token=eq.${encodeURIComponent(code)}&email=ilike.${encodeURIComponent(email)}&used_at=is.null&select=*&order=created_at.desc&limit=1`);
      const tok = (await tR.json())[0];
      if (!tok) return jsonResp(res, 404, { error: 'Invalid code' });
      if (new Date(tok.expires_at).getTime() < Date.now()) return jsonResp(res, 410, { error: 'Code expired' });
      // Mark used to prevent reuse
      await sb(`brand_account_tokens?id=eq.${tok.id}`, { method: 'PATCH', body: JSON.stringify({ used_at: new Date().toISOString() }) });
      // Create the session
      const sessionToken = randomToken(32);
      const sessionExpires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
      await sb('brand_account_sessions', {
        method: 'POST',
        body: JSON.stringify({ brand_id: tok.brand_id, email: tok.email, session_token: sessionToken, expires_at: sessionExpires }),
      });
      // Set HttpOnly cookie so future requests authenticate without body-token
      setBrandSessionCookie(res, sessionToken);
      return jsonResp(res, 200, { ok: true, session_token: sessionToken, email: tok.email, brand_id: tok.brand_id });
    }

    if (action === 'verify') {
      const token = String(body.token || req.query?.t || '').trim();
      if (!token) return jsonResp(res, 400, { error: 'Missing token' });
      const tR = await sb(`brand_account_tokens?token=eq.${encodeURIComponent(token)}&select=*`);
      const tok = (await tR.json())[0];
      if (!tok || tok.used_at) return jsonResp(res, 401, { error: 'Invalid or used token' });
      if (new Date(tok.expires_at).getTime() < Date.now()) return jsonResp(res, 401, { error: 'Token expired' });
      await sb(`brand_account_tokens?id=eq.${tok.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ used_at: new Date().toISOString() }),
      });
      let memberEmail = tok.email;
      if (!memberEmail) {
        const bR = await sb(`brands?id=eq.${tok.brand_id}&select=email`);
        const b = (await bR.json())[0];
        memberEmail = b?.email || null;
      }
      const sessionToken = randomToken(32);
      const expires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
      await sb('brand_account_sessions', {
        method: 'POST',
        body: JSON.stringify({ brand_id: tok.brand_id, email: memberEmail, session_token: sessionToken, expires_at: expires }),
      });
      await sb(`brands?id=eq.${tok.brand_id}`, {
        method: 'PATCH',
        body: JSON.stringify({ is_verified: true, updated_at: new Date().toISOString() }),
      });
      // Set HttpOnly cookie so subsequent requests authenticate without body-session_token.
      setBrandSessionCookie(res, sessionToken);
      return jsonResp(res, 200, { ok: true, session_token: sessionToken });
    }

    if (action === 'data') {
      const sessionToken = getBrandSessionFromReq(req, body) || '';
      const brandId = await verifySession(sessionToken);
      if (!brandId) return jsonResp(res, 401, { error: 'Not authenticated' });
      const [profileR, demosR, contactsR] = await Promise.all([
        sb(`brands?id=eq.${brandId}&select=*`),
        sb(`demos?brand_id=eq.${brandId}&select=*,retailers(id,name,slug),venues(id,name,address)&order=demo_date.desc`),
        sb(`brand_contacts?brand_id=eq.${brandId}&select=retailer_id,created_at,retailers(id,name,slug)`),
      ]);
      const profile = (await profileR.json())[0] || null;
      const demos = await demosR.json();
      const contacts = await contactsR.json();
      return jsonResp(res, 200, { profile, demos, contacts });
    }

    if (action === 'agreement-list') {
      const sessionToken = getBrandSessionFromReq(req, body) || '';
      const brandId = await verifySession(sessionToken);
      if (!brandId) return jsonResp(res, 401, { error: 'Not authenticated' });
      const rRows = await sb(`brand_retailer_agreements?brand_id=eq.${brandId}&select=*,retailers(id,name,slug,demo_policy,cancellation_policy)&order=signed_at.desc`);
      const rows = await rRows.json();
      const enriched = [];
      for (const r of (rows || [])) {
        const ret = r.retailers || {};
        const curHash = await sha256Hex((ret.demo_policy || DEFAULT_DEMO_POLICY) + '\n---\n' + (ret.cancellation_policy || DEFAULT_CANCELLATION_POLICY));
        enriched.push({
          ...r,
          is_active: !r.superseded_at,
          is_expired: new Date(r.expires_at).getTime() < Date.now(),
          is_current_policy: r.policy_hash === curHash,
        });
      }
      return jsonResp(res, 200, { ok: true, agreements: enriched });
    }

    if (action === 'profile-update') {
      const sessionToken = getBrandSessionFromReq(req, body) || '';
      const brandId = await verifySession(sessionToken);
      if (!brandId) return jsonResp(res, 401, { error: 'Not authenticated' });
      const allowed = ['company_name', 'contact_name', 'phone', 'default_coi_url', 'default_coi_expires', 'default_product_info', 'default_categories', 'website', 'notification_prefs', 'needs_electricity', 'products'];
      const patch = { updated_at: new Date().toISOString() };
      for (const k of allowed) {
        if (body[k] !== undefined) {
          if (k === 'notification_prefs') {
            patch[k] = body[k] && typeof body[k] === 'object' ? body[k] : null;
          } else if (k === 'needs_electricity') {
            patch[k] = !!body[k];
          } else if (k === 'products') {
            patch[k] = Array.isArray(body[k]) ? sanitizeProducts(body[k]) : [];
          } else {
            patch[k] = body[k] === '' ? null : body[k];
          }
        }
      }
      if (patch.website && typeof patch.website === 'string' && !/^https?:\/\//i.test(patch.website)) {
        patch.website = 'https://' + patch.website.trim();
      }
      // Specific COI expiry errors instead of a generic "save failed".
      if (Object.prototype.hasOwnProperty.call(patch, 'default_coi_expires')) {
        const chk = validateCoiExpiry(patch.default_coi_expires);
        if (!chk.ok) return jsonResp(res, 400, { error: chk.error, message: chk.message, field: 'default_coi_expires' });
        patch.default_coi_expires = chk.value;
        // Guard the hole where a file is uploaded with no expiry: a null expiry counts as
        // "covered" downstream, so require a date whenever a certificate is on file.
        if (!chk.value) {
          const cur = await sb(`brands?id=eq.${brandId}&select=default_coi_url`);
          const curRow = cur.ok ? (await cur.json())[0] : null;
          if (curRow && curRow.default_coi_url) {
            return jsonResp(res, 400, { error: 'coi_expiry_required', message: 'Add the expiry date printed on your certificate. Without it we cannot tell retailers your insurance is current.', field: 'default_coi_expires' });
          }
        }
      }
      // Retry without the optional columns if the full payload is rejected. A single
      // missing/renamed column used to fail the entire save with a generic message,
      // which is the same shape of bug that made COI uploads silently no-op.
      const CORE_COLS = ['company_name', 'contact_name', 'phone', 'website', 'default_coi_expires', 'updated_at'];
      let r = await sb(`brands?id=eq.${brandId}`, { method: 'PATCH', body: JSON.stringify(patch) });
      let degraded = null;
      if (!r.ok) {
        const firstErr = await r.text().catch(() => '');
        console.error('profile-update full payload failed for brand', brandId, firstErr);
        const corePatch = {};
        for (const k of CORE_COLS) if (patch[k] !== undefined) corePatch[k] = patch[k];
        r = await sb(`brands?id=eq.${brandId}`, { method: 'PATCH', body: JSON.stringify(corePatch) });
        if (r.ok) {
          degraded = firstErr;
          console.warn('profile-update dropped optional columns for brand', brandId, firstErr);
          console.warn('profile-update saved core fields only for brand', brandId, firstErr);
        } else {
          const coreErr = await r.text().catch(() => '');
          console.error('profile-update core payload also failed for brand', brandId, coreErr);
          // Pre-launch: surface the real reason. Guessing at this from a generic
          // "try again" message costs a round trip every time.
          let hint = '';
          try {
            const j = JSON.parse(coreErr || firstErr || '{}');
            if (j.message) hint = ' (' + String(j.message).slice(0, 160) + ')';
          } catch (_) { if (coreErr) hint = ' (' + String(coreErr).slice(0, 160) + ')'; }
          return jsonResp(res, 500, {
            error: 'profile_save_failed',
            message: 'We could not save those changes.' + hint,
            detail: (coreErr || firstErr || '').slice(0, 400),
          });
        }
      }
      if (degraded) {
        // Name the fields that did not persist so the UI can stop claiming success.
        const dropped = Object.keys(patch).filter(k => !CORE_COLS.includes(k));
        return jsonResp(res, 200, { ok: true, degraded: true, dropped, detail: String(degraded).slice(0, 400) });
      }
      return jsonResp(res, 200, { ok: true });
    }

    if (action === 'upload-avatar' || action === 'upload-logo') {
      const sessionToken = getBrandSessionFromReq(req, body) || '';
      const brandId = await verifySession(sessionToken);
      if (!brandId) return jsonResp(res, 401, { error: 'Not authenticated' });
      const dataUrl = String(body.image || '');
      const m = dataUrl.match(/^data:(image\/(?:png|jpeg|webp|gif));base64,(.+)$/);
      if (!m) return jsonResp(res, 400, { error: 'Invalid image — must be PNG, JPEG, WEBP, or GIF data URL' });
      const mime = m[1];
      const ext = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' }[mime];
      const bytes = Buffer.from(m[2], 'base64');
      if (bytes.length > 2 * 1024 * 1024) return jsonResp(res, 400, { error: 'Image too large — max 2MB' });
      const path = `brands/${brandId}.${ext}`;
      const uploadResp = await fetch(`${SUPABASE_URL}/storage/v1/object/avatars/${path}?upsert=true`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`, apikey: SUPABASE_SERVICE_KEY, 'Content-Type': mime, 'x-upsert': 'true' },
        body: bytes,
      });
      if (!uploadResp.ok) {
        const errText = await uploadResp.text().catch(() => '');
        console.error('COI storage upload failed', uploadResp.status, errText);
        return jsonResp(res, 502, { error: 'coi_storage_failed', message: 'We could not save that file to storage. Try again in a moment; if it keeps failing, email david@demohubhq.com.' });
      }
      const publicUrl = `${SUPABASE_URL}/storage/v1/object/public/avatars/${path}?v=${Date.now()}`;
      await sb(`brands?id=eq.${brandId}`, {
        method: 'PATCH',
        body: JSON.stringify({ logo_url: publicUrl, updated_at: new Date().toISOString() }),
      });
      return jsonResp(res, 200, { ok: true, logo_url: publicUrl });
    }

    // Patch brands with optional/extra columns tolerated. sb() never throws and callers used to
    // ignore the response, so a failed write (e.g. a column that does not exist) silently reported
    // success while nothing saved. Try the full payload; on failure retry with just the core
    // fields; report a real error only if the core write fails.
    async function patchBrandResilient(id, core, extras) {
      let r = await sb(`brands?id=eq.${id}`, { method: 'PATCH', body: JSON.stringify({ ...core, ...extras }) });
      if (r.ok) return { ok: true };
      const firstErr = await r.text().catch(() => '');
      r = await sb(`brands?id=eq.${id}`, { method: 'PATCH', body: JSON.stringify(core) });
      if (r.ok) return { ok: true, degraded: true, detail: firstErr };
      const coreErr = await r.text().catch(() => '');
      return { ok: false, detail: coreErr || firstErr };
    }

    // Confirm the bytes really are the type the data URL claims. Stops renamed/garbage files.
    function sniffMatchesMime(buf, mime) {
      if (!buf || buf.length < 8) return false;
      const b = buf;
      if (mime === 'application/pdf') return b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46; // %PDF
      if (mime === 'image/jpeg') return b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF;
      if (mime === 'image/png') return b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47;
      if (mime === 'image/webp') return b.slice(0, 4).toString('ascii') === 'RIFF' && b.slice(8, 12).toString('ascii') === 'WEBP';
      return false;
    }

    // Normalise the SKU list. Caps size and length so a brand cannot paste a novel
    // into the field or push a huge payload into every booking snapshot.
    function sanitizeProducts(arr) {
      const clean = [];
      for (const raw of (Array.isArray(arr) ? arr : []).slice(0, 60)) {
        if (!raw || typeof raw !== 'object') continue;
        const name = String(raw.name || '').trim().slice(0, 120);
        if (!name) continue;                       // an item with no name is not an item
        clean.push({
          id: String(raw.id || '').slice(0, 40) || ('p' + Math.random().toString(36).slice(2, 10)),
          name,
          size: String(raw.size || '').trim().slice(0, 40),
          sku: String(raw.sku || '').trim().slice(0, 60),
        });
      }
      return clean;
    }

    // Shared expiry validation so upload and profile-save give identical, specific messages.
    function validateCoiExpiry(v) {
      if (v === null || v === undefined || v === '') return { ok: true, value: null };
      const str = String(v).slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(str)) return { ok: false, error: 'coi_expiry_invalid', message: "That expiry date is not a valid date. Use the date picker and choose the expiry printed on your certificate." };
      const d = new Date(str + 'T00:00:00Z');
      if (isNaN(d.getTime())) return { ok: false, error: 'coi_expiry_invalid', message: "That expiry date is not a valid date. Use the date picker and choose the expiry printed on your certificate." };
      const today = new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00Z');
      if (d < today) return { ok: false, error: 'coi_expiry_past', message: "That expiry date has already passed. A certificate that has expired will not be accepted, so enter the expiry date printed on a current certificate." };
      const maxD = new Date(today.getTime() + 5 * 365 * 86400000);
      if (d > maxD) return { ok: false, error: 'coi_expiry_far', message: "That expiry date is more than five years out. Please check the date printed on your certificate." };
      return { ok: true, value: str };
    }

    // ===== COI content verification (Claude Haiku vision) =====
    // Extracts structured fields from the certificate and applies the check matrix.
    // Never blocks an upload on our own failure: any error/timeout returns status 'pending'.
    async function verifyCoiWithClaude(bytes, mime, brandCompanyName) {
      const key = process.env.ANTHROPIC_API_KEY;
      if (!key) return { status: 'pending', reason: 'no_api_key' };
      const schema = {
        type: 'object',
        properties: {
          is_coi: { type: 'boolean', description: 'True only if this is a certificate of insurance (ACORD 25 or equivalent).' },
          confidence: { type: 'number', description: '0 to 1 confidence that is_coi is correct.' },
          form_type: { type: 'string', description: 'e.g. "ACORD 25", "ACORD 27", "other", "not_a_certificate".' },
          acord_markers_present: { type: 'boolean', description: 'ACORD logo and/or the text "ACORD 25" visible on the form.' },
          insured_name: { type: ['string', 'null'], description: 'Name in the INSURED box.' },
          producer_name: { type: ['string', 'null'] },
          insurer_name: { type: ['string', 'null'], description: 'Primary carrier affording general liability.' },
          insurer_naic: { type: ['string', 'null'], description: '5-digit NAIC number for that carrier, digits only.' },
          policy_number: { type: ['string', 'null'] },
          earliest_expiry: { type: ['string', 'null'], description: 'Earliest policy expiration date, YYYY-MM-DD.' },
          gl_each_occurrence: { type: ['number', 'null'], description: 'General liability each-occurrence limit in dollars.' },
          gl_general_aggregate: { type: ['number', 'null'] },
          certificate_holder: { type: ['string', 'null'] },
          tampering_signals: { type: 'array', items: { type: 'string' }, description: 'Mismatched fonts, off-center dates, handwriting, visible edits. Empty if none.' },
        },
        required: ['is_coi', 'confidence', 'acord_markers_present', 'tampering_signals'],
      };
      const isPdf = mime === 'application/pdf';
      const docBlock = isPdf
        ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: bytes.toString('base64') } }
        : { type: 'image', source: { type: 'base64', media_type: mime, data: bytes.toString('base64') } };
      const prompt = 'You are checking a document a brand uploaded as proof of insurance.\n'
        + 'Report exactly what the document shows. Do not guess or fill in plausible values.\n'
        + 'If a field is not visible, return null for it.\n'
        + (brandCompanyName ? ('The brand claims to be: "' + brandCompanyName + '". Report the INSURED name exactly as printed; do not correct it to match.\n') : '')
        + 'Set is_coi false for anything that is not an insurance certificate (screenshots, invoices, licenses, photos, blank pages).';
      const payload = {
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1024,
        tools: [{ name: 'report_coi', description: 'Report the fields found on the certificate.', input_schema: schema }],
        tool_choice: { type: 'tool', name: 'report_coi' },
        messages: [{ role: 'user', content: [docBlock, { type: 'text', text: prompt }] }],
      };
      try {
        const ctl = new AbortController();
        const t = setTimeout(() => ctl.abort(), 20000);
        const r = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
          body: JSON.stringify(payload),
          signal: ctl.signal,
        });
        clearTimeout(t);
        if (!r.ok) {
          const errTxt = await r.text().catch(() => '');
          console.warn('COI verify API error', r.status, errTxt.slice(0, 300));
          return { status: 'pending', reason: 'api_error_' + r.status };
        }
        const j = await r.json();
        const block = (j.content || []).find(c => c.type === 'tool_use');
        if (!block || !block.input) return { status: 'pending', reason: 'no_tool_output' };
        return { status: 'ok', data: block.input };
      } catch (e) {
        console.warn('COI verify failed:', (e && e.message) || e);
        return { status: 'pending', reason: 'exception' };
      }
    }

    // Loose name match: ignores case, punctuation and common company suffixes.
    function namesRoughlyMatch(a, b) {
      const norm = (x) => String(x || '').toLowerCase()
        .replace(/\b(llc|l\.l\.c\.|inc|incorporated|corp|corporation|co|company|ltd|limited|lp|llp|the)\b/g, '')
        .replace(/[^a-z0-9]/g, '');
      const A = norm(a), B = norm(b);
      if (!A || !B) return false;
      return A === B || A.includes(B) || B.includes(A);
    }

    // Apply the check matrix. Returns { decision: 'block'|'flag'|'pass', message, flags[] }
    // Brand-facing dates should read like a person wrote them, not like a database row.
    function prettyDate(iso) {
      if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso || '';
      try {
        return new Date(iso + 'T00:00:00Z').toLocaleDateString('en-US',
          { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
      } catch (_) { return iso; }
    }

    function evaluateCoi(d, brandCompanyName) {
      const flags = [];
      if (!d) return { decision: 'flag', flags: ['verification_unavailable'] };
      const conf = typeof d.confidence === 'number' ? d.confidence : 0;
      // --- hard blocks ---
      if (d.is_coi === false && conf > 0.85) {
        return { decision: 'block', flags: ['not_a_coi'], message: 'That document does not look like a Certificate of Insurance. Upload the certificate your insurance broker issued (usually an ACORD 25).' };
      }
      if (d.is_coi === false && d.acord_markers_present === false) {
        return { decision: 'block', flags: ['not_a_coi_no_markers'], message: 'We could not find any certificate of insurance markings on that document. Upload the ACORD certificate from your broker.' };
      }
      if (d.earliest_expiry && /^\d{4}-\d{2}-\d{2}$/.test(d.earliest_expiry)) {
        const today = new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00Z');
        if (new Date(d.earliest_expiry + 'T00:00:00Z') < today) {
          const _days = Math.round((today - new Date(d.earliest_expiry + 'T00:00:00Z')) / 86400000);
          return { decision: 'block', flags: ['expired'], message: 'That certificate expired on ' + prettyDate(d.earliest_expiry)
            + (_days > 0 ? ' (' + _days + ' day' + (_days === 1 ? '' : 's') + ' ago)' : '')
            + '. Ask your broker for the renewed certificate and upload that one — most can re-issue the same day.' };
        }
      }
      // --- flags (upload still accepted) ---
      if (conf > 0 && conf <= 0.85) flags.push('low_confidence');
      if (Array.isArray(d.tampering_signals) && d.tampering_signals.length) flags.push('possible_tampering');
      if (brandCompanyName && d.insured_name && !namesRoughlyMatch(d.insured_name, brandCompanyName)) flags.push('insured_name_mismatch');
      if (d.gl_each_occurrence != null && d.gl_each_occurrence < 1000000) flags.push('low_gl_limit');
      if (!d.insurer_naic) flags.push('no_naic');
      if (d.acord_markers_present === false) flags.push('no_acord_markers');
      return { decision: flags.length ? 'flag' : 'pass', flags };
    }

    if (action === 'upload-coi') {
      const sessionToken = getBrandSessionFromReq(req, body) || '';
      const brandId = await verifySession(sessionToken);
      if (!brandId) return jsonResp(res, 401, { error: 'Not authenticated' });
      const dataUrl = String(body.file || '');
      if (!dataUrl) return jsonResp(res, 400, { error: 'no_file', message: 'No file was received. Pick a file and try again.' });
      // Specific guidance for the formats people actually hit, especially iPhone HEIC photos.
      const declared = (dataUrl.match(/^data:([^;]+);base64,/) || [])[1] || '';
      const m = dataUrl.match(/^data:(application\/pdf|image\/(?:jpeg|png|webp));base64,(.+)$/);
      if (!m) {
        if (/hei[cf]/i.test(declared)) {
          return jsonResp(res, 400, { error: 'coi_format_heic', message: 'iPhone HEIC photos are not supported. In Photos, tap Share then choose a format like JPEG, or take a screenshot of the certificate and upload that. PDF, JPG, PNG and WEBP all work.' });
        }
        return jsonResp(res, 400, { error: 'coi_format_unsupported', message: `That file type is not supported${declared ? ' (' + declared + ')' : ''}. Upload your certificate as a PDF, JPG, PNG or WEBP.` });
      }
      const mime = m[1];
      const ext = { 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }[mime];
      let bytes;
      try { bytes = Buffer.from(m[2], 'base64'); }
      catch (_) { return jsonResp(res, 400, { error: 'coi_unreadable', message: 'That file could not be read. Try uploading it again, or export it as a PDF.' }); }
      if (bytes.length > 10 * 1024 * 1024) return jsonResp(res, 400, { error: 'coi_too_large', message: 'That file is over the 10MB limit. Try a PDF export or a smaller photo.' });
      if (bytes.length < 3 * 1024) return jsonResp(res, 400, { error: 'coi_too_small', message: 'That file is too small to be a certificate (under 3KB). Please upload the actual certificate document.' });
      if (!sniffMatchesMime(bytes, mime)) {
        return jsonResp(res, 400, { error: 'coi_content_mismatch', message: 'That file does not appear to be a real ' + ext.toUpperCase() + '. It may be renamed or corrupted. Re-export the certificate and try again.' });
      }
      // Optional expiry supplied at upload time
      const expChk = validateCoiExpiry(body.expires);
      if (!expChk.ok) return jsonResp(res, 400, { error: expChk.error, message: expChk.message });
      const path = `brands/${brandId}.${ext}`;
      const uploadResp = await fetch(`${SUPABASE_URL}/storage/v1/object/coi-docs/${path}?upsert=true`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`, apikey: SUPABASE_SERVICE_KEY, 'Content-Type': mime, 'x-upsert': 'true' },
        body: bytes,
      });
      if (!uploadResp.ok) {
        const errText = await uploadResp.text();
        return jsonResp(res, 500, { error: 'Upload failed: ' + errText });
      }
      const publicUrl = `${SUPABASE_URL}/storage/v1/object/public/coi-docs/${path}?v=${Date.now()}`;
      const originalName = String(body.filename || `certificate-of-insurance.${ext}`).slice(0, 120);

      // --- content verification (Claude Haiku). Degrades to 'pending', never blocks on our failure. ---
      let brandRow = null;
      try {
        const bR = await sb(`brands?id=eq.${brandId}&select=company_name`);
        if (bR.ok) brandRow = (await bR.json())[0] || null;
      } catch (_) {}
      const vres = await verifyCoiWithClaude(bytes, mime, brandRow && brandRow.company_name);
      const vdata = vres.status === 'ok' ? vres.data : null;
      const verdict = vdata ? evaluateCoi(vdata, brandRow && brandRow.company_name) : { decision: 'pending', flags: ['verification_pending'] };
      if (verdict.decision === 'block') {
        return jsonResp(res, 400, { error: 'coi_rejected', message: verdict.message, flags: verdict.flags });
      }
      const verificationStatus = verdict.decision === 'pass' ? 'passed'
        : verdict.decision === 'flag' ? 'flagged' : 'pending';
      // Trust the printed expiry over anything typed. Falls back to the typed value when
      // verification could not read one.
      const docExpiry = (vdata && vdata.earliest_expiry && /^\d{4}-\d{2}-\d{2}$/.test(vdata.earliest_expiry)) ? vdata.earliest_expiry : null;

      const core = { default_coi_url: publicUrl };
      const effectiveExpiry = docExpiry || expChk.value;
      if (effectiveExpiry) core.default_coi_expires = effectiveExpiry;
      const extras = {
        coi_warn_30_sent_at: null, coi_warn_14_sent_at: null, coi_warn_3_sent_at: null,
        default_coi_filename: originalName, default_coi_mime: mime,
        coi_verification_status: verificationStatus,
        updated_at: new Date().toISOString(),
      };
      const wrote = await patchBrandResilient(brandId, core, extras);
      if (!wrote.ok) {
        console.error('COI DB write failed for brand', brandId, wrote.detail);
        return jsonResp(res, 500, { error: 'coi_save_failed', message: 'Your file uploaded but we could not attach it to your account. Try again; if it keeps failing, email david@demohubhq.com.' });
      }
      if (wrote.degraded) console.warn('COI saved with reduced metadata for brand', brandId, wrote.detail);

      // Audit row for the retailer view. Best-effort: never fail the upload over it.
      try {
        await sb('coi_verifications', {
          method: 'POST',
          body: JSON.stringify({
            brand_id: brandId,
            coi_url: publicUrl,
            status: verificationStatus,
            confidence: vdata && typeof vdata.confidence === 'number' ? vdata.confidence : null,
            is_coi: vdata ? !!vdata.is_coi : null,
            insured_name: vdata ? (vdata.insured_name || null) : null,
            insurer_name: vdata ? (vdata.insurer_name || null) : null,
            insurer_naic: vdata ? (vdata.insurer_naic || null) : null,
            policy_expiry: docExpiry,
            gl_each_occurrence: vdata ? (vdata.gl_each_occurrence ?? null) : null,
            gl_general_aggregate: vdata ? (vdata.gl_general_aggregate ?? null) : null,
            flags: verdict.flags || [],
            raw: vdata || { reason: vres.reason || null },
          }),
        });
      } catch (_) {}

      return jsonResp(res, 200, {
        ok: true, coi_url: publicUrl, filename: originalName, mime,
        expires: effectiveExpiry || null,
        verification: {
          status: verificationStatus,
          flags: verdict.flags || [],
          insurer: vdata ? (vdata.insurer_name || null) : null,
          insured_name: vdata ? (vdata.insured_name || null) : null,
          expiry_from_document: docExpiry,
        },
      });
    }

    if (action === 'remove-coi') {
      const sessionToken = getBrandSessionFromReq(req, body) || '';
      const brandId = await verifySession(sessionToken);
      if (!brandId) return jsonResp(res, 401, { error: 'Not authenticated' });
      const removed = await patchBrandResilient(
        brandId,
        { default_coi_url: null, default_coi_expires: null },
        { coi_warn_30_sent_at: null, coi_warn_14_sent_at: null, coi_warn_3_sent_at: null,
          default_coi_filename: null, default_coi_mime: null, updated_at: new Date().toISOString() },
      );
      if (!removed.ok) {
        console.error('COI remove failed for brand', brandId, removed.detail);
        return jsonResp(res, 500, { error: 'coi_remove_failed', message: 'We could not remove that certificate. Try again in a moment.' });
      }
      return jsonResp(res, 200, { ok: true });
    }

    if (action === 'remove-avatar') {
      const sessionToken = getBrandSessionFromReq(req, body) || '';
      const brandId = await verifySession(sessionToken);
      if (!brandId) return jsonResp(res, 401, { error: 'Not authenticated' });
      await sb(`brands?id=eq.${brandId}`, {
        method: 'PATCH',
        body: JSON.stringify({ logo_url: null, updated_at: new Date().toISOString() }),
      });
      return jsonResp(res, 200, { ok: true });
    }

    if (action === 'team-list') {
      const v = await verifySessionFull(getBrandSessionFromReq(req, body) || '');
      if (!v) return jsonResp(res, 401, { error: 'Not authenticated' });
      const members = await (await sb(`brand_members?brand_id=eq.${v.brand_id}&select=*&order=created_at`)).json();
      return jsonResp(res, 200, { ok: true, members, your_email: v.email });
    }

    if (action === 'team-invite') {
      const v = await verifySessionFull(getBrandSessionFromReq(req, body) || '');
      if (!v) return jsonResp(res, 401, { error: 'Not authenticated' });
      const email = String(body.email || '').trim().toLowerCase();
      const name = String(body.name || '').trim() || null;
      const role = body.role === 'viewer' ? 'viewer' : 'admin';
      if (!email || !/^[^@]+@[^@]+\.[^@]+$/.test(email)) return jsonResp(res, 400, { error: 'Valid email required' });
      const me = await (await sb(`brand_members?brand_id=eq.${v.brand_id}&email=ilike.${encodeURIComponent(v.email)}&select=role`)).json();
      const myRow = Array.isArray(me) ? me[0] : null;
      if (!myRow || myRow.role === 'viewer') return jsonResp(res, 403, { error: 'Viewers cannot invite team members' });
      const existing = await (await sb(`brand_members?brand_id=eq.${v.brand_id}&email=ilike.${encodeURIComponent(email)}&select=id`)).json();
      if (Array.isArray(existing) && existing.length > 0) return jsonResp(res, 409, { error: 'That email is already on the team' });
      const createR = await sb('brand_members', {
        method: 'POST',
        body: JSON.stringify({ brand_id: v.brand_id, email, name, role, invited_by_email: v.email }),
      });
      const created = await createR.json();
      try {
        const brand = (await (await sb(`brands?id=eq.${v.brand_id}&select=company_name`)).json())[0];
        const token = randomToken(24);
        const expires = new Date(Date.now() + 30 * 60 * 1000).toISOString();
        await sb('brand_account_tokens', {
          method: 'POST',
          body: JSON.stringify({ brand_id: v.brand_id, email, token, expires_at: expires }),
        });
        const link = `https://demohubhq.com/brand/verify?t=${token}`;
        if (RESEND_API_KEY) {
          await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              from: FROM_EMAIL,
              to: email,
              reply_to: REPLY_TO,
              subject: `You've been invited to ${brand?.company_name || 'a brand'}'s Demohub account`,
              html: `<div style="font-family:-apple-system,sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;color:#1c1c1a;">
                <h1 style="font-family:Georgia,serif;font-weight:400;font-size:26px;margin:0 0 12px;">You're invited.</h1>
                <p style="font-size:15px;line-height:1.5;margin:0 0 22px;color:#3a3a36;">${escapeText(v.email)} added you to <strong>${escapeText(brand?.company_name || 'their brand account')}</strong> on Demohub. Click below to sign in and start managing demos together.</p>
                <a href="${link}" style="display:inline-block;background:#0f2c17;color:white;padding:14px 26px;border-radius:99px;text-decoration:none;font-weight:600;">Accept invite &rarr;</a>
                <p style="font-size:13px;color:#6b6a64;margin-top:32px;">Link expires in 30 minutes. If you weren't expecting this, you can ignore the email.</p>
              </div>`,
            }),
          });
        }
      } catch (e) { console.warn('Invitation email failed:', e); }
      return jsonResp(res, 200, { ok: true, member: Array.isArray(created) ? created[0] : null });
    }

    if (action === 'team-remove') {
      const v = await verifySessionFull(getBrandSessionFromReq(req, body) || '');
      if (!v) return jsonResp(res, 401, { error: 'Not authenticated' });
      const memberId = String(body.member_id || '');
      const me = await (await sb(`brand_members?brand_id=eq.${v.brand_id}&email=ilike.${encodeURIComponent(v.email)}&select=role`)).json();
      const myRow = Array.isArray(me) ? me[0] : null;
      if (!myRow || myRow.role !== 'owner') return jsonResp(res, 403, { error: 'Only owners can remove team members' });
      const target = (await (await sb(`brand_members?id=eq.${encodeURIComponent(memberId)}&select=*`)).json())[0];
      if (!target) return jsonResp(res, 404, { error: 'Member not found' });
      if (target.brand_id !== v.brand_id) return jsonResp(res, 403, { error: 'Wrong brand' });
      if (target.role === 'owner') return jsonResp(res, 400, { error: 'Cannot remove the owner' });
      await sb(`brand_members?id=eq.${encodeURIComponent(memberId)}`, { method: 'DELETE' });
      try { await sb(`brand_account_sessions?brand_id=eq.${v.brand_id}&email=ilike.${encodeURIComponent(target.email)}`, { method: 'DELETE' }); } catch (_) {}
      return jsonResp(res, 200, { ok: true });
    }

    if (action === 'team-update-role') {
      const v = await verifySessionFull(getBrandSessionFromReq(req, body) || '');
      if (!v) return jsonResp(res, 401, { error: 'Not authenticated' });
      const memberId = String(body.member_id || '');
      const role = body.role === 'viewer' ? 'viewer' : 'admin';
      const me = await (await sb(`brand_members?brand_id=eq.${v.brand_id}&email=ilike.${encodeURIComponent(v.email)}&select=role`)).json();
      const myRow = Array.isArray(me) ? me[0] : null;
      if (!myRow || myRow.role !== 'owner') return jsonResp(res, 403, { error: 'Only owners can change roles' });
      const target = (await (await sb(`brand_members?id=eq.${encodeURIComponent(memberId)}&select=*`)).json())[0];
      if (!target || target.brand_id !== v.brand_id) return jsonResp(res, 404, { error: 'Member not found' });
      if (target.role === 'owner') return jsonResp(res, 400, { error: 'Cannot change owner role' });
      await sb(`brand_members?id=eq.${encodeURIComponent(memberId)}`, { method: 'PATCH', body: JSON.stringify({ role }) });
      return jsonResp(res, 200, { ok: true });
    }

    // ---- SET-PASSWORD: claim the account by setting a password ----
    // Two entry points: (a) authenticated brand (session cookie) setting first password,
    // (b) unauthenticated brand who just paid and knows their email — but we require
    // that a valid session already exist. The confirmation-page flow creates a session
    // BEFORE prompting for password via a one-time signed token in the ?paid= redirect.
    // For safety in this pass we only accept authenticated calls.
    if (action === 'set-password') {
      const sessionToken = getBrandSessionFromReq(req, body);
      const brandInfo = await verifySessionFull(sessionToken);
      if (!brandInfo) return jsonResp(res, 401, { error: 'Not authenticated' });
      const password = String(body.password || '');
      if (password.length < 8) return jsonResp(res, 400, { error: 'Password must be at least 8 characters' });
      if (password.length > 128) return jsonResp(res, 400, { error: 'Password too long' });
      try {
        const password_hash = await hashPassword(password);
        // Store the hash + mark the brand as verified (claimed).
        await sb(`brands?id=eq.${encodeURIComponent(brandInfo.brand_id)}`, {
          method: 'PATCH',
          body: JSON.stringify({ password_hash, is_verified: true, updated_at: new Date().toISOString() }),
        });
        return jsonResp(res, 200, { ok: true, claimed: true, brand_id: brandInfo.brand_id });
      } catch (e) {
        console.error('set-password failed:', e?.message || e);
        return jsonResp(res, 500, { error: 'Could not save password. Try again.' });
      }
    }

    // ---- LOGIN-PASSWORD: exchange email + password for session ----
    if (action === 'login-password') {
      const email = String(body.email || '').trim().toLowerCase();
      const password = String(body.password || '');
      if (!email || !password) return jsonResp(res, 400, { error: 'Email and password required' });
      // Same rate limits as code login to prevent brute force
      const rlIp = await checkRateLimit(req, 'brand-login-pw-ip', 60);
      if (!rlIp.allowed) return jsonResp(res, rlIp.error === 'rate_limit_unavailable' ? 503 : 429, { error: rlIp.error || 'too_many_requests', message: 'Too many attempts. Try again in an hour.' });
      const rlEmail = await checkRateLimit(req, 'brand-login-pw-email:' + email.slice(0, 64), 20);
      if (!rlEmail.allowed) return jsonResp(res, rlEmail.error === 'rate_limit_unavailable' ? 503 : 429, { error: rlEmail.error || 'too_many_requests', message: 'Too many attempts for this email.' });
      // Look up brand by email (via brand_members which is the shareable auth surface)
      const lookupR = await sb(`brand_members?email=ilike.${encodeURIComponent(email)}&select=brand_id,email,brands(password_hash)`);
      let member = (await lookupR.json())[0];
      let storedHash = member && member.brands && member.brands.password_hash;
      if (!member) {
        // No member row (e.g. brand auto-created by /api/booking). Self-heal, then read the hash.
        const healed = await resolveBrandMemberByEmail(email);
        if (healed) {
          member = healed;
          try {
            const bR = await sb(`brands?id=eq.${encodeURIComponent(healed.brand_id)}&select=password_hash`);
            const b = (await bR.json())[0];
            storedHash = b && b.password_hash;
          } catch (_) {}
        }
      }
      if (!storedHash) {
        // Don't reveal whether the email exists — return generic error
        return jsonResp(res, 401, { error: 'Invalid email or password' });
      }
      const ok = await verifyPassword(password, storedHash);
      if (!ok) return jsonResp(res, 401, { error: 'Invalid email or password' });
      // Create session + set cookie (same as verify-code flow)
      const sessionToken = randomToken(32);
      const sessionExpires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
      await sb('brand_account_sessions', {
        method: 'POST',
        body: JSON.stringify({ brand_id: member.brand_id, email: member.email, session_token: sessionToken, expires_at: sessionExpires }),
      });
      setBrandSessionCookie(res, sessionToken);
      return jsonResp(res, 200, { ok: true, session_token: sessionToken, email: member.email, brand_id: member.brand_id });
    }

    // ---- CLAIM-STATUS: does this brand have a password set? ----
    if (action === 'claim-status') {
      const sessionToken = getBrandSessionFromReq(req, body);
      const brandInfo = await verifySessionFull(sessionToken);
      if (!brandInfo) return jsonResp(res, 401, { error: 'Not authenticated' });
      const bR = await sb(`brands?id=eq.${brandInfo.brand_id}&select=password_hash,is_verified`);
      const b = (await bR.json())[0] || {};
      return jsonResp(res, 200, {
        ok: true,
        claimed: !!(b.password_hash),
        verified: !!(b.is_verified),
        email: brandInfo.email,
      });
    }

    // ---- COOKIE-MIGRATE: legacy body session_token → HttpOnly cookie ----
    if (action === 'cookie-migrate') {
      const sessionToken = (body.session_token || body.session_id || '').toString();
      if (!sessionToken) return jsonResp(res, 400, { error: 'session_token required' });
      const brandId = await verifySession(sessionToken);
      if (!brandId) return jsonResp(res, 401, { error: 'Session not found or expired' });
      setBrandSessionCookie(res, sessionToken);
      return jsonResp(res, 200, { ok: true, brand_id: brandId });
    }

    if (action === 'logout') {
      const sessionToken = getBrandSessionFromReq(req, body);
      if (sessionToken) {
        await sb(`brand_account_sessions?session_token=eq.${encodeURIComponent(sessionToken)}`, { method: 'DELETE' });
      }
      clearBrandSessionCookie(res);
      return jsonResp(res, 200, { ok: true });
    }

    if (action === 'logout-everywhere') {
      const sessionToken = getBrandSessionFromReq(req, body) || '';
      const brandId = await verifySession(sessionToken);
      if (!brandId) return jsonResp(res, 401, { error: 'Not authenticated' });
      await sb(`brand_account_sessions?brand_id=eq.${brandId}`, { method: 'DELETE' });
      return jsonResp(res, 200, { ok: true });
    }

    if (action === 'cal') {
      const token = String((req.query?.token) || body.token || '').trim();
      if (!token) { res.status(400).send('Missing ?token= parameter. Get your calendar URL from your brand dashboard.'); return; }
      const pad = (n) => String(n).padStart(2, '0');
      const toICSDate = (d) => d.getUTCFullYear() + pad(d.getUTCMonth() + 1) + pad(d.getUTCDate()) + 'T' + pad(d.getUTCHours()) + pad(d.getUTCMinutes()) + pad(d.getUTCSeconds()) + 'Z';
      const escapeICS = (s) => String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\\;');
      const fold = (line) => { const out = []; for (let i = 0; i < line.length; i += 73) out.push((i === 0 ? '' : ' ') + line.slice(i, i + 73)); return out.join('\r\n'); };
      const parseDemoTime = (dateStr, timeStr) => {
        if (!dateStr) return null;
        const [Y, M, D] = dateStr.split('-').map(n => parseInt(n, 10));
        let H = 11, MIN = 0;
        if (timeStr) {
          const m = String(timeStr).match(/^(\d{1,2}):(\d{2})\s*(AM|PM)?$/i);
          if (m) {
            let h = parseInt(m[1], 10);
            const ampm = (m[3] || '').toUpperCase();
            if (ampm === 'PM' && h !== 12) h += 12;
            if (ampm === 'AM' && h === 12) h = 0;
            H = h; MIN = parseInt(m[2], 10);
          }
        }
        return new Date(Date.UTC(Y, M - 1, D, H + 8, MIN, 0));
      };
      const sR = await sb(`brand_account_sessions?session_token=eq.${encodeURIComponent(token)}&select=brand_id,expires_at`);
      const sess = (await sR.json())[0];
      if (!sess || new Date(sess.expires_at).getTime() < Date.now()) {
        res.status(401).send('Invalid or expired calendar URL. Generate a fresh one from your brand portal.');
        return;
      }
      const brandId = sess.brand_id;
      const bR = await sb(`brands?id=eq.${encodeURIComponent(brandId)}&select=company_name`);
      const brand = (await bR.json())[0];
      if (!brand) { res.status(404).send('Brand not found'); return; }
      const dR = await sb(`demos?brand_id=eq.${encodeURIComponent(brandId)}&status=in.(confirmed,completed,pending)&select=*,retailers(name),venues(name,address)&order=demo_date`);
      const demos = await dR.json();
      const now = new Date();
      const lines = [
        'BEGIN:VCALENDAR', 'VERSION:2.0',
        'PRODID:-//Demohub//Brand calendar feed//EN',
        'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
        fold('X-WR-CALNAME:' + escapeICS(`${brand.company_name} — Demos`)),
        fold('X-WR-CALDESC:' + escapeICS(`All your Demohub demos across every retailer`)),
        'X-WR-TIMEZONE:America/Los_Angeles',
      ];
      (demos || []).forEach(d => {
        const start = parseDemoTime(d.demo_date, d.demo_time);
        if (!start) return;
        const durHours = d.duration_hours || 3;
        const end = new Date(start.getTime() + durHours * 60 * 60 * 1000);
        const retailerName = d.retailers?.name || 'Unknown retailer';
        const venueName = d.venues?.name || '';
        const venueAddr = d.venues?.address || '';
        const summary = `${retailerName}${venueName ? ' · ' + venueName : ''}`;
        const descParts = [];
        if (d.product) descParts.push('Product: ' + d.product);
        if (d.status) descParts.push('Status: ' + d.status);
        descParts.push('Booked via Demohub · demohubhq.com/brand');
        lines.push('BEGIN:VEVENT');
        lines.push('UID:brand-' + d.id + '@demohubhq.com');
        lines.push('DTSTAMP:' + toICSDate(now));
        lines.push('DTSTART:' + toICSDate(start));
        lines.push('DTEND:' + toICSDate(end));
        lines.push(fold('SUMMARY:' + escapeICS(summary)));
        if (venueAddr) lines.push(fold('LOCATION:' + escapeICS(`${venueName}, ${venueAddr}`)));
        else if (venueName) lines.push(fold('LOCATION:' + escapeICS(venueName)));
        lines.push(fold('DESCRIPTION:' + escapeICS(descParts.join('\\n'))));
        lines.push('STATUS:' + (d.status === 'confirmed' ? 'CONFIRMED' : d.status === 'pending' ? 'TENTATIVE' : 'CONFIRMED'));
        lines.push('END:VEVENT');
      });
      lines.push('END:VCALENDAR');
      const out = lines.join('\r\n') + '\r\n';
      res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
      res.setHeader('Content-Disposition', `inline; filename="demohub-demos.ics"`);
      res.setHeader('Cache-Control', 'public, max-age=900');
      res.status(200).send(out);
      return;
    }

    // -------- CRON: daily welcome-series job. Protected by CRON_SECRET. --------
    // Vercel cron invocations send: Authorization: Bearer <CRON_SECRET>
    if (action === 'cron') {
      const auth = String(req.headers?.authorization || req.headers?.Authorization || '');
      const provided = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
      if (!CRON_SECRET || provided !== CRON_SECRET) {
        return jsonResp(res, 401, { error: 'Unauthorized' });
      }

      // === HEARTBEAT: write a start row so we can verify the cron is actually firing ===
      const cronStartMs = Date.now();
      try {
        await sb('cron_heartbeat', {
          method: 'POST',
          body: JSON.stringify({ cron_name: 'daily', outcome: 'started' }),
        });
      } catch (_) { /* heartbeat is best-effort, don't block the work */ }

      const errors = [];
      let retailerDay3Sent = 0;
      let brandFirstDemoSent = 0;
      const nowIso = new Date().toISOString();

      // Retailer day-3 check-in
      try {
        const upperBound = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
        const lowerBound = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
        const path = `retailers?select=id,name,billing_email,branding,slug,welcome_day0_sent_at,welcome_day3_sent_at,created_at` +
          `&created_at=lte.${encodeURIComponent(upperBound)}` +
          `&created_at=gte.${encodeURIComponent(lowerBound)}` +
          `&welcome_day0_sent_at=not.is.null` +
          `&welcome_day3_sent_at=is.null`;
        const rRes = await sb(path);
        const retailers = await rRes.json();
        await processBatched(Array.isArray(retailers) ? retailers : [], 5, async (r) => {
          try {
            const contactName = (r.branding && (r.branding.contact_name || r.branding.contactName)) || '';
            const firstName = String(contactName).trim().split(/\s+/)[0] || r.name || 'there';
            const built = retailerDay3Email({ first_name: firstName });
            const ok = await sendWelcome({ to: r.billing_email, subject: built.subject, html: built.html, text: built.text });
            if (ok) {
              await sb(`retailers?id=eq.${encodeURIComponent(r.id)}`, {
                method: 'PATCH',
                body: JSON.stringify({ welcome_day3_sent_at: nowIso }),
              });
              retailerDay3Sent++;
            } else {
              errors.push({ kind: 'retailer_day3', id: r.id, error: 'send failed' });
            }
          } catch (e) {
            errors.push({ kind: 'retailer_day3', id: r.id, error: String(e?.message || e) });
          }
        });
      } catch (e) {
        errors.push({ kind: 'retailer_day3_query', error: String(e?.message || e) });
      }

      // Brand: 24h after first confirmed demo
      try {
        const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
        const bRes = await sb(`brands?select=id,email,company_name,contact_name,welcome_firstdemo_sent_at&welcome_firstdemo_sent_at=is.null`);
        const brands = await bRes.json();
        await processBatched(Array.isArray(brands) ? brands : [], 5, async (b) => {
          try {
            const dPath = `demos?brand_id=eq.${encodeURIComponent(b.id)}&status=eq.confirmed&confirmed_at=lte.${encodeURIComponent(cutoff)}&select=id,demo_date,confirmed_at,retailers(name)&order=confirmed_at.asc&limit=1`;
            const dRes = await sb(dPath);
            const demos = await dRes.json();
            const demo = Array.isArray(demos) ? demos[0] : null;
            if (!demo) return;
            const retailerName = demo.retailers?.name || 'your retailer';
            let demoDateLabel = demo.demo_date || '';
            try {
              if (demo.demo_date) {
                demoDateLabel = new Date(demo.demo_date + 'T00:00:00Z').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
              }
            } catch (_) {}
            const firstName = String(b.contact_name || '').trim().split(/\s+/)[0] || b.company_name || 'there';
            const built = brandFirstDemoEmail({ first_name: firstName, retailer_name: retailerName, demo_date: demoDateLabel });
            const ok = await sendWelcome({ to: b.email, subject: built.subject, html: built.html, text: built.text });
            if (ok) {
              await sb(`brands?id=eq.${encodeURIComponent(b.id)}`, {
                method: 'PATCH',
                body: JSON.stringify({ welcome_firstdemo_sent_at: nowIso }),
              });
              brandFirstDemoSent++;
            } else {
              errors.push({ kind: 'brand_firstdemo', id: b.id, error: 'send failed' });
            }
          } catch (e) {
            errors.push({ kind: 'brand_firstdemo', id: b.id, error: String(e?.message || e) });
          }
        });
      } catch (e) {
        errors.push({ kind: 'brand_firstdemo_query', error: String(e?.message || e) });
      }

      // COI expiry warnings: 30, 14, 3 days before default_coi_expires
      const coiSent = { tier30: 0, tier14: 0, tier3: 0 };
      const tiers = [
        { days: 30, col: 'coi_warn_30_sent_at', windowLow: 27, windowHigh: 30 },
        { days: 14, col: 'coi_warn_14_sent_at', windowLow: 11, windowHigh: 14 },
        { days: 3,  col: 'coi_warn_3_sent_at',  windowLow: 1,  windowHigh: 3  },
      ];
      for (const tier of tiers) {
        try {
          // Compute date window (inclusive)
          const lo = new Date(Date.now() + tier.windowLow * 86400000);
          const hi = new Date(Date.now() + tier.windowHigh * 86400000);
          const loStr = lo.toISOString().slice(0,10);
          const hiStr = hi.toISOString().slice(0,10);
          const path = `brands?select=id,email,company_name,contact_name,default_coi_expires,${tier.col}` +
            `&default_coi_url=not.is.null` +
            `&default_coi_expires=gte.${loStr}` +
            `&default_coi_expires=lte.${hiStr}` +
            `&${tier.col}=is.null`;
          const r = await sb(path);
          const list = await r.json();
          await processBatched(Array.isArray(list) ? list : [], 5, async (b) => {
            try {
              const ex = new Date(b.default_coi_expires + 'T00:00:00');
              const daysLeft = Math.max(0, Math.ceil((ex.getTime() - Date.now()) / 86400000));
              const expiresLabel = ex.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
              const firstName = String(b.contact_name || '').trim().split(/\s+/)[0] || b.company_name || 'there';
              const built = coiWarningEmail({ tier: tier.days, first_name: firstName, brand_name: b.company_name, expires_label: expiresLabel, days_left: daysLeft });
              const ok = await sendWelcome({ to: b.email, subject: built.subject, html: built.html, text: built.text });
              if (ok) {
                const patch = {}; patch[tier.col] = nowIso;
                await sb(`brands?id=eq.${encodeURIComponent(b.id)}`, { method: 'PATCH', body: JSON.stringify(patch) });
                coiSent['tier' + tier.days]++;
              } else {
                errors.push({ kind: 'coi_warn_' + tier.days, id: b.id, error: 'send failed' });
              }
            } catch (e) {
              errors.push({ kind: 'coi_warn_' + tier.days, id: b.id, error: String(e?.message || e) });
            }
          });
        } catch (e) {
          errors.push({ kind: 'coi_warn_' + tier.days + '_query', error: String(e?.message || e) });
        }
      }

      // Retailer-side COI warnings: 30, 14, 3 days before compliance_records.expires_at
      const retailerCoiSent = { tier30: 0, tier14: 0, tier3: 0 };
      for (const tier of tiers) {
        try {
          const lo = new Date(Date.now() + tier.windowLow * 86400000);
          const hi = new Date(Date.now() + tier.windowHigh * 86400000);
          const loStr = lo.toISOString().slice(0,10);
          const hiStr = hi.toISOString().slice(0,10);
          const path = `compliance_records?select=id,retailer_id,brand_contact_id,expires_at,${tier.col}` +
            `&doc_type=eq.coi` +
            `&expires_at=gte.${loStr}` +
            `&expires_at=lte.${hiStr}` +
            `&${tier.col}=is.null`;
          const r = await sb(path);
          const list = await r.json();
          await processBatched(Array.isArray(list) ? list : [], 5, async (rec) => {
            try {
              // Look up retailer + brand contact
              const [rRes, bcRes] = await Promise.all([
                sb(`retailers?id=eq.${encodeURIComponent(rec.retailer_id)}&select=id,name,billing_email,slug,branding`),
                sb(`brand_contacts?id=eq.${encodeURIComponent(rec.brand_contact_id)}&select=id,name,company,email`),
              ]);
              const ret = (await rRes.json())[0];
              const bc = (await bcRes.json())[0];
              if (!ret || !ret.billing_email) {
                errors.push({ kind: 'retailer_coi_warn_' + tier.days, id: rec.id, error: 'no retailer billing_email' });
                return;
              }
              const brandName = (bc?.company) || (bc?.name) || 'a brand';
              const brandContactName = bc?.name || '';
              const ex = new Date(rec.expires_at + 'T00:00:00');
              const daysLeft = Math.max(0, Math.ceil((ex.getTime() - Date.now()) / 86400000));
              const expiresLabel = ex.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

              // Lookup upcoming demo with this brand (by company name match -> brands -> demos)
              let upcomingDemoLabel = '';
              try {
                if (bc?.company) {
                  const brandRes = await sb(`brands?company_name=eq.${encodeURIComponent(bc.company)}&select=id&limit=1`);
                  const brand = (await brandRes.json())[0];
                  if (brand?.id) {
                    const today = new Date().toISOString().slice(0,10);
                    const dRes = await sb(`demos?brand_id=eq.${encodeURIComponent(brand.id)}&retailer_id=eq.${encodeURIComponent(rec.retailer_id)}&status=in.(pending,confirmed)&demo_date=gte.${today}&select=demo_date&order=demo_date.asc&limit=1`);
                    const d = (await dRes.json())[0];
                    if (d?.demo_date) {
                      upcomingDemoLabel = new Date(d.demo_date + 'T00:00:00Z').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
                    }
                  }
                }
              } catch (_) { /* demo enrichment is nice-to-have */ }

              const retailerDisplayName = (ret.branding && (ret.branding.contact_name || ret.branding.contactName)) || ret.name || '';
              const firstName = String(retailerDisplayName).trim().split(/\s+/)[0] || ret.name || 'there';
              const adminUrl = `https://demohubhq.com/r/${ret.slug /* slug required */}/admin`;
              const built = retailerCoiWarningEmail({
                tier: tier.days, retailer_name: firstName, brand_name: brandName,
                brand_contact_name: brandContactName, expires_label: expiresLabel,
                days_left: daysLeft, upcoming_demo_label: upcomingDemoLabel, admin_url: adminUrl,
              });
              const ok = await sendWelcome({ to: ret.billing_email, subject: built.subject, html: built.html, text: built.text });
              if (ok) {
                const patch = {}; patch[tier.col] = nowIso;
                await sb(`compliance_records?id=eq.${encodeURIComponent(rec.id)}`, { method: 'PATCH', body: JSON.stringify(patch) });
                retailerCoiSent['tier' + tier.days]++;
              } else {
                errors.push({ kind: 'retailer_coi_warn_' + tier.days, id: rec.id, error: 'send failed' });
              }
            } catch (e) {
              errors.push({ kind: 'retailer_coi_warn_' + tier.days, id: rec.id, error: String(e?.message || e) });
            }
          });
        } catch (e) {
          errors.push({ kind: 'retailer_coi_warn_' + tier.days + '_query', error: String(e?.message || e) });
        }
      }

      // ===== Monthly retailer overview (sent once per month, ~1st of each month) =====
      let monthlySummarySent = 0;
      try {
        const now = new Date();
        // Eligible: retailers with monthly_summary_enabled=true and last_sent_at < 28 days ago (or never)
        const twentyEightDaysAgo = new Date(Date.now() - 28 * 24 * 60 * 60 * 1000).toISOString();
        const path = `retailers?select=id,name,billing_email,slug,monthly_summary_enabled,monthly_summary_last_sent_at` +
          `&monthly_summary_enabled=eq.true` +
          `&billing_email=not.is.null` +
          `&or=(monthly_summary_last_sent_at.is.null,monthly_summary_last_sent_at.lt.${encodeURIComponent(twentyEightDaysAgo)})`;
        const eligibleR = await sb(path);
        const eligible = await eligibleR.json();
        const monthLabel = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
        await processBatched(Array.isArray(eligible) ? eligible : [], 5, async (ret) => {
          try {
            // Compute summary metrics for last 30 days
            const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
            const [demosCompletedR, demoFeesR, pendingBookingsR, expiringCoiR] = await Promise.all([
              sb(`demos?retailer_id=eq.${encodeURIComponent(ret.id)}&status=eq.completed&demo_date=gte.${since}&select=demo_fee`),
              sb(`bookings?retailer_id=eq.${encodeURIComponent(ret.id)}&status=eq.pending&select=id`),
              sb(`compliance_records?retailer_id=eq.${encodeURIComponent(ret.id)}&doc_type=eq.coi&expires_at=lt.${new Date(Date.now() + 45 * 86400000).toISOString().slice(0,10)}&select=id`),
              sb(`brand_contacts?retailer_id=eq.${encodeURIComponent(ret.id)}&created_at=gte.${since}&select=id`),
            ]);
            const demosCompleted = await demosCompletedR.json();
            const pendingBookings = await pendingBookingsR.json();
            const expiringCoi = await expiringCoiR.json();
            const newBrands = await (await sb(`brand_contacts?retailer_id=eq.${encodeURIComponent(ret.id)}&created_at=gte.${since}&select=id`)).json();
            const totalFees = Array.isArray(demosCompleted) ? demosCompleted.reduce((s, d) => s + (parseFloat(d.demo_fee) || 0), 0) : 0;
            const demosCount = Array.isArray(demosCompleted) ? demosCompleted.length : 0;
            const pendingCount = Array.isArray(pendingBookings) ? pendingBookings.length : 0;
            const expCoiCount = Array.isArray(expiringCoi) ? expiringCoi.length : 0;
            const newBrandsCount = Array.isArray(newBrands) ? newBrands.length : 0;
            const adminUrl = `https://demohubhq.com/r/${ret.slug}/admin`;
            const subject = `${monthLabel} at ${ret.name} — ${demosCount} demo${demosCount === 1 ? '' : 's'}, $${totalFees.toFixed(0)} in fees`;
            const htmlBody = `<!DOCTYPE html><html><body style="margin:0;padding:24px;background:#fbf7f0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,sans-serif;color:#1c1c1a;">
<table align="center" cellpadding="0" cellspacing="0" style="max-width:600px;margin:0 auto;background:white;border-radius:16px;overflow:hidden;border:1px solid rgba(15,44,23,0.08);">
<tr><td style="padding:28px 32px;background:#0f2c17;">
<table cellpadding="0" cellspacing="0"><tr>
<td style="padding-right:12px;vertical-align:middle;"><svg width="40" height="40" viewBox="0 0 72 72" xmlns="http://www.w3.org/2000/svg"><circle cx="36" cy="36" r="36" fill="#0f2c17"/><circle cx="36" cy="40" r="18" fill="#ed682f"/><rect x="34.5" y="14" width="3" height="10" rx="1.2" fill="#fbf3e0"/><path d="M37 17 Q45 14 48 20 Q44 22 38 21 Q35 19 37 17 Z" fill="#87b08e"/></svg></td>
<td style="font-weight:800;font-size:22px;color:#fbf7f0;letter-spacing:-0.04em;">demohub</td>
</tr></table>
</td></tr>
<tr><td style="padding:32px 36px 8px;">
<div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.12em;color:#a14e2a;margin-bottom:10px;">Monthly overview · ${escapeText(monthLabel)}</div>
<h1 style="font-family:Georgia,serif;font-size:24px;font-weight:500;line-height:1.25;color:#0f2c17;margin:0 0 12px;">Here's what happened last month at ${escapeText(ret.name)}.</h1>
<table cellpadding="0" cellspacing="0" style="width:100%;margin:18px 0 6px;">
<tr>
  <td style="width:50%;padding:14px 12px;text-align:center;background:#f9f7f2;border-radius:10px 0 0 10px;">
    <div style="font-size:1.8rem;font-weight:800;color:#0f2c17;line-height:1;">${demosCount}</div>
    <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.08em;color:#6b6a64;font-weight:600;margin-top:6px;">Demos completed</div>
  </td>
  <td style="width:50%;padding:14px 12px;text-align:center;background:#f9f7f2;border-radius:0 10px 10px 0;border-left:1px solid #ede3d0;">
    <div style="font-size:1.8rem;font-weight:800;color:#0f2c17;line-height:1;">$${totalFees.toFixed(0)}</div>
    <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.08em;color:#6b6a64;font-weight:600;margin-top:6px;">Demo fees collected</div>
  </td>
</tr>
</table>
<table cellpadding="0" cellspacing="0" style="width:100%;margin:8px 0 18px;">
<tr>
  <td style="width:33%;padding:12px 8px;text-align:center;">
    <div style="font-size:1.3rem;font-weight:700;color:#0f2c17;line-height:1;">${pendingCount}</div>
    <div style="font-size:10px;text-transform:uppercase;letter-spacing:0.08em;color:#6b6a64;font-weight:600;margin-top:6px;">Pending bookings</div>
  </td>
  <td style="width:33%;padding:12px 8px;text-align:center;border-left:1px solid #ede3d0;">
    <div style="font-size:1.3rem;font-weight:700;color:${expCoiCount > 0 ? '#a14e2a' : '#0f2c17'};line-height:1;">${expCoiCount}</div>
    <div style="font-size:10px;text-transform:uppercase;letter-spacing:0.08em;color:#6b6a64;font-weight:600;margin-top:6px;">COIs expiring &lt; 45d</div>
  </td>
  <td style="width:33%;padding:12px 8px;text-align:center;border-left:1px solid #ede3d0;">
    <div style="font-size:1.3rem;font-weight:700;color:#0f2c17;line-height:1;">${newBrandsCount}</div>
    <div style="font-size:10px;text-transform:uppercase;letter-spacing:0.08em;color:#6b6a64;font-weight:600;margin-top:6px;">New brand contacts</div>
  </td>
</tr>
</table>
${pendingCount > 0 ? `<p style="background:#fff3ed;border-left:3px solid #ed682f;padding:12px 16px;border-radius:6px;font-size:13px;color:#3a3a36;margin:14px 0;">${pendingCount} booking${pendingCount === 1 ? ' is' : 's are'} waiting for your confirmation. <a href="${adminUrl}" style="color:#a14e2a;font-weight:700;">Review them &rarr;</a></p>` : ''}
${expCoiCount > 0 ? `<p style="background:#fff3ed;border-left:3px solid #ed682f;padding:12px 16px;border-radius:6px;font-size:13px;color:#3a3a36;margin:14px 0;">${expCoiCount} brand${expCoiCount === 1 ? '' : 's'} ha${expCoiCount === 1 ? 's' : 've'} a COI expiring within 45 days. Brands receive automatic 30/14/3 day warnings, but you can preview which here. <a href="${adminUrl}" style="color:#a14e2a;font-weight:700;">View compliance &rarr;</a></p>` : ''}
<p style="font-size:14px;color:#3a3a36;line-height:1.55;margin:18px 0;">Open your admin to dig into specific demos, brand contacts, payouts, and more.</p>
<p style="margin:0 0 18px;"><a href="${adminUrl}" style="background:#0f2c17;color:white;padding:13px 22px;border-radius:10px;text-decoration:none;font-weight:600;display:inline-block;font-size:14px;">Open admin &rarr;</a></p>
<p style="font-size:12px;color:#6b6a64;line-height:1.5;margin:20px 0 0;">These monthly overviews are on by default. You can turn them off anytime from Settings &rarr; Notifications.</p>
</td></tr>
<tr><td style="padding:20px 32px;background:#fbf7f0;border-top:1px solid rgba(15,44,23,0.06);font-size:12px;color:#6b6a64;text-align:center;line-height:1.5;">Demohub LLC &middot; 6700 Fallbrook Ave #125, West Hills, CA 91307<br>You're receiving this monthly overview because you have a Demohub admin account. Manage in Settings &rarr; Notifications.</td></tr>
</table></body></html>`;
            const ok = await sendWelcome({ to: ret.billing_email, subject, html: htmlBody, text: `Your ${monthLabel} overview at ${ret.name}: ${demosCount} demos completed, $${totalFees.toFixed(0)} in fees, ${pendingCount} pending bookings. Open ${adminUrl}` });
            if (ok) {
              await sb(`retailers?id=eq.${encodeURIComponent(ret.id)}`, {
                method: 'PATCH',
                body: JSON.stringify({ monthly_summary_last_sent_at: new Date().toISOString() }),
              });
              monthlySummarySent++;
            } else {
              errors.push({ kind: 'monthly_summary', id: ret.id, error: 'send failed' });
            }
          } catch (e) {
            errors.push({ kind: 'monthly_summary', id: ret.id, error: String(e?.message || e) });
          }
        });
      } catch (e) {
        errors.push({ kind: 'monthly_summary_query', error: String(e?.message || e) });
      }

      // === HEARTBEAT: write success row with summary ===
      try {
        await sb('cron_heartbeat', {
          method: 'POST',
          body: JSON.stringify({
            cron_name: 'daily',
            outcome: 'succeeded',
            duration_ms: Date.now() - cronStartMs,
            summary: { retailerDay3Sent, brandFirstDemoSent, coiSent, retailerCoiSent, monthlySummarySent, errors: errors.length },
          }),
        });
      } catch (_) { /* best-effort */ }
      return jsonResp(res, 200, { ok: true, retailerDay3Sent, brandFirstDemoSent, coiSent, retailerCoiSent, errors, ran_at: nowIso });
    }

    return jsonResp(res, 400, { error: 'Unknown action' });
  } catch (e) {
    console.error('brand-account error:', e);
    return jsonResp(res, 500, { error: String(e && e.message ? e.message : e) });
  }
}
