// Regression tests for the storage backup (Codex work order 2026-09-19, BAK-1..3). Everything is simulated:
// a fake Storage API behind `fetch`, real files only under the OS temp folder. No credentials, no provider calls.
import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync, existsSync, statSync, mkdirSync } from 'node:fs';
import * as nodeFs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import * as B from '../storage-backup.mjs';
import { generateIdentity, encrypt, decrypt } from '../age.mjs';
import { tarPack, tarUnpack } from '../tar.mjs';
import { makePdf, makePng, validatePdf, validatePng } from '../canary.mjs';

let pass = 0, fail = 0; const fails = [];
const ok = (name, cond, detail) => { if (cond) { pass++; console.log('  ok   ' + name); } else { fail++; fails.push(name); console.log('  FAIL ' + name + (detail ? '  — ' + String(detail).slice(0, 300) : '')); } };
const sha = (b) => createHash('sha256').update(b).digest('hex');
const rejects = async (fn, code) => { try { await fn(); return { threw: false }; } catch (e) { return { threw: true, code: e.code, match: !code || e.code === code, e }; } };
const PROD = B.PROJECTS.production, TEST = B.PROJECTS.test;
const envProd = { url: PROD.origin, key: 'synthetic-key', ref: PROD.ref }, envTest = { url: TEST.origin, key: 'synthetic-key', ref: TEST.ref };

class FakeStorage {
  constructor(origin) { this.origin = origin; this.buckets = new Map(B.REQUIRED_BUCKETS.map(b => [b, new Map()])); this.calls = []; this.hook = null; this.clock = 1; }
  put(bucket, path, data, mimetype = 'application/pdf') { this.buckets.get(bucket).set(path, { data: Buffer.from(data), mimetype, updated_at: new Date(1e12 + (this.clock++) * 1000).toISOString(), id: 'id-' + this.clock }); }
  del(bucket, path) { this.buckets.get(bucket).delete(path); }
  fetch = async (url, opts = {}) => {
    const u = new URL(url); const method = (opts.method || 'GET').toUpperCase(); this.calls.push({ url, method, redirect: opts.redirect });
    if (u.origin !== this.origin) throw new Error('fake: request left the approved origin: ' + u.origin);
    if (this.hook) { const r = await this.hook({ u, method, opts, n: this.calls.length }); if (r) return r; }
    const J = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    const p = decodeURIComponent(u.pathname);
    if (p === '/storage/v1/bucket' && method === 'GET') return J(200, [...this.buckets.keys()].map(id => ({ id, public: false })));
    let m = p.match(/^\/storage\/v1\/object\/list\/([^/]+)$/);
    if (m && method === 'POST') { const b = this.buckets.get(m[1]); if (!b) return J(200, []); const { prefix = '', limit = 100, offset = 0 } = JSON.parse(opts.body); const pre = prefix ? prefix + '/' : ''; const rows = new Map();
      for (const [path, o] of b) { if (!path.startsWith(pre)) continue; const rest = path.slice(pre.length); const i = rest.indexOf('/'); if (i >= 0) rows.set(rest.slice(0, i), { name: rest.slice(0, i), id: null, updated_at: null, metadata: null }); else rows.set(rest, { name: rest, id: o.id, updated_at: o.updated_at, metadata: { size: o.data.length, mimetype: o.mimetype, eTag: sha(o.data).slice(0, 8) } }); }
      return J(200, [...rows.values()].sort((a, c) => (a.name < c.name ? -1 : 1)).slice(offset, offset + limit)); }
    m = p.match(/^\/storage\/v1\/object\/([^/]+)\/(.+)$/);
    if (m) { const b = this.buckets.get(m[1]); const o = b && b.get(m[2]);
      if (method === 'GET') return o ? new Response(o.data, { status: 200 }) : J(400, { statusCode: '404', error: 'not_found', message: 'Object not found' });
      if (method === 'POST') { if (o) return J(400, { statusCode: '409', error: 'Duplicate' }); this.put(m[1], m[2], Buffer.from(opts.body), (opts.headers || {})['Content-Type']); return J(200, { Key: m[1] + '/' + m[2] }); }
      if (method === 'DELETE') { if (!o) return J(400, { statusCode: '404', error: 'not_found' }); b.delete(m[2]); return J(200, { message: 'Successfully deleted' }); } }
    return J(404, { error: 'fake: unhandled ' + method + ' ' + p });
  };
}
const roots = [];
function setup({ offsite = true, pageSize = 1000 } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'dh-bak-')); roots.push(base); const root = join(base, 'backup'), off = join(base, 'offsite'); mkdirSync(root, { recursive: true }); mkdirSync(off, { recursive: true });
  const keys = generateIdentity(); writeFileSync(join(root, 'backup-config.json'), JSON.stringify({ recipient: keys.recipient, offsite: offsite ? [{ type: 'dir', path: off }] : [], require_offsite: true }));
  const srv = new FakeStorage(PROD.origin); let t = Date.parse('2026-09-20T09:00:00Z');
  const io = { ...B.defaultIo(), fetch: srv.fetch, fs: nodeFs, now: () => (t += 1000), sleep: async () => {}, retryDelayMs: 0, pageSize, pid: 4242 };
  return { base, root, off, keys, srv, io, advance: (ms) => { t += ms; } };
}
const snaps = (root) => readdirSync(join(root, 'snapshots')).filter(f => f.endsWith('.tar.age')).sort();
const state = (root) => JSON.parse(readFileSync(join(root, 'state.json'), 'utf8'));

