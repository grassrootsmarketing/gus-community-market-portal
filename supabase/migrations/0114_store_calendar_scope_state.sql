-- 0114_store_calendar_scope_state.sql
-- ============================================================================
-- Staff calendar links, Codex review of 2026-10-25 (items 1 and 3): listing must never rotate, and stopping must stay
-- stopped.
--
-- 1. store_calendar_link_ensure: a get-or-create for one scope under the SAME advisory lock issue and revoke take.
--    Returns the scope's active row unchanged when there is one ('existing'), inserts the caller's hash and seal only
--    when the scope genuinely has none ('created'), and refuses to create anything while the scope is disabled
--    ('disabled'). Two Settings loads that both find a scope empty therefore end with ONE active row, and the loser
--    receives the winner's row (and opens the winner's seal), never a token the database did not keep. Only
--    store_calendar_link_issue (Rotate) replaces an active token, deliberately, and it now refuses a disabled scope.
-- 2. store_calendar_scope_state: one row per (retailer, scope) that is or was deliberately stopped. revoke (Stop
--    sharing) now marks the scope disabled in the same transaction, so an ordinary list afterwards issues nothing;
--    store_calendar_scope_enable (Resume) clears it, after which a list or an issue creates one new link. All three
--    paths take the scope lock, so a stop that wins a race with an ensure leaves the scope disabled.
-- Forward-only. Idempotent. Existing rows, hashes, seals and links are untouched; nothing is rotated by this file.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.store_calendar_scope_state (
  retailer_id       uuid NOT NULL REFERENCES public.retailers(id) ON DELETE CASCADE,
  scope_key         uuid NOT NULL,          -- the venue id, or 00000000-0000-0000-0000-000000000000 for the whole store
  disabled_at       timestamptz,            -- NULL = sharing allowed (the default for a scope with no row)
  disabled_by_email text,
  enabled_at        timestamptz,
  enabled_by_email  text,
  PRIMARY KEY (retailer_id, scope_key)
);
ALTER TABLE public.store_calendar_scope_state ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.store_calendar_scope_state FROM public, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.store_calendar_scope_state TO service_role;

-- Get-or-create under the scope lock. Never revokes anything.
CREATE OR REPLACE FUNCTION public.store_calendar_link_ensure(p_retailer_id uuid, p_venue_id uuid, p_token_hash text, p_token_enc text, p_email text)
RETURNS TABLE (outcome text, id uuid, retailer_id uuid, venue_id uuid, token_hash text, token_enc text, issued_at timestamptz, issued_by_email text, last_used_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_scope uuid; v_row public.store_calendar_links;
BEGIN
  IF p_retailer_id IS NULL THEN RAISE EXCEPTION 'retailer_required'; END IF;
  IF p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'token_hash_shape'; END IF;
  IF p_token_enc IS NULL OR p_token_enc !~ '^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$' THEN RAISE EXCEPTION 'token_enc_shape'; END IF;
  IF p_venue_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.venues v WHERE v.id = p_venue_id AND v.retailer_id = p_retailer_id) THEN
    RAISE EXCEPTION 'venue_not_in_retailer';
  END IF;
  v_scope := coalesce(p_venue_id, '00000000-0000-0000-0000-000000000000'::uuid);
  PERFORM pg_advisory_xact_lock(hashtext('store_calendar_link:' || p_retailer_id::text || ':' || v_scope::text));
  IF EXISTS (SELECT 1 FROM public.store_calendar_scope_state s WHERE s.retailer_id = p_retailer_id AND s.scope_key = v_scope AND s.disabled_at IS NOT NULL) THEN
    RETURN QUERY SELECT 'disabled'::text, NULL::uuid, p_retailer_id, p_venue_id, NULL::text, NULL::text, NULL::timestamptz, NULL::text, NULL::timestamptz;
    RETURN;
  END IF;
  SELECT l.* INTO v_row FROM public.store_calendar_links l
   WHERE l.retailer_id = p_retailer_id AND l.revoked_at IS NULL
     AND coalesce(l.venue_id, '00000000-0000-0000-0000-000000000000'::uuid) = v_scope
   LIMIT 1;
  IF FOUND THEN
    RETURN QUERY SELECT 'existing'::text, v_row.id, v_row.retailer_id, v_row.venue_id, v_row.token_hash, v_row.token_enc, v_row.issued_at, v_row.issued_by_email, v_row.last_used_at;
    RETURN;
  END IF;
  INSERT INTO public.store_calendar_links (retailer_id, venue_id, token_hash, token_enc, issued_by_email)
  VALUES (p_retailer_id, p_venue_id, p_token_hash, p_token_enc, p_email) RETURNING * INTO v_row;
  RETURN QUERY SELECT 'created'::text, v_row.id, v_row.retailer_id, v_row.venue_id, v_row.token_hash, v_row.token_enc, v_row.issued_at, v_row.issued_by_email, v_row.last_used_at;
END $$;

-- Rotate: unchanged except that a disabled scope is refused (Resume first).
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
  PERFORM pg_advisory_xact_lock(hashtext('store_calendar_link:' || p_retailer_id::text || ':' || v_scope::text));
  IF EXISTS (SELECT 1 FROM public.store_calendar_scope_state s WHERE s.retailer_id = p_retailer_id AND s.scope_key = v_scope AND s.disabled_at IS NOT NULL) THEN
    RAISE EXCEPTION 'scope_disabled';
  END IF;
  UPDATE public.store_calendar_links SET revoked_at = now(), revoked_by_email = p_email
   WHERE retailer_id = p_retailer_id AND revoked_at IS NULL
     AND coalesce(venue_id, '00000000-0000-0000-0000-000000000000'::uuid) = v_scope;
  INSERT INTO public.store_calendar_links (retailer_id, venue_id, token_hash, token_enc, issued_by_email)
  VALUES (p_retailer_id, p_venue_id, p_token_hash, p_token_enc, p_email) RETURNING * INTO v_row;
  RETURN v_row;
