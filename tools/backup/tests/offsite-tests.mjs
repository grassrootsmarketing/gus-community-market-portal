// Tests for the S3-compatible off-machine destination + heartbeat (Codex work order BAK-4 code, prepared offline).
// Everything is simulated: a fake S3 endpoint that RE-VERIFIES every request signature, a fake Storage API, temp
// folders. The key pair below is AWS's published documentation example, not a credential.
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import * as nodeFs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import * as B from '../storage-backup.mjs';
import { generateIdentity } from '../age.mjs';
import { makePdf, validatePdf } from '../canary.mjs';
import { signV4, s3Put, s3Get, s3List, heartbeat, resolveS3 } from '../offsite-s3.mjs';

let pass = 0, fail = 0; const fails = [];
const ok = (name, cond, detail) => { if (cond) { pass++; console.log('  ok   ' + name); } else { fail++; fails.push(name); console.log('  FAIL ' + name + (detail ? '  — ' + String(detail).slice(0, 300) : '')); } };
const sha = (b) => createHash('sha256').update(b).digest('hex');
const EMPTY = sha(Buffer.alloc(0));
const DOC = { accessKey: 'AKIAIOSFODNN7EXAMPLE', secretKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' };

console.log('— Signature Version 4 —');
{
  const a = signV4({ method: 'GET', path: '/', headers: { host: 'example.amazonaws.com', 'x-amz-date': '20150830T123600Z' }, payloadHash: EMPTY, accessKey: 'AKIDEXAMPLE', secretKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY', region: 'us-east-1', service: 'service' });
  ok('AWS test-suite vector "get-vanilla"', a.signature === '5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31', a.signature);
  const b = signV4({ method: 'GET', path: '/test.txt', headers: { host: 'examplebucket.s3.amazonaws.com', range: 'bytes=0-9', 'x-amz-content-sha256': EMPTY, 'x-amz-date': '20130524T000000Z' }, payloadHash: EMPTY, ...DOC, region: 'us-east-1', service: 's3' });
  ok('Amazon S3 documentation vector "GET object"', b.signature === 'f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41', b.signature);
  const c = signV4({ method: 'GET', path: '/', query: { 'max-keys': '2', prefix: 'J' }, headers: { host: 'examplebucket.s3.amazonaws.com', 'x-amz-content-sha256': EMPTY, 'x-amz-date': '20130524T000000Z' }, payloadHash: EMPTY, ...DOC, region: 'us-east-1', service: 's3' });
  ok('Amazon S3 documentation vector "list objects" (query string)', c.signature === '34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7', c.signature);
}

// ---- fake S3: verifies the signature of what was ACTUALLY sent, create-only PUT, GET, paginated ListObjectsV2 ----
const ORIGIN = 'https://s3.us-east-1.amazonaws.com';
class FakeS3 {
  constructor() { this.objects = new Map(); this.calls = []; this.hook = null; this.pageSize = 2; }
  fetch = async (url, opts = {}) => {
    const u = new URL(url), method = (opts.method || 'GET').toUpperCase(); this.calls.push({ url, method, redirect: opts.redirect });
    if (u.origin !== ORIGIN) throw new Error('fake s3: request left the approved origin');
    const h = Object.fromEntries(Object.entries(opts.headers || {}).map(([k, v]) => [k.toLowerCase(), v])); const auth = h.authorization || ''; delete h.authorization;
    const body = opts.body ? Buffer.from(opts.body) : Buffer.alloc(0);
    if (h['x-amz-content-sha256'] !== sha(body)) return new Response('<Error><Code>XAmzContentSHA256Mismatch</Code></Error>', { status: 400 });
    const query = Object.fromEntries(u.searchParams.entries());
    const expect = signV4({ method, path: u.pathname, query, headers: { host: u.host, ...h }, payloadHash: sha(body), ...DOC, region: 'us-east-1', service: 's3' });
    if (auth !== expect.authorization) return new Response('<Error><Code>SignatureDoesNotMatch</Code></Error>', { status: 403 });
    if (this.hook) { const r = await this.hook({ u, method, body }); if (r) return r; }
    const m = decodeURIComponent(u.pathname).match(/^\/([^/]+)\/?(.*)$/); const key = m[2];
    if (m[1] !== 'demohub-backup-test') return new Response('<Error><Code>NoSuchBucket</Code></Error>', { status: 404 });
    if (method === 'PUT') { if (h['if-none-match'] === '*' && this.objects.has(key)) return new Response('<Error><Code>PreconditionFailed</Code></Error>', { status: 412 }); if (h['content-md5'] !== createHash('md5').update(body).digest('base64')) return new Response('<Error><Code>BadDigest</Code></Error>', { status: 400 }); this.objects.set(key, body); return new Response('', { status: 200, headers: { 'x-amz-version-id': 'v-' + this.objects.size } }); }
    if (method === 'GET' && !key) { const all = [...this.objects.keys()].filter(k => k.startsWith(query.prefix || '')).sort(); const start = query['continuation-token'] ? Number(query['continuation-token']) : 0; const page = all.slice(start, start + this.pageSize); const more = start + this.pageSize < all.length;
      return new Response(`<?xml version="1.0"?><ListBucketResult>${page.map(k => `<Contents><Key>${k}</Key><Size>${this.objects.get(k).length}</Size></Contents>`).join('')}<IsTruncated>${more}</IsTruncated>${more ? `<NextContinuationToken>${start + this.pageSize}</NextContinuationToken>` : ''}</ListBucketResult>`, { status: 200 }); }
    if (method === 'GET') return this.objects.has(key) ? new Response(this.objects.get(key), { status: 200 }) : new Response('<Error><Code>NoSuchKey</Code></Error>', { status: 404 });
    return new Response('<Error><Code>MethodNotAllowed</Code></Error>', { status: 405 });
  };
}
const roots = []; const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'dh-s3-')); roots.push(d); return d; };
const credDir = tmp(); const credFile = join(credDir, 's3-credentials.env'); writeFileSync(credFile, `ACCESS_KEY_ID=${DOC.accessKey}\r\nSECRET_ACCESS_KEY=${DOC.secretKey}\r\n`);
const DEST = { type: 's3', endpoint: ORIGIN, region: 'us-east-1', bucket: 'demohub-backup-test', prefix: 'storage/', credentials_file: credFile };
const mkIo = (s3) => { let t = Date.parse('2026-09-20T09:00:00Z'); return { fetch: s3.fetch, now: () => (t += 1000), timeoutMs: 5000 }; };

