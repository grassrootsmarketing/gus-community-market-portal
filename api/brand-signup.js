// api/brand-signup.js — F5-04: verified brand account creation / passwordless-claim.
// Kills the takeover hole: you can only set a password + get a session for an email AFTER
// proving you own it. An account that ALREADY has a password can never be "claimed" — that
// path is login only. Password format matches the existing login (<salt_hex>$<hash_hex>, scrypt).

import crypto from 'node:crypto';
import { createChallenge, hashCode } from './_verify.js';

import { getBinding, sendBindingFailure } from './_env.js';
import { setSessionCookie as setRoleCookie } from './_cookies.js';
import { requireSameOrigin } from './_csrf.js';
import { sendMailQuietly } from './_mail.js';
let _b = null;

function rest(path, opts = {}) {
  return fetch(`${_b.supabaseUrl}/rest/v1/${path}`, {
    ...opts,
    headers: { apikey: _b.serviceKey, Authorization: `Bearer ${_b.serviceKey}`, 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
}

// Set the HttpOnly brand-session cookie (matches brand-account.js) so a verified brand is
// immediately signed in for booking — no token handling in page JS.
// Codex finding B: "matches brand-account.js" was a promise kept by hand, in a duplicated
// attribute string. Delegated, so the name and attributes have one definition.
function setBrandCookie(res, token) {
  setRoleCookie(res, 'brand', token);
}

// matches brand-account.js: <salt_hex>$<hash_hex>, 16-byte salt, 64-byte scrypt, Node defaults
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const dk = crypto.scryptSync(password, salt, 64);
  return salt.toString('hex') + '$' + dk.toString('hex');
}

// Core: create or claim a brand — ONLY called after email verification succeeds.
// Returns { ok, reason? , brand_id, session_token }.
// RETIRED — Codex finding A: exactly one canonical provisioning path. Everything this used to do
// now happens inside redeem_brand_signup() (migration 0053) as one transaction. Kept as a throwing
// stub rather than deleted so any forgotten caller fails loudly instead of silently taking a
// second, unreviewed route to the same tables.
export async function provisionOrClaimVerifiedBrand() {
  throw new Error('retired: use the redeem_brand_signup RPC via POST /api/brand-signup {action:"verify"}');
}
async function _retired_provisionOrClaimVerifiedBrand(email, password, profile = {}) {
  const e = String(email).trim().toLowerCase();
  if (!password || String(password).length < 8) return { ok: false, reason: 'weak_password' };
  const look = await rest(`brands?email=eq.${encodeURIComponent(e)}&select=id,password_hash&limit=1`);
  const rows = look.ok ? await look.json() : [];
  const existing = rows[0] || null;

  if (existing && existing.password_hash) {
    // Active account already exists — do NOT let anyone re-claim it. This is the takeover guard.
    return { ok: false, reason: 'account_exists_login_instead' };
  }
  const password_hash = hashPassword(password);
  let brandId;
  if (existing) {
    // legitimate claim of a passwordless row — now verified
    await rest(`brands?id=eq.${existing.id}`, { method: 'PATCH', body: JSON.stringify({ password_hash, is_verified: true, updated_at: new Date().toISOString() }) });
    brandId = existing.id;
  } else {
    const cr = await rest('brands', { method: 'POST', headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ email: e, password_hash, is_verified: true, company_name: profile.company_name || null, contact_name: profile.contact_name || null, phone: profile.phone || null }) });
    if (!cr.ok) return { ok: false, reason: 'create_failed' };
    brandId = (await cr.json())[0].id;
  }
  // ensure a brand_members row + issue a session
  await rest('brand_members', { method: 'POST', body: JSON.stringify({ brand_id: brandId, email: e, role: 'owner', name: profile.contact_name || null }) }).catch(() => {});
  const token = crypto.randomUUID();
  await rest('brand_account_sessions', { method: 'POST', body: JSON.stringify({ session_token: token, brand_id: brandId, email: e, expires_at: new Date(Date.now() + 30 * 864e5).toISOString() }) });
  // session_token here reaches no HTTP response: this whole function is unreachable (its only
  // export is the throwing stub above), and the live verify path returns brand_id + created only.
  return { ok: true, brand_id: brandId, session_token: token };
}

// Branded verification email, consistent with the retailer login template (api/admin-auth.js).
function verificationCodeEmail(code) {
  return `<!DOCTYPE html><html><body style="margin:0;padding:24px;background:#fbf7f0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,sans-serif;color:#1c1c1a;">
<table align="center" cellpadding="0" cellspacing="0" style="max-width:480px;margin:0 auto;background:#ffffff;border-radius:16px;overflow:hidden;border:1px solid rgba(15,44,23,0.08);">
<tr><td style="padding:24px 32px;background:#0f2c17;"><span style="font-weight:800;font-size:22px;color:#fbf7f0;letter-spacing:-0.04em;">demohub</span></td></tr>
<tr><td style="padding:34px 36px 30px;text-align:center;">
<div style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.14em;color:#a14e2a;margin-bottom:16px;">Verify your email</div>
<div style="font-size:13px;color:#6b6a64;margin-bottom:12px;">Your verification code</div>
<div style="font-size:38px;font-weight:800;letter-spacing:0.18em;color:#0f2c17;font-family:'SFMono-Regular',Menlo,Monaco,Consolas,monospace;margin-bottom:14px;">${code}</div>
<div style="font-size:13px;color:#6b6a64;">This code expires in 30 minutes.</div>
<p style="font-size:12px;color:#9a978f;line-height:1.5;margin:22px 0 0;">If you didn't request this, you can ignore this email &mdash; no action will be taken.</p>
</td></tr>
<tr><td style="padding:16px 36px;background:#faf7f0;border-top:1px solid rgba(15,44,23,0.06);font-size:11px;color:#9a978f;text-align:center;">Demohub LLC &middot; 6700 Fallbrook Ave #125, West Hills, CA 91307</td></tr>
</table></body></html>`;
}

