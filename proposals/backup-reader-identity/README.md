# Proposal — read-only backup identity (Codex BAK-4). NOT APPLIED.

Today the backup reads production with the service key in `C:\Users\David\prod.env`. The tool only reads, but that key can do anything. This proposal replaces it with one dedicated login that can only list and download the three buckets.

## What would change

| Where | Change | Who approves |
|---|---|---|
| demohub-rebuild-check | Create Auth user `backup-reader` with a fixed UUID + long random password (local file only). Apply the draft policy. Run the tests below. | David |
| Backup tool | New source mode: sign in at `/auth/v1/token?grant_type=password` with the publishable key, use the short-lived token for `/storage/v1/`. Same exact-origin and no-redirect guards. Offline tests first. | — (code only) |
| demohub-prod | Same user + policy, as migration 0084, through the normal paste-and-verify procedure. Then remove the service key from the backup's env file. | David, separately |

## Acceptance tests on demohub-rebuild-check (all must hold)

1. Backup principal: lists and downloads in `coi-docs`, `policy-docs`, `avatars` — a full `drill` passes using it as the source.
2. Backup principal **cannot**: upload, overwrite, move, delete, or create a signed upload URL in any bucket; read any other bucket; read any `public` table through REST; execute any `public` RPC; change its own role or grant anything.
3. A second, ordinary Auth user: sees zero buckets and zero objects.
4. Anon (publishable key alone): unchanged — no listing, no `coi-docs` reads; public-bucket object URLs behave as before.
5. Live grant audit attached: tables, functions and policies reachable by `authenticated`, before and after — the only difference is the two SELECT policies.
6. Password sign-in is the only enabled path for that user; sign-ups stay as they are today.

## Open points for David / Codex

- Supabase Auth has never been used by the app. Confirm that enabling one password user does not change any dashboard Auth setting the app depends on (it should not: the app uses its own magic-link tables).
- The password lives in a local file on the workstation, like `prod.env` today — far less powerful, but still a secret to protect.
- Until this is approved and proven, the existing key remains the bridge (Codex's wording).
