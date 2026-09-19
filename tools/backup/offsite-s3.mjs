// offsite-s3.mjs — off-machine destination for encrypted snapshots: any S3-compatible private bucket (Amazon S3,
// Cloudflare R2, Backblaze B2). Pure Node, no SDK. Only ciphertext ever goes here.
//   * The uploader identity needs PutObject + GetObject (+ ListBucket for `list`). It must NOT have DeleteObject,
//     DeleteObjectVersion, PutBucketVersioning, PutObjectRetention or BypassGovernanceRetention.
//   * Upload is create-only (`If-None-Match: *`): an existing key is never overwritten by this tool.
//   * A copy counts as confirmed only after it has been read back and its sha256 equals the local ciphertext's.
//   * The endpoint must be an exact https origin; redirects are refused so credentials never follow one.
// Credentials live in a local file outside every repository:  ACCESS_KEY_ID=…  /  SECRET_ACCESS_KEY=…
import { createHash, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';

const sha256hex = (b) => createHash('sha256').update(b).digest('hex');
const hmac = (k, s) => createHmac('sha256', k).update(s).digest();
const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
const EMPTY = sha256hex(Buffer.alloc(0));

// Generic AWS Signature Version 4. `headers` must already contain host and x-amz-date; every header given is signed.
export function signV4({ method, path, query = {}, headers, payloadHash, accessKey, secretKey, region, service }) {
  const h = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v).trim().replace(/\s+/g, ' ')]));
  const names = Object.keys(h).sort(); const amzDate = h['x-amz-date']; const day = amzDate.slice(0, 8);
  const cq = Object.keys(query).sort().map((k) => `${enc(k)}=${enc(query[k])}`).join('&');
  const canonical = [method, path, cq, names.map((n) => `${n}:${h[n]}\n`).join(''), names.join(';'), payloadHash].join('\n');
  const scope = `${day}/${region}/${service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonical)].join('\n');
  const key = hmac(hmac(hmac(hmac('AWS4' + secretKey, day), region), service), 'aws4_request');
  const signature = createHmac('sha256', key).update(toSign).digest('hex');
  return { signature, authorization: `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}` };
}

export function resolveS3(dest) {
  let u; try { u = new URL(dest.endpoint); } catch { throw new Error('s3 endpoint is not a URL'); }
  if (u.protocol !== 'https:' || u.username || u.password || u.port || u.search || u.hash || (u.pathname !== '/' && u.pathname !== '')) throw new Error('s3 endpoint must be an exact https origin');
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(dest.bucket || '')) throw new Error('s3 bucket name is not valid');
  if (!/^[a-z0-9-]+$/.test(dest.region || '')) throw new Error('s3 region is not valid');
  const prefix = dest.prefix || ''; if (!/^([A-Za-z0-9._-]+\/)*$/.test(prefix) || prefix.split('/').some((s) => s === '.' || s === '..')) throw new Error('s3 prefix must look like "folder/" or be empty');
  return { origin: u.origin, host: u.host, bucket: dest.bucket, region: dest.region, prefix };
}
export function readS3Credentials(file) {
  const e = Object.fromEntries(readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => /^[A-Z_]+=/.test(l)).map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).trim()]; }));
  if (!e.ACCESS_KEY_ID || !e.SECRET_ACCESS_KEY) throw new Error('credentials file needs ACCESS_KEY_ID= and SECRET_ACCESS_KEY= lines');
  return { accessKey: e.ACCESS_KEY_ID, secretKey: e.SECRET_ACCESS_KEY };
}
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,200}$/;
const amzNow = (io) => new Date(io.now()).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

async function call(io, t, cred, { method, key, query, body, extra }) {
  const path = '/' + t.bucket + (key ? '/' + key.split('/').map(enc).join('/') : '');
  const payloadHash = body ? sha256hex(body) : EMPTY;
  const headers = { host: t.host, 'x-amz-date': amzNow(io), 'x-amz-content-sha256': payloadHash, ...(extra || {}) };
  const { authorization } = signV4({ method, path, query, headers, payloadHash, ...cred, region: t.region, service: 's3' });
  const qs = query && Object.keys(query).length ? '?' + Object.keys(query).sort().map((k) => `${enc(k)}=${enc(query[k])}`).join('&') : '';
  const { host, ...send } = headers;
  return io.fetch(t.origin + path + qs, { method, redirect: 'error', signal: AbortSignal.timeout(io.timeoutMs || 30000), headers: { ...send, Authorization: authorization }, body: body || undefined });
}

export async function s3Put(io, dest, name, cipher, csha) {
  const base = { type: 's3', bucket: dest.bucket };
  try {
    if (!SAFE_NAME.test(name)) return { ...base, confirmed: false, error: 'unsafe snapshot name' };
    const t = resolveS3(dest), cred = readS3Credentials(dest.credentials_file), key = t.prefix + name;
    const md5 = createHash('md5').update(cipher).digest('base64');
    const put = await call(io, t, cred, { method: 'PUT', key, body: cipher, extra: { 'content-md5': md5, 'content-type': 'application/octet-stream', 'if-none-match': '*' } });
    if (put.status === 412) return { ...base, key, confirmed: false, error: 'an object with this name already exists at the destination' };
    if (!put.ok) return { ...base, key, confirmed: false, error: 'upload returned HTTP ' + put.status };
    const get = await call(io, t, cred, { method: 'GET', key });
    if (!get.ok) return { ...base, key, confirmed: false, error: 'read-back returned HTTP ' + get.status };
    const back = Buffer.from(await get.arrayBuffer());
    return { ...base, key, version_id: put.headers.get('x-amz-version-id') || null, confirmed: sha256hex(back) === csha, ...(sha256hex(back) === csha ? {} : { error: 'read-back bytes differ from the local ciphertext' }) };
  } catch (e) { return { ...base, confirmed: false, error: String(e.name === 'TimeoutError' ? 'timeout' : e.message).slice(0, 120) }; }
}
export async function s3Get(io, dest, name) {
  if (!SAFE_NAME.test(name)) throw new Error('unsafe snapshot name');
  const t = resolveS3(dest), cred = readS3Credentials(dest.credentials_file);
  const r = await call(io, t, cred, { method: 'GET', key: t.prefix + name }); if (!r.ok) throw new Error('download returned HTTP ' + r.status);
  return Buffer.from(await r.arrayBuffer());
}
export async function s3List(io, dest) {
  const t = resolveS3(dest), cred = readS3Credentials(dest.credentials_file); const out = []; let token = null;
  for (let page = 0; page < 100; page++) {
    const query = { 'list-type': '2', prefix: t.prefix, ...(token ? { 'continuation-token': token } : {}) };
    const r = await call(io, t, cred, { method: 'GET', key: '', query }); if (!r.ok) throw new Error('listing returned HTTP ' + r.status);
    const xml = await r.text(); if (!/<ListBucketResult/.test(xml)) throw new Error('listing response is not a ListBucketResult');
    for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) { const k = (m[1].match(/<Key>([^<]*)<\/Key>/) || [])[1], s = (m[1].match(/<Size>(\d+)<\/Size>/) || [])[1]; if (k) out.push({ name: k.slice(t.prefix.length), size: Number(s) }); }
    if (!/<IsTruncated>true<\/IsTruncated>/.test(xml)) return out;
    token = (xml.match(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/) || [])[1]; if (!token) throw new Error('truncated listing without a continuation token');
  }
  throw new Error('listing did not finish in 100 pages');
}

// Dead-man's-switch ping (for an external monitor that alerts when NO success arrives in 26 h — the stopped
// workstation cannot report its own missed run). Sends nothing but the request itself: no body, no query, no data.
export async function heartbeat(io, url, ok) {
  try {
    const u = new URL(url); if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash) return 'refused: heartbeat must be a plain https URL';
    const r = await io.fetch(u.origin + u.pathname.replace(/\/$/, '') + (ok ? '' : '/fail'), { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(10000) });
    return r.ok ? 'sent' : 'failed: HTTP ' + r.status;
  } catch (e) { return 'failed: ' + String(e.name === 'TimeoutError' ? 'timeout' : 'network'); }
}
