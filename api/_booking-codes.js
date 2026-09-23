// _booking-codes.js — shared pieces of the booking-code feature (0085). Pure; no I/O.
//   * code shape: PREFIX-KIND-RANDOM, upper-case, e.g. GUS-FREE-7K3M. Generated server-side only.
//   * messages the booking page shows for each refusal reason.
import { randomBytes } from 'node:crypto';

export const CODE_RE = /^[A-Z0-9]{2,12}(-[A-Z0-9]{2,12}){0,3}$/;
export function normalizeCode(s) { const c = String(s || '').trim().toUpperCase().replace(/\s+/g, ''); return CODE_RE.test(c) ? c : null; }

// Unambiguous alphabet (no 0/O/1/I) for the random part.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
// Codex BC-5: eight uniformly drawn symbols (40 bits) — rejection sampling, no modulo bias. Codex BC-4: a prefix
// shorter than two characters is padded so every generated code satisfies CODE_RE and the database constraint.
export const RANDOM_LEN = 8;
export function generateCode(retailerSlug, kind) {
  let prefix = String(retailerSlug || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
  if (prefix.length < 2) prefix = ('DH' + prefix).slice(0, 4);
  const mid = kind === 'both' ? 'VIP' : kind === 'fee' ? 'FREE' : 'SOON';
  let rnd = ''; while (rnd.length < RANDOM_LEN) { const b = randomBytes(16); for (const x of b) { if (x < 224 && rnd.length < RANDOM_LEN) rnd += ALPHABET[x % 32]; } }
  return `${prefix}-${mid}-${rnd}`;
}
export function kindOf({ waives_fee, waives_lead_time }) { return waives_fee && waives_lead_time ? 'both' : waives_fee ? 'fee' : waives_lead_time ? 'lead_time' : null; }
export function kindFlags(kind) {
  if (kind === 'fee') return { waives_fee: true, waives_lead_time: false };
  if (kind === 'lead_time') return { waives_fee: false, waives_lead_time: true };
  if (kind === 'both') return { waives_fee: true, waives_lead_time: true };
  return null;
}
export const KIND_LABELS = { fee: 'No demo fee', lead_time: 'Short-notice booking', both: 'No fee + short notice' };
export const CODE_MESSAGES = {
  too_many_attempts: 'Too many code attempts. Wait a few minutes and try again.',
  code_unavailable: 'Codes cannot be checked right now. You can still book at the normal price.',
  code_not_found: 'That code is not valid for this store.',
  code_inactive: 'That code has been turned off.',
  code_expired: 'That code has expired.',
  code_used_up: 'That code has already been used the maximum number of times.',
  code_invalid_format: 'Codes look like GUS-FREE-7K3M.',
  booking_already_has_code: 'A code was already applied to this booking.',
  booking_not_redeemable: 'This booking can no longer take a code.',
  booking_in_checkout: 'This booking is already in checkout.',
};

// Validates the retailer/owner "create code" request body. Returns { ok, error } or { ok, row }.
export function validateCreate(body) {
  const flags = kindFlags(body.kind); if (!flags) return { ok: false, error: 'invalid_kind' };
  // Codex BC-4: single use is the default. Unlimited is only the explicit string 'unlimited'; an omitted value is 1;
  // an empty string, null, a boolean or anything non-integer is refused rather than read as "no limit".
  let max_uses = 1;
  if (body.max_uses !== undefined) {
    if (body.max_uses === 'unlimited') max_uses = null;
    else { const n = (typeof body.max_uses === 'number' || (typeof body.max_uses === 'string' && /^\d+$/.test(body.max_uses))) ? Number(body.max_uses) : NaN; if (!Number.isInteger(n) || n < 1 || n > 1000) return { ok: false, error: 'invalid_max_uses' }; max_uses = n; }
  }
  let expires_at = null;
  if (body.expires_at) { const d = new Date(body.expires_at); if (Number.isNaN(d.getTime()) || d.getTime() <= Date.now()) return { ok: false, error: 'invalid_expiry' }; expires_at = d.toISOString(); }
  const note = body.note ? String(body.note).slice(0, 200) : null;
  return { ok: true, row: { ...flags, max_uses, expires_at, note } };
}

// ---- data access shared by the retailer admin (api/admin.js) and the owner portal (api/admin-auth.js) ----------
// `sb(path, opts)` is the caller's service-role REST helper (returns parsed JSON).
export async function listCodes(sb, retailerId) {
  const rid = encodeURIComponent(retailerId);
  const codes = await sb(`booking_codes?retailer_id=eq.${rid}&select=id,code,waives_fee,waives_lead_time,max_uses,use_count,expires_at,active,note,created_by,created_by_email,created_at,deactivated_at&order=created_at.desc&limit=200`);
  const reds = await sb(`booking_code_redemptions?retailer_id=eq.${rid}&select=code_id,booking_id,brand_name,waived_fee,waived_lead_time,redeemed_at&order=redeemed_at.desc&limit=500`);
  const byCode = {}; for (const r of (Array.isArray(reds) ? reds : [])) (byCode[r.code_id] = byCode[r.code_id] || []).push(r);
  return (Array.isArray(codes) ? codes : []).map(c => ({ ...c, kind: kindOf(c), redemptions: byCode[c.id] || [] }));
}
export async function createCode(sb, { retailerId, retailerSlug, body, createdBy, createdByEmail }) {
  const v = validateCreate(body || {}); if (!v.ok) return { ok: false, status: 400, error: v.error };
  // The unique index on code makes a collision a clean retry rather than a duplicate.
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = generateCode(retailerSlug, body.kind);
    const rows = await sb('booking_codes', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ retailer_id: retailerId, code, ...v.row, created_by: createdBy, created_by_email: createdByEmail || null }) }).catch(e => ({ error: String(e && e.message) }));
    if (Array.isArray(rows) && rows[0]) return { ok: true, status: 200, code: { ...rows[0], kind: kindOf(rows[0]), redemptions: [] } };
    if (!(rows && /duplicate|23505/.test(String(rows.error)))) return { ok: false, status: 503, error: 'code_create_failed' };
  }
  return { ok: false, status: 503, error: 'code_create_failed' };
}
export async function deactivateCode(sb, { retailerId, codeId }) {
  const rows = await sb(`booking_codes?id=eq.${encodeURIComponent(codeId)}&retailer_id=eq.${encodeURIComponent(retailerId)}&active=eq.true`, { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ active: false, deactivated_at: new Date().toISOString() }) });
  return Array.isArray(rows) && rows[0] ? { ok: true, status: 200, code: { ...rows[0], kind: kindOf(rows[0]) } } : { ok: false, status: 404, error: 'code_not_found' };
}