console.log('\n— upload, confirmation, refusal —');
{
  const s3 = new FakeS3(), io = mkIo(s3); const cipher = Buffer.from('age-encryption.org/v1 synthetic ciphertext ' + 'z'.repeat(5000)); const name = 'demohub-storage-ref-20260920T090000Z-abc123.tar.age';
  const r = await s3Put(io, DEST, name, cipher, sha(cipher));
  ok('a create-only upload that reads back identical is confirmed (signature accepted by the verifying server)', r.confirmed === true && r.key === 'storage/' + name && r.version_id === 'v-1', JSON.stringify(r));
  const again = await s3Put(io, DEST, name, cipher, sha(cipher));
  ok('an existing snapshot name is never overwritten (412) and is NOT confirmed', again.confirmed === false && /already exists/.test(again.error) && s3.objects.get('storage/' + name).equals(cipher), JSON.stringify(again));
  s3.hook = ({ method, u }) => (method === 'GET' && u.pathname.endsWith('b.tar.age') ? new Response(Buffer.from('different bytes'), { status: 200 }) : null);
  const bad = await s3Put(io, DEST, 'b.tar.age', cipher, sha(cipher)); ok('read-back bytes that differ are NOT confirmed', bad.confirmed === false && /differ/.test(bad.error), JSON.stringify(bad));
  s3.hook = ({ method }) => (method === 'PUT' ? new Response('<Error><Code>AccessDenied</Code></Error>', { status: 403 }) : null);
  const denied = await s3Put(io, DEST, 'c.tar.age', cipher, sha(cipher)); ok('a refused upload (403) is NOT confirmed', denied.confirmed === false && /403/.test(denied.error));
  s3.hook = ({ method }) => (method === 'GET' ? new Response('unavailable', { status: 500 }) : null);
  const noread = await s3Put(io, DEST, 'd.tar.age', cipher, sha(cipher)); ok('an upload whose read-back fails (500) is NOT confirmed', noread.confirmed === false && /500/.test(noread.error));
  s3.hook = null;
  ok('every request refuses redirects, and no DELETE is ever issued', s3.calls.every(c => c.redirect === 'error') && !s3.calls.some(c => c.method === 'DELETE'));
  const before = s3.calls.length; const fixtures = ['http://s3.us-east-1.amazonaws.com', 'https://user:pw@s3.us-east-1.amazonaws.com', 'https://s3.us-east-1.amazonaws.com:8443', 'https://s3.us-east-1.amazonaws.com/extra', 'https://s3.us-east-1.amazonaws.com/?x=1', 'not a url'];
  const res = []; for (const endpoint of fixtures) res.push(await s3Put(io, { ...DEST, endpoint }, 'e.tar.age', cipher, sha(cipher)));
  for (const d of [{ ...DEST, prefix: '../up/' }, { ...DEST, prefix: 'no-slash' }, { ...DEST, bucket: 'Bad_Bucket' }]) res.push(await s3Put(io, d, 'e.tar.age', cipher, sha(cipher)));
  res.push(await s3Put(io, DEST, '../escape.tar.age', cipher, sha(cipher)));
  ok('bad endpoint / prefix / bucket / name fixtures are refused with zero requests', res.every(x => x.confirmed === false) && s3.calls.length === before, `${s3.calls.length - before} requests`);
  const wrongKey = join(credDir, 'wrong.env'); writeFileSync(wrongKey, 'ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE\nSECRET_ACCESS_KEY=not-the-secret\n');
  const forged = await s3Put(io, { ...DEST, credentials_file: wrongKey }, 'f.tar.age', cipher, sha(cipher)); ok('a wrong secret is rejected by the server (403) and NOT confirmed', forged.confirmed === false && !s3.objects.has('storage/f.tar.age'));
  ok('error text never contains the secret key', ![r, again, bad, denied, noread, forged, ...res].some(x => JSON.stringify(x).includes(DOC.secretKey)));
}

