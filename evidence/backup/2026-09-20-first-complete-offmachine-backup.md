# First complete off-machine backup + restore from Amazon alone (2026-09-20 01:29Z)

Destination approved by David 2026-09-19: Amazon S3, account "Demohub" (242065760920), us-east-2, bucket `demohub-storage-backup-242065760920`, created by CloudFormation stack `demohub-backup` from `tools/backup/aws/demohub-backup-bucket.yaml` (versioning, 7-day governance Object Lock, 30-day lifecycle, public access blocked, TLS only). Uploader: IAM user `demohub-backup-uploader`; its key lives only in a local file on the workstation.

| Check | Result |
|---|---|
| `cli.mjs daily` | `complete`, exit 0 — 12 objects (9 `coi-docs`, 3 `avatars`), off-machine copies confirmed 1, `last_successful_backup_at` 2026-09-20T01:29:11Z, freshness check fresh, verify 3 local snapshots / 0 problems, prune removed nothing |
| Bucket listing | 1 snapshot, 708,456 bytes (ciphertext) |
| Snapshot downloaded from S3 only | sha256 equals the hash recorded at upload |
| Restore of that download with the recovery identity | 12 files, **12/12 byte-identical** to the earlier independent plain copy; 0 quarantined; temporary plain-text folder removed |
| Uploader key: DELETE | 403 |
| Uploader key: overwrite an existing snapshot | refused (create-only, 412); stored object still identical afterwards |
| Uploader key: read outside `storage/`, list the whole bucket | 403, 403 |
| Uploader key: read/suspend versioning, delete lifecycle, delete bucket policy | 403, 403, 403, 403 |

Source identity for this run: the service key on the workstation (bridge). The restricted reader login is proven on demohub-rebuild-check only (`2026-09-19-reader-identity-test-project.md`); production needs David's separate approval.

Still open: independent missed-run monitor (heartbeat not configured), recovery identity still to be moved into David's vault, Windows daily task not installed (David: not yet), device encryption unconfirmed.

## Missed-run / failed-run alert (2026-09-20 ~01:37Z)

Independent monitor: a healthchecks.io check owned by David (david@demohubhq.com), email alerts, period 1 day + grace 2 hours (= 26 h). The ping URL lives in a local file named by `heartbeat_url_file`; a ping carries no data. The monitor runs outside the workstation, so a powered-off or lost PC still produces an alert.

| Step | Result |
|---|---|
| Good `daily` run | exit 0, heartbeat `sent` (success) |
| Deliberately failed `daily` run (non-existent credentials file, 1 attempt) | exit 1, heartbeat `sent` to `/fail`; nothing touched in production or S3 |
| Email received by David | **"DOWN — received a failure signal"** |
| Good `daily` run again | exit 0, heartbeat `sent`; email **"UP — the downtime lasted 56 seconds"** |

The success ping is sent only for exit 0 (snapshot complete AND confirmed off-machine), so a local-only or failed run can never keep the monitor green. The "no ping for 26 hours" path is healthchecks.io's standard behaviour and was not waited out.

## Restricted reader login on demohub-prod (2026-09-20)

David approved. One Auth user created (0 before), then migration 0084 applied by David through a guarded single-transaction paste that had been rehearsed on demohub-rebuild-check. Result row: `demohub-prod 0084 APPLIED` · ledger `0082,0083,0084` · `buckets:demohub_backup_reader_buckets:SELECT:{authenticated} | objects:demohub_backup_reader_objects:SELECT:{authenticated}` · Auth users 1 · `coi-docs` private · 12 objects.

Read-only checks (no write probes against production): before the policy the reader saw 0 buckets / 0 objects; after, exactly `avatars, coi-docs, policy-docs`; REST `bookings`/`internal_contacts`/`brands` 403, `payments`/`refunds` 404, `retailers` 403 (anon: 4 rows, unchanged); anon storage listing still empty; token role `authenticated`.

`cli.mjs daily` afterwards: `source: restricted reader login`, complete, 12 objects, off-machine confirmed 1, verify 0 problems, heartbeat sent, exit 0.

## Missed-run alert fired for real (2026-09-21 14:24 local → resolved 2026-09-22)

healthchecks.io went DOWN when no success ping arrived within 26 h of the last one (2026-09-20 12:24 local). Cause: the Claude desktop scheduled task's first automated run (2026-09-19 16:06Z) stalled at its first tool call on a permission prompt that nobody was present to answer; a run left "running" blocks every later scheduled start. All 2026-09-20 successes had been manual runs. Resolution: manual `daily` run 2026-09-22 (complete, 12 objects, off-machine confirmed, reader login, exit 0, heartbeat sent → UP); the stuck run to be stopped and the task's tool approvals pre-granted by David via "Run now". This is the interim-scheduler weakness Codex named; the alert worked as designed.
