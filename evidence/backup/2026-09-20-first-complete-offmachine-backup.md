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