console.log('\n— listing + recovery from the off-machine copy alone —');
{
  // Fake Supabase Storage (production origin) + fake S3 behind one fetch; then the local folder is thrown away.
  const s3 = new FakeS3(); const PROD = B.PROJECTS.production; const files = new Map([['coi-docs', new Map([['brand-1/coi.pdf', makePdf('offsite test v1')]])], ['policy-docs', new Map()], ['avatars', new Map()]]);
  const J = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const supa = async (url, opts = {}) => { const u = new URL(url), p = decodeURIComponent(u.pathname), method = (opts.method || 'GET').toUpperCase();
    if (p === '/storage/v1/bucket') return J(200, [...files.keys()].map(id => ({ id })));
    let m = p.match(/^\/storage\/v1\/object\/list\/([^/]+)$/); if (m && method === 'POST') { const { prefix = '' } = JSON.parse(opts.body); const pre = prefix ? prefix + '/' : ''; const rows = new Map(); for (const [path, data] of files.get(m[1])) { if (!path.startsWith(pre)) continue; const rest = path.slice(pre.length), i = rest.indexOf('/'); if (i >= 0) rows.set(rest.slice(0, i), { name: rest.slice(0, i), id: null, metadata: null }); else rows.set(rest, { name: rest, id: 'id-' + rest, updated_at: '2026-09-20T00:00:00Z', metadata: { size: data.length, mimetype: 'application/pdf' } }); } return J(200, [...rows.values()]); }
    m = p.match(/^\/storage\/v1\/object\/([^/]+)\/(.+)$/); if (m && method === 'GET') { const d = files.get(m[1]).get(m[2]); return d ? new Response(d, { status: 200 }) : J(400, { statusCode: '404', error: 'not_found' }); }
    return J(404, {}); };
  const base = tmp(), root = join(base, 'backup'); mkdirSync(root); const keys = generateIdentity(); writeFileSync(join(root, 'backup-config.json'), JSON.stringify({ recipient: keys.recipient, offsite: [DEST], require_offsite: true }));
  let t = Date.parse('2026-09-20T09:00:00Z'); const io = { ...B.defaultIo(), fetch: (url, o) => (new URL(url).origin === ORIGIN ? s3.fetch(url, o) : supa(url, o)), fs: nodeFs, now: () => (t += 1000), sleep: async () => {}, retryDelayMs: 0, pid: 77 };
  const env = { url: PROD.origin, key: 'synthetic-key', ref: PROD.ref };
  const a = await B.runBackup(io, { root, env, mode: 'production' });
  ok('a backup with an S3 destination completes only with the off-machine copy confirmed', a.result === 'complete' && a.offsite_confirmed === 1 && !!a.last_successful_backup_at, JSON.stringify(a));
  files.get('coi-docs').set('brand-1/coi.pdf', makePdf('offsite test v2')); const b = await B.runBackup(io, { root, env, mode: 'production' });
  s3.hook = ({ method }) => (method === 'PUT' ? new Response('down', { status: 503 }) : null); const before = a.last_successful_backup_at;
  let failed = null; try { await B.runBackup(io, { root, env, mode: 'production' }); } catch (e) { failed = e; } s3.hook = null;
  ok('when the S3 upload fails the run fails (offsite_failed) and last_successful_backup_at does not move past the last confirmed run', failed && failed.code === 'offsite_failed' && B.checkFresh(io, root).last_successful_backup_at !== before && B.checkFresh(io, root).last_successful_backup_at === b.last_successful_backup_at, failed && failed.code);
  s3.pageSize = 1; const listed = await s3List(io, DEST);
  ok('listing pages through the destination and finds both confirmed snapshots', listed.length === 2 && listed.every(o => o.name.endsWith('.tar.age') && o.size > 0), JSON.stringify(listed));
  rmSync(root, { recursive: true, force: true });                                                   // "the workstation is gone"
  const older = listed.map(o => o.name).sort()[0]; const bytes = await s3Get(io, DEST, older); const dl = join(base, 'downloaded.tar.age'); writeFileSync(dl, bytes);
  const r = B.restoreSnapshot(io, { snapshotFile: dl, identity: keys.identity, outDir: join(base, 'restored'), expectRef: PROD.ref }); const got = nodeFs.readFileSync(r.files[0].local);
  ok('the OLDER version restores from the S3 copy alone, byte-identical, and the PDF opens', r.files.length === 1 && got.equals(makePdf('offsite test v1')) && validatePdf(got).ok && r.files[0].path === 'brand-1/coi.pdf');
  let missing = null; try { await s3Get(io, DEST, 'nope.tar.age'); } catch (e) { missing = e; } ok('fetching a snapshot that is not there fails', !!missing && /404/.test(missing.message));
  ok('only ciphertext reached the destination (no clear-text path or PDF marker in any stored object)', [...s3.objects.values()].every(v => !v.includes('brand-1') && !v.includes('%PDF') && v.subarray(0, 21).toString() === 'age-encryption.org/v1'));
}

