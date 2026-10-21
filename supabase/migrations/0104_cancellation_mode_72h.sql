-- 0104_cancellation_mode_72h.sql (2026-10-18; reworked after Codex RC-2 / RC-5.6 the same day)
-- Refund enforcement now matches the 72-hour cancellation policy (api/_refund-cutoff.js, api/booking-action.js).
-- The server reads exactly two retailers.cancellation_mode values: 'refundable' (automatic refund when the demo
-- starts at least 72 hours away) and 'non_refundable' (never automatic). The retailer admin used to save the
-- legacy '14_day_refund' value. This migration makes the stored data say what the server does, and it is
-- REQUIRED before the deploy (Codex RC-2): a non-refundable store with no written sentence would otherwise show
-- brands the refundable sentence (api/booking.js falls back by mode too, belt and braces, but the data must agree).
--
--   * every row that is about to change is copied to retailers_cancellation_policy_backup_0104 first, so a
--     rollback can restore the exact previous cancellation_mode and cancellation_policy (Codex RC-5.6).
--   * column default: 'refundable' (was '14_day_refund'); api/signup.js writes 'refundable' explicitly.
--   * backfill: every row that is not 'non_refundable' becomes 'refundable' (null, '14_day_refund', unknown).
--   * a non-refundable store with no written cancellation sentence gets the non-refundable sentence; a refundable
--     store with no sentence is left null (api/booking.js and the admin read null as the 72-hour sentence).
--     The sentence is identical to NON_REFUNDABLE_CANCELLATION_POLICY in api/_refund-cutoff.js.
--
-- Idempotent: re-running changes nothing (the backup only records rows that are about to change).
-- No begin/commit here (the paste wraps it).

CREATE TABLE IF NOT EXISTS public.retailers_cancellation_policy_backup_0104 (
  retailer_id          uuid PRIMARY KEY,
  cancellation_mode    text,
  cancellation_policy  text,
  backed_up_at         timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON public.retailers_cancellation_policy_backup_0104 FROM public, anon, authenticated;

INSERT INTO public.retailers_cancellation_policy_backup_0104 (retailer_id, cancellation_mode, cancellation_policy)
SELECT id, cancellation_mode, cancellation_policy
  FROM public.retailers
 WHERE (cancellation_mode IS DISTINCT FROM 'non_refundable' AND cancellation_mode IS DISTINCT FROM 'refundable')
    OR (cancellation_mode = 'non_refundable' AND coalesce(btrim(cancellation_policy), '') = '')
ON CONFLICT (retailer_id) DO NOTHING;

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
    RAISE EXCEPTION '0104: retailers.cancellation_mode default is % (expected ''refundable'')', v_default;
  END IF;
  SELECT count(*) INTO v_bad FROM public.retailers WHERE cancellation_mode IS DISTINCT FROM 'refundable' AND cancellation_mode IS DISTINCT FROM 'non_refundable';
  IF v_bad > 0 THEN RAISE EXCEPTION '0104: % retailers still carry a cancellation_mode the server does not read', v_bad; END IF;
  SELECT count(*) INTO v_bad FROM public.retailers WHERE cancellation_mode = 'non_refundable' AND coalesce(btrim(cancellation_policy), '') = '';
  IF v_bad > 0 THEN RAISE EXCEPTION '0104: % non-refundable retailers have no written cancellation sentence', v_bad; END IF;
  IF to_regclass('public.retailers_cancellation_policy_backup_0104') IS NULL THEN RAISE EXCEPTION '0104: backup table missing'; END IF;
END $$;
