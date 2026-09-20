# S3 create-only enforcement (Codex closure review item 4) — 2026-09-20

Test object: one uniquely named **synthetic** text object per run under `storage/zz-synthetic-create-only-probe-*.txt` (never a real snapshot). Script: `tools/backup/aws/create-only-probe.mjs`. Credential: the daily uploader key.

| Request | Before the fix | After David updated stack `demohub-backup` |
|---|---|---|
| PUT with `If-None-Match: *` (new key) | 200 | 200 |
| Same PUT repeated | 412 | 412 |
| PUT **without** the condition over the existing key | **200 — new version created, current content replaced** (Codex's finding reproduced) | **403 — denied by policy** |
| Current content still the original | no | **yes** |

Fix: in the uploader's IAM policy, `Deny s3:PutObject` on the bucket when `s3:if-none-match` is `Null` (template `tools/backup/aws/demohub-backup-bucket.yaml`, statement `WritesMustBeCreateOnly`). The existing no-delete / no-retention-bypass / no-reconfiguration denies are unchanged. The earlier 412 result only showed that a cooperative client refuses; this shows the server refuses a request that omits the condition. Multipart uploads are blocked by the same rule; the tool does not use them.

After the update: real snapshots still listed (5), and the conditional create path used by the backup still returns 200. The two synthetic objects are governance-locked for 7 days and expire with the 30-day lifecycle; the pre-fix one carries the overwritten version as its current version (synthetic content only).
