// backup-storage.mjs — READ-ONLY backup of Supabase Storage objects (COI certificates, policy documents, avatars).
// Codex pilot follow-up D: database backups do not include Storage objects.
//
//   node backup-storage.mjs backup  [--env C:/Users/David/prod.env] [--out <dir>]   download everything new/changed
//   node backup-storage.mjs verify  [--out <dir>]                                  re-hash the local copy against its manifest
//   node backup-storage.mjs restore-test --env C:/Users/David/demohub.env          isolated restore drill on the TEST project
//
// Production is only ever READ (list + download). The restore drill writes ONE synthetic file to a scratch
// folder of the TEST project, reads it back, compares hashes and deletes it; it refuses the production ref.
// Output contains real certificates and logos: it stays on the operator's machine, outside every git repo.
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';

const PROD_REF = 'dkgjvsstbgnhcfboqqnd', TEST_REF = 'tileejdviuvijumjeplv';
const BUCKETS = ['coi-docs', 'policy-docs', 'avatars'];
const args = process.argv.slice(2); const cmd = args[0];
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const sha = (b) => createHash('sha256').update(b).digest('hex');
const readEnv = (p) => Object.fromEntries(readFileSync(p, 'utf8').split(/\r?\n/).filter(l => /^[A-Z_]+=/.test(l)).map(l => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).trim()]; }));
const OUT = opt('--out', 'C:/Users/David/Documents/Codex/prod-storage-backup');

function target(envPath) {
  const e = readEnv(envPath);
  const url = e.PROD_URL || e.SB_URL, key = e.PROD_KEY || e.SB_KEY, ref = e.PROD_REF || e.SB_REF;
  if (!url || !key || !ref || !url.includes(ref)) throw new Error('env file must define URL, KEY and REF for one project');
  return { url, key, ref, H: { apikey: key, Authorization: 'Bearer ' + key } };
}
async function listAll(t, bucket, prefix = '') {
  const out = []; let offset = 0;
  for (;;) {
    const r = await fetch(`${t.url}/storage/v1/object/list/${bucket}`, { method: 'POST', headers: { ...t.H, 'Content-Type': 'application/json' }, body: JSON.stringify({ prefix, limit: 1000, offset, sortBy: { column: 'name', order: 'asc' } }) });
    if (r.status === 404 || r.status === 400) return out;            // bucket absent
    if (!r.ok) throw new Error(`list ${bucket}/${prefix}: ${r.status} ${(await r.text()).slice(0, 160)}`);
    const page = await r.json();
    for (const it of page) {
      const path = prefix ? `${prefix}/${it.name}` : it.name;
      if (it.id === null || it.metadata == null) out.push(...await listAll(t, bucket, path));   // folder
      else out.push({ path, size: it.metadata.size ?? null, updated_at: it.updated_at || null, mimetype: it.metadata.mimetype || null });
    }
    if (page.length < 1000) break; offset += 1000;
  }
  return out;
}

