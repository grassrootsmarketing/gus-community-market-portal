// TEST PROJECT ONLY. Acceptance checks for the read-only backup identity. Usage: node reader-accept.mjs before|after
// Prints booleans and status codes only; never a token, password or key.
import { readFileSync, appendFileSync } from 'node:fs';
import * as B from 'file:///C:/Users/David/demohub-docs/tools/backup/storage-backup.mjs';
import { makePdf } from 'file:///C:/Users/David/demohub-docs/tools/backup/canary.mjs';
const rd = (p) => Object.fromEntries(readFileSync(p, 'utf8').split(/\r?\n/).filter(l => /^[A-Z_]+=/.test(l)).map(l => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).trim()]; }));
const env = rd('C:/Users/David/demohub.env'), R = rd('C:/Users/David/demohub-backup-reader.test.env'); const phase = process.argv[2];
const O = 'https://tileejdviuvijumjeplv.supabase.co'; if (env.SB_URL !== O) { console.error('REFUSING: not demohub-rebuild-check'); process.exit(2); }
const io = B.defaultIo(); const out = { phase }; let bad = 0; const expect = (name, cond, detail) => { out[name] = cond ? 'ok' : 'FAIL ' + JSON.stringify(detail); if (!cond) bad++; };
const admin = B.resolveTarget('test', { url: O, key: env.SB_KEY, ref: env.SB_REF });
const pub = B.resolveTarget('test', { url: O, key: R.SB_PUBLISHABLE_KEY, ref: env.SB_REF });
const reader = await B.signInReader(io, pub, { email: R.READER_EMAIL, password: R.READER_PASSWORD, expectId: R.READER_ID });
const call = async (t, method, path, body, headers = {}) => { const r = await fetch(O + path, { method, redirect: 'error', headers: { apikey: t.key, Authorization: 'Bearer ' + (t.bearer || t.key), ...(body && !Buffer.isBuffer(body) ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body ? (Buffer.isBuffer(body) ? body : JSON.stringify(body)) : undefined }); let j = null; const buf = Buffer.from(await r.arrayBuffer()); try { j = JSON.parse(buf.toString()); } catch {} return { status: r.status, j, buf }; };

// fixture: one canary per bucket + one in an unrelated private bucket is not possible without creating a bucket, so
// "other buckets" is checked against the bucket list the reader can see.
const id = 'zz-reader-accept/' + Date.now().toString(36); const pdf = makePdf('reader acceptance ' + id); const fx = { bucket: 'coi-docs', path: id + '/canary.pdf' };
await B.testOnlyPut(io, admin, { ...fx, data: pdf, mimetype: 'application/pdf' });
try {
  const buckets = await call(reader, 'GET', '/storage/v1/bucket'); const list = await call(reader, 'POST', '/storage/v1/object/list/coi-docs', { prefix: id, limit: 100, offset: 0 }); const get = await call(reader, 'GET', `/storage/v1/object/coi-docs/${id}/canary.pdf`);
  const sees = { buckets: Array.isArray(buckets.j) ? buckets.j.map(b => b.id).sort() : buckets.status, listed: Array.isArray(list.j) ? list.j.length : list.status, download: get.status, identical: get.buf.equals(pdf) };
  if (phase === 'before') expect('WITHOUT the policy the reader sees no bucket, no object, and cannot download', Array.isArray(buckets.j) && buckets.j.length === 0 && sees.listed === 0 && get.status !== 200, sees);
  else {
    expect('reader lists exactly the three buckets', JSON.stringify(sees.buckets) === JSON.stringify(['avatars', 'coi-docs', 'policy-docs']), sees);
    expect('reader lists and downloads the canary, byte-identical', sees.listed === 1 && sees.download === 200 && sees.identical, sees);
  }
  // ---- writes: every one must be refused, and the canary must be unchanged afterwards (checked with the admin key)
  const w = {};
  w.upload_new = (await call(reader, 'POST', `/storage/v1/object/coi-docs/${id}/evil.pdf`, pdf, { 'Content-Type': 'application/pdf' })).status;
  w.overwrite = (await call(reader, 'PUT', `/storage/v1/object/coi-docs/${id}/canary.pdf`, Buffer.from('overwritten'), { 'Content-Type': 'application/pdf' })).status;
  w.upsert = (await call(reader, 'POST', `/storage/v1/object/coi-docs/${id}/canary.pdf`, Buffer.from('overwritten'), { 'Content-Type': 'application/pdf', 'x-upsert': 'true' })).status;
  w.delete_one = (await call(reader, 'DELETE', `/storage/v1/object/coi-docs/${id}/canary.pdf`)).status;
  const bulk = await call(reader, 'DELETE', '/storage/v1/object/coi-docs', { prefixes: [`${id}/canary.pdf`] }); w.delete_bulk = bulk.status + ':' + (Array.isArray(bulk.j) ? bulk.j.length + ' removed' : 'refused');
  w.move = (await call(reader, 'POST', '/storage/v1/object/move', { bucketId: 'coi-docs', sourceKey: `${id}/canary.pdf`, destinationKey: `${id}/moved.pdf` })).status;
  w.copy = (await call(reader, 'POST', '/storage/v1/object/copy', { bucketId: 'coi-docs', sourceKey: `${id}/canary.pdf`, destinationKey: `${id}/copy.pdf` })).status;
  w.signed_upload_url = (await call(reader, 'POST', `/storage/v1/object/upload/sign/coi-docs/${id}/signed.pdf`)).status;
  w.create_bucket = (await call(reader, 'POST', '/storage/v1/bucket', { id: 'zz-reader-evil', name: 'zz-reader-evil', public: true })).status;
  w.make_coi_public = (await call(reader, 'PUT', '/storage/v1/bucket/coi-docs', { public: true })).status;
  w.empty_bucket = (await call(reader, 'POST', '/storage/v1/bucket/coi-docs/empty')).status;
  w.delete_bucket = (await call(reader, 'DELETE', '/storage/v1/bucket/policy-docs')).status;
  const after = []; await (async () => { const l = await call(admin, 'POST', '/storage/v1/object/list/coi-docs', { prefix: id, limit: 100, offset: 0 }); for (const o of l.j || []) after.push(o.name); })();
  const still = await call(admin, 'GET', `/storage/v1/object/coi-docs/${id}/canary.pdf`); const bk = await call(admin, 'GET', '/storage/v1/bucket'); const coi = (bk.j || []).find(b => b.id === 'coi-docs');
  const refused = Object.entries(w).every(([k, v]) => k === 'delete_bulk' ? /0 removed|refused/.test(v) : Number(v) >= 400);
  expect('every write / delete / move / copy / bucket change is refused', refused, w);
  expect('afterwards (admin view): only the canary exists, unchanged; coi-docs still private; no new bucket', JSON.stringify(after) === JSON.stringify(['canary.pdf']) && still.buf.equals(pdf) && coi && coi.public === false && !(bk.j || []).some(b => b.id === 'zz-reader-evil'), { after, coi_public: coi && coi.public });
  // ---- database: nothing through REST, no RPC beyond what anon already has
  const t1 = await call(reader, 'GET', '/rest/v1/bookings?select=id&limit=1'), t2 = await call(reader, 'GET', '/rest/v1/internal_contacts?select=id&limit=1'), t3 = await call(reader, 'GET', '/rest/v1/payments?select=id&limit=1'), t4 = await call(reader, 'POST', '/rest/v1/retailers', { name: 'evil' });
  const rows = (x) => (Array.isArray(x.j) ? x.j.length : 0);
  expect('REST: no rows from bookings / internal_contacts / payments, and no insert', [t1, t2, t3].every(x => x.status >= 400 || rows(x) === 0) && t4.status >= 400, { bookings: t1.status, contacts: t2.status, payments: t3.status, insert: t4.status });
  const anonR = await call(pub, 'GET', '/rest/v1/retailers?select=id'), readerR = await call(reader, 'GET', '/rest/v1/retailers?select=id');
  expect('REST retailers: the reader sees no more than an anonymous visitor does', rows(readerR) <= rows(anonR), { anon: anonR.status + ':' + rows(anonR), reader: readerR.status + ':' + rows(readerR) });
  // ---- identity cannot be widened by its holder
  const self = await call(reader, 'PUT', '/auth/v1/user', { data: { role: 'service_role' }, app_metadata: { role: 'service_role' } }); const again = await B.signInReader(io, pub, { email: R.READER_EMAIL, password: R.READER_PASSWORD, expectId: R.READER_ID });
  const claims = JSON.parse(Buffer.from(again.bearer.split('.')[1], 'base64url').toString());
  expect('the holder cannot change its own role or app metadata', claims.role === 'authenticated' && claims.sub === R.READER_ID && (claims.app_metadata || {}).role === undefined, { put_status: self.status, role: claims.role });
  const adminApi = await call(reader, 'GET', '/auth/v1/admin/users'); expect('the reader cannot use the Auth admin API', adminApi.status >= 400, adminApi.status);
  // ---- anon unchanged; a DIFFERENT authenticated user gets nothing
  const an = { b: await call(pub, 'GET', '/storage/v1/bucket'), l: await call(pub, 'POST', '/storage/v1/object/list/coi-docs', { prefix: id, limit: 10, offset: 0 }), g: await call(pub, 'GET', `/storage/v1/object/coi-docs/${id}/canary.pdf`) };
  expect('anonymous (publishable key alone): no buckets, no listing, no coi-docs download', (an.b.status >= 400 || rows(an.b) === 0) && (an.l.status >= 400 || rows(an.l) === 0) && an.g.status !== 200, { b: an.b.status, l: an.l.status, g: an.g.status });
  if (phase === 'after') {
    const other = { email: `zz-other-${Date.now().toString(36)}@demohubhq.com`, password: 'Zz-' + Math.random().toString(36).slice(2) + '-' + Date.now() };
    const mk = await call(admin, 'POST', '/auth/v1/admin/users', { email: other.email, password: other.password, email_confirm: true });
    try { const ot = await B.signInReader(io, pub, other); const ob = await call(ot, 'GET', '/storage/v1/bucket'), ol = await call(ot, 'POST', '/storage/v1/object/list/coi-docs', { prefix: id, limit: 10, offset: 0 }), og = await call(ot, 'GET', `/storage/v1/object/coi-docs/${id}/canary.pdf`);
      expect('a DIFFERENT signed-in user sees no bucket, no object, no download', rows(ob) === 0 && rows(ol) === 0 && og.status !== 200, { b: ob.status + ':' + rows(ob), l: ol.status + ':' + rows(ol), g: og.status }); }
    finally { const del = await call(admin, 'DELETE', '/auth/v1/admin/users/' + mk.j.id); out.other_user_removed = del.status === 200; }
    // ---- the real tool, end to end, using ONLY the publishable key + the reader login as its source
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs'); const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
    const base = mkdtempSync(join(tmpdir(), 'dh-reader-')); const root = join(base, 'local'), off = join(base, 'off'); mkdirSync(root); mkdirSync(off); const k = B.generateIdentity(); writeFileSync(join(root, 'backup-config.json'), JSON.stringify({ recipient: k.recipient, offsite: [{ type: 'dir', path: off }], require_offsite: true }));
    try { const r = await B.runBackup(io, { root, env: { url: O, key: R.SB_PUBLISHABLE_KEY, ref: env.SB_REF, reader: { email: R.READER_EMAIL, password: R.READER_PASSWORD, expectId: R.READER_ID } }, mode: 'test', buckets: ['coi-docs'], prefix: id });
      const rs = B.restoreSnapshot(io, { snapshotFile: join(off, r.snapshot), identity: k.identity, outDir: join(base, 'restored'), expectRef: env.SB_REF });
      expect('the backup tool completes with the reader login as its ONLY source credential, and the restore is byte-identical', r.result === 'complete' && r.objects === 1 && readFileSync(rs.files[0].local).equals(pdf), { result: r.result, objects: r.objects }); }
    finally { rmSync(base, { recursive: true, force: true }); }
  }
} finally { await B.testOnlyDelete(io, admin, fx); out.fixture_removed = true; }
out.failed = bad; console.log(JSON.stringify(out, null, 1)); if (bad) process.exit(1);