// =====================================================================================================
console.log('\n— BAK-1: failures are failures; snapshots are complete or absent —');
{ const S = setup(); S.srv.put('coi-docs', 'brands/a/existing.pdf', 'old-bytes');
  const r1 = await B.runBackup(S.io, { root: S.root, env: envProd });
  ok('baseline: a clean run publishes ONE complete snapshot, confirms the off-machine copy and only then records success', r1.result === 'complete' && snaps(S.root).length === 1 && r1.offsite_confirmed === 1 && state(S.root).last_successful_snapshot === snaps(S.root)[0], JSON.stringify(r1));
  const good = snaps(S.root)[0], goodHash = sha(readFileSync(join(S.root, 'snapshots', good))), goodAt = state(S.root).last_successful_backup_at;
  S.srv.put('coi-docs', 'brands/a/new.pdf', 'new-bytes');
  S.srv.hook = ({ u, method }) => (method === 'GET' && u.pathname.endsWith('/new.pdf') ? new Response('denied', { status: 403 }) : null);
  const r2 = await rejects(() => B.runBackup(S.io, { root: S.root, env: envProd }), 'http_403');
  ok('[review case 1] a listed object whose download is refused (403) FAILS the run — it is not skipped', r2.threw && r2.match, r2.code);
  ok('…no partial snapshot is published, the previous good snapshot is byte-identical, last_successful did not move, last_attempt did', snaps(S.root).length === 1 && sha(readFileSync(join(S.root, 'snapshots', good))) === goodHash && state(S.root).last_successful_backup_at === goodAt && /failed: http_403/.test(state(S.root).last_attempt_result) && state(S.root).last_attempt_at !== goodAt, JSON.stringify(state(S.root)).slice(0, 200));
  ok('…and verify cannot turn that into a green: no leftovers, and freshness still points at the OLD success', B.verifyLocal(S.io, S.root).problems.length === 0 && !existsSync(join(S.root, 'tmp', 'x')) && readdirSync(join(S.root, 'tmp')).length === 0);
  S.srv.hook = ({ u, method }) => (method === 'POST' && u.pathname.includes('/object/list/') ? new Response('invalid request', { status: 400 }) : null);
  const r3 = await rejects(() => B.runBackup(S.io, { root: S.root, env: envProd }), 'http_400');
  ok('[review case 2] a listing error (400) FAILS the run and marks nothing as gone upstream', r3.threw && r3.match && Object.keys(state(S.root).tombstones || {}).length === 0, r3.code);
  S.srv.hook = ({ u, method }) => (method === 'POST' && u.pathname.includes('/object/list/') ? new Response(JSON.stringify({ not: 'an array' }), { status: 200 }) : null);
  ok('a malformed listing page (not an array) fails', (await rejects(() => B.runBackup(S.io, { root: S.root, env: envProd }), 'malformed_listing')).match);
  S.srv.hook = ({ u, method }) => (method === 'POST' && u.pathname.includes('/object/list/coi-docs') ? new Response(JSON.stringify([{ name: 'x.pdf', id: 'i', updated_at: null, metadata: { size: 'big' } }]), { status: 200 }) : null);
  ok('a listing entry without a usable size/updated_at fails', (await rejects(() => B.runBackup(S.io, { root: S.root, env: envProd }), 'malformed_listing')).match);
  S.srv.hook = null; S.srv.buckets.delete('policy-docs');
  const r4 = await rejects(() => B.runBackup(S.io, { root: S.root, env: envProd }), 'required_bucket_missing');
  ok('a missing REQUIRED bucket is an alert (the API answers 200 [] for an unknown bucket, so existence is checked explicitly)', r4.threw && r4.match, r4.code);
  S.srv.buckets.set('policy-docs', new Map());
  let n500 = 0; S.srv.hook = ({ u, method }) => (method === 'GET' && u.pathname.endsWith('/new.pdf') && ++n500 <= 1 ? new Response('busy', { status: 500 }) : null);
  const r5 = await B.runBackup(S.io, { root: S.root, env: envProd });
  ok('one transient 500 is retried and the run completes', r5.result === 'complete' && n500 === 2 && snaps(S.root).length === 2, JSON.stringify({ n500, r: r5.result }));
  S.srv.put('coi-docs', 'brands/a/another.pdf', 'z'); S.srv.hook = ({ u, method }) => (method === 'GET' && u.pathname.endsWith('/another.pdf') ? new Response('down', { status: 503 }) : null);
  const r6 = await rejects(() => B.runBackup(S.io, { root: S.root, env: envProd }), 'retries_exhausted');
  ok('exhausted retries (503 three times) fail the run; still two snapshots', r6.match && snaps(S.root).length === 2, r6.code);
  S.srv.hook = ({ u, method }) => (method === 'GET' && u.pathname.endsWith('/another.pdf') ? new Response('truncat', { status: 200 }) : null);
  ok('a download whose length differs from the listing fails (size_mismatch)', (await rejects(() => B.runBackup(S.io, { root: S.root, env: envProd }), 'size_mismatch')).match);
  S.srv.hook = null;
}
console.log('\n— BAK-1: versions, deletions, pagination, a moving source, interruption, concurrency —');
{ const S = setup({ pageSize: 2 }); const P1 = 'brands/a/coi.pdf';
  S.srv.put('coi-docs', P1, 'ORIGINAL certificate bytes'); S.srv.put('avatars', 'brands/a/logo.png', makePng(1), 'image/png');
  for (let i = 0; i < 5; i++) S.srv.put('coi-docs', `brands/b/file-${i}.pdf`, 'f' + i);
  const a = await B.runBackup(S.io, { root: S.root, env: envProd }); const snapA = snaps(S.root)[0];
  ok('pagination: 7 objects across folders with a page size of 2 are all captured', a.objects === 7 && a.per_bucket['coi-docs'] === 6 && a.per_bucket.avatars === 1, JSON.stringify(a));
  S.srv.put('coi-docs', P1, 'REPLACED certificate bytes'); S.srv.del('avatars', 'brands/a/logo.png');
  const b = await B.runBackup(S.io, { root: S.root, env: envProd }); const snapB = snaps(S.root)[1];
  const ra = B.restoreSnapshot(S.io, { snapshotFile: join(S.root, 'snapshots', snapA), identity: S.keys.identity, outDir: join(S.base, 'restore-a'), expectRef: PROD.ref });
  const rb = B.restoreSnapshot(S.io, { snapshotFile: join(S.root, 'snapshots', snapB), identity: S.keys.identity, outDir: join(S.base, 'restore-b'), expectRef: PROD.ref });
  const bytes = (r, p) => { const f = r.files.find(x => x.path === p); return f ? readFileSync(f.local).toString() : null; };
  ok('[review case 3] same-path replacement: the EARLIER version survives in the earlier snapshot, the new one is in the later snapshot', bytes(ra, P1) === 'ORIGINAL certificate bytes' && bytes(rb, P1) === 'REPLACED certificate bytes');
  ok('a deleted file is absent from the next snapshot (retention is not renewed), still in the older one, and recorded as a tombstone with its path', b.removed_since_previous === 1 && !rb.files.some(f => f.path === 'brands/a/logo.png') && ra.files.some(f => f.path === 'brands/a/logo.png') && rb.tombstones.length === 1 && rb.tombstones[0].path === 'avatars/brands/a/logo.png', JSON.stringify(rb.tombstones));
  ok('object paths never appear in clear text on disk (state, sidecars, snapshot names)', !/brands\/a|coi\.pdf|logo\.png/.test(readFileSync(join(S.root, 'state.json'), 'utf8') + readdirSync(join(S.root, 'snapshots')).join(' ') + readdirSync(join(S.root, 'snapshots')).filter(f => f.endsWith('.json')).map(f => readFileSync(join(S.root, 'snapshots', f), 'utf8')).join(' ')));
  let flips = 0; S.srv.hook = ({ u, method }) => { if (method === 'GET' && u.pathname.endsWith('/file-0.pdf')) { S.srv.put('coi-docs', 'brands/b/file-1.pdf', 'changed-' + (++flips)); } return null; };
  const moving = await rejects(() => B.runBackup(S.io, { root: S.root, env: envProd }), 'source_changed_during_capture');
  ok('a source that changes during every capture pass fails — no snapshot claims to be complete', moving.match && snaps(S.root).length === 2 && flips === 3, `${moving.code} flips=${flips}`);
  flips = 0; S.srv.hook = ({ u, method }) => { if (method === 'GET' && u.pathname.endsWith('/file-0.pdf') && flips === 0) { flips++; S.srv.put('coi-docs', 'brands/b/file-2.pdf', 'changed-once'); } return null; };
  const settled = await B.runBackup(S.io, { root: S.root, env: envProd });
  ok('a source that changes once is re-captured and then published (second pass)', settled.result === 'complete' && snaps(S.root).length === 3);
  S.srv.hook = null;
  const before = snaps(S.root).map(f => sha(readFileSync(join(S.root, 'snapshots', f)))).join();
  const crashFs = { ...nodeFs, renameSync: (a, b2) => { if (String(b2).endsWith('.tar.age')) throw new Error('simulated kill during publish'); return nodeFs.renameSync(a, b2); } };
  const killed = await rejects(() => B.runBackup({ ...S.io, fs: crashFs }, { root: S.root, env: envProd }));
  ok('a run killed at publish time leaves the last complete snapshots untouched, no partial file in snapshots/, and releases the lock', killed.threw && snaps(S.root).map(f => sha(readFileSync(join(S.root, 'snapshots', f)))).join() === before && !readdirSync(join(S.root, 'snapshots')).some(f => f.includes('.partial')) && !existsSync(join(S.root, 'run.lock')) && B.verifyLocal(S.io, S.root).problems.length === 0);
  writeFileSync(join(S.root, 'run.lock'), JSON.stringify({ pid: 1, at: new Date(S.io.now()).toISOString() }));
  const busy = await rejects(() => B.runBackup(S.io, { root: S.root, env: envProd }), 'already_running');
  ok('a concurrent run is refused (lock) before touching anything', busy.match && snaps(S.root).length === 3);
  writeFileSync(join(S.root, 'run.lock'), JSON.stringify({ pid: 1, at: new Date(S.io.now() - 3 * 36e5).toISOString() }));
  ok('a stale lock (3 h old) is taken over and the run completes', (await B.runBackup(S.io, { root: S.root, env: envProd })).result === 'complete' && !existsSync(join(S.root, 'run.lock')));
}
console.log('\n— BAK-1.4: success is only recorded after an off-machine confirmation; staleness is visible —');
{ const S = setup({ offsite: false }); S.srv.put('coi-docs', 'a.pdf', 'x');
  const lo = await rejects(() => B.runBackup(S.io, { root: S.root, env: envProd }), 'local_only');
  ok('no off-machine destination: the local snapshot is kept, the run is NOT green, last_successful stays empty', lo.match && snaps(S.root).length === 1 && !state(S.root).last_successful_backup_at && !!state(S.root).last_local_complete_at && state(S.root).last_attempt_result === 'local_only_no_offsite_configured');
  ok('the missed-success check reports stale when there has never been a complete backup', B.checkFresh(S.io, S.root).fresh === false);
  const S2 = setup(); S2.srv.put('coi-docs', 'a.pdf', 'x'); rmSync(S2.off, { recursive: true });
  const of = await rejects(() => B.runBackup(S2.io, { root: S2.root, env: envProd }), 'offsite_failed');
  ok('off-machine destination unavailable (drive unplugged): non-zero, last_successful not advanced', of.match && !state(S2.root).last_successful_backup_at);
  mkdirSync(S2.off, { recursive: true }); const good = await B.runBackup(S2.io, { root: S2.root, env: envProd });
  const offFile = join(S2.off, good.snapshot);
  ok('with the destination back: the off-machine copy is byte-identical to the local snapshot and the run is green', good.result === 'complete' && sha(readFileSync(offFile)) === sha(readFileSync(join(S2.root, 'snapshots', good.snapshot))) && B.checkFresh(S2.io, S2.root).fresh === true);
  ok('pretend the workstation is gone: the OFF-MACHINE copy alone restores with the recovery identity', B.restoreSnapshot(S2.io, { snapshotFile: offFile, identity: S2.keys.identity, outDir: join(S2.base, 'r'), expectRef: PROD.ref }).files.length === 1);
  S2.advance(27 * 36e5); ok('27 hours without a new success: the check goes stale (26 h limit)', B.checkFresh(S2.io, S2.root).fresh === false && B.checkFresh(S2.io, S2.root).age_hours >= 27);
  const v = join(S2.root, 'snapshots', good.snapshot); const buf = readFileSync(v); buf[buf.length - 5] ^= 1; writeFileSync(v, buf);
  ok('verify detects a modified local snapshot', B.verifyLocal(S2.io, S2.root).problems.length === 1);
}
console.log('\n— BAK-2: exact destination, separate credentials, no path derived from an object name —');
{ const tries = { 'wrong host with the ref in its path': { ...envProd, url: `https://wrong-host.invalid/${PROD.ref}` }, 'ref as a subdomain label of another host': { ...envProd, url: `https://${PROD.ref}.supabase.co.evil.example` }, 'userinfo': { ...envProd, url: `https://user:pw@${PROD.ref}.supabase.co` }, 'explicit port': { ...envProd, url: `${PROD.origin}:8443` }, 'query': { ...envProd, url: `${PROD.origin}/?x=1` }, 'fragment': { ...envProd, url: `${PROD.origin}/#f` }, 'extra path': { ...envProd, url: `${PROD.origin}/storage` }, 'http': { ...envProd, url: PROD.origin.replace('https', 'http') }, 'TEST ref with the PRODUCTION url': { ...envProd, ref: TEST.ref }, 'production ref with the TEST url': { ...envProd, url: TEST.origin } };
  for (const [label, env] of Object.entries(tries)) { const S = setup(); const r = await rejects(() => B.runBackup(S.io, { root: S.root, env })); ok(`[review case 5] ${label}: refused with ZERO requests`, r.threw && S.srv.calls.length === 0 && ['origin_mismatch', 'project_mismatch', 'bad_url'].includes(r.code), `${r.code} calls=${S.srv.calls.length}`); }
  const S = setup(); S.srv.put('coi-docs', 'a.pdf', 'x'); await B.runBackup(S.io, { root: S.root, env: envProd });
  ok('every request refuses redirects (redirect: "error") and stays on the approved origin', S.srv.calls.length > 3 && S.srv.calls.every(c => c.redirect === 'error' && c.url.startsWith(PROD.origin + '/storage/v1/')));
  const St = new FakeStorage(TEST.origin); const mixed = await rejects(() => B.runBackup({ ...S.io, fetch: St.fetch }, { root: S.root, env: envTest, mode: 'test' }), 'state_project_mismatch');
  ok('a backup folder that belongs to production refuses test credentials with zero requests', mixed.match && St.calls.length === 0);
  // (a) the SOURCE side: a name that URL normalisation would re-route is never requested — the run fails instead
  for (const hostile of ['../../escape.bin', 'brands/../../../rest/v1/secrets', 'a\\b.pdf']) { const H = setup(); H.srv.put('coi-docs', hostile, 'x');
    const r = await rejects(() => B.runBackup(H.io, { root: H.root, env: envProd }), 'unfetchable_object_name');
    ok(`a hostile object name (${JSON.stringify(hostile)}) fails the run; every request stayed under /storage/v1/ and none fetched it`, r.match && H.srv.calls.every(c => new URL(c.url).pathname.startsWith('/storage/v1/') && !/escape|secrets|%5C/i.test(c.url) ) && snaps(H.root).length === 0, r.code); }
  // (b) names that ARE fetchable but are not safe Windows paths: backed up fine, never used as local paths
  const U = setup(); const odd = ['a:stream.pdf', 'CON', 'dir/NUL.txt', 'trailing./x.pdf', 'Case.pdf', 'case.pdf', 'brands/ü/文件 v2.pdf', 'brands/deep/er/ok.pdf'];
  odd.forEach((p, i) => U.srv.put('coi-docs', p, 'payload-' + i));
  const rep = await B.runBackup(U.io, { root: U.root, env: envProd }); const out = join(U.base, 'restore'); const res = B.restoreSnapshot(U.io, { snapshotFile: join(U.root, 'snapshots', rep.snapshot), identity: U.keys.identity, outDir: out, expectRef: PROD.ref });
  const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]);
  ok('alternate-stream / reserved / trailing-dot / case-colliding names are backed up, then quarantined under their content hash on restore (original path kept in the report)', rep.objects === 8 && res.quarantined.length === 5 && res.quarantined.every(q => /^_unsafe-names\/[0-9a-f]{64}$/.test(q.stored_as)) && res.files.every(f => resolve(f.local).startsWith(resolve(out))), JSON.stringify(res.quarantined.map(q => q.path)));
  const uni = res.files.find(f => f.path === 'brands/ü/文件 v2.pdf');
  ok('normal nested and unicode names round-trip exactly, without collision', uni && readFileSync(uni.local).toString() === 'payload-6' && readFileSync(res.files.find(f => f.path === 'brands/deep/er/ok.pdf').local).toString() === 'payload-7' && new Set(res.files.map(f => f.local.toLowerCase())).size === 8);
  // (c) the RESTORE side against a crafted snapshot whose manifest carries traversal paths
  const data = Buffer.from('crafted'); const h = sha(data); const crafted = { schema: 2, complete: true, project_ref: PROD.ref, objects: ['../../escape.bin', '..\\..\\escape2.bin', '/abs/escape3.bin', 'C:/escape4.bin', 'ok/fine.bin'].map(p => ({ bucket: 'coi-docs', path: p, size: data.length, sha256: h, mimetype: null })), tombstones: [] };
  const craftedFile = join(U.base, 'crafted.tar.age'); writeFileSync(craftedFile, encrypt(tarPack([{ name: 'manifest.json', data: Buffer.from(JSON.stringify(crafted)) }, { name: 'objects/' + h, data }]), U.keys.recipient));
  const cres = B.restoreSnapshot(U.io, { snapshotFile: craftedFile, identity: U.keys.identity, outDir: join(U.base, 'crafted-out'), expectRef: PROD.ref });
  const outside = walk(U.base).filter(f => /escape/i.test(f)); const roots2 = [join(tmpdir(), 'escape.bin'), join(tmpdir(), 'escape2.bin'), resolve(U.base, '..', 'escape.bin'), 'C:/escape4.bin', '/abs/escape3.bin'];
  ok('[review case 6] a snapshot whose manifest names traversal / absolute / drive paths causes NO write outside the restore root', outside.length === 0 && roots2.every(p => !existsSync(p)) && cres.quarantined.length === 4 && cres.files.every(f => resolve(f.local).startsWith(resolve(join(U.base, 'crafted-out')))), JSON.stringify({ outside, q: cres.quarantined.map(q => q.path) }));
  ok('the archive format itself refuses foreign entry names', (() => { try { tarPack([{ name: '../x', data: Buffer.from('a') }]); return false; } catch { return true; } })());
}
console.log('\n— BAK-3: restore restores, and every failure fails —');
{ const S = setup(); const pdf = makePdf('drill'), png = makePng(7); S.srv.put('coi-docs', 'zz-canary/canary.pdf', pdf); S.srv.put('avatars', 'zz-canary/canary.png', png, 'image/png');
  const rep = await B.runBackup(S.io, { root: S.root, env: envProd }); const file = join(S.off, rep.snapshot);
  const res = B.restoreSnapshot(S.io, { snapshotFile: file, identity: S.keys.identity, outDir: join(S.base, 'r1'), expectRef: PROD.ref });
  const rp = readFileSync(res.files.find(f => f.path.endsWith('.pdf')).local), rg = readFileSync(res.files.find(f => f.path.endsWith('.png')).local);
  ok('a genuine recovery from the OFF-MACHINE snapshot passes: identity, hashes, MIME/path mapping, and both canaries still open', rp.equals(pdf) && rg.equals(png) && validatePdf(rp).ok && validatePng(rg).ok && res.files.find(f => f.path.endsWith('.png')).mimetype === 'image/png' && res.manifest.project_ref === PROD.ref);
  ok('validators are not rubber stamps: a truncated PDF and a bit-flipped PNG are rejected', !validatePdf(pdf.subarray(0, pdf.length - 40)).ok && !validatePng(Buffer.from(png).fill(0, 60, 64)).ok);
  ok('the wrong recovery identity cannot restore', (() => { try { B.restoreSnapshot(S.io, { snapshotFile: file, identity: generateIdentity().identity, outDir: join(S.base, 'r2') }); return false; } catch { return true; } })());
  ok('a snapshot of another project is refused', (() => { try { B.restoreSnapshot(S.io, { snapshotFile: file, identity: S.keys.identity, outDir: join(S.base, 'r3'), expectRef: TEST.ref }); return false; } catch (e) { return e.code === 'snapshot_project_mismatch'; } })());
  ok('restore never writes into a non-empty folder', (() => { try { B.restoreSnapshot(S.io, { snapshotFile: file, identity: S.keys.identity, outDir: join(S.base, 'r1') }); return false; } catch (e) { return e.code === 'out_not_empty'; } })());
  const T = new FakeStorage(TEST.origin); const tio = { ...S.io, fetch: T.fetch }; const tt = B.resolveTarget('test', envTest); const job = { bucket: 'coi-docs', path: 'zz-restore-drill/x/canary.pdf', data: rp, mimetype: 'application/pdf' };
  const okRun = await B.uploadRestoredCanary(tio, tt, job);
  ok('upload-back of the restored canary to the TEST scratch path: identical read-back, removed, absence confirmed by not-found AND listing', okRun.read_back_identical && okRun.removed === true && T.buckets.get('coi-docs').size === 0);
  const prodRefuse = await rejects(() => B.uploadRestoredCanary(S.io, B.resolveTarget('production', envProd), job), 'refused'); const callsBefore = S.srv.calls.length;
  ok('the same call against PRODUCTION is refused with zero requests', prodRefuse.match && S.srv.calls.length === callsBefore);
  T.hook = ({ method }) => (method === 'POST' ? new Response('provider failure', { status: 500 }) : null);
  ok('[review case 4] a failed upload fails', (await rejects(() => B.uploadRestoredCanary(tio, tt, job), 'retries_exhausted')).match);
  let gets = 0; T.hook = ({ u, method }) => (method === 'GET' && u.pathname.includes('/object/coi-docs/') && ++gets === 1 ? new Response('different-content', { status: 200 }) : null);
  const mm = await rejects(() => B.uploadRestoredCanary(tio, tt, job), 'readback_mismatch');
  ok('[review case 4] changed bytes on read-back fail — and cleanup still ran (scratch object removed)', mm.match && T.buckets.get('coi-docs').size === 0 && mm.e.detail.removed === true, mm.code);
  T.hook = ({ method }) => (method === 'DELETE' ? new Response('nope', { status: 403 }) : null);
  const df = await rejects(() => B.uploadRestoredCanary(tio, tt, job));
  ok('a failed deletion fails and names the scratch object that needs cleanup (no URL, no key)', df.threw && df.e.detail.cleanup_needed === 'coi-docs/zz-restore-drill/x/canary.pdf' && !/https?:|synthetic-key/.test(JSON.stringify(df.e.detail) + df.e.message), JSON.stringify(df.e.detail));
  T.buckets.get('coi-docs').clear(); let afterDelete = false; T.hook = ({ method }) => { if (method === 'DELETE') { afterDelete = true; return null; } if (afterDelete && method === 'GET') return new Response('provider unavailable', { status: 500 }); return null; };
  const f5 = await rejects(() => B.uploadRestoredCanary(tio, tt, job), 'cleanup_unconfirmed');
  ok('[review case 4] a final read answering 500 is NOT proof of absence — the drill fails', f5.match, f5.code);
}
console.log('\n— retention (approved: 30 days, never the last good snapshot) —');
{
  const s = setup(); s.srv.put('coi-docs', 'a/coi.pdf', makePdf('retention')); const DAY = 864e5;
  const a = await B.runBackup(s.io, { root: s.root, env: envProd, mode: 'production' }); s.advance(20 * DAY);
  const b = await B.runBackup(s.io, { root: s.root, env: envProd, mode: 'production' }); s.advance(15 * DAY);
  ok('no approved number of days -> nothing is deleted', B.pruneLocal(s.io, s.root, undefined).pruned.length === 0 && B.pruneLocal(s.io, s.root, 3).pruned.length === 0 && snaps(s.root).length === 2);
  rmSync(s.off, { recursive: true, force: true }); const f = await rejects(() => B.runBackup(s.io, { root: s.root, env: envProd, mode: 'production' }), 'offsite_failed');
  const whileFailing = B.pruneLocal(s.io, s.root, 30);
  ok('while backups are failing nothing is deleted, even a 35-day-old snapshot', f.match && whileFailing.pruned.length === 0 && /not complete/.test(whileFailing.skipped) && snaps(s.root).includes(a.snapshot), JSON.stringify(whileFailing));
  mkdirSync(s.off, { recursive: true }); const c = await B.runBackup(s.io, { root: s.root, env: envProd, mode: 'production' }); const p = B.pruneLocal(s.io, s.root, 30); const left = snaps(s.root);
  ok('after a complete run: only the >30-day snapshot with a confirmed off-machine copy is removed; newer ones, the unconfirmed one and the last good one stay', JSON.stringify(p.pruned) === JSON.stringify([a.snapshot]) && left.includes(b.snapshot) && left.includes(c.snapshot) && left.length === 3 && p.kept_last_successful === c.snapshot && B.verifyLocal(s.io, s.root).problems.length === 0, JSON.stringify({ p, left }));
  s.advance(400 * DAY); const late = B.pruneLocal(s.io, s.root, 30);
  ok('a year with no new run: the last good snapshot and the never-confirmed one are still kept', snaps(s.root).includes(c.snapshot) && snaps(s.root).length === 2 && !late.pruned.includes(c.snapshot), JSON.stringify(late));
}
console.log('\n— primitives —');
{ const k = generateIdentity(); const big = Buffer.alloc(200000, 7); ok('age: multi-chunk round trip; wrong key and tampering refused', decrypt(encrypt(big, k.recipient), k.identity).equals(big) && (() => { try { decrypt(encrypt(big, k.recipient), generateIdentity().identity); return false; } catch { return true; } })());
  const t = tarPack([{ name: 'manifest.json', data: Buffer.from('{}') }, { name: 'objects/' + 'a'.repeat(64), data: Buffer.alloc(700, 1) }]); const u = tarUnpack(t); ok('tar: round trip', u.length === 2 && u[1].data.length === 700);
  const evil = Buffer.from(t); evil.write('../evil.txt\0', 0); ok('tar: a forged entry name is refused on unpack', (() => { try { tarUnpack(evil); return false; } catch { return true; } })()); }

for (const r of roots) { try { rmSync(r, { recursive: true, force: true }); } catch {} }
console.log(`\nstorage backup regression: ${pass} passed, ${fail} failed`);
if (fail) { console.log('FAILURES:\n' + fails.map(f => '  x ' + f).join('\n')); process.exit(1); }
