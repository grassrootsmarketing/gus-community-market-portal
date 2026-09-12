-- supabase/rehearsal/verify-pre.sql — Codex Release B round 4, R4-04 (7): the UPGRADE REHEARSAL, step 1.
-- Runs against the disposable staging project ONLY (CI refuses any other target), right after a
-- `supabase db reset --linked` performed with every migration >= 0073 hidden from the CLI.
-- Asserts the starting point is production's: ledger 0000..0072 applied, 0073 NEVER applied.
-- Read-only apart from the assertion itself.
DO $$
DECLARE v_max text; v_n int;
BEGIN
  SELECT max(version) INTO v_max FROM supabase_migrations.schema_migrations;
  IF v_max IS DISTINCT FROM '0072' THEN
    RAISE EXCEPTION 'rehearsal precondition: ledger max must be 0072 (production''s), got %', v_max;
  END IF;
  SELECT count(*) INTO v_n FROM supabase_migrations.schema_migrations WHERE version = '0073';
  IF v_n <> 0 THEN RAISE EXCEPTION 'rehearsal precondition: 0073 must NOT be in the ledger (production never applied it)'; END IF;
  -- the pre-Release-B contracts production runs today
  IF to_regprocedure('public.complete_fulfillment(uuid,text,boolean,boolean,boolean,text)') IS NULL THEN
    RAISE EXCEPTION 'rehearsal precondition: the six-argument complete_fulfillment (production''s) is missing';
  END IF;
  IF to_regprocedure('public.booking_transition(uuid,uuid,text,jsonb,numeric)') IS NOT NULL THEN
    RAISE EXCEPTION 'rehearsal precondition: booking_transition must not exist before 0077';
  END IF;
  IF to_regprocedure('public.record_fulfillment(uuid,text,integer,boolean,boolean,boolean,text,integer)') IS NOT NULL THEN
    RAISE EXCEPTION 'rehearsal precondition: record_fulfillment must not exist before 0081';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'booking_fulfillments' AND column_name = 'generation') THEN
    RAISE EXCEPTION 'rehearsal precondition: booking_fulfillments.generation must not exist before 0078';
  END IF;
  RAISE NOTICE 'rehearsal precondition OK: ledger max %, 0073 absent, pre-Release-B contracts in place', v_max;
END $$;
SELECT version, name FROM supabase_migrations.schema_migrations WHERE version >= '0060' ORDER BY version;
