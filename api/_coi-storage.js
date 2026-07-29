// api/_coi-storage.js — F5-10/F5-11/F5-13 (LG-03): COIs live in a PRIVATE bucket under random,
// unguessable keys; downloads are short-lived signed URLs issued only after an authorization
// check; and reject/remove/replace actually deletes the bytes. Storage ops use the service key
// (run only in the server handler), so these are exercised on the preview, not the public key.
import crypto from 'node:crypto';
import { getBinding } from './_env.js';
const BUCKET = 'coi-docs';
function h(b) { return { apikey: b.serviceKey, Authorization: `Bearer ${b.serviceKey}` }; }

export function newCoiKey(ext = 'pdf') {
  return `${new Date().getFullYear()}/${crypto.randomBytes(24).toString('hex')}.${(ext || 'pdf').replace(/[^a-z0-9]/gi, '') || 'pdf'}`;
}
export async function uploadCoi(objectKey, bytes, mime) {
  const b = await getBinding();
  const r = await fetch(`${b.supabaseUrl}/storage/v1/object/${BUCKET}/${objectKey}`, { method: 'POST', headers: { ...h(b), 'Content-Type': mime || 'application/pdf', 'x-upsert': 'false' }, body: bytes });
  if (!r.ok) throw new Error('coi upload failed: ' + (await r.text()).slice(0, 160));
  return objectKey;
}
export async function signedCoiUrl(objectKey, ttlSeconds = 120) {
  const b = await getBinding();
  const r = await fetch(`${b.supabaseUrl}/storage/v1/object/sign/${BUCKET}/${objectKey}`, { method: 'POST', headers: { ...h(b), 'Content-Type': 'application/json' }, body: JSON.stringify({ expiresIn: ttlSeconds }) });
  if (!r.ok) throw new Error('sign failed');
  const j = await r.json();
  return `${b.supabaseUrl}/storage/v1${j.signedURL}`;
}
export async function deleteCoi(objectKey) {
  if (!objectKey) return;
  const b = await getBinding();
  try { await fetch(`${b.supabaseUrl}/storage/v1/object/${BUCKET}/${objectKey}`, { method: 'DELETE', headers: h(b) }); } catch (_) {}
}
