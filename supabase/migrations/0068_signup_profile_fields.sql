-- 0068_signup_profile_fields.sql — capture the richer info collected on the retailer signup card.
--
-- The retailer signup form asks for the owner's name, phone, business name, and how many stores,
-- but only email + store name were ever persisted (contact name / phone / store count were dropped
-- on the client and had nowhere to land server-side). This adds the missing columns and widens
-- provision_verified_retailer to write them in the same atomic transaction.
--
-- The brand card needs no schema change: brands already has phone + default_categories, and the
-- category is persisted post-verify through the authenticated brand-account profile-update path.
BEGIN;

-- New columns (idempotent). phone = the owner's contact number; expected_locations = the store
-- count they told us at signup, used only to drive the onboarding checklist (never a hard limit).
ALTER TABLE public.retailers ADD COLUMN IF NOT EXISTS phone text;
ALTER TABLE public.retailers ADD COLUMN IF NOT EXISTS expected_locations integer;

-- Widen provision_verified_retailer. The old 2-arg form is dropped first so the 5-arg form is the
-- only overload PostgREST can resolve (avoids the PGRST203 ambiguity 0067 had to untangle).
DROP FUNCTION IF EXISTS public.provision_verified_retailer(text, text);

CREATE OR REPLACE FUNCTION public.provision_verified_retailer(
  p_email text,
  p_store_name text,
  p_phone text DEFAULT NULL,
  p_contact_name text DEFAULT NULL,
  p_store_count integer DEFAULT NULL
)
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
  -- clamp the store count to the same 1..999 range the signup stepper allows
  v_count int := CASE
                   WHEN p_store_count IS NULL THEN NULL
                   WHEN p_store_count < 1   THEN 1
                   WHEN p_store_count > 999 THEN 999
                   ELSE p_store_count
                 END;
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

  INSERT INTO retailers (slug, name, billing_tier, billing_email, phone, expected_locations)
    VALUES (v_slug, coalesce(nullif(btrim(p_store_name), ''), v_slug), 'solo', v_email,
            nullif(btrim(coalesce(p_phone, '')), ''), v_count)
    RETURNING id INTO v_rid;
  INSERT INTO settings (retailer_id, demo_fee, demo_duration, advance_booking_days)
    VALUES (v_rid, 30, 180, 60);
  -- owner membership (canonical source of authority) — now carries the owner's name
  INSERT INTO retailer_admins (retailer_id, email, email_normalized, role, name)
    VALUES (v_rid, v_email, v_email, 'admin', nullif(btrim(coalesce(p_contact_name, '')), ''));
  v_sid := gen_random_uuid();
  INSERT INTO admin_sessions (session_id, retailer_id, email, expires_at)
    VALUES (v_sid, v_rid, v_email, now() + interval '30 days');

  retailer_id := v_rid; slug := v_slug; session_id := v_sid; already := false; RETURN NEXT;
END $$;

REVOKE ALL ON FUNCTION public.provision_verified_retailer(text, text, text, text, integer) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.provision_verified_retailer(text, text, text, text, integer) TO service_role;

COMMIT;
