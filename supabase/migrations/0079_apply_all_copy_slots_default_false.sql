-- 0079_apply_all_copy_slots_default_false.sql
-- Codex "Release B — third closure review" (2026-09-11), packet correction: the 0077 apply-all RPC
-- enforces the CALLER-SUPPLIED p_copy_slots mode; it does not read the Vercel kill switch. The
-- shipped API passes the mode explicitly (api/admin.js: FLAGS.slotEditing === true). A future
-- privileged caller that omitted the argument would have copied slot lists by default. This
-- migration re-issues the function (same signature, 0077 body) with p_copy_slots DEFAULT false, so
-- omitting the mode is the fail-closed hours + capacity copy and slot copying must be asked for.
-- Forward-only; 0077 untouched. Changing a default requires DROP + CREATE.

DROP FUNCTION IF EXISTS public.venue_availability_apply_all(uuid, uuid, integer, jsonb, jsonb, boolean, integer, boolean);
CREATE OR REPLACE FUNCTION public.venue_availability_apply_all(
  p_retailer_id uuid, p_source_venue_id uuid, p_expected_version integer,
  p_schedule jsonb DEFAULT NULL, p_slots jsonb DEFAULT NULL, p_reset_slots boolean DEFAULT false, p_max_demos_per_slot integer DEFAULT NULL,
  p_copy_slots boolean DEFAULT false)
