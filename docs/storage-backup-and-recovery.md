# Demohub — uploaded-file backup and recovery (COI certificates, policy documents, avatars)

Why this exists: Supabase's daily database backups cover tables only. Files uploaded through the Storage API — every brand's Certificate of Insurance in `coi-docs`, plus `policy-docs` and `avatars` — are **not** in those backups.

This is version 2, built to Codex's work order of 2026-09-19 (BAK-1 … BAK-4). Version 1 (`tools/backup-storage.mjs`) is retired: it now exits 64 so that a stale command cannot print a misleading "verified".

## Status — what is true today

| | |
|---|---|
| Tool, regression tests, restore drill | **Done.** 64 + 26 tests pass; real drill passed on demohub-rebuild-check. |
| Encrypted production snapshots on David's desktop workstation | **Running.** First snapshot 2026-09-19, 12 objects; restored once and matched the v1 copy 12/12. |
| Off-machine copy | **LIVE since 2026-09-20.** Amazon S3 (account Demohub, us-east-2, bucket `demohub-storage-backup-242065760920`): versioned, 7-day governance Object Lock, 30-day expiry, uploader key cannot delete or reconfigure (all probes 403). First complete run exit 0; snapshot pulled back from S3 alone and restored 12/12 identical (`evidence/backup/2026-09-20-first-complete-offmachine-backup.md`). |
| Retention | **Approved 2026-09-19: 30 days**, never the last good snapshot. Local pruning runs only after a complete run; the S3 bucket expires snapshots itself (the uploader cannot delete). 7-day governance Object Lock on the bucket. |
| Restricted read-only source identity | **Proven on demohub-rebuild-check 2026-09-19** (`evidence/backup/2026-09-19-reader-identity-test-project.md`). Production: not applied, separate approval. |
| Daily Windows task | Prepared; David chose **not yet**. The Claude desktop task runs the `daily` command at 09:00 meanwhile. |
| Missed-run alert independent of the workstation | Code ready (heartbeat); monitor account not chosen yet. |

## How it works

