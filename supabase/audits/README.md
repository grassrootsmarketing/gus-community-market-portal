# supabase/audits

Read-only SQL that a human runs in the SQL editor and reads the output of.

**Nothing in this folder is a migration.** These scripts contain bare `SELECT`s and
commented-out `DELETE`s that require review before execution. They must never sit in
`supabase/migrations/`, because `supabase db reset` reads that directory and applies
whatever it finds there — regardless of what any checker believes about it.

`tools/check-migrations.mjs` now fails if anything that is not a numbered migration
appears in `supabase/migrations/`.
