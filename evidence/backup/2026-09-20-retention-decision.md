# Retention model decision (Codex closure review item 5) — 2026-09-20

David's decision, verbatim: "Proceed with option B. Document it as a finite recovery window—not 'never lose the last off-machine copy.' I'll respond to backup alerts promptly; the remaining days are a buffer, not a waiting period."

Approved model: **finite off-machine recovery window of 30 days**, plus the independent 26-hour failed/missed-run alert and prompt operator response. No never-expiring recovery anchor is kept (so backed-up customer documents are not retained indefinitely). The local folder separately keeps its last good snapshot.

Mechanics as deployed (unchanged): S3 lifecycle on `storage/` — current version expires at 30 days (delete marker; normal list/fetch stop finding it), noncurrent versions removed 7 days later, 7-day governance Object Lock; during that last interval only the account administrator could recover by version id, never the daily uploader.

Wording corrected in: `docs/storage-backup-and-recovery.md` (status table, retention section, open-items list, alert response steps), the bucket template comment, the `pruneLocal` comment, and the local `backup-config.json` note. The earlier phrase "never the last good one" now applies only to the local folder, and says so.
