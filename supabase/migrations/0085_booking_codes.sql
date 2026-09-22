-- 0085_booking_codes.sql
-- Booking codes (David, 2026-09-22): a retailer — or the platform owner on a retailer's behalf — generates a code a
-- brand types at checkout. A code waives the demo fee, clears the advance-booking (lead-time) minimum, or both.
--
-- Money rule: a booking is EITHER full price through the payment ledger OR free with no ledger row at all. A code
-- never produces a discounted amount, so pa_amount_decomposition, the group-sum checks and every reconciliation
-- case stay exactly as reviewed. A fee-waived booking is marked payment_status = 'waived' (amount_paid 0), gets its
-- outbox row directly (target confirmed / pending per auto_confirm_bookings) and is promoted by the existing
-- fulfilment worker; checkout_claim_group refuses it.
--
-- Lead-time rule: until now settings.advance_booking_days was display-only (the booking page hard-coded 14 and the
-- server checked nothing). api/book.js now enforces it in the retailer's local calendar; a code with
-- waives_lead_time is the only way past it. Nothing here changes existing bookings.

begin;

CREATE TABLE IF NOT EXISTS booking_codes (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  retailer_id       uuid NOT NULL REFERENCES retailers(id) ON DELETE CASCADE,
  code              text NOT NULL,                                   -- shown to the retailer; typed by the brand
  waives_fee        boolean NOT NULL DEFAULT false,
  waives_lead_time  boolean NOT NULL DEFAULT false,
  max_uses          integer CHECK (max_uses IS NULL OR max_uses >= 1),   -- NULL = unlimited until expiry/deactivation
  use_count         integer NOT NULL DEFAULT 0 CHECK (use_count >= 0),
  expires_at        timestamptz,
  active            boolean NOT NULL DEFAULT true,
  note              text,
  created_by        text NOT NULL CHECK (created_by IN ('retailer', 'owner')),
  created_by_email  text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  deactivated_at    timestamptz,
  CONSTRAINT booking_codes_waives_something CHECK (waives_fee OR waives_lead_time),
  CONSTRAINT booking_codes_code_shape CHECK (code ~ '^[A-Z0-9]{2,12}(-[A-Z0-9]{2,12}){0,3}$')
);
CREATE UNIQUE INDEX IF NOT EXISTS booking_codes_code_key ON booking_codes (code);
CREATE INDEX IF NOT EXISTS booking_codes_retailer_idx ON booking_codes (retailer_id, created_at DESC);

CREATE TABLE IF NOT EXISTS booking_code_redemptions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code_id           uuid NOT NULL REFERENCES booking_codes(id) ON DELETE RESTRICT,
  booking_id        uuid NOT NULL UNIQUE REFERENCES bookings(id) ON DELETE RESTRICT,
  retailer_id       uuid NOT NULL REFERENCES retailers(id) ON DELETE RESTRICT,
  brand_id          uuid REFERENCES brands(id) ON DELETE SET NULL,
  brand_name        text,
  waived_fee        boolean NOT NULL,
  waived_lead_time  boolean NOT NULL,
  redeemed_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS booking_code_redemptions_code_idx ON booking_code_redemptions (code_id, redeemed_at DESC);

ALTER TABLE bookings ADD COLUMN IF NOT EXISTS booking_code_id uuid REFERENCES booking_codes(id) ON DELETE SET NULL;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS fee_waived boolean NOT NULL DEFAULT false;

