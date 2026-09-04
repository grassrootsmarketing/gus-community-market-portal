-- 0072_support_access_atomic.sql — Codex FC-02: support-access consent, session mint and audit are
-- not atomic; revoking consent does not revoke the sessions it authorised.
--
-- THE BUG. api/admin-auth.js owner-impersonate did three things in three PostgREST requests:
--   1. read retailers.allow_support_access / support_access_expires_at and judge consent in JS;
--   2. INSERT admin_sessions (the impersonation session);
--   3. INSERT support_sessions (the audit row the retailer sees under "Demohub support activity"),
--      with a compensating DELETE of step 2 if step 3 failed.
-- Three requests are three transactions, so:
--   * the consent read in step 1 is stale by step 2. A retailer who flips the toggle OFF between
--     the read and the insert still gets a support session minted against a consent that no longer
--     exists — and the retailer's dashboard says "OFF. Demohub cannot sign in to your account.";
--   * compensation is best-effort. If the DELETE in step 3's failure path also fails (the same
--     outage that failed the audit insert), a usable session exists with NO audit row, which is the
--     exact state the audit exists to make impossible;
--   * support-access-toggle OFF merely PATCHed the retailer. Sessions already minted under the old
--     consent stayed valid for up to four hours. "OFF" was a promise about the future only.
--
-- THE FIX. Two SECURITY DEFINER functions, service_role only, each ONE transaction:
--
--   support_session_create(p_retailer_id, p_owner_email, p_session_email, p_ip_address, p_user_agent)
--     Locks the retailer row (SELECT ... FOR NO KEY UPDATE), re-reads consent UNDER that lock, and
--     refuses with 'support_access_disabled' (SQLSTATE P0001) when the retailer is missing, the flag
--     is not exactly true, or the expiry is null / not strictly in the future — one message for every
--     refusal, so the caller cannot learn which condition failed. Otherwise it computes
--     expires_at = LEAST(now() + 4 hours, support_access_expires_at), inserts admin_sessions and
--     support_sessions, and returns (session_id, expires_at). plpgsql runs in the caller's single
--     transaction, so a failure of EITHER insert rolls back BOTH. No compensation path exists
--     because none is needed: an admin_sessions row without its support_sessions row cannot be
--     committed. The API never supplies an expiry; the cap and the consent bound live here.
--
--   support_access_set(p_retailer_id, p_enabled)
--     Locks the same retailer row. ON: allow_support_access = true, expires = now() + 24 hours.
--     OFF: allow_support_access = false, expires = NULL, then ENDS every open support session for
--     the retailer (support_sessions.ended_at = now()) and DELETES the admin_sessions rows they
--     point at. The audit UPDATE runs BEFORE the DELETE on purpose: the FK
--     support_sessions.target_session_id -> admin_sessions ON DELETE SET NULL nulls the pointer
--     when the session row goes, so ended_at / owner_email / started_at / writes_count are
--     stamped while the pointer still resolves. Returns the final (allow_support_access,
--     support_access_expires_at, ended_sessions).
--
-- WHY THE ROW LOCK CLOSES THE RACE. Both functions take the retailer row lock FIRST and do
-- everything else behind it, so create-vs-OFF serialize in one of exactly two orders:
--   create commits first -> OFF then sees the committed support_sessions row and revokes it before
--                            OFF itself is visible to anyone;
--   OFF commits first    -> create's SELECT ... FOR NO KEY UPDATE waits on the lock, and under
--                            READ COMMITTED re-reads the row version OFF committed, sees
--                            allow_support_access = false, and raises support_access_disabled.
-- Lock ORDER is identical in both paths (retailers row, then child tables), so they cannot
-- deadlock with each other. FOR NO KEY UPDATE rather than FOR UPDATE: it gives the same mutual
-- exclusion between these two functions and against any UPDATE of the row, but does not conflict
-- with the FOR KEY SHARE that an INSERT into a table referencing retailers(id) takes, so a booking
-- or venue insert for the same retailer is not parked behind a support toggle.
--
-- tests/support_access.test.mjs exercises the route; tests/support_access_race.test.mjs drives the
-- two functions on separate pg connections to prove both orders and a 100-iteration stress run.
BEGIN;

