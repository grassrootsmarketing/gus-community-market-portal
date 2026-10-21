-- 0105_booking_cancellations.sql (2026-10-18, Codex refund-cutoff review RC-1 / RC-3)
-- One durable record per cancelled booking: who asked (the brand, or the store could not host), when the request
-- was received (the effective time the 72-hour clock is measured from), the policy applied, the start instant
-- used, the decision, and any override. api/booking-action.js records it BEFORE any refund effect and, on a
-- retry, reuses the saved decision instead of judging the clock again, so an eligible refund cannot expire
-- because a provider call or the booking transition failed the first time.
--
--   booking_cancellations              the record (booking_id is the key: one decision per booking)
--   booking_cancellation_record()      insert-or-return under the booking's row lock (compare-and-set): the first
--                                      caller's decision stands; a concurrent or later caller gets it back with
--                                      existing = true. Refuses a booking that belongs to another retailer or is
--                                      already terminal with no record (state_conflict).
--
-- Idempotent. No begin/commit here (the paste wraps it).

CREATE TABLE IF NOT EXISTS public.booking_cancellations (
  booking_id          uuid PRIMARY KEY REFERENCES public.bookings(id) ON DELETE CASCADE,
  retailer_id         uuid NOT NULL REFERENCES public.retailers(id) ON DELETE CASCADE,
  category            text NOT NULL CHECK (category IN ('brand_requested', 'store_caused')),
  requested_at        timestamptz NOT NULL,                 -- effective time: when the brand's request was received
  decided_at          timestamptz NOT NULL DEFAULT now(),   -- when the store recorded the cancellation
  actor               text,                                 -- authenticated operator (retailer session email)
  cancellation_mode   text NOT NULL,                        -- the store's mode as applied (refundable | non_refundable)
  cutoff_hours        integer NOT NULL,
  start_at            timestamptz,                          -- the demo start instant the decision measured against
  start_source        text,                                 -- snapshot | computed | unresolved
  hours_before_demo   numeric,
  refund              boolean NOT NULL,                     -- the decision: call the ledger refund path
  status              text NOT NULL CHECK (status IN ('auto', 'pending_manual', 'not_paid', 'under_review')),
  reason              text NOT NULL,
  force_refund        boolean NOT NULL DEFAULT false,
  override_reason     text,
  backdate_note       text,
  note                text,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS booking_cancellations_retailer_idx ON public.booking_cancellations (retailer_id, decided_at DESC);
CREATE INDEX IF NOT EXISTS booking_cancellations_review_idx ON public.booking_cancellations (status) WHERE status = 'under_review';
ALTER TABLE public.booking_cancellations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.booking_cancellations FROM public, anon, authenticated;

CREATE OR REPLACE FUNCTION public.booking_cancellation_record(p_booking_id uuid, p_retailer_id uuid, p_decision jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_bk record; v_row public.booking_cancellations%ROWTYPE;
BEGIN
  SELECT id, retailer_id, status INTO v_bk FROM public.bookings WHERE id = p_booking_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('outcome', 'no_booking'); END IF;
  IF v_bk.retailer_id IS DISTINCT FROM p_retailer_id THEN RETURN jsonb_build_object('outcome', 'forbidden'); END IF;
  SELECT * INTO v_row FROM public.booking_cancellations WHERE booking_id = p_booking_id;
  IF FOUND THEN
    RETURN jsonb_build_object('outcome', 'existing', 'existing', true, 'decision', to_jsonb(v_row));
  END IF;
  IF v_bk.status NOT IN ('pending', 'confirmed', 'held') THEN
    RETURN jsonb_build_object('outcome', 'state_conflict', 'status', v_bk.status);
  END IF;
  INSERT INTO public.booking_cancellations (booking_id, retailer_id, category, requested_at, actor, cancellation_mode, cutoff_hours,
      start_at, start_source, hours_before_demo, refund, status, reason, force_refund, override_reason, backdate_note, note)
  VALUES (p_booking_id, p_retailer_id, p_decision->>'category', (p_decision->>'requested_at')::timestamptz, p_decision->>'actor',
      p_decision->>'cancellation_mode', (p_decision->>'cutoff_hours')::integer,
      NULLIF(p_decision->>'start_at', '')::timestamptz, p_decision->>'start_source', NULLIF(p_decision->>'hours_before_demo', '')::numeric,
      (p_decision->>'refund')::boolean, p_decision->>'status', p_decision->>'reason', coalesce((p_decision->>'force_refund')::boolean, false),
      p_decision->>'override_reason', p_decision->>'backdate_note', p_decision->>'note')
  RETURNING * INTO v_row;
  RETURN jsonb_build_object('outcome', 'recorded', 'existing', false, 'decision', to_jsonb(v_row));
END $$;
REVOKE ALL ON FUNCTION public.booking_cancellation_record(uuid, uuid, jsonb) FROM public, anon, authenticated;

DO $$
BEGIN
  IF to_regclass('public.booking_cancellations') IS NULL THEN RAISE EXCEPTION '0105: booking_cancellations missing'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'booking_cancellation_record') THEN
    RAISE EXCEPTION '0105: booking_cancellation_record missing';
  END IF;
END $$;
