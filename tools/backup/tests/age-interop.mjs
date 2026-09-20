// age-interop.mjs — Codex closure review item 2: interoperability between this repository's age v1 writer/reader and
// the MAINTAINED reference tool (FiloSottile/age). Needs the reference binary; prints counts/booleans only.
//   node age-interop.mjs                         synthetic vectors only (throwaway keys)
//   node age-interop.mjs --snapshot <.tar.age> --identity-file <file> [--state <state.json>]   + an existing archive
// No shell is involved: the binary is started with an argument array; key material travels only as a file path.
import { spawnSync } from 'node:child_process'; import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os'; import { join } from 'node:path'; import { createHash } from 'node:crypto';
import { generateIdentity, encrypt, decrypt } from '../age.mjs'; import { tarUnpack } from '../tar.mjs'; import { findAge } from '../age-bin.mjs';
const sha = (b) => createHash('sha256').update(b).digest('hex'); const opt = (k) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : null; };
const AGE = findAge(); const out = { reference_tool: spawnSync(AGE, ['--version'], { encoding: 'utf8' }).stdout.trim() }; let bad = 0; const check = (k, v, d) => { out[k] = v ? 'ok' : 'FAIL ' + (d || ''); if (!v) bad++; };
const run = (args, input) => spawnSync(AGE, args, { input, maxBuffer: 1 << 28 }); const base = mkdtempSync(join(tmpdir(), 'dh-age-'));
try {
  const k = generateIdentity(), other = generateIdentity(); const idf = join(base, 'id.txt'), oidf = join(base, 'other.txt'); writeFileSync(idf, k.identity + '\n'); writeFileSync(oidf, other.identity + '\n');
  const sizes = [0, 1, 65535, 65536, 65537, 131072, 300000]; const mk = (n) => { const b = Buffer.alloc(n); for (let i = 0; i < n; i++) b[i] = (i * 31 + n) & 255; return b; };
  let a = 0, b = 0; for (const n of sizes) { const p = mk(n); const r = run(['-d', '-i', idf], encrypt(p, k.recipient)); if (r.status === 0 && r.stdout.equals(p)) a++; const e = run(['-r', k.recipient], p); if (e.status === 0 && decrypt(e.stdout, k.identity).equals(p)) b++; }
  check('ours_encrypts__reference_decrypts (0,1,64KiB-1,64KiB,64KiB+1,128KiB,300k bytes)', a === sizes.length, `${a}/${sizes.length}`);
  check('reference_encrypts__ours_decrypts (same sizes)', b === sizes.length, `${b}/${sizes.length}`);
  const c = encrypt(mk(70000), k.recipient); const t1 = Buffer.from(c); t1[t1.length - 5] ^= 1; const t2 = Buffer.from(c); t2[c.indexOf('\n--- ') + 8] ^= 1; const t3 = c.subarray(0, c.length - 1000);
  check('reference tool REJECTS our archive when tampered (payload byte, header MAC, truncated)', [t1, t2, t3].every(x => run(['-d', '-i', idf], x).status !== 0));
  check('reference tool REJECTS our archive with the wrong key', run(['-d', '-i', oidf], c).status !== 0);
  const rc = run(['-r', k.recipient], mk(70000)).stdout; const r1 = Buffer.from(rc); r1[r1.length - 5] ^= 1; const thr = (fn) => { try { fn(); return false; } catch { return true; } };
  check('our reader REJECTS a reference archive when tampered or opened with the wrong key', thr(() => decrypt(r1, k.identity)) && thr(() => decrypt(rc, other.identity)));
  const snap = opt('--snapshot'), idFile = opt('--identity-file');
  if (snap && idFile) {
    const r = run(['-d', '-i', idFile, snap]); check('EXISTING archive: the reference tool decrypts it with the current identity', r.status === 0, 'exit ' + r.status);
    if (r.status === 0) { const entries = tarUnpack(r.stdout); const m = JSON.parse(entries.find(e => e.name === 'manifest.json').data.toString()); let okc = 0; for (const o of m.objects) { const e = entries.find(x => x.name === 'objects/' + o.sha256); if (e && sha(e.data) === o.sha256 && e.data.length === o.size) okc++; }
      out.existing_archive = { project_ref: m.project_ref, objects_in_manifest: m.object_count, recovered_hashes_match_manifest: okc, tombstones: m.tombstones.length };
      check('EXISTING archive: every recovered object hashes to its manifest entry', okc === m.object_count && okc > 0);
      const st = opt('--state'); if (st && existsSync(st)) { const s = JSON.parse(readFileSync(st, 'utf8')); const payloads = [...Object.values(s.index || {}), ...Object.values(s.tombstones || {})].map(v => v.p).filter(Boolean); const paths = new Set(m.objects.map(o => `${o.bucket}/${o.path}`)); let pd = 0, inManifest = 0;
        for (const p of payloads) { const d = run(['-d', '-i', idFile], Buffer.from(p, 'base64')); if (d.status === 0 && d.stdout.length) { pd++; if (paths.has(d.stdout.toString())) inManifest++; } }
        out.encrypted_path_payloads = { total: payloads.length, reference_tool_decrypted: pd, of_which_name_a_path_in_this_manifest: inManifest }; check('encrypted path / tombstone payloads: the reference tool decrypts every one', pd === payloads.length && pd > 0); } }
  }
} finally { rmSync(base, { recursive: true, force: true }); out.temporary_files_removed = !existsSync(base); }
out.failed = bad; console.log(JSON.stringify(out, null, 1)); if (bad) process.exit(1);
