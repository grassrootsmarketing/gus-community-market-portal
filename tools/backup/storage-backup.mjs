// storage-backup.mjs (v2) — full, encrypted, uniquely named snapshots of Supabase Storage.
// Codex work order 2026-09-19 (BAK-1 failures are visible + snapshots complete; BAK-2 destination and path
// boundaries; BAK-3 a restore that restores). Library first, CLI at the bottom; every network and filesystem
// effect goes through the injected `io`, so the regression tests drive the real logic.
//
// Guarantees:
//   * any listing / page / download / retry failure, a missing required bucket, a size or hash mismatch, or a
//     source that keeps changing => the run FAILS (non-zero) and nothing partial is published;
//   * a snapshot is one immutable `<name>.tar.age`, written to a temp name and renamed only after it re-validates;
//     the previous good snapshot is never touched; one run at a time (lock file);
//   * object bytes are stored under content-addressed names; original object paths live only inside the
//     ENCRYPTED manifest; the runner holds only the public age recipient, never the recovery identity;
//   * `last_successful_backup_at` moves only after source completeness + local validation + encryption +
//     confirmation (read-back hash) at every configured off-machine destination.
import { createHash, randomBytes } from 'node:crypto';
import { join, resolve, sep } from 'node:path';
import * as nodeFs from 'node:fs';
import { encrypt, decrypt, parseRecipient, generateIdentity } from './age.mjs';
import { tarPack, tarUnpack } from './tar.mjs';

export const TOOL_VERSION = '2.0.0';
export const PROJECTS = {
  production: { ref: 'dkgjvsstbgnhcfboqqnd', origin: 'https://dkgjvsstbgnhcfboqqnd.supabase.co' },
  test:       { ref: 'tileejdviuvijumjeplv', origin: 'https://tileejdviuvijumjeplv.supabase.co' },
};
export const REQUIRED_BUCKETS = ['coi-docs', 'policy-docs', 'avatars'];
export class BackupError extends Error { constructor(code, message, detail) { super(`${code}: ${message}`); this.code = code; this.detail = detail; } }
const sha256 = (b) => createHash('sha256').update(b).digest('hex');
const nowIso = (io) => new Date(io.now()).toISOString();

