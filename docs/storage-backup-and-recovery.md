# Demohub — uploaded-file backup and recovery (COI certificates, policy documents, avatars)

Why this exists: Supabase's daily database backups cover tables only. Files uploaded through the Storage API — every brand's Certificate of Insurance in `coi-docs`, plus `policy-docs` and `avatars` — are **not** in those backups.

This is version 2, built to Codex's work order of 2026-09-19 (BAK-1 … BAK-4). Version 1 (`tools/backup-storage.mjs`) is retired: it now exits 64 so that a stale command cannot print a misleading "verified".

## Status — what is true today

| | |
|---|---|
| Tool, regression tests, restore drill | **Done.** 64 + 26 tests pass; real drill passed on demohub-rebuild-check. |
| Encrypted production snapshots on David's desktop workstation | **Running.** First snapshot 2026-09-19, 12 objects; restored once and matched the v1 copy 12/12. |
| Off-machine copy | **LIVE since 2026-09-20.** Amazon S3 (account Demohub, us-east-2, bucket `demohub-storage-backup-242065760920`): versioned, 7-day governance Object Lock, 30-day expiry, uploader key cannot delete or reconfigure (all probes 403). First complete run exit 0; snapshot pulled back from S3 alone and restored 12/12 identical (`evidence/backup/2026-09-20-first-complete-offmachine-backup.md`). |
| Retention | **Approved 2026-09-19: 30 days** (wording under review — see open item 4); locally never the last good snapshot. Local pruning runs only after a complete run; the S3 bucket expires snapshots itself (the uploader cannot delete). 7-day governance Object Lock on the bucket. |
| Restricted read-only source identity | **LIVE on demohub-prod since 2026-09-20** (migration 0084, two SELECT-only policies for one fixed backup login; login file `C:UsersDaviddemohub-backup-reader.prod.env`). The daily job no longer reads the service key. Proven first on demohub-rebuild-check. |
| Daily Windows task | Prepared; David chose **not yet**. The Claude desktop task runs the `daily` command at 09:00 meanwhile. |
| Missed-run alert independent of the workstation | **LIVE since 2026-09-20**: healthchecks.io check (David's account), period 1 day + grace 2 h, email alerts. Failure alert proven (DOWN then UP emails received). |

## How it works

- **One full snapshot per run.** At ~1 MB that is simpler and safer than an incremental cache. Each run produces one uniquely named file, `snapshots/demohub-storage-<project>-<UTC time>-<id>.tar.age`, plus a small sidecar with its hash. Nothing is ever overwritten.
- **Encrypted before it touches the backup folder.** Format: [age](https://github.com/FiloSottile/age) v1 (X25519 + ChaCha20-Poly1305). The scheduled job holds only the **public** recipient. Object names and the manifest are inside the encrypted file; local file names are opaque hashes.
- **A failure cannot look green.** A listing error, a malformed page, a missing required bucket, a failed or short download, exhausted retries, or a source that keeps changing all fail the run; a partial snapshot is never published and the previous good one is untouched. One run at a time (lock file). Bounded timeouts and retries.
- **Older versions survive.** A certificate replaced at the same path stays in the earlier snapshots. A file deleted upstream is absent from the next snapshot and recorded as a tombstone (path encrypted), so a restore does not silently resurrect a deliberately removed document.
- **Read-only on production.** Requests go only to the exact production origin, only under `/storage/v1/`, redirects refused. Upload and delete helpers refuse anything but the test project, before any request is made.
- **`last_successful_backup_at` moves only when** the source inventory was complete, the local file verified, it was encrypted, **and** an off-machine copy was read back with a matching hash.

Location: `C:\Users\David\Documents\Codex\prod-storage-backup-v2\` on the desktop workstation (`state.json`, `BACKUP-LOG.md`, `last-run.json`, `snapshots\`). Source credential: the **restricted backup reader login** only (`C:\Users\David\demohub-backup-reader.prod.env`: publishable key + that login). The unattended `daily` job accepts no other credential and no override; a missing reader setting fails the run. The service key in `prod.env` is reachable only through the manual `backup --emergency-service-key` bridge, which needs David's authorization each time and is labelled as such in the output.

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

Runs entirely against **demohub-rebuild-check** with synthetic canaries (a valid PDF and PNG, clearly labelled, never a real certificate) and a throwaway key: backup → replace one file and delete the other → backup again → discard the local folder → restore both snapshots from the second copy (a separate temp folder on the same machine: this proves saved-snapshot and version restoration, **not** physical off-machine loss — that is proven by the production S3 fetch-and-restore in `evidence/backup/`) → check the older version, the newer version, the tombstone, and that both files pass **structural validation** (PDF xref/trailer/%%EOF; PNG chunk CRCs and pixel data) — no viewer is involved; opening in an ordinary viewer is part of the separate-device recovery exercise → upload the restored PDF to a scratch path, read it back, delete it, confirm it is gone. Any failed step fails the drill and names any scratch object left behind. Passed 2026-09-19. Cadence: monthly during the pilot, and after any change to credentials, encryption, retention or restore code. Real customer certificates are never copied to the test project.

## Privacy, access, retention

- The backup folders and the cutover snapshots in `Documents\Codex\prod-snapshots\` stay on David's workstation, out of every git repository, and are never attached to reviews. Only encrypted snapshots may leave the machine.
- The v1 folder `Documents\Codex\prod-storage-backup\` is **plain-text certificates**. It is kept until v2 has a verified off-machine copy; after that David decides whether to delete it.
- Disk encryption on the workstation (Windows 11 Home "Device encryption") is recommended and not yet confirmed.
- **Retention (approved by David 2026-09-19): 30 days of daily snapshots.** Never the last known-good one, never while backups are failing, never a snapshot without a confirmed off-machine copy. In S3 a 30-day lifecycle rule does the expiry; that rule is a plain timer, so if backups failed for 30 days straight and every alert were ignored, the S3 copies would age out while the local last-good snapshot stays. This is an engineering recovery window, not a legal, contractual, insurance or financial-records retention decision.
- Live financial records are not disposable: never reset production or delete payment/refund rows.

## Current decisions and what is still open (one status, 2026-09-20)

Decided and live: off-machine = Amazon S3 (dedicated account "Demohub", us-east-2) · restricted reader login on demohub-prod (migration 0084) · independent missed-run/failed-run alert (healthchecks.io, 1 day + 2 h) · recovery-key custodian = David.

Still open:

1. **Recovery-key custody (David).** The recovery identity file is still on the workstation. Until it is in David's vault with an independent offline copy, and a snapshot fetched from S3 has been decrypted on a **separate device** without any file from this workstation, "survives workstation loss" is not closed. AWS root access/MFA and these instructions must also be reachable without the workstation. Only after that exercise: decide about deleting the temporary key file and the plain-text v1 folder.
2. **Encryption tool.** Snapshots are currently produced by this repository's own implementation of the age v1 format. Codex requires the maintained `age` tool: first prove it decrypts an existing snapshot with the current identity, then use it for new snapshots. Needs David's OK to install the pinned release.
3. **S3 create-only enforcement.** Proven gap (synthetic object, 2026-09-20): the uploader credential could add a new version over an existing name by omitting `If-None-Match`. The template now denies any write without that condition; it takes effect when David updates the `demohub-backup` stack. Re-run `tools/backup/aws/create-only-probe.mjs` afterwards (expects 200 / 412 / 403).
4. **Retention wording vs. reality (David chooses one).** S3 lifecycle is a plain timer (current version expires at 30 days → delete marker; noncurrent versions removed 7 days later), so "never the last good off-machine copy" is not something the timer can promise. Either (a) keep a separately controlled recovery anchor outside automatic expiry and outside the uploader's write scope, replaced only after a newer one is verified, or (b) approve a finite off-machine window (30 days + alert response) and drop the "never" wording for the off-machine copy. Local pruning already never removes the last good local snapshot.
5. **Scheduling.** Windows Task Scheduler: deferred by David, **not installed**. The interim arrangement is the Claude desktop task at 09:00 plus the independent alert. The prepared installer uses 12:30 and `LogonType Interactive` (it runs only while David is logged in, not merely because the PC is on). On approval: pick one time, verify a run with Claude closed, confirm catch-up and network behaviour, then retire the Claude schedule.
6. Workstation device encryption: unconfirmed. Plain-text v1 folder: still present, David's decision after item 1.

Supplement not started (separately scoped): a weekly encrypted logical database export (`pg_dump`, excluding session/token table data), per Codex answer 5. Managed database backups remain in place.
