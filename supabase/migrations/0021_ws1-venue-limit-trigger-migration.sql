-- WS1-R2-01 (atomic backstop): enforce the per-retailer venue plan limit at the DATABASE, so two
-- concurrent createVenue requests cannot both pass a count-then-insert check and exceed the limit.
-- The trigger locks the retailer row (serializing same-tenant inserts) and is the AUTHORITATIVE
-- limit; the JS pre-check in commands.js only provides a friendlier error before hitting it.
-- Run on STAGING first, test concurrent creates, then production. Idempotent.

CREATE OR REPLACE FUNCTION enforce_venue_limit() RETURNS trigger AS $$
DECLARE
  v_tier   text;
  v_status text;
  v_limit  int;
  v_count  int;
BEGIN
  -- Serialize concurrent inserts for the same tenant.
  PERFORM 1 FROM retailers WHERE id = NEW.retailer_id FOR UPDATE;

  -- Legacy precedence: settings.billing_tier first, then retailers.billing_tier.
  SELECT lower(billing_tier) INTO v_tier FROM settings WHERE retailer_id = NEW.retailer_id LIMIT 1;
  SELECT lower(billing_status) INTO v_status FROM retailers WHERE id = NEW.retailer_id;
  IF v_tier IS NULL THEN
    SELECT lower(billing_tier) INTO v_tier FROM retailers WHERE id = NEW.retailer_id;
  END IF;
  v_tier := coalesce(v_tier, 'solo');

  v_limit := CASE v_tier
    WHEN 'pro'        THEN 10
    WHEN 'enterprise' THEN 1000   -- safety ceiling; tier is billing-assigned, not self-selectable
    ELSE 1                        -- solo / free / legacy starter+growth / unknown => most restrictive
  END;

  -- Inactive paid subscription drops entitlement back to the Solo limit.
  IF v_limit > 1 AND v_status IN ('canceled','cancelled','unpaid','past_due','incomplete_expired') THEN
    v_limit := 1;
  END IF;

  SELECT count(*) INTO v_count FROM venues WHERE retailer_id = NEW.retailer_id;
  IF v_count >= v_limit THEN
    RAISE EXCEPTION 'venue_limit_reached: % plan allows % location(s)', v_tier, v_limit
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_enforce_venue_limit ON venues;
CREATE TRIGGER trg_enforce_venue_limit
  BEFORE INSERT ON venues
  FOR EACH ROW EXECUTE FUNCTION enforce_venue_limit();

-- NOTE: the tier→limit numbers here MUST match commands.js TIER_LIMITS. Confirm the real
-- per-tier location caps with the product/pricing definition before production.
