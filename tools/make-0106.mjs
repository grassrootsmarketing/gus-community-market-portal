// tools/make-0106.mjs (2026-10-19, Codex refund-cutoff rev2 review R2-2 and R2-3): writes
// supabase/migrations/0106_cancellation_decision_binding.sql from the current bodies it re-declares, so the copied
// functions are byte-for-byte the live ones plus the stated one-line changes.
//   * bookings.cancellation_pending_at: the barrier. Set by booking_cancellation_record (under the booking lock);
//     cleared by booking_transition when the cancellation lands. While set, confirm / materialize / promote and
//     every schedule change (store move, proposal, acceptance) are refused with 'cancellation_pending'.
//   * booking_cancellation_record(uuid, uuid, jsonb, jsonb): the decision is recorded only if the inputs it was
//     computed from are still the authoritative row (schedule revision, date, time, payment state, fee waiver) and the
//     store's policy (mode, zone) is unchanged; otherwise 'stale' with the current values and nothing written.
//   * booking_cancellation_resolutions + booking_cancellation_resolve(): the operator's later answer to a cancellation
//     whose refund was undecided (granted / no refund), recorded once, replayed on retry; the initial decision stays.
//   * explicit service_role EXECUTE grants on every function this touches (the review found 0105 relied on defaults).
import { readFileSync, writeFileSync } from 'node:fs';
const ROOT = 'C:/Users/David/demohub-refund-72h/';
const kit = readFileSync('C:/Users/David/demohub-refund-72h/tools/sources/0095_move_functions_as_shipped.sql', 'utf8').split('\n');
const slice = (from, to) => kit.slice(from - 1, to).join('\n');   // 1-based inclusive line numbers of the verbatim 0095 bodies
const moveFn = slice(2, 131), proposeFn = slice(133, 180), acceptFn = slice(182, 277);
for (const [name, body, head] of [['move_booking_by_retailer', moveFn, 'CREATE OR REPLACE FUNCTION public.move_booking_by_retailer('], ['propose_reschedule', proposeFn, 'CREATE OR REPLACE FUNCTION public.propose_reschedule('], ['accept_reschedule', acceptFn, 'CREATE OR REPLACE FUNCTION public.accept_reschedule(']]) {
  if (!body.startsWith(head) || !body.trimEnd().endsWith('END $$;')) throw new Error(name + ': unexpected slice');
}
const barrier = (s, label) => { const a = 'IF v_b.pending_move_settlement IS NOT NULL THEN'; const n = s.split(a).length - 1; if (n !== 1) throw new Error(label + ': guard count ' + n); return s.replace(a, "IF v_b.pending_move_settlement IS NOT NULL OR v_b.cancellation_pending_at IS NOT NULL THEN   -- 0106: a recorded cancellation is a barrier too"); };
const moveFn2 = barrier(moveFn, 'move'), proposeFn2 = barrier(proposeFn, 'propose'), acceptFn2 = barrier(acceptFn, 'accept');

let bt = readFileSync('C:/Users/David/demohub-refund-72h/tools/sources/booking_transition_0078.sql', 'utf8');
bt = bt.replace(/\u2014/g, ",");   // the live 0078 text has two em dashes in comments; they become commas (David: no em dashes), the code is untouched
if (!bt.startsWith("CREATE OR REPLACE FUNCTION public.booking_transition(") || !bt.trimEnd().endsWith('END $$;')) throw new Error('booking_transition slice');
const a1 = "  v_cur := coalesce(v_b.status, 'pending');\n";
if (bt.split(a1).length !== 2) throw new Error('bt anchor 1');
bt = bt.replace(a1, a1 + `
  -- 0106 (Codex refund-cutoff R2-3): a recorded cancellation decision is a barrier until the cancellation lands.
  -- No confirmation, capture promotion or projection step may run on top of it; only the cancel itself.
  IF v_b.cancellation_pending_at IS NOT NULL AND p_action <> 'cancel' THEN
    RETURN QUERY SELECT false, 'cancellation_pending'::text, v_cur, v_cur, NULL::uuid, false, false, 0; RETURN;
  END IF;
`);
const a2 = "      paid_at           = CASE WHEN p_fields ? 'paid_at'           THEN (p_fields->>'paid_at')::timestamptz       ELSE paid_at END\n";
if (bt.split(a2).length !== 2) throw new Error('bt anchor 2');
bt = bt.replace(a2, a2.trimEnd() + ",\n      cancellation_pending_at = CASE WHEN p_action = 'cancel' THEN NULL ELSE cancellation_pending_at END   -- 0106: the barrier lifts with the cancellation\n");