async function sendCode(email, code) {
  if (!_b.resendApiKey) return;
  await sendMailQuietly({ from: 'Demohub <bookings@demohubhq.com>', to: email, subject: 'Your Demohub verification code', html: verificationCodeEmail(code) }, { binding: _b });
}

const GENERIC_REQUEST_REPLY = 'If that email can receive mail, a code is on its way.';

async function rpc(fn, args) {
  const r = await fetch(`${_b.supabaseUrl}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: { apikey: _b.serviceKey, Authorization: `Bearer ${_b.serviceKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch (_) {}
  return { ok: r.ok, status: r.status, json: j };
}

// Durable throttle. Fails CLOSED: if the counter cannot be read we refuse rather than allow,
// because an attacker who can break the throttle store should not thereby remove the throttle.
async function throttle(scope, key, purpose, limit) {
  if (!key) return false;
  const r = await rpc('verification_throttle_hit', {
    p_scope: scope, p_key: String(key), p_purpose: purpose, p_limit: limit,
    p_window_minutes: 60, p_block_minutes: 60,
  });
  if (!r.ok || !r.json) return false;
  return r.json.allowed === true;
}

// Only a proxy-set address is trusted; a client-supplied header must never widen the quota.
function clientIp(req) {
  const xff = String(req.headers['x-forwarded-for'] || '');
  const first = xff.split(',')[0].trim();
  return first || String(req.headers['x-real-ip'] || '') || 'unknown';
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  try { _b = await getBinding(); } catch (e) { return sendBindingFailure(res, e); }
  // Codex finding B: the verify action creates or claims a brand account and issues a session
  // cookie, so a cross-origin page must not be able to drive it. No exemption applies.
  if (!requireSameOrigin(req, res, _b)) return;
  let body = {}; try { body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}); } catch (_) {}
  const action = String(body.action || '');
  const email = String(body.email || '').trim().toLowerCase();
  if (!/^[^@]+@[^@]+\.[^@]+$/.test(email)) return res.status(400).json({ error: 'valid email required' });

  if (action === 'request') {
    // Codex finding A: the REQUEST stage creates only a verification challenge. Nothing about
    // the brand, its profile, its membership or a session is written here. The old reachable
    // handler (brand-account.js?action=signup) wrote all four before any email proof, which let
    // anyone overwrite a passwordless brand's profile by "signing up" as it.
    //
    // Durable throttles on BOTH axes, in the database rather than in memory, so they survive
    // both challenge churn and serverless instance recycling. Neither axis alone can be used to
    // exhaust the other.
    const ipOk = await throttle('ip', clientIp(req), 'brand_signup', 20);
    const emOk = await throttle('email', email, 'brand_signup', 5);
    if (!ipOk || !emOk) {
      // Deliberately the SAME response as success: a distinguishable rate-limit reply is an
      // account-existence and traffic oracle.
      return res.status(200).json({ ok: true, message: GENERIC_REQUEST_REPLY });
    }
    try {
      // Profile fields ride on the challenge payload. They are applied only at redeem time,
      // and only to fields that are currently blank.
      const ch = await createChallenge(email, 'brand_signup', {
        company_name: String(body.company_name || '').trim() || null,
        contact_name: String(body.contact_name || '').trim() || null,
        phone: String(body.phone || '').trim() || null,
      });
      await sendCode(email, ch.code);
    } catch (e) {
      // Never reveal whether the address exists, is throttled, or the mail provider failed.
      console.warn('brand_signup request failed', JSON.stringify({ code: (e && e.message) || 'unknown' }));
    }
    return res.status(200).json({ ok: true, message: GENERIC_REQUEST_REPLY });
  }
  if (action === 'verify') {
    // Throttle the redeem axis too, so a fresh challenge per guess cannot reset the counter.
    const ipOk = await throttle('ip', clientIp(req), 'brand_verify', 30);
    const emOk = await throttle('email', email, 'brand_verify', 10);
    if (!ipOk || !emOk) return res.status(429).json({ error: 'too_many_attempts' });

    // ONE round trip does all of: match the code, consume the challenge, provision the brand,
    // create the owner membership, and issue the session — in a single transaction that claims
    // the challenge row FOR UPDATE. Codex finding A required atomicity here; previously a crash
    // between consume and provision left the code spent and the brand absent, and N parallel
    // guesses could all read the same pre-increment attempt count.
    const token = crypto.randomUUID();
    const r = await rpc('redeem_brand_signup', {
      p_email: email,
      p_code_hash: hashCode(email, 'brand_signup', String(body.code || '')),
      p_session_token: token,
      p_session_days: 30,
      p_max_attempts: 6,
    });
    if (!r.ok) return res.status(503).json({ error: 'verification_unavailable' });
    const out = r.json || {};

    if (out.outcome !== 'ok') {
      // One response for every failure mode. Distinguishing "wrong code" from "no challenge"
      // from "already used" tells an attacker which emails have pending signups.
      const status = out.outcome === 'too_many_attempts' ? 429 : 400;
      return res.status(status).json({ error: 'verification_failed' });
    }

    setBrandCookie(res, token);
    // Codex finding B: the session goes in the HttpOnly cookie ONLY. It is not returned in the
    // body, so page JavaScript cannot read it and it cannot land in localStorage or a log.
    return res.status(200).json({ ok: true, brand_id: out.brand_id, created: !!out.created });
  }
  return res.status(400).json({ error: 'unknown action' });
}
