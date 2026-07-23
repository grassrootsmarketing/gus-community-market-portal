// api/_verify.js — F5-02: race-safe email-ownership verification.
// create a challenge (hashed 6-digit code, 30-min expiry) and consume it exactly once.
// The consume is a conditional UPDATE (consumed_at IS NULL) so two concurrent redeems
// cannot both succeed. No account/session is issued until consume() returns ok.

import crypto from 'node:crypto';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const PEPPER = process.env.VERIFY_PEPPER || process.env.CRON_SECRET || 'dev-pepper';

function rest(path, opts = {}) {
  return fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...opts,
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
}
function hashCode(email, purpose, code) {
  return crypto.createHmac('sha256', PEPPER).update(`${String(email).toLowerCase()}|${purpose}|${code}`).digest('hex');
}
function newCode() { return String(crypto.randomInt(0, 1000000)).padStart(6, '0'); }

// Create a challenge. Returns the raw code (to email) — never stored raw.
export async function createChallenge(email, purpose, payload = null, ttlMinutes = 30) {
  const e = String(email || '').trim().toLowerCase();
  if (!e || !/^[^@]+@[^@]+\.[^@]+$/.test(e)) throw new Error('invalid email');
  const code = newCode();
  const body = {
    email: e, purpose, code_hash: hashCode(e, purpose, code),
    payload: payload || null, attempts: 0,
    expires_at: new Date(Date.now() + ttlMinutes * 60000).toISOString(),
  };
  const r = await rest('email_verifications', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error('could not create verification: ' + (await r.text()).slice(0, 160));
  const row = (await r.json())[0];
  return { id: row.id, code, email: e, purpose };
}

// Redeem. Atomic single-use. Returns { ok, payload } or { ok:false, reason }.
export async function consumeChallenge(email, purpose, code) {
  const e = String(email || '').trim().toLowerCase();
  const wantHash = hashCode(e, purpose, String(code || ''));
  // find the newest live, unconsumed, unexpired challenge for this (email, purpose)
  const q = await rest(`email_verifications?email=eq.${encodeURIComponent(e)}&purpose=eq.${encodeURIComponent(purpose)}&consumed_at=is.null&expires_at=gt.${encodeURIComponent(new Date().toISOString())}&select=id,code_hash,payload,attempts&order=created_at.desc&limit=1`);
  const rows = q.ok ? await q.json() : [];
  const row = Array.isArray(rows) ? rows[0] : null;
  if (!row) return { ok: false, reason: 'no_active_code' };
  if (row.attempts >= 6) return { ok: false, reason: 'too_many_attempts' };
  if (row.code_hash !== wantHash) {
    await rest(`email_verifications?id=eq.${row.id}`, { method: 'PATCH', body: JSON.stringify({ attempts: row.attempts + 1 }) });
    return { ok: false, reason: 'wrong_code' };
  }
  // atomic claim: only succeeds if still unconsumed
  const claim = await rest(`email_verifications?id=eq.${row.id}&consumed_at=is.null`, {
    method: 'PATCH', headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ consumed_at: new Date().toISOString() }),
  });
  const claimed = claim.ok ? await claim.json() : [];
  if (!Array.isArray(claimed) || claimed.length !== 1) return { ok: false, reason: 'already_used' };
  return { ok: true, payload: row.payload || null };
}
