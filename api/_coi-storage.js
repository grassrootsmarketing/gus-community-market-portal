// api/_coi-storage.js — F5-10/F5-11/F5-13 (LG-03): COIs live in a PRIVATE bucket under random,
// unguessable keys; downloads are short-lived signed URLs issued only after an authorization
// check; and reject/remove/replace actually deletes the bytes. Storage ops use the service key
// (run only in the server handler), so these are exercised on the preview, not the public key.
import crypto from 'node:crypto';
const SUPABASE_URL = process.env.SUPABASE_URL, SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const BUCKET = 'coi-docs';
function h() { return { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }; }

export function newCoiKey(ext = 'pdf') {
  return `${new Date().getFullYear()}/${crypto.randomBytes(24).toString('hex')}.${(ext || 'pdf').replace(/[^a-z0-9]/gi, '') || 'pdf'}`;
}
export async function uploadCoi(objectKey, bytes, mime) {
  const r = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${objectKey}`, { method: 'POST', headers: { ...h(), 'Content-Type': mime || 'application/pdf', 'x-upsert': 'false' }, body: bytes });
  if (!r.ok) throw new Error('coi upload failed: ' + (await r.text()).slice(0, 160));
  return objectKey;
}
export async function signedCoiUrl(objectKey, ttlSeconds = 120) {
  const r = await fetch(`${SUPABASE_URL}/storage/v1/object/sign/${BUCKET}/${objectKey}`, { method: 'POST', headers: { ...h(), 'Content-Type': 'application/json' }, body: JSON.stringify({ expiresIn: ttlSeconds }) });
  if (!r.ok) throw new Error('sign failed');
  const j = await r.json();
  return `${SUPABASE_URL}/storage/v1${j.signedURL}`;
}
export async function deleteCoi(objectKey) {
  if (!objectKey) return;
  try { await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${objectKey}`, { method: 'DELETE', headers: h() }); } catch (_) {}
}
