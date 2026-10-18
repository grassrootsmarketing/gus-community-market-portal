-- 0103_payment_attempt_payer.sql (2026-10-18, Codex shipped-release finding 1, P1)
-- The booker receipt exception (release contract item 2) must be decided by WHO PAID, not by who booked. The checkout
-- route now records the authenticated initiator of every payment attempt on the attempt row (member id, email, role
-- at that moment). Receipt fan-out and the send-time recheck read the PAID attempt's payer: the booker receives the
-- receipt only when the paid attempt was initiated by that accepted booker. An owner paying for a booker's booking,
-- a legacy attempt without a payer, or any ambiguity keeps the receipt owner-only.
-- Forward-only; no row rewrites. No begin/commit here: the production paste wraps it.

ALTER TABLE payment_attempts ADD COLUMN IF NOT EXISTS payer_member_id uuid REFERENCES brand_members(id) ON DELETE RESTRICT;
ALTER TABLE payment_attempts ADD COLUMN IF NOT EXISTS payer_email text;
ALTER TABLE payment_attempts ADD COLUMN IF NOT EXISTS payer_role text;
ALTER TABLE payment_attempts DROP CONSTRAINT IF EXISTS payment_attempts_payer_role_check;
ALTER TABLE payment_attempts ADD CONSTRAINT payment_attempts_payer_role_check CHECK (payer_role IS NULL OR payer_role IN ('owner','booker'));
CREATE INDEX IF NOT EXISTS payment_attempts_payer_member_idx ON payment_attempts (payer_member_id) WHERE payer_member_id IS NOT NULL;

DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM information_schema.columns WHERE table_name = 'payment_attempts' AND column_name IN ('payer_member_id','payer_email','payer_role');
  IF n <> 3 THEN RAISE EXCEPTION '0103 postcondition: payer columns missing (%/3)', n; END IF;
END $$;
