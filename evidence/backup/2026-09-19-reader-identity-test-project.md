# Read-only backup identity — proven on demohub-rebuild-check (2026-09-19)

Scope: **test project only** (`tileejdviuvijumjeplv`), on David's approval ("Test it on demohub-rebuild-check first"). Nothing was changed on demohub-prod. Script: `proposals/backup-reader-identity/reader-accept.mjs` (prints booleans and status codes only).

## Grant audit before the change (what `authenticated` can reach)

| Check | Result |
|---|---|
| Auth users in the project | 0 (the app does not use Supabase Auth) |
| `public` table privileges for `authenticated` | none |
| `public` tables with RLS off | none |
| Policies naming anon / authenticated / public | `public.retailers: retailers_anon_read (SELECT)` only |
| SECURITY DEFINER functions `authenticated` can execute | none |
| Functions `authenticated` can execute | 21 — slot/availability helpers and trigger functions, identical to `anon`'s 21 |
| Storage policies | none |
| Storage table grants for `authenticated` | Supabase defaults (incl. INSERT/UPDATE/DELETE on `objects`, `buckets`) — all gated by RLS, which had zero policies |

## Change applied (test project)

1. Auth user `backup-reader@demohubhq.com`, fixed id `49245ab8-bc78-484e-b8ac-51b301a05553`, role `authenticated`, long random password in a local file outside every repository.
2. Two policies, both `FOR SELECT TO authenticated`, both requiring `auth.uid()` = that id **and** the bucket to be one of `coi-docs`, `policy-docs`, `avatars`: `demohub_backup_reader_objects` on `storage.objects`, `demohub_backup_reader_buckets` on `storage.buckets`. The migration's post-condition (exactly two SELECT policies, zero write policies for anon/authenticated in `storage`) passed.

## Acceptance — before the policy / after the policy

| Check | Before | After |
|---|---|---|
| Reader signs in with the **publishable** key + password (no service key) | ok | ok |
| Buckets / objects visible, download | none, refused | exactly the three buckets; canary listed and downloaded byte-identical |
| Upload new, overwrite (PUT), upsert, delete one, bulk delete, move, copy, signed upload URL, create bucket, make `coi-docs` public, empty bucket, delete bucket | all refused | all refused |
| Admin view afterwards: only the canary, unchanged; `coi-docs` still private; no new bucket | ok | ok |
| REST: `bookings`, `internal_contacts`, `payments` rows; insert into `retailers` | none; refused | none; refused |
| REST `retailers`: reader sees no more than an anonymous visitor | ok | ok |
| Holder tries to give itself `service_role` via its own profile; fresh token still `authenticated`, same id, no role in app metadata | ok | ok |
| Auth admin API with the reader token | refused | refused |
| Anonymous (publishable key alone): buckets, listing, `coi-docs` download | none | none (unchanged) |
| A **different** signed-in user (created and removed for the test) | — | no bucket, no object, no download |
| The real backup tool with the reader login as its **only** source credential → encrypted snapshot → restore | — | complete; restored file byte-identical |

All fixtures were removed (canary object, second user). The reader user and the two policies remain on the test project for future drills.

## Not done

Production. Applying the same user + policy to demohub-prod is a separate approval and goes through the normal paste-and-verify migration procedure (`proposals/backup-reader-identity/0084_backup_reader_storage_select.DRAFT.sql`). Until then the production backup keeps using the service key on the workstation (the bridge Codex allowed).