if (cmd === 'backup') {
  const t = target(opt('--env', 'C:/Users/David/prod.env'));
  if (t.ref !== PROD_REF) throw new Error(`backup expects the production project (${PROD_REF}), got ${t.ref}`);
  mkdirSync(OUT, { recursive: true });
  const manPath = join(OUT, 'MANIFEST.json');
  const man = existsSync(manPath) ? JSON.parse(readFileSync(manPath, 'utf8')) : { project_ref: t.ref, objects: {} };
  let fetched = 0, kept = 0, bytes = 0; const seen = new Set();
  for (const bucket of BUCKETS) {
    const objs = await listAll(t, bucket);
    for (const o of objs) {
      const id = `${bucket}/${o.path}`; seen.add(id);
      const prev = man.objects[id]; const file = join(OUT, bucket, ...o.path.split('/'));
      if (prev && prev.updated_at === o.updated_at && prev.size === o.size && existsSync(file)) { kept++; continue; }
      const r = await fetch(`${t.url}/storage/v1/object/${bucket}/${o.path.split('/').map(encodeURIComponent).join('/')}`, { headers: t.H });   // GET = read-only
      if (!r.ok) { console.log(`  ! ${id}: ${r.status}`); continue; }
      const buf = Buffer.from(await r.arrayBuffer());
      mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, buf);
      man.objects[id] = { size: buf.length, listed_size: o.size, updated_at: o.updated_at, mimetype: o.mimetype, sha256: sha(buf), backed_up_at: new Date().toISOString() };
      fetched++; bytes += buf.length;
    }
  }
  // objects that disappeared upstream are KEPT locally and flagged — a backup must outlive a deletion
  let goneUpstream = 0; for (const id of Object.keys(man.objects)) { if (!seen.has(id)) { if (!man.objects[id].gone_upstream_at) man.objects[id].gone_upstream_at = new Date().toISOString(); goneUpstream++; } else delete man.objects[id].gone_upstream_at; }
  man.last_run = new Date().toISOString();
  writeFileSync(manPath, JSON.stringify(man, null, 1));
  const per = {}; for (const id of Object.keys(man.objects)) { const b = id.split('/')[0]; per[b] = (per[b] || 0) + 1; }
  console.log(JSON.stringify({ project: t.ref, out: OUT, downloaded: fetched, unchanged: kept, bytes_downloaded: bytes, total_objects: Object.keys(man.objects).length, per_bucket: per, kept_although_gone_upstream: goneUpstream }));
} else if (cmd === 'verify') {
  const man = JSON.parse(readFileSync(join(OUT, 'MANIFEST.json'), 'utf8')); let ok = 0, bad = [];
  for (const [id, m] of Object.entries(man.objects)) { const file = join(OUT, ...id.split('/')); if (!existsSync(file)) { bad.push(id + ' (missing)'); continue; } const h = sha(readFileSync(file)); if (h === m.sha256 && statSync(file).size === m.size) ok++; else bad.push(id + ' (hash/size mismatch)'); }
  console.log(JSON.stringify({ verified: ok, problems: bad.length, first: bad.slice(0, 5) })); if (bad.length) process.exit(1);
} else if (cmd === 'restore-test') {
  const t = target(opt('--env', 'C:/Users/David/demohub.env'));
  if (t.ref === PROD_REF) throw new Error('REFUSING: the restore drill never runs against production');
  if (t.ref !== TEST_REF) throw new Error(`restore drill expects the test project (${TEST_REF}), got ${t.ref}`);
  const bucket = 'coi-docs', path = `zz-restore-drill/${Date.now()}-synthetic.pdf`;
  const body = Buffer.from('%PDF-1.4\n% synthetic restore-drill file, not a certificate\n' + 'x'.repeat(4096));
  const up = await fetch(`${t.url}/storage/v1/object/${bucket}/${path}`, { method: 'POST', headers: { ...t.H, 'Content-Type': 'application/pdf', 'x-upsert': 'false' }, body });
  const upOk = up.ok; const upTxt = upOk ? '' : (await up.text()).slice(0, 160);
  const dl = upOk ? await fetch(`${t.url}/storage/v1/object/${bucket}/${path}`, { headers: t.H }) : null;
  const back = dl && dl.ok ? Buffer.from(await dl.arrayBuffer()) : null;
  const del = upOk ? await fetch(`${t.url}/storage/v1/object/${bucket}/${path}`, { method: 'DELETE', headers: t.H }) : null;
  const after = upOk ? await fetch(`${t.url}/storage/v1/object/${bucket}/${path}`, { headers: t.H }) : null;
  console.log(JSON.stringify({ project: t.ref, bucket, uploaded: upOk, upload_error: upTxt || undefined, read_back_identical: !!back && sha(back) === sha(body), bytes: body.length, removed: !!del && del.ok, gone_after: !!after && !after.ok }));
} else { console.error('usage: backup | verify | restore-test'); process.exit(1); }