// Codex BC-5: shared, atomic attempt limiter (database-backed, so it holds across serverless instances). Covers
// the preview route AND code-bearing booking. Fails CLOSED for code application: if the limiter cannot be reached
// the code is refused (ordinary no-code checkout is unaffected). Returns null when allowed, else a response spec.
import { createHash } from 'node:crypto';
export function netHash(req) {
  const ip = String((req.headers && (req.headers['x-forwarded-for'] || req.headers['x-real-ip'])) || '').split(',')[0].trim();
  return ip ? createHash('sha256').update('dh-code-limiter:' + ip).digest('hex').slice(0, 32) : null;   // never the raw address
}
export async function checkAttemptLimit(rpc, { brandId, retailerId, netHash: nh }) {
  let r; try { r = await rpc('booking_code_attempt', { p_brand_id: brandId, p_retailer_id: retailerId, p_net_hash: nh }); } catch (_) { return { status: 503, body: { error: 'code_unavailable', message: CODE_MESSAGES.code_unavailable } }; }
  if (!r || typeof r.allowed !== 'boolean') return { status: 503, body: { error: 'code_unavailable', message: CODE_MESSAGES.code_unavailable } };
  if (!r.allowed) return { status: 429, body: { error: 'too_many_attempts', message: CODE_MESSAGES.too_many_attempts, retry_after_seconds: r.retry_after_seconds } };
  return null;
}
