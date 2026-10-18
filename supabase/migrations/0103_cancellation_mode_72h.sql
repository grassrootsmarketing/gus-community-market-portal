-- 0103_cancellation_mode_72h.sql (2026-10-18)
-- Refund enforcement now matches the 72-hour cancellation policy (api/_refund-cutoff.js, api/booking-action.js).
-- The server reads exactly two retailers.cancellation_mode values: 'refundable' (automatic refund when the demo
-- starts at least 72 hours away) and 'non_refundable' (never automatic). The retailer admin used to save the
-- legacy '14_day_refund' value, which the server still READS as refundable, so this migration is housekeeping,
-- not a prerequisite: the code works with or without it. It makes the stored data say what the server does.
--
--   * column default: 'refundable' (was '14_day_refund'); api/signup.js writes 'refundable' explicitly.
--   * backfill: every row that is not 'non_refundable' becomes 'refundable' (null, '14_day_refund', unknown).
--   * a non-refundable store with no written cancellation sentence gets the non-refundable sentence, so the
--     text brands sign (api/booking.js falls back to the 72-hour sentence when the column is null) does not
--     promise a refund the store does not give. The sentence is identical to NON_REFUNDABLE_CANCELLATION_POLICY
--     in api/_refund-cutoff.js and CANCEL_POLICY_NON_REFUNDABLE in r/gus/admin/index.html.
--
-- Idempotent: re-running changes nothing. No begin/commit here (the paste wraps it).

ALTER TABLE public.retailers ALTER COLUMN cancellation_mode SET DEFAULT 'refundable';

UPDATE public.retailers
   SET cancellation_mode = 'refundable'
 WHERE cancellation_mode IS DISTINCT FROM 'non_refundable'
   AND cancellation_mode IS DISTINCT FROM 'refundable';

UPDATE public.retailers
   SET cancellation_policy = 'Demo fees are not refunded when a demo is cancelled, because the store orders product for you as soon as you book. Please cancel as early as you can so the slot can go to another brand. Reschedules are welcome anytime.'
 WHERE cancellation_mode = 'non_refundable'
   AND coalesce(btrim(cancellation_policy), '') = '';

DO $$
DECLARE v_default text; v_bad integer;
BEGIN
  SELECT pg_get_expr(d.adbin, d.adrelid) INTO v_default
    FROM pg_attrdef d JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
   WHERE d.adrelid = 'public.retailers'::regclass AND a.attname = 'cancellation_mode';
  IF v_default IS NULL OR v_default NOT LIKE '%refundable%' OR v_default LIKE '%14_day_refund%' THEN
    RAISE EXCEPTION '0103: retailers.cancellation_mode default is % (expected ''refundable'')', v_default;
  END IF;
  SELECT count(*) INTO v_bad FROM public.retailers WHERE cancellation_mode IS DISTINCT FROM 'refundable' AND cancellation_mode IS DISTINCT FROM 'non_refundable';
  IF v_bad > 0 THEN RAISE EXCEPTION '0103: % retailers still carry a cancellation_mode the server does not read', v_bad; END IF;
  SELECT count(*) INTO v_bad FROM public.retailers WHERE cancellation_mode = 'non_refundable' AND coalesce(btrim(cancellation_policy), '') = '';
  IF v_bad > 0 THEN RAISE EXCEPTION '0103: % non-refundable retailers have no written cancellation sentence', v_bad; END IF;
END $$;