- **One full snapshot per run.** At ~1 MB that is simpler and safer than an incremental cache. Each run produces one uniquely named file, `snapshots/demohub-storage-<project>-<UTC time>-<id>.tar.age`, plus a small sidecar with its hash. Nothing is ever overwritten.
- **Encrypted before it touches the backup folder.** Format: [age](https://github.com/FiloSottile/age) v1 (X25519 + ChaCha20-Poly1305). The scheduled job holds only the **public** recipient. Object names and the manifest are inside the encrypted file; local file names are opaque hashes.
- **A failure cannot look green.** A listing error, a malformed page, a missing required bucket, a failed or short download, exhausted retries, or a source that keeps changing all fail the run; a partial snapshot is never published and the previous good one is untouched. One run at a time (lock file). Bounded timeouts and retries.
- **Older versions survive.** A certificate replaced at the same path stays in the earlier snapshots. A file deleted upstream is absent from the next snapshot and recorded as a tombstone (path encrypted), so a restore does not silently resurrect a deliberately removed document.
- **Read-only on production.** Requests go only to the exact production origin, only under `/storage/v1/`, redirects refused. Upload and delete helpers refuse anything but the test project, before any request is made.
- **`last_successful_backup_at` moves only when** the source inventory was complete, the local file verified, it was encrypted, **and** an off-machine copy was read back with a matching hash.

Location: `C:\Users\David\Documents\Codex\prod-storage-backup-v2\` on the desktop workstation (`state.json`, `BACKUP-LOG.md`, `last-run.json`, `snapshots\`). Credentials: `C:\Users\David\prod.env`, read locally only. That key is still the powerful service key; the tool only reads with it, but the key itself is not read-only (see open decision 4).

## Commands

```bash
node C:/Users/David/demohub-docs/tools/backup/cli.mjs daily
```

The unattended job: backup → verify → freshness check → heartbeat. Writes `last-run.json`.

| Exit | Meaning |
|---|---|
| 0 | Complete: snapshot made **and** confirmed off-machine |
| 10 | Snapshot made, but it exists only on this workstation |
| 11 | Snapshot made, off-machine copy failed or could not be confirmed |
| 1 | Anything else failed (nothing partial was published) |
| 2 | No complete off-machine backup in the last 26 hours |

Other commands: `backup` (one run, no retries), `verify` (re-hash local snapshots), `check` (26-hour freshness), `offsite-list` / `offsite-fetch --snapshot <name> --out <file>` (get a snapshot back from the S3-compatible destination without the local folder), `restore`, `drill`.

Tests (no credentials, no network):

```bash
node C:/Users/David/demohub-docs/tools/backup/tests/run-tests.mjs
```

```bash
node C:/Users/David/demohub-docs/tools/backup/tests/offsite-tests.mjs
```

## Restoring

Restoring needs the **recovery identity** (the private key). It is not on the scheduled runner and must not be stored beside the snapshots. Custodian: David — password manager plus one offline copy.

```bash
node C:/Users/David/demohub-docs/tools/backup/cli.mjs restore --snapshot "<path to .tar.age>" --identity-file "<path to recovery key file>" --out "<new empty folder>"
```

The output folder then holds real certificates in clear text: use it, then delete it. Files with names unsafe on Windows are placed under `_unsafe-names\` rather than written to their literal path. Tombstoned paths are listed — do not re-upload those without a reason.

1. **One file lost or corrupted:** restore the most recent snapshot that contains it, then re-upload that one file to the same bucket path from the Supabase dashboard. That is a production write: David does it, or authorizes it explicitly.
2. **File newer than the last snapshot:** ask the brand to upload the certificate again from Compliance; the review queue treats it like any new upload. A missing certificate does not erase the payment ledger, but it **can prevent timely COI review and therefore affect confirmation or hold expiry**. Use the normal re-upload and re-review path; never mark a missing or unreviewed certificate approved just to unblock a booking.
3. **Database loss:** Supabase dashboard → Database → Backups → Scheduled backups. A last resort and David's decision. Never overwrite production payment or refund rows from an old copy — Stripe's real state does not roll back.

## Restore drill

```bash
node C:/Users/David/demohub-docs/tools/backup/cli.mjs drill
```

Runs entirely against **demohub-rebuild-check** with synthetic canaries (a valid PDF and PNG, clearly labelled, never a real certificate) and a throwaway key: backup → replace one file and delete the other → backup again → discard the local folder → restore both snapshots from the off-machine copy → check the older version, the newer version, the tombstone, and that both files open → upload the restored PDF to a scratch path, read it back, delete it, confirm it is gone. Any failed step fails the drill and names any scratch object left behind. Passed 2026-09-19. Cadence: monthly during the pilot, and after any change to credentials, encryption, retention or restore code. Real customer certificates are never copied to the test project.

## Privacy, access, retention

- The backup folders and the cutover snapshots in `Documents\Codex\prod-snapshots\` stay on David's workstation, out of every git repository, and are never attached to reviews. Only encrypted snapshots may leave the machine.
- The v1 folder `Documents\Codex\prod-storage-backup\` is **plain-text certificates**. It is kept until v2 has a verified off-machine copy; after that David decides whether to delete it.
- Disk encryption on the workstation (Windows 11 Home "Device encryption") is recommended and not yet confirmed.
- **Retention (approved by David 2026-09-19): 30 days of daily snapshots.** Never the last known-good one, never while backups are failing, never a snapshot without a confirmed off-machine copy. In S3 a 30-day lifecycle rule does the expiry; that rule is a plain timer, so if backups failed for 30 days straight and every alert were ignored, the S3 copies would age out while the local last-good snapshot stays. This is an engineering recovery window, not a legal, contractual, insurance or financial-records retention decision.
- Live financial records are not disposable: never reset production or delete payment/refund rows.

## Decisions still open (David)

1. **Off-machine destination.** Code is ready for any S3-compatible private bucket (Amazon S3, Cloudflare R2, Backblaze B2): create-only uploads, read-back confirmation, no delete call exists in the tool. The uploader key must have put/get/list only — no delete, no version or retention administration. Codex's preference: a dedicated private S3 bucket with versioning and a 7-day governance-mode Object Lock (Object Lock cannot be switched off later). Bridge option: an encrypted external drive kept elsewhere, as `{"type":"dir","path":"E:/…"}` — only as good as the habit of plugging it in.
2. **Recovery-key custodian** and where the offline copy lives.
3. **Retention / lock settings** (30 days proposed; 7-day lock proposed).
4. **Restricted read-only source identity.** A production policy change: one dedicated backup user, SELECT-only on the three buckets, no insert/update/delete. To be written as a migration, tested on demohub-rebuild-check, and applied to demohub-prod only with David's approval. Until then the existing key is the bridge.
5. **Daily schedule.** `tools/backup/install-windows-task.ps1` registers a Windows Task Scheduler job (daily 12:30, catch-up after a missed start, network required, no overlap, 30-minute limit). Not installed until David runs it.
6. **Missed-run alert that does not depend on this workstation.** The `daily` command can ping a dead-man's-switch monitor (success URL, or `/fail`); the monitor emails David when no success arrives within 26 hours. Needs David to pick the service/account; the ping URL goes in a local file named by `heartbeat_url_file` in `backup-config.json`. The ping carries no data.

Supplement not started: a weekly encrypted logical database export (`pg_dump`, excluding session/token table data), per Codex answer 5.