RETURNS TABLE(ok boolean, reason text, detail jsonb, venue_id uuid, venue_name text, availability jsonb, availability_version integer, max_demos_per_slot integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_locked venues[]; src venues%ROWTYPE; v venues%ROWTYPE; v_av jsonb; v_src_av jsonb;
  v_msg text; v_detail text; v_reason text; v_rows jsonb := '[]'::jsonb; i integer;
BEGIN
  IF p_retailer_id IS NULL OR p_source_venue_id IS NULL THEN
    RETURN QUERY SELECT false, 'not_found'::text, NULL::jsonb, NULL::uuid, NULL::text, NULL::jsonb, NULL::integer, NULL::integer; RETURN;
  END IF;
  IF NOT p_copy_slots AND (p_slots IS NOT NULL OR p_reset_slots) THEN
    RAISE EXCEPTION 'slot_editing_disabled: slot lists cannot change in hours-only mode' USING errcode = 'check_violation';
  END IF;
  v_locked := '{}';
  FOR v IN SELECT * FROM venues WHERE retailer_id = p_retailer_id ORDER BY id FOR UPDATE LOOP v_locked := v_locked || v; END LOOP;
  IF cardinality(v_locked) = 0 THEN
    RETURN QUERY SELECT false, 'not_found'::text, NULL::jsonb, NULL::uuid, NULL::text, NULL::jsonb, NULL::integer, NULL::integer; RETURN;
  END IF;
  src := NULL;
  FOR i IN 1..cardinality(v_locked) LOOP IF v_locked[i].id = p_source_venue_id THEN src := v_locked[i]; END IF; END LOOP;
  IF src.id IS NULL THEN
    RETURN QUERY SELECT false, 'not_found'::text, NULL::jsonb, NULL::uuid, NULL::text, NULL::jsonb, NULL::integer, NULL::integer; RETURN;
  END IF;
  IF p_expected_version IS NULL OR p_expected_version <> src.availability_version THEN
    RETURN QUERY SELECT false, 'stale_version'::text, jsonb_build_object('current_version', src.availability_version), src.id, src.name, src.availability, src.availability_version, src.max_demos_per_slot; RETURN;
  END IF;
  IF p_max_demos_per_slot IS NOT NULL AND p_max_demos_per_slot < 1 THEN
    RETURN QUERY SELECT false, 'invalid_capacity'::text, NULL::jsonb, src.id, src.name, src.availability, src.availability_version, src.max_demos_per_slot; RETURN;
  END IF;

  v_src_av := CASE WHEN src.availability IS NULL OR jsonb_typeof(src.availability) <> 'object' THEN '{}'::jsonb ELSE src.availability END;
  IF p_schedule IS NOT NULL THEN v_src_av := jsonb_set(v_src_av, '{schedule}', p_schedule, true); END IF;
  IF p_reset_slots THEN v_src_av := v_src_av - 'slots';
  ELSIF p_slots IS NOT NULL THEN v_src_av := jsonb_set(v_src_av, '{slots}', p_slots, true); END IF;
  IF NOT (v_src_av ? 'blackouts') THEN v_src_av := jsonb_set(v_src_av, '{blackouts}', '[]'::jsonb, true); END IF;
  BEGIN
    FOR i IN 1..cardinality(v_locked) LOOP
      v := v_locked[i];
      IF v.id = src.id THEN
        v_av := v_src_av;
      ELSE
        v_av := CASE WHEN v.availability IS NULL OR jsonb_typeof(v.availability) <> 'object' THEN '{}'::jsonb ELSE v.availability END;
        IF v_src_av ? 'schedule' THEN v_av := jsonb_set(v_av, '{schedule}', v_src_av->'schedule', true); ELSE v_av := v_av - 'schedule'; END IF;
        IF p_copy_slots THEN
          IF v_src_av ? 'slots' THEN v_av := jsonb_set(v_av, '{slots}', v_src_av->'slots', true); ELSE v_av := v_av - 'slots'; END IF;
        END IF;
        IF NOT (v_av ? 'blackouts') THEN v_av := jsonb_set(v_av, '{blackouts}', '[]'::jsonb, true); END IF;
      END IF;
      BEGIN
        UPDATE venues
           SET availability = v_av,
               availability_version = venues.availability_version + 1,
               max_demos_per_slot = coalesce(p_max_demos_per_slot, src.max_demos_per_slot)
         WHERE id = v.id
        RETURNING * INTO v;
      EXCEPTION WHEN check_violation THEN
        GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT, v_detail = PG_EXCEPTION_DETAIL;
        v_reason := split_part(v_msg, ':', 1);
        IF v_reason NOT IN ('slot_in_use', 'availability_invalid', 'slot_config_invalid', 'capacity_below_active_reservations') THEN RAISE; END IF;
        RAISE EXCEPTION 'apply_all_refused' USING errcode = 'check_violation',
          detail = jsonb_build_object('reason', v_reason, 'venue_id', v.id, 'venue_name', v.name, 'message', v_msg,
                                      'affected', CASE WHEN coalesce(v_detail,'') <> '' THEN v_detail::jsonb ELSE NULL END)::text;
      END;
      v_rows := v_rows || jsonb_build_array(jsonb_build_object('venue_id', v.id, 'venue_name', v.name, 'availability', v.availability,
                                                               'availability_version', v.availability_version, 'max_demos_per_slot', v.max_demos_per_slot));
    END LOOP;
  EXCEPTION WHEN check_violation THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT, v_detail = PG_EXCEPTION_DETAIL;
    IF v_msg <> 'apply_all_refused' THEN RAISE; END IF;
    RETURN QUERY SELECT false, (v_detail::jsonb)->>'reason', v_detail::jsonb,
                        ((v_detail::jsonb)->>'venue_id')::uuid, (v_detail::jsonb)->>'venue_name', NULL::jsonb, NULL::integer, NULL::integer;
    RETURN;
  END;
  RETURN QUERY SELECT true, NULL::text, NULL::jsonb, (e->>'venue_id')::uuid, e->>'venue_name', e->'availability',
                      (e->>'availability_version')::integer, (e->>'max_demos_per_slot')::integer
    FROM jsonb_array_elements(v_rows) e;
  RETURN;
END $$;
REVOKE ALL ON FUNCTION public.venue_availability_apply_all(uuid, uuid, integer, jsonb, jsonb, boolean, integer, boolean) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.venue_availability_apply_all(uuid, uuid, integer, jsonb, jsonb, boolean, integer, boolean) TO service_role;

DO $$
DECLARE v_args text;
BEGIN
  v_args := pg_get_function_arguments('public.venue_availability_apply_all(uuid,uuid,integer,jsonb,jsonb,boolean,integer,boolean)'::regprocedure);
  IF position('p_copy_slots boolean DEFAULT false' IN v_args) = 0 THEN
    RAISE EXCEPTION '0079 postcondition: p_copy_slots must default to false (got: %)', v_args;
  END IF;
  IF to_regprocedure('public.venue_availability_apply_all(uuid,uuid,integer,jsonb,jsonb,boolean,integer)') IS NOT NULL THEN
    RAISE EXCEPTION '0079 postcondition: the 7-argument apply-all must not exist';
  END IF;
END $$;