-- ---------------------------------------------------------------------------------------------
-- support_session_create: consent check + admin_sessions + support_sessions in ONE transaction.
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.support_session_create(
  p_retailer_id  uuid,
  p_owner_email  text,
  p_session_email text DEFAULT NULL,
  p_ip_address   text DEFAULT NULL,
  p_user_agent   text DEFAULT NULL
)
RETURNS TABLE(session_id uuid, expires_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_allow   boolean;
  v_consent timestamptz;
  v_expires timestamptz;
  v_sid     uuid;
BEGIN
  -- 1. Lock the retailer row and read consent UNDER the lock. A missing retailer is refused with
  --    the same opaque message as OFF: the API has already answered 404 for a truly unknown id,
  --    and a row that vanished between that check and this lock must not read differently.
  SELECT r.allow_support_access, r.support_access_expires_at
    INTO v_allow, v_consent
    FROM retailers r
   WHERE r.id = p_retailer_id
   FOR NO KEY UPDATE;

  IF NOT FOUND
     OR v_allow IS DISTINCT FROM true
     OR v_consent IS NULL
     OR v_consent <= now() THEN
    RAISE EXCEPTION 'support_access_disabled' USING errcode = 'P0001';
  END IF;

  -- 2. Session life = min(4h cap, remaining consent). Computed here, never supplied by a caller.
  v_expires := LEAST(now() + interval '4 hours', v_consent);

  -- 3. The impersonation session. Column names in an INSERT list are not subject to plpgsql
  --    variable substitution, so `expires_at` here is the column, not the OUT parameter.
  INSERT INTO admin_sessions (email, retailer_id, expires_at)
  VALUES (coalesce(nullif(btrim(p_session_email), ''), p_owner_email), p_retailer_id, v_expires)
  RETURNING admin_sessions.session_id INTO v_sid;

  -- 4. The audit row. owner_email is NOT NULL on support_sessions: a NULL p_owner_email reaches
  --    this INSERT (step 3 accepted it only if p_session_email was given) and fails here, which
  --    rolls back step 3 with it. tests/support_access.test.mjs uses exactly that to prove the
  --    atomicity claim without any fault-injection seam in production code.
  INSERT INTO support_sessions (owner_email, target_retailer_id, target_session_id, started_at, ip_address, user_agent)
  VALUES (p_owner_email, p_retailer_id, v_sid, now(), p_ip_address, left(p_user_agent, 500));

  RETURN QUERY SELECT v_sid, v_expires;
END $$;

REVOKE ALL ON FUNCTION public.support_session_create(uuid, text, text, text, text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.support_session_create(uuid, text, text, text, text) TO service_role;

COMMENT ON FUNCTION public.support_session_create(uuid, text, text, text, text) IS
  'Codex FC-02 (0072). Mints an owner impersonation session for a retailer ONLY under live consent, '
  'checked under a row lock, and writes the support_sessions audit row in the same transaction. '
  'expires_at = LEAST(now() + 4 hours, retailers.support_access_expires_at). Raises support_access_disabled '
  '(P0001) for missing / OFF / expired consent. service_role only.';

-- ---------------------------------------------------------------------------------------------
-- support_access_set: flip consent; OFF ends and revokes every open support session.
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.support_access_set(
  p_retailer_id uuid,
  p_enabled     boolean
)
RETURNS TABLE(allow_support_access boolean, support_access_expires_at timestamptz, ended_sessions integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_id    uuid;
  v_sids  uuid[];
  v_ended integer := 0;
BEGIN
  -- 1. Same lock, same order as support_session_create.
  SELECT r.id INTO v_id FROM retailers r WHERE r.id = p_retailer_id FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'retailer_not_found' USING errcode = 'P0002';
  END IF;

  IF p_enabled IS TRUE THEN
    UPDATE retailers r
       SET allow_support_access = true,
           support_access_expires_at = now() + interval '24 hours'
     WHERE r.id = p_retailer_id;
  ELSE
    UPDATE retailers r
       SET allow_support_access = false,
           support_access_expires_at = NULL
     WHERE r.id = p_retailer_id;

    -- 2. Audit FIRST: stamp ended_at while target_session_id still resolves, and collect the
    --    session ids to revoke. (After the DELETE below, ON DELETE SET NULL clears the pointer.)
    WITH ended AS (
      UPDATE support_sessions s
         SET ended_at = now()
       WHERE s.target_retailer_id = p_retailer_id
         AND s.ended_at IS NULL
      RETURNING s.target_session_id
    )
    SELECT coalesce(array_agg(e.target_session_id) FILTER (WHERE e.target_session_id IS NOT NULL), '{}'::uuid[])
      INTO v_sids
      FROM ended e;

    -- 3. Revoke: the cookie a support user still holds now points at nothing (401 on next use).
    DELETE FROM admin_sessions a
     WHERE a.retailer_id = p_retailer_id
       AND a.session_id = ANY (v_sids);
    GET DIAGNOSTICS v_ended = ROW_COUNT;
  END IF;

  RETURN QUERY
    SELECT r.allow_support_access, r.support_access_expires_at, v_ended
      FROM retailers r
     WHERE r.id = p_retailer_id;
END $$;

REVOKE ALL ON FUNCTION public.support_access_set(uuid, boolean) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.support_access_set(uuid, boolean) TO service_role;

COMMENT ON FUNCTION public.support_access_set(uuid, boolean) IS
  'Codex FC-02 (0072). Sets retailer support-access consent under a row lock. ON = 24h window. '
  'OFF = clears consent, stamps ended_at on every open support_sessions row for the retailer, then deletes '
  'the admin_sessions rows those sessions point at (audit before revoke, because the FK is ON DELETE SET NULL). '
  'service_role only.';

COMMIT;

-- ---------------------------------------------------------------------------------------------
-- Post-condition: both functions exist, are SECURITY DEFINER, and are executable by service_role
-- ONLY. Absence of any of these is a failed migration, not a warning.
-- ---------------------------------------------------------------------------------------------
DO $$
DECLARE
  v_create regprocedure := 'public.support_session_create(uuid, text, text, text, text)'::regprocedure;
  v_set    regprocedure := 'public.support_access_set(uuid, boolean)'::regprocedure;
  v_fn     regprocedure;
  v_role   text;
BEGIN
  FOREACH v_fn IN ARRAY ARRAY[v_create, v_set] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = v_fn AND prosecdef) THEN
      RAISE EXCEPTION 'POST-CONDITION FAILED: % is missing or not SECURITY DEFINER', v_fn;
    END IF;
    IF NOT has_function_privilege('service_role', v_fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'POST-CONDITION FAILED: service_role cannot execute %', v_fn;
    END IF;
    FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      IF has_function_privilege(v_role, v_fn, 'EXECUTE') THEN
        RAISE EXCEPTION 'POST-CONDITION FAILED: % can execute %', v_role, v_fn;
      END IF;
    END LOOP;
  END LOOP;

  -- The create path must compute its own expiry and must lock before it reads.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
     WHERE oid = v_create
       AND prosrc ILIKE '%FOR NO KEY UPDATE%'
       AND prosrc ILIKE '%LEAST(now() + interval ''4 hours''%'
       AND prosrc ILIKE '%support_access_disabled%'
  ) THEN
    RAISE EXCEPTION 'POST-CONDITION FAILED: support_session_create() lacks the row lock, the 4h cap, or the opaque refusal';
  END IF;
END $$;