END $$;

-- Stop sharing: retire the active link AND mark the scope disabled, one transaction, one lock.
CREATE OR REPLACE FUNCTION public.store_calendar_link_revoke(p_retailer_id uuid, p_venue_id uuid, p_email text)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE n int; v_scope uuid;
BEGIN
  IF p_retailer_id IS NULL THEN RAISE EXCEPTION 'retailer_required'; END IF;
  v_scope := coalesce(p_venue_id, '00000000-0000-0000-0000-000000000000'::uuid);
  PERFORM pg_advisory_xact_lock(hashtext('store_calendar_link:' || p_retailer_id::text || ':' || v_scope::text));
  UPDATE public.store_calendar_links SET revoked_at = now(), revoked_by_email = p_email
   WHERE retailer_id = p_retailer_id AND revoked_at IS NULL
     AND coalesce(venue_id, '00000000-0000-0000-0000-000000000000'::uuid) = v_scope;
  GET DIAGNOSTICS n = ROW_COUNT;
  INSERT INTO public.store_calendar_scope_state (retailer_id, scope_key, disabled_at, disabled_by_email)
  VALUES (p_retailer_id, v_scope, now(), p_email)
  ON CONFLICT (retailer_id, scope_key) DO UPDATE SET disabled_at = now(), disabled_by_email = EXCLUDED.disabled_by_email;
  RETURN n;
END $$;

-- Resume: clear the disabled state under the lock. Creates nothing; the next list or Rotate makes the new link.
CREATE OR REPLACE FUNCTION public.store_calendar_scope_enable(p_retailer_id uuid, p_venue_id uuid, p_email text)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_scope uuid; n int;
BEGIN
  IF p_retailer_id IS NULL THEN RAISE EXCEPTION 'retailer_required'; END IF;
  v_scope := coalesce(p_venue_id, '00000000-0000-0000-0000-000000000000'::uuid);
  PERFORM pg_advisory_xact_lock(hashtext('store_calendar_link:' || p_retailer_id::text || ':' || v_scope::text));
  UPDATE public.store_calendar_scope_state SET disabled_at = NULL, enabled_at = now(), enabled_by_email = p_email
   WHERE retailer_id = p_retailer_id AND scope_key = v_scope AND disabled_at IS NOT NULL;
  GET DIAGNOSTICS n = ROW_COUNT; RETURN n;
END $$;

REVOKE ALL ON FUNCTION public.store_calendar_link_ensure(uuid, uuid, text, text, text) FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION public.store_calendar_link_issue(uuid, uuid, text, text, text)  FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION public.store_calendar_link_revoke(uuid, uuid, text)             FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION public.store_calendar_scope_enable(uuid, uuid, text)            FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.store_calendar_link_ensure(uuid, uuid, text, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.store_calendar_link_issue(uuid, uuid, text, text, text)  TO service_role;
GRANT EXECUTE ON FUNCTION public.store_calendar_link_revoke(uuid, uuid, text)             TO service_role;
GRANT EXECUTE ON FUNCTION public.store_calendar_scope_enable(uuid, uuid, text)            TO service_role;

-- Post-conditions (literal-only).
DO $$
DECLARE v_src text; n int;
BEGIN
  IF to_regclass('public.store_calendar_scope_state') IS NULL THEN RAISE EXCEPTION '0114 postcondition: store_calendar_scope_state is absent'; END IF;
  SELECT count(*) INTO n FROM pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace WHERE s.nspname = 'public' AND p.proname IN ('store_calendar_link_ensure', 'store_calendar_link_issue', 'store_calendar_link_revoke', 'store_calendar_scope_enable', 'store_calendar_link_resolve', 'store_calendar_rate_hit');
  IF n <> 6 THEN RAISE EXCEPTION '0114 postcondition: expected the six functions, found %', n; END IF;
  SELECT prosrc INTO v_src FROM pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace WHERE s.nspname = 'public' AND p.proname = 'store_calendar_link_ensure';
  IF position('UPDATE public.store_calendar_links' IN v_src) > 0 OR position('pg_advisory_xact_lock' IN v_src) = 0 THEN RAISE EXCEPTION '0114 postcondition: ensure must take the lock and never revoke'; END IF;
  SELECT prosrc INTO v_src FROM pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace WHERE s.nspname = 'public' AND p.proname = 'store_calendar_link_revoke';
  IF position('store_calendar_scope_state' IN v_src) = 0 THEN RAISE EXCEPTION '0114 postcondition: revoke does not disable the scope'; END IF;
  SELECT prosrc INTO v_src FROM pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace WHERE s.nspname = 'public' AND p.proname = 'store_calendar_link_issue';
  IF position('scope_disabled' IN v_src) = 0 THEN RAISE EXCEPTION '0114 postcondition: issue does not refuse a disabled scope'; END IF;
  IF has_function_privilege('anon', 'public.store_calendar_link_ensure(uuid, uuid, text, text, text)', 'EXECUTE') THEN RAISE EXCEPTION '0114 postcondition: anon can execute ensure'; END IF;
  IF has_table_privilege('anon', 'public.store_calendar_scope_state', 'SELECT') THEN RAISE EXCEPTION '0114 postcondition: anon can read the scope state'; END IF;
END $$;
