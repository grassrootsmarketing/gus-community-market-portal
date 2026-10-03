// api/_verify.js — F5-02: race-safe email-ownership verification.
//
// Codex S-2 (2026-10-03): issuance and redemption live in the database (migration 0089). One VERIFICATION WINDOW
// per (normalized email, purpose) serializes both paths, holds the shared failed-guess budget and the deadline,
// keeps at most five live codes, and on success consumes the matched code and retires its siblings. This module
// only hashes the code and calls the RPCs; it never decides which row is "newest".
//
//   createChallenge(email, purpose, payload)  -> verification_issue
//   redeemRetailerSignup(email, code)         -> redeem_retailer_signup (match + provision, one transaction)
//   brand sign-in                              -> redeem_brand_signup, called directly by api/brand-signup.js
//
// consumeChallenge (the old newest-row, read-then-write verifier) is gone: nothing may compare codes outside the
// window lock.

import crypto from 'node:crypto';

import { getBinding } from './_env.js';
import { MIN_PEPPER_LEN } from './_signin-config.js';   // the one compatibility floor (Codex S-1)

// Codex finding A: the pepper had two fallbacks, and both were disqualifying.
//   process.env.CRON_SECRET  — reuses one secret for two unrelated purposes, so rotating the
//                              cron secret silently invalidates every outstanding login code,
//                              and a cron-secret leak becomes a code-forgery capability.
//   'dev-pepper'             — a public constant in a public repository. With it, anyone can
//                              compute a valid code hash for any email offline.
// Now required, with a length floor. Missing or weak configuration means codes cannot be
// issued or verified at all, which is the correct failure for an auth primitive.
function requirePepper() {
  const p = process.env.VERIFY_PEPPER;
  if (!p || String(p).trim().length < MIN_PEPPER_LEN) {
    throw new Error('verify_pepper_not_configured');
  }
  return String(p).trim();
}

export const WINDOW_MINUTES = 30;
export const MAX_LIVE_CODES = 5;
export const MAX_FAILED_GUESSES = 6;

// One normalization for issuance and redemption (the RPCs apply lower(btrim()) again, identically).
export function normalizeEmail(email) { return String(email || '').trim().toLowerCase(); }
// A code is exactly six digits. Anything else is refused before hashing, so a malformed guess never reaches the
// budget as a "wrong code" and never costs a database round trip.
export function isCodeShape(code) { return /^[0-9]{6}$/.test(String(code == null ? '' : code).trim()); }

async function rpc(name, args) {
  const b = await getBinding();
  const r = await fetch(`${b.supabaseUrl}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: { apikey: b.serviceKey, Authorization: `Bearer ${b.serviceKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  const text = await r.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch (_) {}
  return { ok: r.ok, status: r.status, json, text };
}

export function hashCode(email, purpose, code) {
  return crypto.createHmac('sha256', requirePepper()).update(`${normalizeEmail(email)}|${purpose}|${code}`).digest('hex');
}
function newCode() { return String(crypto.randomInt(0, 1000000)).padStart(6, '0'); }

// Issue a code into the address's current window (the database opens a new window when the previous one has
// lapsed or succeeded). Returns the raw code (to email) and the window deadline the code expires at; the raw
// code is never stored.
export async function createChallenge(email, purpose, payload = null) {
  const e = normalizeEmail(email);
  if (!e || !/^[^@]+@[^@]+\.[^@]+$/.test(e)) throw new Error('invalid email');
  const code = newCode();
  const r = await rpc('verification_issue', {
    p_email: e, p_purpose: purpose, p_code_hash: hashCode(e, purpose, code),
    p_payload: payload || null, p_window_minutes: WINDOW_MINUTES, p_max_live: MAX_LIVE_CODES,
  });
  if (!r.ok || !r.json || !r.json.id) throw new Error('could not create verification: ' + String(r.text || '').slice(0, 160));
  return { id: r.json.id, code, email: e, purpose, expires_at: r.json.expires_at, window_seq: r.json.window_seq };
}

// Whole minutes until the window deadline, for the email copy ("It expires in N minutes."). Never below 1.
export function minutesUntil(iso) {
  const ms = new Date(iso).getTime() - Date.now();
  return Number.isFinite(ms) ? Math.max(1, Math.ceil(ms / 60000)) : WINDOW_MINUTES;
}

// Retailer redeem: match against the window's live set and provision the store in ONE transaction.
// Returns { ok:true, already, retailer_id, slug, session_id, payload } or { ok:false, reason } where reason is one
// of no_active_code | expired | already_used | too_many_attempts | wrong_code | bad_code_shape. A database failure
// is { ok:false, reason:'verification_unavailable', unavailable:true }: callers fail closed and say so, and never
// present it as a wrong code.
export async function redeemRetailerSignup(email, code) {
  const e = normalizeEmail(email);
  if (!isCodeShape(code)) return { ok: false, reason: 'bad_code_shape' };
  const r = await rpc('redeem_retailer_signup', { p_email: e, p_code_hash: hashCode(e, 'retailer_signup', String(code).trim()), p_max_attempts: MAX_FAILED_GUESSES });
  if (!r.ok || !r.json || !r.json.outcome) return { ok: false, reason: 'verification_unavailable', unavailable: true };
  const out = r.json;
  if (out.outcome !== 'ok') return { ok: false, reason: out.outcome === 'invalid' ? 'wrong_code' : out.outcome };
  return { ok: true, already: !!out.already, retailer_id: out.retailer_id, slug: out.slug, session_id: out.session_id || null, payload: out.payload || {} };
}
