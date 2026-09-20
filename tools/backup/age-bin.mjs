// age-bin.mjs — the MAINTAINED age implementation (https://github.com/FiloSottile/age) as the encryption engine.
// Codex closure review 2026-09-20, item 2: new archives are produced by the reference tool, not by this repository's
// own implementation (age.mjs stays as a READER for old archives, for encrypted path payloads, and for tests).
//   * pinned version, checked on every run; a missing, different-version or failing tool FAILS the backup;
//   * started with an argument array (no shell); only the PUBLIC recipient is ever passed; plaintext goes in on
//     stdin and ciphertext comes back on stdout — nothing is written to disk by this step;
//   * the output is checked to be an age v1 file addressed to one X25519 recipient before it is accepted.
import { spawnSync } from 'node:child_process'; import { existsSync, readdirSync } from 'node:fs'; import { join } from 'node:path';
import { parseRecipient } from './age.mjs';

export const PINNED_AGE_VERSION = '1.3.1';
export function findAge(env = process.env) {
  if (env.DEMOHUB_AGE_BIN) return env.DEMOHUB_AGE_BIN;
  const pk = join(env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Packages');
  try { for (const d of readdirSync(pk)) if (d.startsWith('FiloSottile.age_')) { const p = join(pk, d, 'age', 'age.exe'); if (existsSync(p)) return p; } } catch {}
  return 'age';
}
export function ageVersion(bin = findAge()) { const r = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 15000 }); if (r.error || r.status !== 0) return null; return r.stdout.trim().replace(/^v/, ''); }
export function encryptWithAge(plaintext, recipient, { bin = findAge(), expectVersion = PINNED_AGE_VERSION } = {}) {
  parseRecipient(recipient);                                                        // a well-formed PUBLIC key, nothing else
  const v = ageVersion(bin); if (v === null) throw Object.assign(new Error('the age tool is not installed or does not start'), { code: 'age_tool_missing' });
  if (v !== expectVersion) throw Object.assign(new Error(`age ${v} found, ${expectVersion} is the pinned version`), { code: 'age_tool_version' });
  const r = spawnSync(bin, ['-r', recipient], { input: plaintext, maxBuffer: 1 << 30, timeout: 120000 });
  if (r.error || r.status !== 0) throw Object.assign(new Error('the age tool failed with exit ' + (r.error ? r.error.code : r.status)), { code: 'age_tool_failed' });
  const head = r.stdout.subarray(0, 200).toString('latin1');
  if (!head.startsWith('age-encryption.org/v1\n-> X25519 ') || r.stdout.length <= plaintext.length) throw Object.assign(new Error('the age tool produced unexpected output'), { code: 'age_tool_failed' });
  return r.stdout;
}