ALTER TABLE booking_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE booking_code_redemptions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON booking_codes, booking_code_redemptions FROM public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------
-- Preview (read-only): what a code would do for this retailer right now. Never increments.
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION booking_code_check(p_code text, p_retailer_id uuid)
RETURNS TABLE (ok boolean, reason text, code_id uuid, waives_fee boolean, waives_lead_time boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_c booking_codes%ROWTYPE;
BEGIN
  SELECT * INTO v_c FROM booking_codes c WHERE c.code = upper(trim(coalesce(p_code, ''))) AND c.retailer_id = p_retailer_id;
  IF NOT FOUND THEN RETURN QUERY SELECT false, 'code_not_found'::text, NULL::uuid, false, false; RETURN; END IF;
  IF NOT v_c.active THEN RETURN QUERY SELECT false, 'code_inactive'::text, v_c.id, false, false; RETURN; END IF;
  IF v_c.expires_at IS NOT NULL AND v_c.expires_at <= now() THEN RETURN QUERY SELECT false, 'code_expired'::text, v_c.id, false, false; RETURN; END IF;
  IF v_c.max_uses IS NOT NULL AND v_c.use_count >= v_c.max_uses THEN RETURN QUERY SELECT false, 'code_used_up'::text, v_c.id, false, false; RETURN; END IF;
  RETURN QUERY SELECT true, NULL::text, v_c.id, v_c.waives_fee, v_c.waives_lead_time;
END $$;
REVOKE ALL ON FUNCTION booking_code_check(text, uuid) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION booking_code_check(text, uuid) TO service_role;

-- ---------------------------------------------------------------------------------------------
-- Redeem: ONE transaction under the code's row lock. Checks again (a parallel request may have taken the last
-- use), records the redemption, increments, stamps the booking and — for a fee waiver — marks it free and issues
-- its outbox row. A booking can redeem at most one code, and only while it is still unpaid + pending_payment.
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION booking_code_redeem(p_code text, p_retailer_id uuid, p_booking_id uuid, p_brand_id uuid)
RETURNS TABLE (ok boolean, reason text, code_id uuid, waived_fee boolean, waived_lead_time boolean, target_status text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_c booking_codes%ROWTYPE; v_b bookings%ROWTYPE; v_auto boolean; v_target text;
BEGIN
  SELECT * INTO v_c FROM booking_codes c WHERE c.code = upper(trim(coalesce(p_code, ''))) AND c.retailer_id = p_retailer_id FOR UPDATE;
  IF NOT FOUND THEN RETURN QUERY SELECT false, 'code_not_found'::text, NULL::uuid, false, false, NULL::text; RETURN; END IF;
  IF NOT v_c.active THEN RETURN QUERY SELECT false, 'code_inactive'::text, v_c.id, false, false, NULL::text; RETURN; END IF;
  IF v_c.expires_at IS NOT NULL AND v_c.expires_at <= now() THEN RETURN QUERY SELECT false, 'code_expired'::text, v_c.id, false, false, NULL::text; RETURN; END IF;
  IF v_c.max_uses IS NOT NULL AND v_c.use_count >= v_c.max_uses THEN RETURN QUERY SELECT false, 'code_used_up'::text, v_c.id, false, false, NULL::text; RETURN; END IF;

  SELECT * INTO v_b FROM bookings b WHERE b.id = p_booking_id AND b.retailer_id = p_retailer_id FOR UPDATE;
  IF NOT FOUND THEN RETURN QUERY SELECT false, 'booking_not_found'::text, v_c.id, false, false, NULL::text; RETURN; END IF;
  IF v_b.brand_id IS DISTINCT FROM p_brand_id THEN RETURN QUERY SELECT false, 'booking_brand_mismatch'::text, v_c.id, false, false, NULL::text; RETURN; END IF;
  IF v_b.booking_code_id IS NOT NULL THEN RETURN QUERY SELECT false, 'booking_already_has_code'::text, v_c.id, false, false, NULL::text; RETURN; END IF;
  -- a fee waiver needs an unpaid pending_payment booking; a short-notice-only code may also stamp a provisional
  -- (held) booking, whose hold is captured or released exactly as before.
  IF v_c.waives_fee THEN
    IF coalesce(v_b.status, '') <> 'pending_payment' OR coalesce(v_b.payment_status, 'unpaid') <> 'unpaid' THEN
      RETURN QUERY SELECT false, 'booking_not_redeemable'::text, v_c.id, false, false, NULL::text; RETURN;
    END IF;
  ELSIF coalesce(v_b.status, '') NOT IN ('pending_payment', 'held') THEN
    RETURN QUERY SELECT false, 'booking_not_redeemable'::text, v_c.id, false, false, NULL::text; RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM payment_allocations a WHERE a.booking_id = p_booking_id) THEN
    RETURN QUERY SELECT false, 'booking_in_checkout'::text, v_c.id, false, false, NULL::text; RETURN;
  END IF;

  INSERT INTO booking_code_redemptions (code_id, booking_id, retailer_id, brand_id, brand_name, waived_fee, waived_lead_time)
    VALUES (v_c.id, p_booking_id, p_retailer_id, p_brand_id, v_b.brand_name, v_c.waives_fee, v_c.waives_lead_time);
  UPDATE booking_codes SET use_count = use_count + 1 WHERE id = v_c.id;

  IF v_c.waives_fee THEN
    SELECT coalesce(r.auto_confirm_bookings, false) INTO v_auto FROM retailers r WHERE r.id = p_retailer_id;
    v_target := CASE WHEN v_auto THEN 'confirmed' ELSE 'pending' END;
    UPDATE bookings SET booking_code_id = v_c.id, fee_waived = true, payment_status = 'waived', amount_paid = 0, paid_at = now()
      WHERE id = p_booking_id;
    -- The same outbox the paid path uses (0038/0065/0078), with no payment group: the worker promotes
    -- pending_payment -> target via booking_transition 'promote_paid' and sends the normal notices.
    INSERT INTO booking_fulfillments (booking_id, payment_group_id, target_status, status)
      VALUES (p_booking_id, NULL, v_target, 'pending')
      ON CONFLICT (booking_id) DO NOTHING;
  ELSE
    UPDATE bookings SET booking_code_id = v_c.id WHERE id = p_booking_id;
  END IF;

  RETURN QUERY SELECT true, NULL::text, v_c.id, v_c.waives_fee, v_c.waives_lead_time, v_target;
END $$;
REVOKE ALL ON FUNCTION booking_code_redeem(text, uuid, uuid, uuid) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION booking_code_redeem(text, uuid, uuid, uuid) TO service_role;

-- ---------------------------------------------------------------------------------------------
-- checkout_claim_group must never price a fee-waived booking. The claim function is re-created in
-- several migrations; rather than copy it again, a trigger on payment_allocations refuses the row.
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION _pa_refuse_fee_waived() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM bookings b WHERE b.id = NEW.booking_id AND b.fee_waived) THEN
    RAISE EXCEPTION 'booking_fee_waived: booking % is free and cannot enter checkout', NEW.booking_id USING errcode = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS pa_refuse_fee_waived ON payment_allocations;
CREATE TRIGGER pa_refuse_fee_waived BEFORE INSERT ON payment_allocations FOR EACH ROW EXECUTE FUNCTION _pa_refuse_fee_waived();

-- post-conditions
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM information_schema.columns WHERE table_name = 'bookings' AND column_name IN ('booking_code_id', 'fee_waived');
  IF n <> 2 THEN RAISE EXCEPTION 'POST-CONDITION FAILED: bookings columns missing'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'pa_refuse_fee_waived') THEN RAISE EXCEPTION 'POST-CONDITION FAILED: trigger missing'; END IF;
  SELECT count(*) INTO n FROM pg_policies WHERE tablename IN ('booking_codes', 'booking_code_redemptions');
  IF n <> 0 THEN RAISE EXCEPTION 'POST-CONDITION FAILED: unexpected policies on booking code tables'; END IF;
END $$;

commit;
