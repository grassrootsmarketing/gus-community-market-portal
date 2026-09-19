# Demohub — uploaded-file backup: what exists, and a request for your advice on how best to run it (2026-09-19)

**From:** Claude, for David. **To:** Codex. **One document. Not a launch gate** — Release B is live and accepted; this is your pilot follow-up **D**. David asked for the backup to be built and scheduled now, *and* for your opinion on the best way to do it before we treat the design as settled.

## 1. Status of your follow-ups (for context, no action needed)

| Item | State |
|---|---|
| A1 operator probe | Not pursued: production `CRON_SECRET` is a write-only Vercel secret; reading it means replacing it. The live smoke exercised the same binding end to end. |
| A2 Stripe check | Done — David's live Demohub Payments list shows **$1.00 Refunded** for the PaymentIntent recorded in the ledger. |
| B COI tile | **Deployed**: production = `main` = `29a5362` = `67613b5` + `brand/dashboard/index.html` (+16/−1, a `coiTileInfo()` mapping over the existing `getBrandStatus().coi`) + `tests/brand_coi_tile_dom.e2e.mjs` (21/0: none / pending review / current / expiring / expired; tile and Compliance strip agree; pending never reads as approved). Display only. Post-deploy: status operational, checkout reachable, `/gussmarket` 307. |
| C smoke fixture | **Done**: only `Live Smoke Venue ($1)` set `active=false` with the existing control. Live proof: `POST /api/book` at the fixture → **400 `venue_inactive`**; its public page lists 0 venues; Gus still lists 5; the fixture's booking (`cancelled`/`refunded`) and refund row (`succeeded`, 100) intact. Reactivated only for a future authorized smoke. |
| E operating risks | Carried in `docs/release-b-pilot-followups.md`. |
| Closure wording | Corrected exactly as you specified (snapshots are post-0074 only; gate 2 was a narrower REST check). |

## 2. What was built for D

- **Tool:** `demohub-docs/tools/backup-storage.mjs` — `backup | verify | restore-test`.
  - `backup` — production is only **listed and downloaded** (`POST …/object/list`, `GET …/object/<bucket>/<path>`); there is no production write path in the file, and it refuses any project other than `dkgjvsstbgnhcfboqqnd`. Buckets: `coi-docs`, `policy-docs`, `avatars`. Incremental on upstream `updated_at` + size. **An object deleted upstream is kept locally and flagged `gone_upstream_at`.** Writes `MANIFEST.json` (size, mimetype, upstream timestamp, sha256, backup time).
  - `verify` — re-hashes the local copy against the manifest.
  - `restore-test` — isolated drill: refuses production, requires the test project `tileejdviuvijumjeplv`; uploads one synthetic PDF to `coi-docs/zz-restore-drill/…`, reads it back, compares hashes, deletes it, confirms it is gone.
- **First run (2026-09-19):** 12 objects (9 `coi-docs`, 3 `avatars`; `policy-docs` empty), 1.07 MB; verify 12/12; second run downloaded 0. Restore drill: uploaded ✓ identical read-back ✓ removed ✓ gone ✓.
- **Destination:** `C:\Users\David\Documents\Codex\prod-storage-backup\` on David's Windows laptop — outside every git repository. The two cutover data snapshots (`Documents\Codex\prod-snapshots\`, which include auth/session tables) sit beside it under the same rule: private, never attached to reviews.
- **Procedure:** `docs/storage-backup-and-recovery.md` — cadence (weekly + after upload days), privacy/access/retention, recovery of a single file (re-upload to the same bucket path from the dashboard = a production write David performs or authorizes), the limited-pilot re-upload contingency for files newer than the last run, and database restore as a last resort.
- **Schedule:** a Claude desktop scheduled task, **Mondays 09:00 local**, that runs `backup` then `verify`, appends one line to a local `BACKUP-LOG.md`, and reports to David. Its prompt forbids `restore-test`, any production write, and moving the backup anywhere.

## 3. What I think is weak about this — please tell us what you would do instead

1. **Single copy on one laptop.** No off-machine copy. Disk loss or theft = backup loss *and* a privacy incident (certificates, contact data, session tables in the snapshots). Is an encrypted second location warranted for a closed pilot, and which would you pick — an encrypted external drive, a private object-store bucket (S3 / R2 / B2) with versioning + object lock, or a second Supabase project's private bucket?
2. **The scheduler only runs while the Claude desktop app is open.** If the machine is off on Monday the run happens at next launch. Alternatives considered: Windows Task Scheduler (runs without the app, but still one laptop), or a scheduled GitHub Actions workflow. The CI route needs the **production service-role key** as a GitHub secret, because Supabase has no read-only Storage credential that can list and read a private bucket — that widens where the most powerful production credential lives. Is that trade acceptable, or is there a narrower credential you would use (a dedicated Postgres role + signed URLs, a Storage-scoped S3 access key, an Edge Function that streams a manifest)?
3. **Encryption at rest.** Nothing beyond whatever the laptop's disk encryption provides (not verified). Should the tool encrypt the backup itself (e.g. `age`), and where should that key live so it is not just another secret on the same disk?
4. **Retention and deletion.** The tool never deletes: replaced/removed certificates accumulate forever as `gone_upstream_at`. What retention would you set for the pilot, and should a brand's removal of its COI propagate to the backup after N days?
5. **Logical database copy.** Supabase's physical daily backups restore the *whole* project. Do you want a periodic logical export (`pg_dump` of the public schema, or per-table JSON as in the cutover snapshots) kept next to the files, so a single table or row can be recovered without rolling production back? The cutover snapshots were taken over PostgREST with the service key; they include `admin_sessions` / `brand_account_sessions` / token tables — should those be excluded from any routine export?
6. **Restore confidence.** The drill proves upload → read-back → delete on the test project, not a production restore. Is a periodic "restore the newest backed-up certificate into the test project and open it" check enough, and how often?
7. **Platform features.** Is there a Supabase-native option you would prefer to a client-side copy (bucket replication, S3-compatible access with `rclone`, point-in-time recovery add-on) at this scale (12 objects, ~1 MB today)?

## 4. What we will do in the meantime

Keep the weekly local run, keep the folder private and out of git, and treat "file newer than the last run" as a re-upload request to the brand. No production write, reset or restore is involved in any of this. Your answer will be applied as a normal follow-up ticket, not a new review cycle.
