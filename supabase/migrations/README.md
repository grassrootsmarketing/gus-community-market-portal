# Demohub — versioned database schema (F5-01)

This directory is the single source of truth for the Demohub database structure. A fresh staging
or CI database is built by running every file here in numeric order.

## Files
- `0000_baseline_reconstructed.sql` — the base tables, **reconstructed from application source**
  (not yet from a production dump). ⚠ Must be reconciled against a real production structural
  export before it is authoritative (tracked F5-01 exit item).
- `0001…0021_*.sql` — the additive migrations written during development, in dependency order.
  Each is idempotent (`IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS`), so re-running is safe.

## Strategy
- **Fresh install:** run `0000` then `0001…` in order → complete schema.
- **Upgrade:** on an existing DB, the additive migrations no-op where already applied.
- **Additive + reversible** where possible; any irreversible change ships with a forward-fix note.

## Reconciliation (the remaining F5-01 step)
The baseline is reconstructed, so it may miss real production columns/types/defaults/constraints,
RLS policies, storage buckets/policies, or indexes. Reconcile by exporting the **structure only**
of the production Supabase schema and diffing it against a database built from these migrations;
fold any differences into `0000` (or a new numbered migration) and record the diff. Until then,
this schema is validated for *shape*, not certified byte-identical to production.

## Not yet captured here (from later phases / reconciliation)
- Storage buckets `coi-docs`, `avatars`, `policy-docs` and their access policies (Phase D).
- Full RLS policy set (multi-tenant hardening / reconciliation).
- Some secondary indexes and check constraints.
