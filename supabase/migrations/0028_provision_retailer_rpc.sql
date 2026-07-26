-- 0028_provision_retailer_rpc.sql — transactional, idempotent retailer provisioning (P1-3).
-- Creates retailer + settings + OWNER membership + session in ONE transaction. If any step
-- fails the whole thing rolls back — no half-provisioned tenant, no owner-less store.
-- Idempotent: if the email already owns a retailer, returns it instead of creating a duplicate.
CREATE OR REPLACE FUNCTION provision_verified_retailer(p_email text, p_store_name text)
RETURNS TABLE(retailer_id uuid, slug text, session_id uuid, already boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_email text := lower(btrim(p_email));
  v_base  text;
  v_slug  text;
  v_rid   uuid;
  v_sid   uuid;
  v_try   int := 0;
  v_ex_id uuid;
  v_ex_slug text;
BEGIN
  IF v_email IS NULL OR v_email = '' THEN RAISE EXCEPTION 'email required'; END IF;

  -- Idempotency: this email already owns a retailer -> return it (no session minted here)
  SELECT r.id, r.slug INTO v_ex_id, v_ex_slug
  FROM retailers r WHERE lower(btrim(r.billing_email)) = v_email LIMIT 1;
  IF FOUND THEN
    retailer_id := v_ex_id; slug := v_ex_slug; session_id := NULL; already := true; RETURN NEXT; RETURN;
  END IF;

  -- Unique slug
  v_base := regexp_replace(lower(coalesce(nullif(btrim(p_store_name), ''), split_part(v_email, '@', 1))), '[^a-z0-9]+', '-', 'g');
  v_base := trim(both '-' from v_base);
  IF v_base = '' THEN v_base := 'store'; END IF;
  v_slug := v_base;
  WHILE EXISTS (SELECT 1 FROM retailers WHERE retailers.slug = v_slug) AND v_try < 50 LOOP
    v_try := v_try + 1;
    v_slug := v_base || '-' || (floor(random() * 900) + 100)::int;
  END LOOP;

  INSERT INTO retailers (slug, name, billing_tier, billing_email)
    VALUES (v_slug, coalesce(nullif(btrim(p_store_name), ''), v_slug), 'solo', v_email)
    RETURNING id INTO v_rid;
  INSERT INTO settings (retailer_id, demo_fee, demo_duration, advance_booking_days)
    VALUES (v_rid, 30, 180, 60);
  INSERT INTO retailer_admins (retailer_id, email, email_normalized, role)
    VALUES (v_rid, v_email, v_email, 'admin');   -- owner membership (canonical source of authority)
  v_sid := gen_random_uuid();
  INSERT INTO admin_sessions (session_id, retailer_id, email, expires_at)
    VALUES (v_sid, v_rid, v_email, now() + interval '30 days');

  retailer_id := v_rid; slug := v_slug; session_id := v_sid; already := false; RETURN NEXT;
END $$;

REVOKE ALL ON FUNCTION provision_verified_retailer(text, text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION provision_verified_retailer(text, text) TO service_role;
