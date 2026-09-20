// create-only-probe.mjs — Codex closure review item 4. Proves that S3 ITSELF refuses a write that omits the create-only
// condition, using ONE uniquely named SYNTHETIC object (never a real snapshot). Prints status codes and booleans only.
//   node create-only-probe.mjs            uses C:/Users/David/Documents/Codex/prod-storage-backup-v2/backup-config.json
import { readFileSync } from 'node:fs'; import { createHash } from 'node:crypto';
import { signV4, resolveS3, readS3Credentials } from '../offsite-s3.mjs';
const sha = (b) => createHash('sha256').update(b).digest('hex');
const dest = JSON.parse(readFileSync(process.argv[2] || 'C:/Users/David/Documents/Codex/prod-storage-backup-v2/backup-config.json', 'utf8')).offsite.find(d => d.type === 's3');
const t = resolveS3(dest), cred = readS3Credentials(dest.credentials_file);
const key = `${t.prefix}zz-synthetic-create-only-probe-${Date.now().toString(36)}.txt`; const path = '/' + t.bucket + '/' + key;
const call = async (method, body, extra = {}) => { const payloadHash = sha(body || Buffer.alloc(0)); const headers = { host: t.host, 'x-amz-date': new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, ''), 'x-amz-content-sha256': payloadHash, ...extra };
  if (body) headers['content-md5'] = createHash('md5').update(body).digest('base64');
  const { authorization } = signV4({ method, path, headers, payloadHash, ...cred, region: t.region, service: 's3' }); const { host, ...send } = headers;
  const r = await fetch(t.origin + path, { method, redirect: 'error', headers: { ...send, Authorization: authorization }, body }); return { status: r.status, version: r.headers.get('x-amz-version-id'), buf: Buffer.from(await r.arrayBuffer()) }; };
const original = Buffer.from('SYNTHETIC create-only probe - not a backup - ' + key); const out = { synthetic_key: key };
const a = await call('PUT', original, { 'if-none-match': '*' }); out.create_with_condition = a.status;
const b = await call('PUT', Buffer.from('second conditional write'), { 'if-none-match': '*' }); out.repeat_with_condition = b.status;
const c = await call('PUT', Buffer.from('UNCONDITIONAL overwrite attempt')); out.unconditional_put = c.status; out.unconditional_put_created_new_version = c.status === 200 && c.version !== a.version;
const g = await call('GET'); out.current_content_is_still_the_original = g.buf.equals(original); out.original_sha256 = sha(original).slice(0, 16) + '…';
out.verdict = a.status === 200 && b.status === 412 && c.status === 403 && out.current_content_is_still_the_original ? 'ENFORCED BY S3: a write without the condition is denied' : (c.status === 200 ? 'NOT ENFORCED: the credential can overwrite when the header is omitted (only the cooperative client refuses)' : 'UNEXPECTED — review');
console.log(JSON.stringify(out, null, 1)); if (!/^ENFORCED/.test(out.verdict)) process.exitCode = 3;
