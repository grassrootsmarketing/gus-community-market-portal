# Maintained age tool: interoperability and switch-over (Codex closure review item 2) — 2026-09-20

Tool: FiloSottile/age **v1.3.1**, installed with David's approval through winget (`FiloSottile.age`, user scope), which downloads the author's GitHub release zip and verifies its published SHA-256 (`c56e8ce2…e38154`). Script: `tools/backup/tests/age-interop.mjs` (the binary is started with an argument array, no shell; key material only ever as a file path; prints counts and booleans).

| Check | Result |
|---|---|
| Our writer → reference tool decrypts, sizes 0 / 1 / 65 535 / 65 536 / 65 537 / 131 072 / 300 000 bytes | 7/7 |
| Reference tool encrypts → our reader decrypts, same sizes | 7/7 |
| Reference tool rejects our archive when tampered (payload byte, header MAC, truncated) and with the wrong key | rejected ×4 |
| Our reader rejects a reference archive when tampered / wrong key | rejected ×2 |
| **Existing production archive** (the oldest, 2026-09-19T02:20Z, written by the in-repo implementation), decrypted by the reference tool with the current identity | exit 0; 12 objects in manifest, **12/12 recovered hashes match**, 0 tombstones |
| Encrypted path payloads in `state.json` (12), decrypted by the reference tool | 12/12, each names a path present in that manifest |

Switch-over: `age-bin.mjs` is now the encryption engine for archives and path payloads (`io.encrypt`); only the public recipient is passed; the pinned version is checked on every run; a missing tool, a different version, a non-zero exit or unexpected output fails the backup and nothing is published (regression cases added; suites 64 + 39). The in-repo `age.mjs` remains as a reader (restore of old and new archives) and for the simulated suites, which are labelled as such. Nothing already saved was deleted or rewritten.

First production archive from the reference engine: `…20260920T192414Z-df4d7e.tar.age` — sidecar `encryption_engine: age 1.3.1 (FiloSottile/age, reference implementation)`, run complete, independent off-machine copy 1, source `restricted reader login`. Fetched back **from S3** and decrypted with the reference tool: 12/12 hashes match the manifest; temporary files removed.

Not yet done: the separate-device recovery exercise (David, with the vaulted key) — see closure item 1.
