-- supabase/rehearsal/verify-ledger.sql, Codex R4-04 (7)/(8): after `supabase migration up --linked` with 0073 still
-- hidden, the ledger tail must be EXACTLY the planned sequence: every version >= 0074 that exists as a file in the
-- tree, none missing, nothing extra, 0073 never inserted. Since 2026-10-22 the expected list is DERIVED from the
-- files at run time (the workflow substitutes __EXPECTED_TAIL__ below) rather than typed by hand: the literal
-- written for Release B (0074..0083) had silently gone stale once 0084 onward shipped. The gaps production carries
-- (0088, 0089 were never files) are therefore expected gaps here too.
DO $
DECLARE v_tail text; v_expected text := '__EXPECTED_TAIL__';
BEGIN
  SELECT string_agg(version, ',' ORDER BY version) INTO v_tail FROM supabase_migrations.schema_migrations WHERE version >= '0073';
  IF v_tail IS DISTINCT FROM v_expected THEN
    RAISE EXCEPTION 'rehearsal ledger tail mismatch: expected [%] got [%]', v_expected, coalesce(v_tail, '');
  END IF;
  RAISE NOTICE 'rehearsal ledger OK: %', v_tail;
END $$;
SELECT version, name FROM supabase_migrations.schema_migrations WHERE version >= '0070' ORDER BY version;
