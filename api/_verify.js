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

// Codex C-4: every RPC call is bounded (request and body read share one deadline) and its failure is reported as
// one of a few allowlisted codes. The provider's body never travels in an error: a PostgREST message can quote
// the SQL, the arguments or a hint, none of which belong in a log line or a reply.
export const RPC_TIMEOUT_MS = 10000;
export const VERIFY_ERROR_CODES = Object.freeze(['rpc_missing', 'db_timeout', 'db_unreachable', 'db_forbidden', 'db_failed', 'invalid_response']);
export class VerifyError extends Error {
  constructor(code, status) { super(code); this.name = 'VerifyError'; this.code = VERIFY_ERROR_CODES.includes(code) ? code : 'db_failed'; this.status = status || null; }
}
function classify(status, json) {
  if (status === 404 || (json && json.code === 'PGRST202')) return 'rpc_missing';            // function not in the schema (old database, new code)
  if (status === 401 || status === 403 || status === 406) return 'db_forbidden';
  return 'db_failed';
}
async function rpc(name, args) {
  const b = await getBinding();
  const signal = globalThis.AbortSignal.timeout(RPC_TIMEOUT_MS);
  let r, text;
  try {
    r = await fetch(`${b.supabaseUrl}/rest/v1/rpc/${name}`, {
      method: 'POST', signal,
      headers: { apikey: b.serviceKey, Authorization: `Bearer ${b.serviceKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
    });
    text = await r.text();
  } catch (e) {
    throw new VerifyError((e && (e.name === 'TimeoutError' || e.name === 'AbortError')) ? 'db_timeout' : 'db_unreachable');
  }
  let json = null; try { json = text ? JSON.parse(text) : null; } catch (_) {}
  if (!r.ok) throw new VerifyError(classify(r.status, json), r.status);
  if (json === null || typeof json !== 'object') throw new VerifyError('invalid_response', r.status);
  return json;
}

export function hashCode(email, purpose, code) {
  return crypto.createHmac('sha256', requirePepper()).update(`${normalizeEmail(email)}|${purpose}|${code}`).digest('hex');
}
function newCode() { return String(crypto.randomInt(0, 1000000)).padStart(6, '0'); }

// Issue a code into the address's current window (the database opens a new window when the previous one has
// lapsed or succeeded). Returns { issued:true, id, code, email, purpose, expires_at, window_seq } with the raw code
// (to email; never stored), or { issued:false, reason:'exhausted' } when the window's guess budget is spent and
// has not lapsed yet (Codex C-2): nothing was inserted, no live-code slot was used, and the caller must send no
// mail, because no code can match until the window ends. Database failures throw a VerifyError (allowlisted code).
export async function createChallenge(email, purpose, payload = null) {
  const e = normalizeEmail(email);
  if (!e || !/^[^@]+@[^@]+\.[^@]+$/.test(e)) throw new VerifyError('invalid_response');
  const code = newCode();
  const out = await rpc('verification_issue', {
    p_email: e, p_purpose: purpose, p_code_hash: hashCode(e, purpose, code),
    p_payload: payload || null, p_window_minutes: WINDOW_MINUTES, p_max_live: MAX_LIVE_CODES,
  });
  if (out.outcome === 'exhausted') return { issued: false, reason: 'exhausted', email: e, purpose, expires_at: out.expires_at || null };
  if (!out.id) throw new VerifyError('invalid_response');
  return { issued: true, id: out.id, code, email: e, purpose, expires_at: out.expires_at, window_seq: out.window_seq };
}

// Whole minutes until the window deadline, for the email copy ("It expires in N minutes."). Never below 1.
export function minutesUntil(iso) {
  const ms = new Date(iso).getTime() - Date.now();
  return Number.isFinite(ms) ? Math.max(1, Math.ceil(ms / 60000)) : WINDOW_MINUTES;
}

// Retailer redeem: match against the window's live set and provision the store in ONE transaction.
// Returns { ok:true, already, retailer_id, slug, session_id, payload } or { ok:false, reason } where reason is one
// of no_active_code | expired | already_used | too_many_attempts | wrong_code | bad_code_shape. A database failure
// is { ok:false, reason:'verification_unavailable', unavailable:true, code } (allowlisted code): callers fail
// closed and say so, and never present it as a wrong code.
export async function redeemRetailerSignup(email, code) {
  const e = normalizeEmail(email);
  if (!isCodeShape(code)) return { ok: false, reason: 'bad_code_shape' };
  let out;
  try { out = await rpc('redeem_retailer_signup', { p_email: e, p_code_hash: hashCode(e, 'retailer_signup', String(code).trim()), p_max_attempts: MAX_FAILED_GUESSES }); }
  catch (err) { return { ok: false, reason: 'verification_unavailable', unavailable: true, code: err instanceof VerifyError ? err.code : 'db_failed' }; }
  if (!out.outcome) return { ok: false, reason: 'verification_unavailable', unavailable: true, code: 'invalid_response' };
  if (out.outcome !== 'ok') return { ok: false, reason: out.outcome === 'invalid' ? 'wrong_code' : out.outcome };
  return { ok: true, already: !!out.already, retailer_id: out.retailer_id, slug: out.slug, session_id: out.session_id || null, payload: out.payload || {} };
}

// Brand redeem: the RPC call only (the route maps outcomes and sets the cookie). Same failure contract.
export async function redeemBrandSignup(email, code, sessionToken) {
  const e = normalizeEmail(email);
  try { return { ok: true, out: await rpc('redeem_brand_signup', { p_email: e, p_code_hash: hashCode(e, 'brand_signup', String(code).trim()), p_session_token: sessionToken, p_session_days: 30, p_max_attempts: MAX_FAILED_GUESSES }) }; }
  catch (err) { return { ok: false, code: err instanceof VerifyError ? err.code : 'db_failed' }; }
}
