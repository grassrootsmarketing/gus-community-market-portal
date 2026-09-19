#!/usr/bin/env node
// cli.mjs — operator entry points for the Demohub storage backup (v2).
//   init      create the backup folder config + a recovery key pair (the PRIVATE identity is written once, to a
//             separate file the operator moves into a vault; the runner keeps only the public recipient)
//   backup    full encrypted snapshot of PRODUCTION storage (read-only there).  exit 0 complete | 10 local only |
//             11 off-machine copy failed | 1 any other failure
//   verify    re-hash local snapshots against their sidecars            exit 1 on any problem
//   check     missed-success check (no complete off-machine backup in 26 h)  exit 2 when stale
//   restore   decrypt + unpack ONE saved snapshot into a new folder (needs the recovery identity file)
//   drill     the whole pipeline end to end against the TEST project with synthetic canaries
// Production credentials: C:/Users/David/prod.env (read here only).  Drill credentials: C:/Users/David/demohub.env.
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as B from './storage-backup.mjs';
import { generateIdentity, recipientOf } from './age.mjs';
import { makePdf, makePng, validatePdf, validatePng } from './canary.mjs';
import { s3Get, s3List, heartbeat } from './offsite-s3.mjs';

const args = process.argv.slice(2), cmd = args[0];
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const ROOT = opt('--root', 'C:/Users/David/Documents/Codex/prod-storage-backup-v2');
const readEnv = (p) => Object.fromEntries(readFileSync(p, 'utf8').split(/\r?\n/).filter(l => /^[A-Z_]+=/.test(l)).map(l => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).trim()]; }));
const prodEnv = () => { const e = readEnv(opt('--env', 'C:/Users/David/prod.env')); return { url: e.PROD_URL, key: e.PROD_KEY, ref: e.PROD_REF }; };
const testEnv = () => { const e = readEnv(opt('--env', 'C:/Users/David/demohub.env')); return { url: e.SB_URL, key: e.SB_KEY, ref: e.SB_REF }; };
const out = (o) => console.log(JSON.stringify(o));
const log = (line) => { try { appendFileSync(join(ROOT, 'BACKUP-LOG.md'), `- ${new Date().toISOString()} — ${line}\n`); } catch {} };
const io = B.defaultIo();

