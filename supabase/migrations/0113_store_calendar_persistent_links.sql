-- 0113_store_calendar_persistent_links.sql
-- ============================================================================
-- Persistent staff calendar links (David, 2026-10-23, after the first day of the pilot). The reveal-once design
-- (0111: the server kept only a hash, so a link could be shown to the admin exactly once) was rejected by the
-- product owner: the links are shared only by store admins with their own floor staff, and an admin must be able
-- to open Settings at any time and copy the current link, the way the booking link and the calendar feed work.
--
-- This migration keeps the hash as the lookup key (resolve is unchanged: the visitor's token is hashed and looked
-- up; the table is still never consulted by plaintext) and adds ONE column, token_enc, that carries the token
-- sealed by the application (AES-256-GCM under a key derived on the server from its own secret; see
-- api/_store-calendar.js sealToken/openToken). The database never holds the plaintext: a copy of this table still
-- reveals no usable link without the server's secret. Only service_role can read the column (0111 revoked every
-- other role from the table).
--
-- issue gains the sealed value as a parameter so a link is recorded with its recovery in the same statement (no
-- window in which a link exists that the admin can never see). The four-argument form is removed so there is one
-- issue function, not two overloads for PostgREST to choose between.
--
-- Also here: retailers created without a calendar feed key (the pilot store among them, found 2026-10-23: every
-- feed link its Settings page ever showed was missing the key and answered 401) get one, the way 0007 gave every
-- retailer of its day one. Existing keys are untouched.
-- Forward-only. Idempotent.
-- ============================================================================

ALTER TABLE public.store_calendar_links ADD COLUMN IF NOT EXISTS token_enc text;
COMMENT ON COLUMN public.store_calendar_links.token_enc IS 'The link token sealed by the application (AES-256-GCM, server-derived key); never plaintext. service_role only.';

DROP FUNCTION IF EXISTS public.store_calendar_link_issue(uuid, uuid, text, text);

CREATE OR REPLACE FUNCTION public.store_calendar_link_issue(p_retailer_id uuid, p_venue_id uuid, p_token_hash text, p_token_enc text, p_email text)
RETURNS public.store_calendar_links LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_row public.store_calendar_links; v_scope uuid;
BEGIN
  IF p_retailer_id IS NULL THEN RAISE EXCEPTION 'retailer_required'; END IF;
  IF p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'token_hash_shape'; END IF;
  IF p_token_enc IS NULL OR p_token_enc !~ '^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$' THEN RAISE EXCEPTION 'token_enc_shape'; END IF;
  IF p_venue_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.venues WHERE id = p_venue_id AND retailer_id = p_retailer_id) THEN
    RAISE EXCEPTION 'venue_not_in_retailer';
  END IF;
  v_scope := coalesce(p_venue_id, '00000000-0000-0000-0000-000000000000'::uuid);
  -- one scope at a time, for the rest of this transaction (SC-4)
  PERFORM pg_advisory_xact_lock(hashtext('store_calendar_link:' || p_retailer_id::text || ':' || v_scope::text));
  UPDATE public.store_calendar_links SET revoked_at = now(), revoked_by_email = p_email
   WHERE retailer_id = p_retailer_id AND revoked_at IS NULL
     AND coalesce(venue_id, '00000000-0000-0000-0000-000000000000'::uuid) = v_scope;
  INSERT INTO public.store_calendar_links (retailer_id, venue_id, token_hash, token_enc, issued_by_email)
  VALUES (p_retailer_id, p_venue_id, p_token_hash, p_token_enc, p_email) RETURNING * INTO v_row;
  RETURN v_row;
END $$;
REVOKE ALL ON FUNCTION public.store_calendar_link_issue(uuid, uuid, text, text, text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.store_calendar_link_issue(uuid, uuid, text, text, text) TO service_role;

-- A calendar feed key for every retailer that has none (0007's rule, applied to the rows created since without one).
UPDATE public.retailers SET cal_feed_key = replace(gen_random_uuid()::text, '-', '')
 WHERE cal_feed_key IS NULL OR cal_feed_key = '';

-- Post-conditions (literal-only).
DO $$
DECLARE v_src text; n int;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'store_calendar_links' AND column_name = 'token_enc') THEN
    RAISE EXCEPTION '0113 postcondition: token_enc is absent';
  END IF;
  SELECT count(*) INTO n FROM pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace WHERE s.nspname = 'public' AND p.proname = 'store_calendar_link_issue';
  IF n <> 1 THEN RAISE EXCEPTION '0113 postcondition: expected exactly one issue function, found %', n; END IF;
  SELECT prosrc INTO v_src FROM pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace WHERE s.nspname = 'public' AND p.proname = 'store_calendar_link_issue';
  IF position('token_enc' IN v_src) = 0 OR position('pg_advisory_xact_lock' IN v_src) = 0 THEN RAISE EXCEPTION '0113 postcondition: issue does not record token_enc under the scope lock'; END IF;
  IF has_function_privilege('anon', 'public.store_calendar_link_issue(uuid, uuid, text, text, text)', 'EXECUTE') THEN RAISE EXCEPTION '0113 postcondition: anon can execute issue'; END IF;
  IF has_table_privilege('anon', 'public.store_calendar_links', 'SELECT') THEN RAISE EXCEPTION '0113 postcondition: anon can read the links table'; END IF;
  IF EXISTS (SELECT 1 FROM public.retailers WHERE cal_feed_key IS NULL OR cal_feed_key = '') THEN RAISE EXCEPTION '0113 postcondition: a retailer still has no calendar feed key'; END IF;
END $$;
