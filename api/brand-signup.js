// api/brand-signup.js — F5-04: verified brand account creation / passwordless-claim.
// Kills the takeover hole: you can only set a password + get a session for an email AFTER
// proving you own it. An account that ALREADY has a password can never be "claimed" — that
// path is login only. Password format matches the existing login (<salt_hex>$<hash_hex>, scrypt).

import crypto from 'node:crypto';
import { createChallenge, consumeChallenge } from './_verify.js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const RESEND_API_KEY = process.env.RESEND_API_KEY;

function rest(path, opts = {}) {
  return fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...opts,
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
}
// matches brand-account.js: <salt_hex>$<hash_hex>, 16-byte salt, 64-byte scrypt, Node defaults
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const dk = crypto.scryptSync(password, salt, 64);
  return salt.toString('hex') + '$' + dk.toString('hex');
}

// Core: create or claim a brand — ONLY called after email verification succeeds.
// Returns { ok, reason? , brand_id, session_token }.
export async function provisionOrClaimVerifiedBrand(email, password, profile = {}) {
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
  return { ok: true, brand_id: brandId, session_token: token };
}

async function sendCode(email, code) {
  if (!RESEND_API_KEY) return;
  try { await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ from: 'Demohub <bookings@demohubhq.com>', to: email, subject: 'Your Demohub verification code', html: `<p>Your code is <strong>${code}</strong> (expires in 30 min).</p>` }) }); } catch (_) {}
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  let body = {}; try { body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}); } catch (_) {}
  const action = String(body.action || '');
  const email = String(body.email || '').trim().toLowerCase();
  if (!/^[^@]+@[^@]+\.[^@]+$/.test(email)) return res.status(400).json({ error: 'valid email required' });

  if (action === 'request') {
    try { const ch = await createChallenge(email, 'brand_signup', null); await sendCode(email, ch.code); } catch (_) {}
    return res.status(200).json({ ok: true, message: 'If that email can receive mail, a code is on its way.' });
  }
  if (action === 'verify') {
    const r = await consumeChallenge(email, 'brand_signup', String(body.code || ''));
    if (!r.ok) return res.status(400).json({ error: 'verification_failed', reason: r.reason });
    const out = await provisionOrClaimVerifiedBrand(email, String(body.password || ''), { company_name: body.company_name, contact_name: body.contact_name, phone: body.phone });
    if (!out.ok) return res.status(out.reason === 'account_exists_login_instead' ? 409 : 400).json({ error: out.reason });
    return res.status(200).json({ ok: true, session_token: out.session_token });
  }
  return res.status(400).json({ error: 'unknown action' });
}