// ---- BAK-2.1 exact destination ---------------------------------------------------------------------
export function resolveTarget(mode, env) {
  const p = PROJECTS[mode]; if (!p) throw new BackupError('bad_mode', `unknown mode ${mode}`);
  const ref = env.ref, key = env.key, raw = env.url;
  if (!ref || !key || !raw) throw new BackupError('env_incomplete', 'url, key and ref are all required');
  if (ref !== p.ref) throw new BackupError('project_mismatch', `mode ${mode} requires project ${p.ref}, the credentials name ${ref}`);
  let u; try { u = new URL(raw); } catch { throw new BackupError('bad_url', 'the configured URL does not parse'); }
  const bare = u.protocol === 'https:' && !u.username && !u.password && !u.port && !u.search && !u.hash && (u.pathname === '/' || u.pathname === '') && !/[?#]$/.test(raw.trim());
  if (!bare || u.origin !== p.origin) throw new BackupError('origin_mismatch', `mode ${mode} only talks to ${p.origin}`);
  return { mode, ref: p.ref, origin: p.origin, key };
}

// ---- BAK-4 restricted source identity ----------------------------------------------------------------
// Sign in as the ONE dedicated backup user (password grant) and use its short-lived token for Storage. `t.key` is
// then the project's PUBLISHABLE key: on its own it grants nothing, so no service key is needed for a backup.
// The only non-Storage request this tool ever makes; same exact origin, redirects refused, bounded, never retried
// (a wrong password must not hammer the sign-in endpoint), and the response text is never echoed.
export async function signInReader(io, t, { email, password, expectId }) {
  if (!email || !password) throw new BackupError('env_incomplete', 'reader sign-in needs an email and a password');
  let r; try { r = await io.fetch(t.origin + '/auth/v1/token?grant_type=password', { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(io.timeoutMs), headers: { apikey: t.key, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) }); }
  catch (e) { throw new BackupError('signin_failed', 'the sign-in request failed: ' + (e && e.name === 'TimeoutError' ? 'timed out' : 'network')); }
  if (r.status !== 200) throw new BackupError('signin_failed', 'sign-in answered ' + r.status);
  let j = null; try { j = await r.json(); } catch {}
  if (!j || typeof j.access_token !== 'string' || !j.user || typeof j.user.id !== 'string') throw new BackupError('signin_failed', 'sign-in response is malformed');
  if (expectId && j.user.id !== expectId) throw new BackupError('signin_failed', 'signed in as an unexpected principal');
  return { ...t, bearer: j.access_token, principal: j.user.id };
}

// ---- bounded, redirect-refusing HTTP ---------------------------------------------------------------
async function http(io, t, method, path, { json, body, headers = {}, okStatuses = [200] } = {}) {
  if (!path.startsWith('/storage/v1/')) throw new BackupError('bad_path', 'only Storage API paths are requested');
  const url = t.origin + path; let last;
  // URL normalisation must not be able to move a request somewhere else (dot segments, encoded or not)
  if (new URL(url).origin !== t.origin || new URL(url).pathname !== path.split('?')[0]) throw new BackupError('bad_path', 'the request path does not survive URL normalisation unchanged');
  for (let attempt = 1; attempt <= io.retries; attempt++) {
    try {
      const r = await io.fetch(url, { method, redirect: 'error', signal: AbortSignal.timeout(io.timeoutMs),
        headers: { apikey: t.key, Authorization: 'Bearer ' + (t.bearer || t.key), ...(json ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: json ? JSON.stringify(json) : body });
      if (okStatuses.includes(r.status)) return r;
      const text = (await r.text().catch(() => '')).slice(0, 200);
      last = new BackupError('http_' + r.status, `${method} ${path.replace(/\?.*/, '')} answered ${r.status}`, { status: r.status, text });
      if (!(r.status === 429 || r.status >= 500)) throw last;                 // a definitive refusal is not retried
    } catch (e) { if (e instanceof BackupError && !(e.detail && (e.detail.status === 429 || e.detail.status >= 500))) throw e; last = e instanceof BackupError ? e : new BackupError('network', `${method} ${path.replace(/\?.*/, '')}: ${e && e.name === 'TimeoutError' ? 'timed out' : 'request failed'}`); }
    if (attempt < io.retries) await io.sleep(io.retryDelayMs * attempt);
  }
  throw new BackupError('retries_exhausted', last.message, last.detail);
}
const encPath = (p) => p.split('/').map(encodeURIComponent).join('/');

// ---- BAK-1.1 a complete, valid inventory or a failure ----------------------------------------------
async function requireBuckets(io, t, buckets) {
  const r = await http(io, t, 'GET', '/storage/v1/bucket'); let list; try { list = await r.json(); } catch { list = null; }
  if (!Array.isArray(list) || list.some(b => !b || typeof b.id !== 'string')) throw new BackupError('malformed_bucket_list', 'the bucket list is not a well-formed array');
  const have = new Set(list.map(b => b.id)); const missing = buckets.filter(b => !have.has(b));
  if (missing.length) throw new BackupError('required_bucket_missing', `required bucket(s) absent: ${missing.join(', ')} — this is an alert, not an empty backup`);
}
async function listPrefix(io, t, bucket, prefix, out, depth = 0) {
  if (depth > 12) throw new BackupError('listing_too_deep', `folder nesting beyond 12 levels in ${bucket}`);
  for (let offset = 0; ; offset += io.pageSize) {
    const r = await http(io, t, 'POST', `/storage/v1/object/list/${encodeURIComponent(bucket)}`, { json: { prefix, limit: io.pageSize, offset, sortBy: { column: 'name', order: 'asc' } } });
    let page; try { page = await r.json(); } catch { page = null; }
    if (!Array.isArray(page)) throw new BackupError('malformed_listing', `listing of ${bucket}/${prefix} is not an array`);
    for (const it of page) {
      if (!it || typeof it.name !== 'string' || !it.name || it.name.includes('/')) throw new BackupError('malformed_listing', `listing of ${bucket}/${prefix} has a malformed entry`);
      if (it.name === '.' || it.name === '..' || /[\\\x00-\x1f]/.test(it.name)) throw new BackupError('unfetchable_object_name', `an entry under ${bucket} has a name that cannot be requested safely — it cannot be backed up, so the run is not complete`);
      const path = prefix ? `${prefix}/${it.name}` : it.name;
      if (it.id == null && it.metadata == null) { await listPrefix(io, t, bucket, path, out, depth + 1); continue; }     // folder
      if (it.id == null || !it.metadata || !Number.isFinite(it.metadata.size) || typeof it.updated_at !== 'string') throw new BackupError('malformed_listing', `object entry without id/size/updated_at under ${bucket}/${prefix}`);
      out.push({ bucket, path, size: it.metadata.size, mimetype: it.metadata.mimetype || null, updated_at: it.updated_at, etag: it.metadata.eTag || null });
    }
    if (page.length < io.pageSize) return;
  }
}
export async function inventory(io, t, { buckets = REQUIRED_BUCKETS, prefix = '' } = {}) {
  await requireBuckets(io, t, buckets);
  const out = []; for (const b of buckets) await listPrefix(io, t, b, prefix, out);
  const ids = new Set(); for (const o of out) { const id = `${o.bucket}/${o.path}`; if (ids.has(id)) throw new BackupError('malformed_listing', 'the same object was listed twice (pagination overlap)'); ids.add(id); }
  return out.sort((a, b) => (a.bucket + '/' + a.path < b.bucket + '/' + b.path ? -1 : 1));
}
const fingerprint = (inv) => sha256(JSON.stringify(inv.map(o => [o.bucket, o.path, o.size, o.updated_at, o.etag])));

// ---- BAK-1.2 full snapshot with change detection ---------------------------------------------------
export async function capture(io, t, opts = {}) {
  for (let pass = 1; pass <= io.capturePasses; pass++) {
    const started = nowIso(io); const before = await inventory(io, t, opts); const blobs = new Map(); const objects = []; let mismatch = null;
    for (const o of before) {
      const r = await http(io, t, 'GET', `/storage/v1/object/${encodeURIComponent(o.bucket)}/${encPath(o.path)}`);
      const buf = Buffer.from(await r.arrayBuffer());
      // a length that differs from the listing is either an object replaced mid-capture (the inventory will differ
      // below -> capture again) or a broken download (the inventory is unchanged -> fail). Never archive it.
      if (buf.length !== o.size) { mismatch = new BackupError('size_mismatch', `an object in ${o.bucket} downloaded as ${buf.length} bytes, listed as ${o.size}`); break; }
      const h = sha256(buf); blobs.set(h, buf); objects.push({ ...o, sha256: h });
    }
    const after = await inventory(io, t, opts);
    if (fingerprint(before) === fingerprint(after)) { if (mismatch) throw mismatch; return { objects, blobs, capture_started_at: started, capture_finished_at: nowIso(io), passes: pass }; }
  }
  throw new BackupError('source_changed_during_capture', `the source inventory changed during ${io.capturePasses} consecutive capture passes — no snapshot was published`);
}

// ---- state, lock, config ---------------------------------------------------------------------------
const P = (root, ...a) => join(root, ...a);
const readJson = (io, file, dflt) => { try { return JSON.parse(io.fs.readFileSync(file, 'utf8')); } catch { return dflt; } };
const writeJsonAtomic = (io, file, obj) => { const tmp = file + '.tmp-' + randomBytes(4).toString('hex'); io.fs.writeFileSync(tmp, JSON.stringify(obj, null, 1)); io.fs.renameSync(tmp, file); };
export function loadConfig(io, root) {
  const c = readJson(io, P(root, 'backup-config.json'), null); if (!c) throw new BackupError('no_config', `missing ${P(root, 'backup-config.json')} — run "init" first`);
  parseRecipient(c.recipient); if (!Array.isArray(c.offsite)) c.offsite = []; if (c.require_offsite === undefined) c.require_offsite = true; return c;
}
function acquireLock(io, root) {
  const file = P(root, 'run.lock');
  try { io.fs.writeFileSync(file, JSON.stringify({ pid: io.pid, at: nowIso(io) }), { flag: 'wx' }); }
  catch (e) { const cur = readJson(io, file, null); const age = cur ? io.now() - Date.parse(cur.at) : Infinity;
    if (cur && age < io.lockStaleMs) throw new BackupError('already_running', `another backup run holds the lock since ${cur.at}`);
    io.fs.writeFileSync(file, JSON.stringify({ pid: io.pid, at: nowIso(io), took_over_stale_lock_from: cur && cur.at })); }
  return () => { try { io.fs.unlinkSync(file); } catch {} };
}

// ---- the backup run --------------------------------------------------------------------------------
export async function runBackup(io, { root, env, mode = 'production', buckets, prefix, requireReader = false } = {}) {
  io.fs.mkdirSync(P(root, 'snapshots'), { recursive: true }); io.fs.mkdirSync(P(root, 'tmp'), { recursive: true });
  const statePath = P(root, 'state.json'); const release = acquireLock(io, root);
  const state = readJson(io, statePath, { schema: 2 }); state.last_attempt_at = nowIso(io); state.last_attempt_result = 'started'; writeJsonAtomic(io, statePath, state);
  const runId = nowIso(io).replace(/[-:]/g, '').replace(/\..*/, 'Z') + '-' + randomBytes(3).toString('hex'); const work = P(root, 'tmp', 'run-' + runId);
  try {
    const cfg = loadConfig(io, root); let t = resolveTarget(mode, env);                 // BAK-2: before any request
    // Codex closure review 2026-09-20, item 3: in PRODUCTION the off-machine requirement is not configurable, and only a
    // physically independent destination type counts (a local folder named "off-machine" does not). Checked before any request.
    const independent = (d) => (io.independentTypes || ['s3']).includes(d && d.type);
    if (mode === 'production') {
      if (cfg.require_offsite === false) throw new BackupError('config_invalid', 'production backups always require an off-machine copy; require_offsite:false is not accepted');
      if (requireReader && !env.reader) throw new BackupError('reader_required', 'this run must use the restricted backup reader login; no other source credential is accepted');
    }
    if (env.reader) t = await signInReader(io, t, env.reader);                          // BAK-4: restricted read-only identity instead of a service key
    if (requireReader && mode === 'production' && (!t.principal || t.principal !== env.reader.expectId)) throw new BackupError('reader_required', 'the authenticated principal is not the expected backup reader');
    if (state.project_ref && state.project_ref !== t.ref) throw new BackupError('state_project_mismatch', `this backup folder belongs to ${state.project_ref}, not ${t.ref}`);
    const cap = await capture(io, t, { buckets, prefix });
    // tombstones: ids seen in the previous COMPLETE snapshot and absent from this complete inventory
    const prevIndex = state.index || {}; const index = {}; const idOf = (o) => sha256(`${o.bucket}/${o.path}`);
    for (const o of cap.objects) index[idOf(o)] = prevIndex[idOf(o)]?.p ? { p: prevIndex[idOf(o)].p } : { p: encrypt(Buffer.from(`${o.bucket}/${o.path}`), cfg.recipient).toString('base64') };
    const tomb = { ...(state.tombstones || {}) }; for (const id of Object.keys(prevIndex)) if (!index[id] && !tomb[id]) tomb[id] = { p: prevIndex[id].p, first_absent_at: cap.capture_finished_at };
    for (const id of Object.keys(tomb)) if (index[id]) delete tomb[id];                     // it came back
    const manifest = { schema: 2, tool_version: TOOL_VERSION, project_ref: t.ref, origin: t.origin, mode, buckets: buckets || REQUIRED_BUCKETS, prefix: prefix || '',
      complete: true, capture_started_at: cap.capture_started_at, capture_finished_at: cap.capture_finished_at, capture_passes: cap.passes,
      object_count: cap.objects.length, total_bytes: cap.objects.reduce((n, o) => n + o.size, 0), objects: cap.objects,
      tombstones: Object.entries(tomb).map(([id, v]) => ({ id, first_absent_at: v.first_absent_at, encrypted_path_b64: v.p })),
      note: 'Not a globally atomic source snapshot: the inventory was identical before and after the downloads.' };
    const tar = tarPack([{ name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest)) }, ...[...cap.blobs.entries()].map(([h, data]) => ({ name: 'objects/' + h, data }))]);
    // local validation of exactly what will be encrypted
    const back = tarUnpack(tar); const m2 = JSON.parse(back.find(e => e.name === 'manifest.json').data.toString());
    for (const o of m2.objects) { const e = back.find(x => x.name === 'objects/' + o.sha256); if (!e || sha256(e.data) !== o.sha256 || e.data.length !== o.size) throw new BackupError('local_validation_failed', 'an archived object does not match its manifest entry'); }
    const cipher = encrypt(tar, cfg.recipient); const name = `demohub-storage-${t.ref}-${runId}.tar.age`; const csha = sha256(cipher);
    io.fs.mkdirSync(work, { recursive: true }); const tmpFile = P(work, name + '.partial'); io.fs.writeFileSync(tmpFile, cipher);
    if (sha256(io.fs.readFileSync(tmpFile)) !== csha) throw new BackupError('local_write_failed', 'the written archive does not hash to what was produced');
    const finalFile = P(root, 'snapshots', name); if (io.fs.existsSync(finalFile)) throw new BackupError('name_collision', 'a snapshot with this name already exists');
    io.fs.renameSync(tmpFile, finalFile);                                                  // publish: immutable from here
    const sidecar = { name, created_at: nowIso(io), project_ref: t.ref, tool_version: TOOL_VERSION, complete: true, object_count: manifest.object_count, total_bytes: manifest.total_bytes, ciphertext_bytes: cipher.length, ciphertext_sha256: csha, tombstones: manifest.tombstones.length, offsite: [] };
    // off-machine copies, each confirmed by reading back and hashing
    for (const d of cfg.offsite) { const res = await io.offsite(d, name, cipher, csha); sidecar.offsite.push(res); }
    const confirmed = sidecar.offsite.filter(o => o.confirmed).length; const failedOffsite = sidecar.offsite.filter(o => !o.confirmed);
    const confirmedIndependent = cfg.offsite.filter((d, i) => sidecar.offsite[i] && sidecar.offsite[i].confirmed && independent(d)).length;
    io.fs.writeFileSync(P(root, 'snapshots', name + '.json'), JSON.stringify(sidecar, null, 1));
    state.project_ref = t.ref; state.index = index; state.tombstones = tomb; state.last_local_complete_at = sidecar.created_at; state.last_local_snapshot = name;
    let result = 'complete';
    if (failedOffsite.length) result = 'offsite_failed';
    else if (mode === 'production' ? !confirmedIndependent : (!confirmed && cfg.require_offsite)) result = 'local_only_no_offsite_configured';
    if (result === 'complete') { state.last_successful_backup_at = sidecar.created_at; state.last_successful_snapshot = name; }
    state.last_attempt_result = result; writeJsonAtomic(io, statePath, state);
    const report = { result, snapshot: name, objects: manifest.object_count, bytes: manifest.total_bytes, per_bucket: countBy(cap.objects), removed_since_previous: manifest.tombstones.length, offsite_confirmed: confirmed, offsite_confirmed_independent: confirmedIndependent, source_identity: t.principal ? 'restricted reader login ' + t.principal : 'service key', last_successful_backup_at: state.last_successful_backup_at || null };
    if (result === 'offsite_failed') throw new BackupError('offsite_failed', `the local snapshot is complete but ${failedOffsite.length} off-machine copy/copies could not be confirmed`, report);
    if (result !== 'complete') throw new BackupError('local_only', 'the snapshot is complete LOCALLY, but no off-machine destination is configured, so this does not count as a successful backup', report);
    return report;
  } catch (e) {
    const s = readJson(io, statePath, state); if (s.last_attempt_result === 'started') { s.last_attempt_result = 'failed: ' + (e.code || 'error'); writeJsonAtomic(io, statePath, s); }
    throw e;
  } finally { try { io.fs.rmSync(work, { recursive: true, force: true }); } catch {} release(); }
}
const countBy = (objs) => objs.reduce((a, o) => (a[o.bucket] = (a[o.bucket] || 0) + 1, a), {});

// ---- verify (local ciphertext integrity; cannot decrypt by design) and the missed-success check ----
export function verifyLocal(io, root) {
  const dir = P(root, 'snapshots'); const files = io.fs.existsSync(dir) ? io.fs.readdirSync(dir) : []; const problems = []; let ok = 0;
  for (const f of files.filter(x => x.endsWith('.tar.age'))) { const sc = readJson(io, P(dir, f + '.json'), null); if (!sc) { problems.push(f + ': no sidecar (unpublished or foreign file)'); continue; }
    const h = sha256(io.fs.readFileSync(P(dir, f))); if (h !== sc.ciphertext_sha256 || !sc.complete) problems.push(f + ': hash mismatch or not marked complete'); else ok++; }
  for (const f of files.filter(x => x.endsWith('.partial'))) problems.push(f + ': leftover partial file');
  return { snapshots_ok: ok, problems };
}
// ---- retention (David approved 2026-09-19: 30 days of daily snapshots, never the last good one) ------------
// Local folder only; the off-machine bucket expires objects with its own lifecycle rule because the uploader
// identity cannot delete. Rules: runs only when the state says the LAST attempt was complete (a failing backup
// never triggers deletion); never removes `last_successful_snapshot`; never removes a snapshot whose sidecar lacks
// a confirmed off-machine copy; ignores anything it does not recognise.
export function pruneLocal(io, root, retentionDays) {
  const days = Number(retentionDays); if (!Number.isFinite(days) || days < 7) return { pruned: [], skipped: 'no approved retention (needs a number of days >= 7)' };
  const s = readJson(io, P(root, 'state.json'), {}); if (s.last_attempt_result !== 'complete' || !s.last_successful_snapshot) return { pruned: [], skipped: 'the last run was not complete — nothing is deleted while backups are failing' };
  const dir = P(root, 'snapshots'); const cutoff = io.now() - days * 864e5; const pruned = [];
  for (const f of (io.fs.existsSync(dir) ? io.fs.readdirSync(dir) : []).filter(x => x.endsWith('.tar.age'))) {
    if (f === s.last_successful_snapshot) continue; const sc = readJson(io, P(dir, f + '.json'), null);
    if (!sc || sc.name !== f || !sc.complete || !Date.parse(sc.created_at) || Date.parse(sc.created_at) >= cutoff) continue;
    if (!(sc.offsite || []).some(o => o.confirmed)) continue;
    io.fs.rmSync(P(dir, f)); io.fs.rmSync(P(dir, f + '.json')); pruned.push(f);
  }
  return { pruned, kept_last_successful: s.last_successful_snapshot };
}

export function checkFresh(io, root, maxAgeHours = 26) {
  const s = readJson(io, P(root, 'state.json'), {}); const last = s.last_successful_backup_at ? Date.parse(s.last_successful_backup_at) : 0; const ageH = last ? (io.now() - last) / 36e5 : Infinity;
  return { fresh: ageH <= maxAgeHours, age_hours: Number.isFinite(ageH) ? Math.round(ageH * 10) / 10 : null, last_successful_backup_at: s.last_successful_backup_at || null, last_attempt_at: s.last_attempt_at || null, last_attempt_result: s.last_attempt_result || null };
}

// ---- BAK-2.3 / BAK-3 restore FROM A SAVED SNAPSHOT --------------------------------------------------
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
export function safeLocalPath(outRoot, bucket, objectPath, taken) {
  const segs = [bucket, ...String(objectPath).split('/')];
  const bad = segs.some(s => !s || s === '.' || s === '..' || /[\\:*?"<>|\x00-\x1f]/.test(s) || /[. ]$/.test(s) || RESERVED.test(s) || s.length > 200);
  const key = segs.join('/').toLowerCase(); if (bad || taken.has(key)) return null; taken.add(key);
  const full = resolve(outRoot, ...segs); if (!(full + sep).startsWith(resolve(outRoot) + sep)) return null; return full;
}
export function restoreSnapshot(io, { snapshotFile, identity, outDir, expectRef }) {
  const cipher = io.fs.readFileSync(snapshotFile); const sc = readJson(io, snapshotFile + '.json', null);
  if (sc && sha256(cipher) !== sc.ciphertext_sha256) throw new BackupError('snapshot_corrupt', 'the snapshot file does not match its recorded hash');
  const entries = tarUnpack(decrypt(cipher, identity)); const man = JSON.parse(entries.find(e => e.name === 'manifest.json').data.toString());
  if (man.schema !== 2 || man.complete !== true) throw new BackupError('snapshot_incomplete', 'the manifest does not declare a complete schema-2 snapshot');
  if (expectRef && man.project_ref !== expectRef) throw new BackupError('snapshot_project_mismatch', `snapshot is of ${man.project_ref}, expected ${expectRef}`);
  if (io.fs.existsSync(outDir) && io.fs.readdirSync(outDir).length) throw new BackupError('out_not_empty', 'restore only writes into a new or empty folder');
  io.fs.mkdirSync(outDir, { recursive: true }); const taken = new Set(); const files = []; const quarantined = [];
  for (const o of man.objects) { const e = entries.find(x => x.name === 'objects/' + o.sha256); if (!e || sha256(e.data) !== o.sha256 || e.data.length !== o.size) throw new BackupError('snapshot_object_mismatch', 'an object in the archive does not match the manifest');
    let dest = safeLocalPath(outDir, o.bucket, o.path, taken);
    if (!dest) { dest = P(outDir, '_unsafe-names', o.sha256); quarantined.push({ bucket: o.bucket, path: o.path, stored_as: '_unsafe-names/' + o.sha256 }); }
    io.fs.mkdirSync(join(dest, '..'), { recursive: true }); io.fs.writeFileSync(dest, e.data); files.push({ bucket: o.bucket, path: o.path, mimetype: o.mimetype, sha256: o.sha256, size: o.size, local: dest }); }
  const tombstones = man.tombstones.map(tb => ({ id: tb.id, first_absent_at: tb.first_absent_at, path: decrypt(Buffer.from(tb.encrypted_path_b64, 'base64'), identity).toString() }));
  return { manifest: { ...man, objects: undefined, tombstones: undefined }, files, quarantined, tombstones, note: 'Tombstoned paths were deliberately removed upstream: do not re-upload them without a decision.' };
}

// ---- upload-back of a restored file (test project only), with honest cleanup ------------------------
export async function uploadRestoredCanary(io, t, { bucket, path, data, mimetype }) {
  if (t.mode !== 'test') throw new BackupError('refused', 'restored files are only ever uploaded to the TEST project by this tool');
  let uploaded = false; let failure = null; const result = { scratch_object: `${bucket}/${path}` };
  try {
    await http(io, t, 'POST', `/storage/v1/object/${encodeURIComponent(bucket)}/${encPath(path)}`, { body: data, headers: { 'Content-Type': mimetype || 'application/octet-stream', 'x-upsert': 'false' } }); uploaded = true;
    const r = await http(io, t, 'GET', `/storage/v1/object/${encodeURIComponent(bucket)}/${encPath(path)}`); const back = Buffer.from(await r.arrayBuffer());
    if (sha256(back) !== sha256(data)) throw new BackupError('readback_mismatch', 'the bytes read back differ from the restored file');
    result.read_back_identical = true;
  } catch (e) { failure = e; }
  finally {
    if (uploaded) { try { await http(io, t, 'DELETE', `/storage/v1/object/${encodeURIComponent(bucket)}/${encPath(path)}`); result.removed = await confirmAbsent(io, t, bucket, path); if (!result.removed) throw new BackupError('cleanup_unconfirmed', 'deletion could not be confirmed'); }
      catch (e) { result.cleanup_needed = result.scratch_object; if (!failure) failure = e instanceof BackupError ? e : new BackupError('cleanup_failed', 'the scratch object may still exist'); } }
  }
  if (failure) { failure.detail = { ...(failure.detail || {}), ...result }; throw failure; }
  return result;
}
export async function confirmAbsent(io, t, bucket, path) {          // documented not-found + authenticated listing; a generic error proves nothing
  const r = await io.fetch(t.origin + `/storage/v1/object/${encodeURIComponent(bucket)}/${encPath(path)}`, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(io.timeoutMs), headers: { apikey: t.key, Authorization: 'Bearer ' + (t.bearer || t.key) } });
  let body = null; try { body = await r.json(); } catch {}
  const notFound = (r.status === 404 || r.status === 400) && body && (String(body.statusCode) === '404' || body.error === 'not_found' || body.code === 'NoSuchKey');
  if (!notFound) return false;
  const dir = path.split('/').slice(0, -1).join('/'), leaf = path.split('/').pop(); const out = []; await listPrefix(io, t, bucket, dir, out); return !out.some(o => o.path === (dir ? dir + '/' : '') + leaf);
}

// ---- default io --------------------------------------------------------------------------------------
export function defaultIo() {
  return { fetch: globalThis.fetch, fs: nodeFs, now: () => Date.now(), sleep: (ms) => new Promise(r => setTimeout(r, ms)), pid: process.pid,
    timeoutMs: 30000, retries: 3, retryDelayMs: 1500, pageSize: 1000, capturePasses: 3, lockStaleMs: 2 * 36e5,
    offsite: async function (dest, name, cipher, csha) {
      if (dest.type === 's3') return s3Put(this, dest, name, cipher, csha);
      if (dest.type !== 'dir') return { type: dest.type, confirmed: false, error: 'unsupported destination type' };
      try { if (!nodeFs.existsSync(dest.path)) return { type: 'dir', path: dest.path, confirmed: false, error: 'destination folder is not available (drive unplugged?)' };
        const f = join(dest.path, name); if (nodeFs.existsSync(f)) return { type: 'dir', path: dest.path, confirmed: false, error: 'a file with this name already exists at the destination' };
        nodeFs.writeFileSync(f + '.partial', cipher); nodeFs.renameSync(f + '.partial', f);
        return { type: 'dir', path: dest.path, confirmed: sha256(nodeFs.readFileSync(f)) === csha }; }
      catch (e) { return { type: 'dir', path: dest.path, confirmed: false, error: String(e.code || e.message).slice(0, 80) }; } } };
}
export { generateIdentity, sha256 };
import { s3Put } from './offsite-s3.mjs';

// ---- test-project-only write helpers for the restore drill (never reachable in production mode) -----
export async function testOnlyPut(io, t, { bucket, path, data, mimetype }) {
  if (t.mode !== 'test') throw new BackupError('refused', 'writes are only ever made to the TEST project');
  await http(io, t, 'POST', `/storage/v1/object/${encodeURIComponent(bucket)}/${encPath(path)}`, { body: data, headers: { 'Content-Type': mimetype || 'application/octet-stream', 'x-upsert': 'false' } });
}
export async function testOnlyDelete(io, t, { bucket, path }) {
  if (t.mode !== 'test') throw new BackupError('refused', 'deletes are only ever made in the TEST project');
  await http(io, t, 'DELETE', `/storage/v1/object/${encodeURIComponent(bucket)}/${encPath(path)}`);
  if (!(await confirmAbsent(io, t, bucket, path))) throw new BackupError('cleanup_unconfirmed', `deletion of a drill object in ${bucket} could not be confirmed`);
}
