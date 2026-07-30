# Demohub — versioned database schema

This directory is the single source of truth for the Demohub database structure. A database is
built by running every file here in numeric order, from empty.

## Files

- `0000_baseline_true.sql` — the base tables, **generated from production's own catalogs**
  (`pg_class` / `pg_attribute` / `pg_constraint` / `pg_index` / `pg_policy`) via a read-only query.
  It replaced `0000_baseline_reconstructed.sql`, which had been written by reading application
  source and inferring what the database must contain. That inference was wrong in both
  directions — it invented objects production did not have and missed objects it did — which is
  why the chain had never once been built from empty.
- `0001…0053_*.sql` — additive migrations in dependency order. Each is idempotent
  (`IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`, `CREATE OR REPLACE`, or an explicit `pg_catalog`
  existence check), so re-running is safe.
- `audit_orphan_sessions_and_prod_preflight.sql` — an operator diagnostic, not part of the chain.
  It is not numbered, so the official runner ignores it.

## What the baseline deliberately does NOT reproduce

`0000` is a faithful export with three deliberate omissions. Production has them; a new database
must not.

| Omitted | Why |
|---|---|
| `retailers_anon_read` policy | Granted the browser `anon` role read access to the `retailers` table. Replaced by a three-column grant in `0017` (`id`, `slug`, `name`) — the public store page needs those and nothing else. The policy exposed billing email and tier. |
| the anon `venues` policy | Same shape: unnecessary browser-role read access. |
| public `coi-docs` bucket | Certificates of insurance are third-party commercial documents. `0049` creates the bucket **private**. Production's copy is public; that is a live finding, not a thing to reproduce. |

Reproducing a defect faithfully is still reproducing a defect. Each omission is recorded here
because a future diff against production **will** show these three as differences, and the correct
response is to fix production, not to re-add them.

## Naming — this is load-bearing

Filenames must be `<numeric-version>_<name>.sql`. The Supabase CLI's migration runner parses the
leading digits as the version and **silently skips** files it cannot parse. A file named
`0025a_...sql` is not a lower-priority migration; it is an invisible one. That is why the former
`0025a` was folded into `0025`, and why `tools/check-migrations.mjs` fails the build on a
non-numeric version.

## Strategy

- **Fresh install:** run `0000`, then `0001…` in order.
- **Upgrade:** additive migrations no-op where already applied.
- **Post-conditions:** the later migrations end with a `DO $$` block that re-reads the catalogs and
  raises if the intended end state is absent. A migration that runs without error but achieves
  nothing is the failure mode these guard against — several in this chain previously did exactly
  that.
- **`storage.objects` is owned by `supabase_storage_admin`.** A migration cannot `ALTER` it or
  create policies on it (error 42501, insufficient privilege), so `0049` **asserts** the expected
  RLS state and fails loudly rather than pretending to set it.

## Verification

`tools/check-migrations.mjs` enforces, on every run:

- filenames parse to a numeric version, and versions are unique
- exactly one baseline
- no interactive `SELECT` left in a migration (in the SQL editor, a multi-statement file shows only
  the last result, so a trailing `SELECT` hides whether the statements before it succeeded)
- no `ALTER`/`CREATE POLICY` against `storage.objects`
- no reference to a retired project ref

## Status

The reconciliation step that this file previously listed as outstanding is **done** — that is what
`0000_baseline_true.sql` is. The chain has been built from empty and verified. Storage buckets
(`coi-docs` private, `avatars`, `policy-docs`) are captured in `0049`; the RLS and privilege state
is captured in `0043` and `0051`.

What is *not* proven by this directory alone: that a database built from it matches the one the
application will actually run against. That is the binding layer's job (`api/_env.js`), and the
`deployment_identity` row created by `0050` is the token it checks — a database that cannot say
which environment it is gets no traffic.