console.log('\n— heartbeat (dead-man\'s-switch ping) —');
{
  const calls = []; const io = { fetch: async (url, o) => { calls.push({ url, ...o }); return new Response('OK', { status: 200 }); } };
  ok('success pings the URL itself', (await heartbeat(io, 'https://hc.example/ping/abc', true)) === 'sent' && calls[0].url === 'https://hc.example/ping/abc' && calls[0].method === 'GET' && !calls[0].body && calls[0].redirect === 'error');
  ok('failure pings <url>/fail', (await heartbeat(io, 'https://hc.example/ping/abc/', false)) === 'sent' && calls[1].url === 'https://hc.example/ping/abc/fail');
  const n = calls.length; ok('http, credentials-in-URL and query strings are refused with zero requests', /refused/.test(await heartbeat(io, 'http://hc.example/ping/abc', true)) && /refused/.test(await heartbeat(io, 'https://u:p@hc.example/x', true)) && /refused/.test(await heartbeat(io, 'https://hc.example/x?data=1', true)) && calls.length === n);
  ok('a monitor outage is reported, never thrown', (await heartbeat({ fetch: async () => new Response('', { status: 500 }) }, 'https://hc.example/p', true)) === 'failed: HTTP 500' && (await heartbeat({ fetch: async () => { throw new Error('ENOTFOUND'); } }, 'https://hc.example/p', true)) === 'failed: network');
}

for (const r of roots) { try { rmSync(r, { recursive: true, force: true }); } catch {} }
console.log(`\noffsite destination tests: ${pass} passed, ${fail} failed`);
if (fail) { console.log('FAILURES:\n' + fails.map(f => '  x ' + f).join('\n')); process.exit(1); }
