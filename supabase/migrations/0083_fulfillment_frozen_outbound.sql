-- 0083_fulfillment_frozen_outbound.sql
-- Codex return review (2026-09-17), follow-up F-1 — David chose to fix it before launch rather than
-- defer it. The held-stage worker sends the "slot held" notice under a stable provider idempotency
-- key (hold-placed:<booking>:<generation>, N-2), but it REBUILT the message on every attempt and the
-- amount lookup is optional. After a lost acceptance response, a retry could therefore carry a
-- different body under the same key; the provider rejects a reused key with a different payload, and
-- the held-notice work burned its attempts and parked although the first message may have been
-- delivered.
--
-- Fix: the exact outbound message is persisted BEFORE the first provider attempt and every retry
-- replays that payload under the same key. The write is fenced exactly like record_fulfillment
-- (0081): only the live claim (lease owner AND generation AND a still-pending row) may freeze, the
-- first writer wins, and a later call returns what was frozen — it never overwrites it. Keys carry
-- the generation, so a capture's re-issued paid generation never collides with held-stage entries.
-- Forward-only, additive; 0078 / 0081 untouched.

ALTER TABLE booking_fulfillments ADD COLUMN IF NOT EXISTS outbound jsonb NOT NULL DEFAULT '{}'::jsonb;
COMMENT ON COLUMN booking_fulfillments.outbound IS
  'Frozen outbound messages by logical key (e.g. hold-placed:<booking>:<generation>): {from,to,replyTo,subject,html,frozen_at}. Written once, before the first provider attempt, via freeze_fulfillment_outbound(); retries replay it unchanged (0083, Codex F-1).';

CREATE OR REPLACE FUNCTION freeze_fulfillment_outbound(
  p_booking_id uuid, p_owner text, p_generation integer, p_key text, p_payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v booking_fulfillments%ROWTYPE; v_new jsonb;
BEGIN
  IF p_booking_id IS NULL OR p_owner IS NULL OR p_generation IS NULL OR coalesce(btrim(p_key), '') = '' THEN
    RETURN jsonb_build_object('outcome', 'stale', 'reason', 'missing_claim');
  END IF;
  SELECT * INTO v FROM booking_fulfillments WHERE booking_id = p_booking_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('outcome', 'stale', 'reason', 'no_row'); END IF;
  -- the same fence as record_fulfillment (0081): the claim must still be the CURRENT one
  IF v.lease_owner IS DISTINCT FROM p_owner OR v.generation IS DISTINCT FROM p_generation OR v.status <> 'pending' THEN
    RETURN jsonb_build_object('outcome', 'stale', 'reason',
      CASE WHEN v.status <> 'pending' THEN 'row_' || v.status
           WHEN v.generation IS DISTINCT FROM p_generation THEN 'generation_' || v.generation::text
           ELSE 'lease_' || coalesce(v.lease_owner, 'none') END);
  END IF;
  -- first writer wins: an already-frozen message is returned, never replaced
  IF v.outbound ? p_key THEN
    RETURN jsonb_build_object('outcome', 'existing', 'payload', v.outbound -> p_key);
  END IF;
  IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object'
     OR coalesce(p_payload->>'to', '') = '' OR coalesce(p_payload->>'subject', '') = '' OR coalesce(p_payload->>'html', '') = '' THEN
    RAISE EXCEPTION 'freeze_fulfillment_outbound: payload must carry to, subject and html' USING errcode = 'check_violation';
  END IF;
  v_new := p_payload || jsonb_build_object('frozen_at', to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
  UPDATE booking_fulfillments SET outbound = outbound || jsonb_build_object(p_key, v_new) WHERE booking_id = p_booking_id;
  RETURN jsonb_build_object('outcome', 'frozen', 'payload', v_new);
END $$;
REVOKE ALL ON FUNCTION freeze_fulfillment_outbound(uuid,text,integer,text,jsonb) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION freeze_fulfillment_outbound(uuid,text,integer,text,jsonb) TO service_role;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'booking_fulfillments' AND column_name = 'outbound') THEN
    RAISE EXCEPTION '0083 postcondition: booking_fulfillments.outbound is missing';
  END IF;
  IF to_regprocedure('public.freeze_fulfillment_outbound(uuid,text,integer,text,jsonb)') IS NULL THEN
    RAISE EXCEPTION '0083 postcondition: freeze_fulfillment_outbound missing';
  END IF;
  IF (SELECT count(*) FROM booking_fulfillments WHERE outbound IS NULL) <> 0 THEN
    RAISE EXCEPTION '0083 postcondition: outbound must be non-null on every row';
  END IF;
  -- a caller without a live claim can freeze nothing
  IF (freeze_fulfillment_outbound('00000000-0000-4000-8000-000000000000'::uuid, 'nobody', 1, 'k', '{"to":"x","subject":"y","html":"z"}'::jsonb)->>'outcome') <> 'stale' THEN
    RAISE EXCEPTION '0083 postcondition: a claimless freeze must be a stale no-op';
  END IF;
END $$;