try {
  if (cmd === 'init') {
    mkdirSync(ROOT, { recursive: true }); const cfgFile = join(ROOT, 'backup-config.json');
    if (existsSync(cfgFile)) throw new Error('already initialised — refusing to replace the recovery key of existing snapshots');
    const idFile = opt('--identity-out', 'C:/Users/David/Documents/DEMOHUB-BACKUP-RECOVERY-KEY--move-to-vault.txt'); if (existsSync(idFile)) throw new Error('identity file already exists: ' + idFile);
    const k = generateIdentity();
    writeFileSync(idFile, `# Demohub storage backup — RECOVERY IDENTITY (private). Created ${new Date().toISOString()}\n# Without this, the encrypted snapshots cannot be restored. Move it into your password manager, keep one\n# offline copy somewhere else, then DELETE this file. Never store it next to the snapshots.\n# public recipient: ${k.recipient}\n${k.identity}\n`);
    writeFileSync(cfgFile, JSON.stringify({ recipient: k.recipient, offsite: [], require_offsite: true, retention_days_proposed: 30, note: 'offsite: [{"type":"dir","path":"E:/demohub-backup"}] for an external drive. No snapshot is ever deleted automatically until David approves a retention rule.' }, null, 1));
    out({ initialised: ROOT, recipient: k.recipient, recovery_identity_written_to: idFile, next: 'move that file into a vault + one offline copy, then delete it' });
  } else if (cmd === 'backup') {
    try { const r = await B.runBackup(io, { root: ROOT, env: prodEnv(), mode: 'production' }); log(`COMPLETE ${r.snapshot} objects ${r.objects} offsite ${r.offsite_confirmed}`); out(r); }
    catch (e) { const code = e.code === 'local_only' ? 10 : e.code === 'offsite_failed' ? 11 : 1; log(`${code === 10 ? 'LOCAL ONLY' : code === 11 ? 'OFFSITE FAILED' : 'FAILED'} ${e.code || 'error'}${e.detail && e.detail.snapshot ? ' ' + e.detail.snapshot : ''}`); out({ ...(e.detail && e.detail.snapshot ? e.detail : {}), result: 'NOT_COMPLETE', code: e.code || 'error', message: String(e.message).slice(0, 300) }); process.exitCode = code; }
  } else if (cmd === 'daily') {
    // The unattended job: backup -> verify -> missed-success check -> heartbeat. Any problem = non-zero exit and a
    // "/fail" ping; the success ping is sent ONLY for a complete, off-machine-confirmed backup.
    // Bounded whole-run retries (the scheduler's own restart-on-failure does not reliably react to exit codes):
    // at most 3 attempts, 5 minutes apart, and never for a configuration problem such as `local_only`.
    const run = { started_at: new Date().toISOString(), attempts: 0 }; let code = 0; const maxAttempts = Number(opt('--attempts', 3)), waitMs = Number(opt('--retry-wait-ms', 300000));
    for (;;) { run.attempts++; code = 0;
    try { const r = await B.runBackup(io, { root: ROOT, env: prodEnv(), mode: 'production' }); run.backup = r; log(`COMPLETE ${r.snapshot} objects ${r.objects} offsite ${r.offsite_confirmed}`); }
    catch (e) { code = e.code === 'local_only' ? 10 : e.code === 'offsite_failed' ? 11 : 1; run.backup = { ...(e.detail && e.detail.snapshot ? e.detail : {}), result: 'NOT_COMPLETE', code: e.code || 'error', message: String(e.message).slice(0, 300) }; log(`${code === 10 ? 'LOCAL ONLY' : code === 11 ? 'OFFSITE FAILED' : 'FAILED'} ${e.code || 'error'}`); }
      if (code === 0 || code === 10 || run.attempts >= maxAttempts) break; await io.sleep(waitMs); }
    try { run.verify = B.verifyLocal(io, ROOT); if (run.verify.problems.length && !code) code = 1; } catch (e) { run.verify = { error: String(e.message).slice(0, 200) }; if (!code) code = 1; }
    run.check = B.checkFresh(io, ROOT, 26); if (!run.check.fresh && !code) code = 2;
    let hb = null; try { const cfg = JSON.parse(readFileSync(join(ROOT, 'backup-config.json'), 'utf8')); if (cfg.heartbeat_url_file) hb = readFileSync(cfg.heartbeat_url_file, 'utf8').trim(); } catch {}
    run.heartbeat = hb ? await heartbeat(io, hb, code === 0) : 'not configured'; run.exit_code = code; run.finished_at = new Date().toISOString();
    try { writeFileSync(join(ROOT, 'last-run.json'), JSON.stringify(run, null, 1)); } catch {}
    out(run); process.exitCode = code;
  } else if (cmd === 'offsite-list' || cmd === 'offsite-fetch') {
    // Recovery path when the workstation's backup folder is gone: needs only the destination config + credentials.
    const dest = JSON.parse(readFileSync(opt('--dest-config', join(ROOT, 'backup-config.json')), 'utf8')).offsite.find(d => d.type === 's3'); if (!dest) throw new Error('no s3 destination in the config');
    if (cmd === 'offsite-list') out({ snapshots: (await s3List(io, dest)).filter(o => o.name.endsWith('.tar.age')) });
    else { const name = opt('--snapshot'), to = opt('--out'); if (!name || !to) throw new Error('offsite-fetch needs --snapshot <name> --out <file>'); if (existsSync(to)) throw new Error('refusing to overwrite ' + to); const buf = await s3Get(io, dest, name); writeFileSync(to, buf); out({ fetched: name, bytes: buf.length, sha256: B.sha256(buf), saved_to: to }); }
  } else if (cmd === 'verify') { const v = B.verifyLocal(io, ROOT); out(v); if (v.problems.length) process.exitCode = 1; }
  else if (cmd === 'check') { const c = B.checkFresh(io, ROOT, Number(opt('--max-age-hours', 26))); out(c); if (!c.fresh) process.exitCode = 2; }
  else if (cmd === 'restore') {
    const idFile = opt('--identity-file'); const snap = opt('--snapshot'); const outDir = opt('--out'); if (!idFile || !snap || !outDir) throw new Error('restore needs --snapshot <file> --identity-file <file> --out <new folder>');
    const identity = readFileSync(idFile, 'utf8').split(/\r?\n/).find(l => /^AGE-SECRET-KEY-1/.test(l.trim())); if (!identity) throw new Error('no AGE-SECRET-KEY-1… line in the identity file');
    const r = B.restoreSnapshot(io, { snapshotFile: snap, identity: identity.trim(), outDir, expectRef: opt('--expect-ref', B.PROJECTS.production.ref) });
    out({ restored_to: outDir, project_ref: r.manifest.project_ref, captured: [r.manifest.capture_started_at, r.manifest.capture_finished_at], files: r.files.length, quarantined_unsafe_names: r.quarantined.length, tombstones: r.tombstones.length, note: r.note });
  } else if (cmd === 'drill') {
    // Full pipeline against the TEST project: synthetic canaries -> backup A -> replace + delete -> backup B ->
    // forget the local folder -> restore both from the OFF-MACHINE copy -> files open -> upload one restored canary to
    // a scratch path, read it back, delete it, confirm. A throwaway key pair is used: the production recovery
    // identity is never needed by, or exposed to, a drill.
    const t = B.resolveTarget('test', testEnv()); const base = mkdtempSync(join(tmpdir(), 'dh-drill-')); const root = join(base, 'local'), off = join(base, 'off-machine'); mkdirSync(root, { recursive: true }); mkdirSync(off, { recursive: true });
    const k = generateIdentity(); writeFileSync(join(root, 'backup-config.json'), JSON.stringify({ recipient: k.recipient, offsite: [{ type: 'dir', path: off }], require_offsite: true }));
    const id = 'zz-backup-drill/' + Date.now().toString(36); const pdf1 = makePdf('version 1 ' + id), pdf2 = makePdf('version 2 ' + id), png = makePng(9);
    const src = [{ bucket: 'coi-docs', path: `${id}/canary.pdf` }, { bucket: 'avatars', path: `${id}/canary.png` }]; const steps = {}; let failure = null; const cleanup = [];
    try {
      await B.testOnlyPut(io, t, { ...src[0], data: pdf1, mimetype: 'application/pdf' }); cleanup.push(src[0]); await B.testOnlyPut(io, t, { ...src[1], data: png, mimetype: 'image/png' }); cleanup.push(src[1]);
      const a = await B.runBackup(io, { root, env: testEnv(), mode: 'test', buckets: ['coi-docs', 'avatars'], prefix: id }); steps.backup_a = { objects: a.objects, offsite_confirmed: a.offsite_confirmed };
      await B.testOnlyDelete(io, t, src[0]); await B.testOnlyPut(io, t, { ...src[0], data: pdf2, mimetype: 'application/pdf' }); await B.testOnlyDelete(io, t, src[1]); cleanup.pop();
      const b = await B.runBackup(io, { root, env: testEnv(), mode: 'test', buckets: ['coi-docs', 'avatars'], prefix: id }); steps.backup_b = { objects: b.objects, removed_since_previous: b.removed_since_previous };
      rmSync(root, { recursive: true, force: true }); steps.local_folder_discarded = !existsSync(root);                       // "the workstation is gone"
      const ra = B.restoreSnapshot(io, { snapshotFile: join(off, a.snapshot), identity: k.identity, outDir: join(base, 'restore-a'), expectRef: t.ref });
      const rb = B.restoreSnapshot(io, { snapshotFile: join(off, b.snapshot), identity: k.identity, outDir: join(base, 'restore-b'), expectRef: t.ref });
      const fa = ra.files.find(f => f.path.endsWith('canary.pdf')), ga = ra.files.find(f => f.path.endsWith('canary.png')), fb = rb.files.find(f => f.path.endsWith('canary.pdf'));
      const A = readFileSync(fa.local), G = readFileSync(ga.local), Bv = readFileSync(fb.local);
      steps.restore_older = { pdf_is_version_1: A.equals(pdf1), pdf_opens: validatePdf(A).ok, png_identical: G.equals(png), png_opens: validatePng(G).ok, mimetype: ga.mimetype };
      steps.restore_newer = { pdf_is_version_2: Bv.equals(pdf2), pdf_opens: validatePdf(Bv).ok, deleted_png_absent: !rb.files.some(f => f.path.endsWith('canary.png')), tombstone_path: (rb.tombstones[0] || {}).path === `avatars/${id}/canary.png` };
      steps.upload_back = await B.uploadRestoredCanary(io, t, { bucket: 'coi-docs', path: `zz-restore-drill/${id.split('/')[1]}/canary.pdf`, data: A, mimetype: 'application/pdf' });
      const flat = [steps.backup_a.objects === 2, steps.backup_a.offsite_confirmed === 1, steps.backup_b.objects === 1, steps.backup_b.removed_since_previous === 1, steps.local_folder_discarded, ...Object.values(steps.restore_older).map(v => v === true || v === 'image/png'), ...Object.values(steps.restore_newer), steps.upload_back.read_back_identical === true, steps.upload_back.removed === true];
      if (!flat.every(Boolean)) throw new Error('a drill assertion is false');
    } catch (e) { failure = e; }
    finally { for (const c of cleanup) { try { await B.testOnlyDelete(io, t, c); } catch (e) { steps.cleanup_needed = (steps.cleanup_needed || []).concat(`${c.bucket}/${c.path}`); if (!failure) failure = e; } } try { rmSync(base, { recursive: true, force: true }); } catch {} }
    out({ drill: failure ? 'FAILED' : 'PASSED', project: t.ref, ...(failure ? { error: String(failure.message).slice(0, 300), detail: failure.detail } : {}), steps }); if (failure) process.exitCode = 1;
  } else { console.error('usage: init | backup | daily | verify | check | restore | drill | offsite-list | offsite-fetch   [--root <dir>]'); process.exitCode = 1; }
} catch (e) { out({ result: 'ERROR', message: String(e.message).slice(0, 300) }); process.exitCode = 1; }