const sql = `-- 0106_cancellation_decision_binding.sql (2026-10-19, Codex refund-cutoff revision 2 review, R2-2 and R2-3)
-- 0104 and 0105 are applied to the test project and are left byte-for-byte; every correction is forward, here.
--
-- R2-3  The recorded cancellation decision is bound to the authoritative row and becomes a barrier:
--   * booking_cancellation_record(booking, retailer, decision, expect) records only if, under the booking's lock, the
--     row still shows the schedule revision, date, time, payment status, fee waiver and the store's mode and zone the
--     decision was computed from; otherwise it answers 'stale' with the current values and writes nothing. The route
--     recomputes once from the current row and records again. A retry replays the saved decision ('existing').
--   * bookings.cancellation_pending_at is set in that same statement. While set, booking_transition refuses every
--     action but 'cancel' ('cancellation_pending'), and the three schedule changes (move_booking_by_retailer,
--     propose_reschedule, accept_reschedule) refuse the same way, next to the existing move-settlement barrier.
--     booking_transition('cancel') clears it. No database transaction is held across any Stripe call.
-- R2-2  A cancelled paid booking whose refund was left undecided gets an operator resolution, recorded once:
--   * booking_cancellation_resolutions (one per booking): refund_granted | no_refund, who, why, when, the refund
--     request and the review case it closed. booking_cancellation_resolve() inserts once and replays on retry; the
--     initial decision row in booking_cancellations is never changed.
-- Grants: every function here is EXECUTE for service_role explicitly; public, anon and authenticated are denied.
-- Forward-only. Idempotent. No row rewrites. No begin/commit here: the production paste wraps it.

ALTER TABLE public.bookings ADD COLUMN IF NOT EXISTS cancellation_pending_at timestamptz;
CREATE INDEX IF NOT EXISTS bookings_cancellation_pending ON public.bookings (cancellation_pending_at) WHERE cancellation_pending_at IS NOT NULL;
COMMENT ON COLUMN public.bookings.cancellation_pending_at IS '0106: a cancellation decision is recorded and the cancellation is landing; no confirmation, capture promotion or schedule change may run until booking_transition(cancel) clears it.';

CREATE TABLE IF NOT EXISTS public.booking_cancellation_resolutions (
  booking_id          uuid PRIMARY KEY REFERENCES public.bookings(id) ON DELETE CASCADE,
  retailer_id         uuid NOT NULL REFERENCES public.retailers(id) ON DELETE CASCADE,
  decision            text NOT NULL CHECK (decision IN ('refund_granted', 'no_refund')),
  operator            text,
  reason              text NOT NULL,
  refund_request_id   uuid,
  case_id             uuid,
  resolved_at         timestamptz NOT NULL DEFAULT now(),
  created_at          timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON TABLE public.booking_cancellation_resolutions FROM public, anon, authenticated;
GRANT ALL ON TABLE public.booking_cancellation_resolutions TO service_role;

-- ---------------------------------------------------------------------------------------------
-- booking_cancellation_record, bound to the authoritative row (replaces the 0105 three-argument form).
-- p_expect: {schedule_revision, demo_date, demo_time, payment_status, fee_waived, cancellation_mode, timezone}.
-- ---------------------------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.booking_cancellation_record(uuid, uuid, jsonb);
CREATE OR REPLACE FUNCTION public.booking_cancellation_record(p_booking_id uuid, p_retailer_id uuid, p_decision jsonb, p_expect jsonb DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_bk public.bookings%ROWTYPE; v_rt record; v_row public.booking_cancellations%ROWTYPE; v_now timestamptz; v_current jsonb;
BEGIN
  SELECT * INTO v_bk FROM public.bookings WHERE id = p_booking_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('outcome', 'no_booking'); END IF;
  IF v_bk.retailer_id IS DISTINCT FROM p_retailer_id THEN RETURN jsonb_build_object('outcome', 'forbidden'); END IF;
  v_now := clock_timestamp();
  SELECT * INTO v_row FROM public.booking_cancellations WHERE booking_id = p_booking_id;
  IF FOUND THEN
    -- a retry continues the recorded operation; the barrier is (re)asserted while the booking is still active
    IF v_bk.status IN ('pending', 'confirmed', 'held') AND v_bk.cancellation_pending_at IS NULL THEN
      UPDATE public.bookings SET cancellation_pending_at = v_now WHERE id = p_booking_id;
    END IF;
    RETURN jsonb_build_object('outcome', 'existing', 'existing', true, 'decision', to_jsonb(v_row));
  END IF;
  IF v_bk.status NOT IN ('pending', 'confirmed', 'held') THEN
    RETURN jsonb_build_object('outcome', 'state_conflict', 'status', v_bk.status);
  END IF;
  SELECT cancellation_mode, timezone INTO v_rt FROM public.retailers WHERE id = p_retailer_id;
  v_current := jsonb_build_object(
    'schedule_revision', v_bk.schedule_revision, 'demo_date', v_bk.demo_date, 'demo_time', v_bk.demo_time,
    'payment_status', v_bk.payment_status, 'fee_waived', coalesce(v_bk.fee_waived, false),
    'cancellation_mode', v_rt.cancellation_mode, 'timezone', v_rt.timezone, 'status', v_bk.status);
  -- the decision was computed from these inputs; if the row moved on, it is not recorded
  IF p_expect IS NOT NULL THEN
    IF (p_expect ? 'schedule_revision' AND (p_expect->>'schedule_revision')::integer IS DISTINCT FROM v_bk.schedule_revision)
       OR (p_expect ? 'demo_date' AND (p_expect->>'demo_date')::date IS DISTINCT FROM v_bk.demo_date)
       OR (p_expect ? 'demo_time' AND (p_expect->>'demo_time') IS DISTINCT FROM v_bk.demo_time)
       OR (p_expect ? 'payment_status' AND (p_expect->>'payment_status') IS DISTINCT FROM v_bk.payment_status)
       OR (p_expect ? 'fee_waived' AND (p_expect->>'fee_waived')::boolean IS DISTINCT FROM coalesce(v_bk.fee_waived, false))
       OR (p_expect ? 'cancellation_mode' AND (p_expect->>'cancellation_mode') IS DISTINCT FROM v_rt.cancellation_mode)
       OR (p_expect ? 'timezone' AND (p_expect->>'timezone') IS DISTINCT FROM v_rt.timezone) THEN
      RETURN jsonb_build_object('outcome', 'stale', 'current', v_current);
    END IF;
  END IF;
  INSERT INTO public.booking_cancellations (booking_id, retailer_id, category, requested_at, actor, cancellation_mode, cutoff_hours,
      start_at, start_source, hours_before_demo, refund, status, reason, force_refund, override_reason, backdate_note, note)
  VALUES (p_booking_id, p_retailer_id, p_decision->>'category', (p_decision->>'requested_at')::timestamptz, p_decision->>'actor',
      p_decision->>'cancellation_mode', (p_decision->>'cutoff_hours')::integer,
      NULLIF(p_decision->>'start_at', '')::timestamptz, p_decision->>'start_source', NULLIF(p_decision->>'hours_before_demo', '')::numeric,
      (p_decision->>'refund')::boolean, p_decision->>'status', p_decision->>'reason', coalesce((p_decision->>'force_refund')::boolean, false),
      p_decision->>'override_reason', p_decision->>'backdate_note', p_decision->>'note')
  RETURNING * INTO v_row;
  UPDATE public.bookings SET cancellation_pending_at = v_now WHERE id = p_booking_id;
  RETURN jsonb_build_object('outcome', 'recorded', 'existing', false, 'decision', to_jsonb(v_row), 'current', v_current);
END $$;
REVOKE ALL ON FUNCTION public.booking_cancellation_record(uuid, uuid, jsonb, jsonb) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.booking_cancellation_record(uuid, uuid, jsonb, jsonb) TO service_role;

-- ---------------------------------------------------------------------------------------------
-- booking_cancellation_resolve: the operator's later answer, once per booking, replayed on retry.
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.booking_cancellation_resolve(p_booking_id uuid, p_retailer_id uuid, p_decision text, p_operator text, p_reason text, p_refund_request_id uuid DEFAULT NULL, p_case_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_bk record; v_dec public.booking_cancellations%ROWTYPE; v_res public.booking_cancellation_resolutions%ROWTYPE;
BEGIN
  IF p_decision NOT IN ('refund_granted', 'no_refund') THEN RETURN jsonb_build_object('outcome', 'invalid_decision'); END IF;
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN RETURN jsonb_build_object('outcome', 'reason_required'); END IF;
  SELECT id, retailer_id, status, payment_status INTO v_bk FROM public.bookings WHERE id = p_booking_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('outcome', 'no_booking'); END IF;
  IF v_bk.retailer_id IS DISTINCT FROM p_retailer_id THEN RETURN jsonb_build_object('outcome', 'forbidden'); END IF;
  SELECT * INTO v_res FROM public.booking_cancellation_resolutions WHERE booking_id = p_booking_id;
  IF FOUND THEN RETURN jsonb_build_object('outcome', 'existing', 'existing', true, 'resolution', to_jsonb(v_res)); END IF;
  IF v_bk.status NOT IN ('cancelled', 'declined') THEN RETURN jsonb_build_object('outcome', 'not_cancelled', 'status', v_bk.status); END IF;
  SELECT * INTO v_dec FROM public.booking_cancellations WHERE booking_id = p_booking_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('outcome', 'no_decision'); END IF;
  IF v_dec.refund = true THEN RETURN jsonb_build_object('outcome', 'already_refunding', 'decision', to_jsonb(v_dec)); END IF;
  INSERT INTO public.booking_cancellation_resolutions (booking_id, retailer_id, decision, operator, reason, refund_request_id, case_id)
  VALUES (p_booking_id, p_retailer_id, p_decision, p_operator, left(btrim(p_reason), 500), p_refund_request_id, p_case_id)
  RETURNING * INTO v_res;
  RETURN jsonb_build_object('outcome', 'resolved', 'existing', false, 'resolution', to_jsonb(v_res), 'decision', to_jsonb(v_dec));
END $$;
REVOKE ALL ON FUNCTION public.booking_cancellation_resolve(uuid, uuid, text, text, text, uuid, uuid) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.booking_cancellation_resolve(uuid, uuid, text, text, text, uuid, uuid) TO service_role;

-- ---------------------------------------------------------------------------------------------
-- booking_transition (0078 body + the 0106 barrier; verbatim otherwise).
-- ---------------------------------------------------------------------------------------------
${bt.trim()}
REVOKE ALL ON FUNCTION public.booking_transition(uuid, uuid, text, jsonb, numeric) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.booking_transition(uuid, uuid, text, jsonb, numeric) TO service_role;

-- ---------------------------------------------------------------------------------------------
-- move_booking_by_retailer, propose_reschedule, accept_reschedule (0095 bodies + the 0106 barrier; verbatim otherwise).
-- ---------------------------------------------------------------------------------------------
${moveFn2.trim()}
REVOKE ALL ON FUNCTION public.move_booking_by_retailer(uuid, uuid, date, text, text, text, integer) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.move_booking_by_retailer(uuid, uuid, date, text, text, text, integer) TO service_role;

${proposeFn2.trim()}
REVOKE ALL ON FUNCTION public.propose_reschedule(uuid, uuid, date, text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.propose_reschedule(uuid, uuid, date, text) TO service_role;

${acceptFn2.trim()}
REVOKE ALL ON FUNCTION public.accept_reschedule(uuid, uuid, integer) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.accept_reschedule(uuid, uuid, integer) TO service_role;

-- Post-conditions (literal-only).
DO $$
DECLARE v_def text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'bookings' AND column_name = 'cancellation_pending_at') THEN RAISE EXCEPTION '0106 postcondition: bookings.cancellation_pending_at missing'; END IF;
  IF to_regclass('public.booking_cancellation_resolutions') IS NULL THEN RAISE EXCEPTION '0106 postcondition: booking_cancellation_resolutions missing'; END IF;
  IF to_regprocedure('public.booking_cancellation_record(uuid, uuid, jsonb, jsonb)') IS NULL THEN RAISE EXCEPTION '0106 postcondition: booking_cancellation_record (4 args) missing'; END IF;
  IF to_regprocedure('public.booking_cancellation_record(uuid, uuid, jsonb)') IS NOT NULL THEN RAISE EXCEPTION '0106 postcondition: the 0105 three-argument record function still exists'; END IF;
  IF to_regprocedure('public.booking_cancellation_resolve(uuid, uuid, text, text, text, uuid, uuid)') IS NULL THEN RAISE EXCEPTION '0106 postcondition: booking_cancellation_resolve missing'; END IF;
  SELECT pg_get_functiondef('public.booking_transition(uuid, uuid, text, jsonb, numeric)'::regprocedure) INTO v_def;
  IF position('cancellation_pending' IN v_def) = 0 THEN RAISE EXCEPTION '0106 postcondition: booking_transition lacks the barrier'; END IF;
  FOREACH v_def IN ARRAY ARRAY['public.move_booking_by_retailer(uuid, uuid, date, text, text, text, integer)', 'public.propose_reschedule(uuid, uuid, date, text)', 'public.accept_reschedule(uuid, uuid, integer)'] LOOP
    IF position('cancellation_pending_at' IN pg_get_functiondef(v_def::regprocedure)) = 0 THEN RAISE EXCEPTION '0106 postcondition: % lacks the barrier', v_def; END IF;
  END LOOP;
  IF NOT has_function_privilege('service_role', 'public.booking_cancellation_record(uuid, uuid, jsonb, jsonb)', 'EXECUTE') THEN RAISE EXCEPTION '0106 postcondition: service_role cannot execute booking_cancellation_record'; END IF;
  IF has_function_privilege('anon', 'public.booking_cancellation_record(uuid, uuid, jsonb, jsonb)', 'EXECUTE') THEN RAISE EXCEPTION '0106 postcondition: anon can execute booking_cancellation_record'; END IF;
END $$;
`;
if (/\u2014/.test(sql)) throw new Error('em dash');
writeFileSync(ROOT + 'supabase/migrations/0106_cancellation_decision_binding.sql', sql);
console.log('wrote 0106', sql.length, 'chars');
