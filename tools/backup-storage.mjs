// backup-storage.mjs (v1) — RETIRED 2026-09-19.
// Codex's review reproduced real defects in this version: a failed download was skipped instead of failing the
// run, a listing error could be mistaken for deletion, a same-path replacement overwrote the older bytes, the
// restore drill could not fail, the project guard was a substring match, and object names became local paths.
// It is replaced by tools/backup/ (cli.mjs + storage-backup.mjs, 60 regression tests). This stub exists so a
// stale command or scheduled job fails loudly instead of producing a misleading "verified".
console.error('RETIRED: use  node C:/Users/David/demohub-docs/tools/backup/cli.mjs <backup|verify|check|restore|drill>');
process.exit(64);
