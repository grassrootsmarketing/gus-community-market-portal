-- 0031_event_inbox_lease.sql — atomic exactly-once webhook processing (Codex #9 P0-7).
-- Adds a lease to processed_stripe_events + CAS claim/complete/fail functions so two concurrent
-- deliveries of one event cannot both run the money handlers, and a crashed worker's lease expires.
BEGIN;
ALTER TABLE processed_stripe_events ADD COLUMN IF NOT EXISTS lease_owner text;
ALTER TABLE processed_stripe_events ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz;

-- Returns 'process' (caller owns the lease), 'skip' (already completed), or 'busy' (live lease held).
CREATE OR REPLACE FUNCTION claim_stripe_event(p_event_id text, p_event_type text, p_owner text, p_lease_seconds int)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v record;
BEGIN
  BEGIN
    INSERT INTO processed_stripe_events(event_id, event_type, status, lease_owner, lease_expires_at)
      VALUES (p_event_id, p_event_type, 'processing', p_owner, now() + make_interval(secs => p_lease_seconds));
    RETURN 'process';
  EXCEPTION WHEN unique_violation THEN NULL; END;
  SELECT * INTO v FROM processed_stripe_events WHERE event_id = p_event_id FOR UPDATE;
  IF v.status = 'completed' THEN RETURN 'skip'; END IF;
  IF v.lease_expires_at IS NULL OR v.lease_expires_at < now() THEN
    UPDATE processed_stripe_events
      SET status = 'processing', lease_owner = p_owner, lease_expires_at = now() + make_interval(secs => p_lease_seconds)
      WHERE event_id = p_event_id;
    RETURN 'process';
  END IF;
  RETURN 'busy';
END $$;

-- Only the lease owner may complete/fail. Returns true iff exactly one row changed.
CREATE OR REPLACE FUNCTION complete_stripe_event(p_event_id text, p_owner text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE n int;
BEGIN
  UPDATE processed_stripe_events SET status = 'completed', processed_at = now(), lease_owner = NULL, lease_expires_at = NULL
    WHERE event_id = p_event_id AND lease_owner = p_owner AND status = 'processing';
  GET DIAGNOSTICS n = ROW_COUNT; RETURN n = 1;
END $$;

CREATE OR REPLACE FUNCTION fail_stripe_event(p_event_id text, p_owner text, p_err text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE n int;
BEGIN
  UPDATE processed_stripe_events SET status = 'failed', last_error = left(coalesce(p_err,''), 300), lease_owner = NULL, lease_expires_at = NULL
    WHERE event_id = p_event_id AND lease_owner = p_owner;
  GET DIAGNOSTICS n = ROW_COUNT; RETURN n = 1;
END $$;

REVOKE ALL ON FUNCTION claim_stripe_event(text,text,text,int)   FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION complete_stripe_event(text,text)          FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION fail_stripe_event(text,text,text)         FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION claim_stripe_event(text,text,text,int) TO service_role;
GRANT EXECUTE ON FUNCTION complete_stripe_event(text,text)        TO service_role;
GRANT EXECUTE ON FUNCTION fail_stripe_event(text,text,text)       TO service_role;
COMMIT;
