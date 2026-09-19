# Demohub — uploaded-file backup and recovery (COI certificates, policy documents, avatars)

Why this exists: Supabase's daily database backups cover tables only. Files uploaded through the Storage API — every brand's Certificate of Insurance in `coi-docs`, plus `policy-docs` and `avatars` — are **not** in those backups (Codex pilot follow-up D, 2026-09-19).

## What is backed up, and where

- Tool: `demohub-docs/tools/backup-storage.mjs`. **Read-only against production**: it lists the buckets and downloads objects with `GET`; there is no write verb on the production path.
- Destination: `C:\Users\David\Documents\Codex\prod-storage-backup\<bucket>\<object path>` with `MANIFEST.json` (size, mimetype, upstream `updated_at`, sha256, backup time).
- Incremental: an object is downloaded again only when its upstream `updated_at` or size changed. **An object deleted upstream is kept locally and flagged `gone_upstream_at`** — a backup has to outlive a deletion.
- First run 2026-09-19: 12 objects (9 in `coi-docs`, 3 in `avatars`), 1.07 MB; `verify` 12/12; a second run downloaded 0 (incremental works).

## Run it

```bash
node C:/Users/David/demohub-docs/tools/backup-storage.mjs backup
```

```bash
node C:/Users/David/demohub-docs/tools/backup-storage.mjs verify
```

Cadence for the pilot: **weekly, and after any day with new COI uploads.** Owner: David (Claude can run it on request). The credentials come from `C:\Users\David\prod.env`, which never leaves the machine.

## Privacy, access, retention

- The backup folder and the two cutover data snapshots in `Documents\Codex\prod-snapshots\` contain real certificates, contact details and (the snapshots) authentication/session tables. **They stay on David's machine, out of every git repository, and are not attached to reviews or handoffs.**
- Access: David only. Retention: keep while the pilot runs; when a brand's certificate is replaced, the older file remains in the backup as history unless David removes it deliberately.
- Live financial records in the database are **not disposable** any more (real payment smoke, 2026-09-19): never reset production or delete payment/refund rows.

## Recovery

1. **One file lost or corrupted:** find it under `prod-storage-backup\coi-docs\…` (the path equals the `default_coi_url` / `coi_verifications` path in the database), confirm its sha256 against `MANIFEST.json`, and re-upload it to the same bucket path from the Supabase dashboard (Storage → `coi-docs`). That is a production write: David does it, or authorizes it explicitly.
2. **File not in the backup (uploaded since the last run):** limited-pilot contingency — ask the brand to upload the certificate again from Compliance; the review queue handles it like any new upload. Bookings and payments are unaffected by a missing file; only the reviewer's ability to open the document is.
3. **Database loss:** Supabase dashboard → Database → Backups → Scheduled backups (daily physical backups, Pro plan). Restoring rolls the whole database back — a last resort, David's decision, never used to tidy an audit count.

## Restore drill (proves the mechanics without touching production)

```bash
node C:/Users/David/demohub-docs/tools/backup-storage.mjs restore-test
```

Writes one synthetic PDF to a scratch folder of the **test** project's `coi-docs` bucket, reads it back, compares hashes, deletes it and confirms it is gone. It refuses the production project. Result 2026-09-19: uploaded ✓, read back identical ✓, removed ✓, gone afterwards ✓.
