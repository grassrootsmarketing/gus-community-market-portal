-- supabase/rehearsal/verify-ledger.sql — Codex R4-04 (7)/(8): after `supabase migration up --linked`
-- with 0073 still hidden, the ledger tail must be EXACTLY the planned production sequence — every
-- version named, none missing, 0073 never inserted. This is the record the cutover runbook copies.
DO $$
DECLARE v_tail text; v_expected text := '0074,0075,0076,0077,0078,0079,0080,0081';
BEGIN
  SELECT string_agg(version, ',' ORDER BY version) INTO v_tail FROM supabase_migrations.schema_migrations WHERE version >= '0073';
  IF v_tail IS DISTINCT FROM v_expected THEN
    RAISE EXCEPTION 'rehearsal ledger tail mismatch: expected [%] got [%]', v_expected, coalesce(v_tail, '');
  END IF;
  RAISE NOTICE 'rehearsal ledger OK: %', v_tail;
END $$;
SELECT version, name FROM supabase_migrations.schema_migrations WHERE version >= '0070' ORDER BY version;
