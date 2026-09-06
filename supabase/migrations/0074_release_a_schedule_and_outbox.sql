-- 0074_release_a_schedule_and_outbox.sql — Release A shared prerequisite: the bookings schedule is
-- authoritative, demos is its projection, and every store-contact / brand notification is driven by a
-- transactional outbox written by the SAME transaction that changes the thing being announced.
--
-- THE DEFECT. api/brand-account.js action `reschedule-respond` (accept) PATCHed ONLY
-- demos.demo_date/demo_time. The linked bookings row — the row 0047/0066/0069/0070 enforce slot
-- capacity on — kept the OLD date/time. So after an accepted reschedule:
--   * the retailer calendar (demos) showed the demo on the new day, while
--   * capacity accounting (bookings) still held the OLD slot and never checked the NEW one — two
--     brands could be "moved" onto a full slot, and the old slot looked taken while nothing was there;
--   * the store-contact reminders (keyed off the demo) and the brand's booking record disagreed.
-- The accept was also two unrelated writes (demos PATCH, then a best-effort email) with no version:
-- an old dashboard tab could accept a proposal the retailer had since replaced, and a second click
-- (or a replay) re-applied it.
--
-- THE FIX, in seven parts (each idempotent; the file is one BEGIN/COMMIT plus a post-condition):
--
--   1. bookings gains the schedule identity.  schedule_revision (1 for every existing row; +1 per
--      accepted move) names an OCCURRENCE of the booking: '<booking_id>:<schedule_revision>' is the
--      occurrence_key every reminder is deduplicated under, so a moved demo gets a fresh set of
--      reminders and the old set is retired (not re-sent, not re-keyed). start_at/end_at/timezone are
--      the occurrence SNAPSHOT — demo_date + demo_time resolved in the retailer's zone at the moment
--      the schedule was set (NULL on legacy rows the backfill could not resolve). needs_electricity is
--      per-booking (nullable = legacy/unknown; the booking form starts writing it). reschedule_proposal_version
--      counts proposals: the retailer's proposal (still stored on demos.reschedule_to_*, 0012) is
--      versioned by the booking it belongs to, and the brand's accept/decline must quote the version
--      it saw — a stale tab, a replay, or a superseded proposal is refused instead of applied.
--
--   2. coi_verifications.brand_note — an owner-written, BRAND-VISIBLE reason that rides on the
--      coi_approved / coi_rejected event. review_notes stays the private reviewer column.
--      review_coi_verification() gains p_brand_note (6-arg form replaces 0067's 5-arg form) and
--      writes it in the same UPDATE that flips status, so the event trigger sees both together.
--
--   3. The outbox.  notification_events is what HAPPENED (one row per state transition, UNIQUE on
--      (kind, transition_id) so a transition is recorded once however many times its writer runs);
--      notification_deliveries is what is OWED to whom (one row per event x recipient, or per
--      reminder offset x recipient x occurrence, UNIQUE on dedupe_key). The worker claims deliveries
--      (status/lease/claim_token), freezes the exact payload and provider idempotency key BEFORE the
--      first attempt, and records the outcome. Nothing in here sends mail. service_role only, RLS on,
--      no browser-role grants — the same posture as cron_heartbeat / refund_requests / 0073.
--      0073's demo_notifications (claimed-then-sent ledger keyed on free-text kinds) is DROPPED: it
--      was never written to (0 rows on every environment) and this outbox replaces it.
--
--   4. Event triggers write the outbox IN the transaction that changes state, so an event cannot
--      exist without its state change and a state change cannot commit without its event:
--        bookings  INSERT status='confirmed'                       -> demo_confirmed
--        bookings  UPDATE OF status  * -> 'confirmed'               -> demo_confirmed
--                                    'confirmed' -> cancelled/declined -> demo_cancelled, and every
--                                    pending/claimed delivery for the booking is skipped
--                                    (reminders and any not-yet-sent confirmation alike).
--                                    pending -> declined writes NOTHING: contacts were never told.
--        coi_verifications UPDATE OF status  -> approved/passed     -> coi_approved
--                                            -> rejected            -> coi_rejected
--                                    Re-saving the same status writes nothing (OLD/NEW compared).
--      transition_id shapes: '<booking_id>:confirmed:<schedule_revision>', '<booking_id>:cancelled',
--      '<booking_id>:rescheduled:<new_revision>', '<coi_verification_id>:approved' / ':rejected'.
--      COI events have NO retailer (a certificate belongs to the brand across every store), so
--      retailer_id is nullable on both tables with a CHECK that keeps it mandatory for demo events.
--
--   5. RPCs, SECURITY DEFINER, service_role only, each ONE transaction:
--        propose_reschedule(demo, retailer, date, time)   writes the proposal on demos AND bumps
--                                                         bookings.reschedule_proposal_version,
--                                                         returning the version the brand must quote.
--        accept_reschedule(booking, brand, version)       locks the booking FOR UPDATE, verifies the
--                                                         brand, the active status (a cancel that
--                                                         raced in wins), the proposal + version,
--                                                         the destination date, and COI coverage
--                                                         on the NEW date with the SAME rule as
--                                                         api/_coi-policy.js; then moves bookings
--                                                         (revision+1, snapshot recomputed — the 0070
--                                                         move trigger enforces capacity; slot_full
--                                                         is caught and returned with NO change),
--                                                         projects the move onto demos, clears the
--                                                         proposal, writes demo_rescheduled, and
--                                                         skips every pending delivery of the OLD
--                                                         occurrence. Any error rolls back all of it.
--        decline_reschedule(booking, brand, version)      clears the proposal; bumps nothing else.
--      Lock ORDER in all three is bookings row -> demos row -> (trigger) venue row -> slot lock, so
--      they cannot deadlock with each other or with the capacity paths.
--
--   6. Backfill.  booking_slot_start(date, time, tz) parses the free-text demo_time exactly as
--      api/_local-time.js parseDemoTime() does ("11:00 AM", "3pm", "15:00"; unparseable -> 11:00,
--      the calendar's long-standing default) and resolves it in the retailer zone. Every
--      pending/confirmed booking with a demo_date gets start_at/end_at/timezone; a BEFORE trigger
--      keeps the snapshot current for new inserts and for moves. No status is changed. Counts are
--      RAISEd as NOTICEs (backfilled / defaulted-to-11:00 / left NULL).
--
--   7. schedule_mismatches() — audit: future booking/demo pairs whose venue, date, time or
--      status family disagree. Expected to return zero rows; tests/schedule_audit.mjs runs it.
--
-- tools/check-migrations.mjs rules apply (no bare SELECT). Forward-only. Never run against prod
-- by hand — the post-condition block below is what proves it applied.
BEGIN;

-- ---------------------------------------------------------------------------------------------
-- 1. bookings: schedule identity + occurrence snapshot + proposal version + electricity
-- ---------------------------------------------------------------------------------------------
ALTER TABLE public.bookings
  ADD COLUMN IF NOT EXISTS schedule_revision           integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS needs_electricity           boolean,
  ADD COLUMN IF NOT EXISTS start_at                    timestamptz,
  ADD COLUMN IF NOT EXISTS end_at                      timestamptz,
  ADD COLUMN IF NOT EXISTS timezone                    text,
  ADD COLUMN IF NOT EXISTS reschedule_proposal_version integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.bookings.schedule_revision IS
  '0074: occurrence counter. 1 at creation, +1 per accepted reschedule. occurrence_key = id||'':''||schedule_revision.';
COMMENT ON COLUMN public.bookings.reschedule_proposal_version IS
  '0074: +1 per retailer proposal (propose_reschedule). accept/decline must quote it; a mismatch is stale_proposal.';
COMMENT ON COLUMN public.bookings.start_at IS
  '0074: snapshot of demo_date+demo_time in bookings.timezone (booking_slot_start). NULL on legacy rows without a date.';

-- ---------------------------------------------------------------------------------------------
-- 2. coi_verifications: brand-visible note
-- ---------------------------------------------------------------------------------------------
ALTER TABLE public.coi_verifications ADD COLUMN IF NOT EXISTS brand_note text;
COMMENT ON COLUMN public.coi_verifications.brand_note IS
  '0074: owner-written reason shown to the BRAND on approval/rejection. review_notes stays private.';

-- ---------------------------------------------------------------------------------------------
-- 2b. review_coi_verification(): +p_brand_note, written in the SAME UPDATE that flips status, so the
--     coi_approved / coi_rejected event (4b) reads NEW.brand_note from the very row version the
--     decision produced. Everything else is byte-for-byte 0067 (decision/reviewer/notes/expiry
--     validation, row lock, immutable-review and removed-record refusals, the three stale-review
--     identity checks, policy_expiry handling, current-version-only brands update). The 5-arg
--     signature is DROPPED: with both overloads present a PostgREST rpc/ call that omits
--     p_brand_note matches both and fails PGRST203 "ambiguous". The note is validated as
--     brand-facing plain text (<= 1000 chars, newlines only) — refused, never silently rewritten.
--     The API requires a note on REJECT (400 brand_note_required); that brand-facing rule stays in
--     api/admin-auth.js, because 0058/0060/0067 self-tests and housekeeping rejects call this
--     function without one.
-- ---------------------------------------------------------------------------------------------
drop function if exists public.review_coi_verification(uuid, text, text, text, date);

create or replace function public.review_coi_verification(
  p_verification_id uuid,
  p_decision        text,
  p_reviewer        text,
  p_notes           text default null,
  p_expiry          date default null,
  p_brand_note      text default null
) returns public.coi_verifications
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row        public.coi_verifications;
  v_brand      public.brands;
  v_brand_note text;
begin
  if p_decision is null or p_decision not in ('approved','rejected') then
    raise exception 'decision must be approved or rejected' using errcode = 'check_violation';
  end if;
  if p_reviewer is null or btrim(p_reviewer) = '' then
    raise exception 'reviewer is required' using errcode = 'check_violation';
  end if;
  if p_notes is not null and length(p_notes) > 2000 then
    raise exception 'review notes are limited to 2000 characters' using errcode = 'check_violation';
  end if;

  -- Release A §6: the note to the brand is emailed verbatim. Trim, normalise CRLF, and refuse
  -- (never strip) control characters other than newline so nothing is silently rewritten.
  v_brand_note := nullif(btrim(regexp_replace(p_brand_note, E'\r\n?', E'\n', 'g')), '');
  if v_brand_note is not null then
    if length(v_brand_note) > 1000 then
      raise exception 'brand_note_too_long: the note to the brand is limited to 1000 characters'
        using errcode = 'check_violation';
    end if;
    if v_brand_note ~ '[\x01-\x09\x0B\x0C\x0E-\x1F\x7F]' then
      raise exception 'brand_note_invalid: the note to the brand may only contain plain text and line breaks'
        using errcode = 'check_violation';
    end if;
  end if;

  -- P0-4: the reviewer-confirmed expiry is REQUIRED for an approval and must be in the future.
  -- Without it a brand could be approved-but-never-covered (coiCovered needs a date). The API also
  -- validates, but the RPC is the authority: no approval commits without a usable coverage date.
  if p_decision = 'approved' then
    if p_expiry is null then
      raise exception 'expiry_required: an approval must carry the certificate policy expiry'
        using errcode = 'check_violation';
    end if;
    if p_expiry <= current_date then
      raise exception 'expiry_in_past: the certificate expiry must be in the future'
        using errcode = 'check_violation';
    end if;
  end if;

  select * into v_row from coi_verifications where id = p_verification_id for update;
  if not found then
    raise exception 'verification record not found' using errcode = 'no_data_found';
  end if;
  if v_row.brand_id is null then
    raise exception 'verification record has no brand' using errcode = 'check_violation';
  end if;

  -- IMMUTABLE REVIEWS (0060). A decided record is history; a new decision requires a new upload.
  if v_row.review_decision is not null then
    raise exception 'already decided: this record was % and cannot be re-decided', v_row.review_decision
      using errcode = 'check_violation';
  end if;
  if v_row.removed_at is not null then
    raise exception 'removed record cannot be reviewed' using errcode = 'check_violation';
  end if;

  select * into v_brand from brands where id = v_row.brand_id for update;
  if not found then
    raise exception 'brand not found for this verification' using errcode = 'no_data_found';
  end if;

  if p_decision = 'approved' then
    -- STALE IS AN IDENTITY QUESTION (0060): approval is permitted only for the brand's CURRENT version.
    if v_row.superseded_at is not null then
      raise exception 'stale review: this version was superseded by a later upload'
        using errcode = 'check_violation';
    end if;
    if v_brand.current_coi_verification_id is distinct from v_row.id then
      raise exception 'stale review: this record is not the brand''s current certificate'
        using errcode = 'check_violation';
    end if;
    if v_row.storage_path is distinct from v_brand.default_coi_url then
      raise exception 'stale review: this record''s document is not the brand''s current document'
        using errcode = 'check_violation';
    end if;
  end if;

  update coi_verifications
     set review_decision = p_decision,
         reviewed_at     = now(),
         reviewed_by     = btrim(p_reviewer),
         review_notes    = p_notes,
         -- Release A §6: brand-facing note, committed with the status it explains. The 0074
         -- status trigger reads NEW.brand_note from this same row version.
         brand_note      = v_brand_note,
         status          = case when p_decision = 'approved' then 'approved' else 'rejected' end,
         -- P0-4: record the coverage expiry the owner actually confirmed on THIS record. On a
         -- rejection we leave whatever was parsed at upload; it does not gate anything.
         policy_expiry   = case when p_decision = 'approved' then p_expiry else policy_expiry end
   where id = p_verification_id
  returning * into v_row;

  -- Only the current version may move the brand's entitlement. Rejecting a superseded record is
  -- allowed for housekeeping but must not change what the brand is entitled to.
  if v_brand.current_coi_verification_id is not distinct from v_row.id then
    update brands
       set coi_verification_status = case when p_decision = 'approved' then 'approved' else 'rejected' end,
           -- P0-4: the reviewer-confirmed expiry commits in the SAME transaction as the decision.
           -- On approval it overwrites any brand-entered / AI-derived date; on rejection it is
           -- untouched (the brand is not covered anyway).
           default_coi_expires = case when p_decision = 'approved' then p_expiry else default_coi_expires end
     where id = v_row.brand_id;
  end if;

  return v_row;
end $$;

revoke all on function public.review_coi_verification(uuid, text, text, text, date, text) from public, anon, authenticated;
grant execute on function public.review_coi_verification(uuid, text, text, text, date, text) to service_role;

-- ---------------------------------------------------------------------------------------------
-- 3. Outbox
-- ---------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.notification_events (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  retailer_id   uuid,                        -- NULL only for COI events (brand-scoped)
  booking_id    uuid,                        -- NULL for COI events
  brand_id      uuid,
  kind          text        NOT NULL CHECK (kind IN ('demo_confirmed','demo_cancelled','demo_rescheduled','coi_approved','coi_rejected')),
  transition_id text        NOT NULL,        -- '<booking_id>:confirmed:<rev>' | '<booking_id>:cancelled' | '<booking_id>:rescheduled:<rev>' | '<coi_id>:approved' | '<coi_id>:rejected'
  payload       jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  fanned_out_at timestamptz,
  CONSTRAINT notification_events_once UNIQUE (kind, transition_id),
  CONSTRAINT notification_events_retailer_for_demo CHECK (retailer_id IS NOT NULL OR kind IN ('coi_approved','coi_rejected'))
);

CREATE TABLE IF NOT EXISTS public.notification_deliveries (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id            uuid        REFERENCES public.notification_events(id) ON DELETE SET NULL,
  retailer_id         uuid,                  -- NULL only for COI deliveries (brand-scoped)
  booking_id          uuid,
  recipient_kind      text        NOT NULL CHECK (recipient_kind IN ('store_contact','brand')),
  recipient_id        uuid,                  -- internal_contacts.id or brands.id
  recipient_email     text        NOT NULL,
  kind                text        NOT NULL,  -- event kind or 'reminder'
  offset_key          text,                  -- 'w1','d3','d1','d<N>','morning_of','h1' (reminders only)
  occurrence_key      text,                  -- '<booking_id>:<schedule_revision>'
  dedupe_key          text        NOT NULL UNIQUE,  -- '<kind>:<occurrence_key|transition_id>:<recipient_kind>:<recipient_id>:<offset_key|->'
  due_at              timestamptz NOT NULL,
  expires_at          timestamptz,           -- catch-up deadline; NULL = no expiry
  status              text        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','claimed','accepted','failed','skipped','unknown')),
  attempts            integer     NOT NULL DEFAULT 0,
  next_attempt_at     timestamptz,
  lease_until         timestamptz,
  claim_token         uuid,
  idempotency_key     text        UNIQUE,    -- provider idempotency key, frozen with the payload
  frozen_payload      jsonb,                 -- {to, subject, html} exactly as attempted
  provider_message_id text,
  last_error          text,
  skip_reason         text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT notification_deliveries_retailer_for_demo CHECK (retailer_id IS NOT NULL OR kind IN ('coi_approved','coi_rejected'))
);

CREATE INDEX IF NOT EXISTS notification_deliveries_due        ON public.notification_deliveries (status, due_at) WHERE status IN ('pending','claimed');
CREATE INDEX IF NOT EXISTS notification_deliveries_occurrence ON public.notification_deliveries (occurrence_key);
CREATE INDEX IF NOT EXISTS notification_deliveries_booking    ON public.notification_deliveries (booking_id);
CREATE INDEX IF NOT EXISTS notification_events_unfanned       ON public.notification_events (created_at) WHERE fanned_out_at IS NULL;

ALTER TABLE public.notification_events     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notification_deliveries ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.notification_events     FROM public, anon, authenticated;
REVOKE ALL ON public.notification_deliveries FROM public, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.notification_events     TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.notification_deliveries TO service_role;

-- 0073's ledger: never written (0 rows everywhere), superseded by the outbox above.
DROP TABLE IF EXISTS public.demo_notifications;

-- ---------------------------------------------------------------------------------------------
-- 6a. booking_slot_start(): free-text demo_time -> timestamptz in the retailer zone.
--     Mirrors api/_local-time.js parseDemoTime(): "11:00 AM" | "3:00 PM" | "15:00" | "11am" |
--     "11:30 am". Unparseable/NULL time -> p_default_hour:00 (11 = the calendar default; pass NULL
--     to get NULL instead). NULL date -> NULL. An unknown zone falls back to America/Los_Angeles
--     rather than failing the caller (the JS safeZone() does the same).
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.booking_slot_start(p_date date, p_time text, p_tz text, p_default_hour integer DEFAULT 11)
RETURNS timestamptz
LANGUAGE plpgsql STABLE AS $$
DECLARE
  m      text[];
  v_h    integer;
  v_min  integer;
  v_ampm text;
  v_tz   text := coalesce(nullif(btrim(p_tz), ''), 'America/Los_Angeles');
  v_wall timestamp;
BEGIN
  IF p_date IS NULL THEN RETURN NULL; END IF;
  m := regexp_match(coalesce(p_time, ''), '^\s*(\d{1,2})(?::(\d{2}))?\s*([AaPp]\.?[Mm]\.?)?\s*$');
  IF m IS NOT NULL THEN
    v_h    := m[1]::integer;
    v_min  := coalesce(m[2]::integer, 0);
    v_ampm := lower(replace(coalesce(m[3], ''), '.', ''));
    IF v_min > 59 THEN
      v_h := NULL;
    ELSIF v_ampm <> '' THEN
      IF v_h < 1 OR v_h > 12 THEN v_h := NULL;
      ELSIF v_ampm = 'pm' AND v_h <> 12 THEN v_h := v_h + 12;
      ELSIF v_ampm = 'am' AND v_h = 12 THEN v_h := 0;
      END IF;
    ELSIF v_h > 23 THEN
      v_h := NULL;
    END IF;
  END IF;
  IF v_h IS NULL THEN
    IF p_default_hour IS NULL THEN RETURN NULL; END IF;
    v_h := p_default_hour; v_min := 0;
  END IF;
  v_wall := p_date + make_time(v_h, v_min, 0);
  BEGIN
    RETURN v_wall AT TIME ZONE v_tz;
  EXCEPTION WHEN invalid_parameter_value OR invalid_datetime_format THEN
    RETURN v_wall AT TIME ZONE 'America/Los_Angeles';
  END;
END $$;

-- Was the time string parseable at all? (Backfill reporting; same grammar as above.)
CREATE OR REPLACE FUNCTION public.booking_slot_time_parseable(p_time text)
RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT booking_slot_start(DATE '2000-01-01', p_time, 'UTC', NULL) IS NOT NULL
$$;

-- ---------------------------------------------------------------------------------------------
-- 6b. Snapshot trigger: keep start_at/end_at/timezone in step with demo_date/demo_time on every
--     insert and every move. Duration is the demos row's duration_hours when one exists, else 3h.
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.booking_slot_snapshot() RETURNS trigger AS $$
DECLARE v_tz text; v_hours integer;
BEGIN
  SELECT r.timezone INTO v_tz FROM retailers r WHERE r.id = NEW.retailer_id;
  NEW.timezone := coalesce(nullif(btrim(v_tz), ''), 'America/Los_Angeles');
  NEW.start_at := booking_slot_start(NEW.demo_date, NEW.demo_time, NEW.timezone, 11);
  IF NEW.start_at IS NULL THEN
    NEW.end_at := NULL;
  ELSE
    SELECT d.duration_hours INTO v_hours FROM demos d WHERE d.booking_id = NEW.id LIMIT 1;
    NEW.end_at := NEW.start_at + make_interval(hours => coalesce(v_hours, 3));
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_booking_slot_snapshot ON public.bookings;
CREATE TRIGGER trg_booking_slot_snapshot
  BEFORE INSERT OR UPDATE OF demo_date, demo_time, retailer_id ON public.bookings
  FOR EACH ROW EXECUTE FUNCTION public.booking_slot_snapshot();

-- ---------------------------------------------------------------------------------------------
-- 4a. bookings -> notification_events (AFTER, same transaction)
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.booking_notification_events() RETURNS trigger AS $$
DECLARE
  v_old text := CASE WHEN TG_OP = 'UPDATE' THEN OLD.status ELSE NULL END;
BEGIN
  IF NEW.status = 'confirmed' AND v_old IS DISTINCT FROM 'confirmed' THEN
    INSERT INTO notification_events (retailer_id, booking_id, brand_id, kind, transition_id, payload)
    VALUES (NEW.retailer_id, NEW.id, NEW.brand_id, 'demo_confirmed',
            NEW.id::text || ':confirmed:' || NEW.schedule_revision::text,
            jsonb_build_object('demo_date', NEW.demo_date, 'demo_time', NEW.demo_time, 'venue_id', NEW.venue_id,
                               'schedule_revision', NEW.schedule_revision, 'start_at', NEW.start_at, 'timezone', NEW.timezone))
    ON CONFLICT (kind, transition_id) DO NOTHING;
  ELSIF TG_OP = 'UPDATE' AND v_old = 'confirmed' AND NEW.status IN ('cancelled', 'declined') THEN
    INSERT INTO notification_events (retailer_id, booking_id, brand_id, kind, transition_id, payload)
    VALUES (NEW.retailer_id, NEW.id, NEW.brand_id, 'demo_cancelled',
            NEW.id::text || ':cancelled',
            jsonb_build_object('demo_date', NEW.demo_date, 'demo_time', NEW.demo_time, 'venue_id', NEW.venue_id,
                               'schedule_revision', NEW.schedule_revision, 'new_status', NEW.status, 'cancel_reason', NEW.cancel_reason))
    ON CONFLICT (kind, transition_id) DO NOTHING;
    -- Nothing queued for this booking should still go out: reminders and a not-yet-sent confirmation.
    UPDATE notification_deliveries
       SET status = 'skipped', skip_reason = 'booking_cancelled', updated_at = now()
     WHERE booking_id = NEW.id AND status IN ('pending', 'claimed');
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_booking_notification_events ON public.bookings;
CREATE TRIGGER trg_booking_notification_events
  AFTER INSERT OR UPDATE OF status ON public.bookings
  FOR EACH ROW EXECUTE FUNCTION public.booking_notification_events();

-- ---------------------------------------------------------------------------------------------
-- 4b. coi_verifications -> notification_events. review_coi_verification (0067) sets status to
--     'approved' / 'rejected' in the same UPDATE as policy_expiry; an AI auto-pass may write
--     'passed'. Both approval spellings dedupe onto one ':approved' transition.
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.coi_notification_events() RETURNS trigger AS $$
DECLARE v_old text := lower(coalesce(OLD.status, '')); v_new text := lower(coalesce(NEW.status, ''));
BEGIN
  IF v_new = v_old THEN RETURN NEW; END IF;
  IF v_new IN ('approved', 'passed') AND v_old NOT IN ('approved', 'passed') THEN
    INSERT INTO notification_events (retailer_id, booking_id, brand_id, kind, transition_id, payload)
    VALUES (NULL, NULL, NEW.brand_id, 'coi_approved', NEW.id::text || ':approved',
            jsonb_build_object('brand_id', NEW.brand_id, 'verification_id', NEW.id, 'expires_at', NEW.policy_expiry,
                               'brand_note', NEW.brand_note, 'status', NEW.status))
    ON CONFLICT (kind, transition_id) DO NOTHING;
  ELSIF v_new = 'rejected' THEN
    INSERT INTO notification_events (retailer_id, booking_id, brand_id, kind, transition_id, payload)
    VALUES (NULL, NULL, NEW.brand_id, 'coi_rejected', NEW.id::text || ':rejected',
            jsonb_build_object('brand_id', NEW.brand_id, 'verification_id', NEW.id, 'brand_note', NEW.brand_note, 'status', NEW.status))
    ON CONFLICT (kind, transition_id) DO NOTHING;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_coi_notification_events ON public.coi_verifications;
CREATE TRIGGER trg_coi_notification_events
  AFTER UPDATE OF status ON public.coi_verifications
  FOR EACH ROW EXECUTE FUNCTION public.coi_notification_events();

-- ---------------------------------------------------------------------------------------------
-- 5a. propose_reschedule: retailer proposes a new date for a confirmed demo. Proposal on demos
--     (0012 columns, unchanged for the UI), version on the booking. One transaction.
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.propose_reschedule(p_demo_id uuid, p_retailer_id uuid, p_new_date date, p_new_time text DEFAULT NULL)
RETURNS TABLE(ok boolean, reason text, proposal_version integer, booking_id uuid, new_time text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_bid  uuid;
  v_b    bookings%ROWTYPE;
  v_d    demos%ROWTYPE;
  v_tz   text;
  v_ver  integer;
  v_time text;
BEGIN
  SELECT d.booking_id INTO v_bid FROM demos d WHERE d.id = p_demo_id AND d.retailer_id = p_retailer_id;
  IF NOT FOUND THEN RETURN QUERY SELECT false, 'not_found'::text, NULL::integer, NULL::uuid, NULL::text; RETURN; END IF;
  IF v_bid IS NULL THEN RETURN QUERY SELECT false, 'no_booking'::text, NULL::integer, NULL::uuid, NULL::text; RETURN; END IF;

  -- Lock order: bookings row, then demos row (accept/decline take the same order).
  SELECT * INTO v_b FROM bookings b WHERE b.id = v_bid FOR UPDATE;
  IF NOT FOUND THEN RETURN QUERY SELECT false, 'no_booking'::text, NULL::integer, NULL::uuid, NULL::text; RETURN; END IF;
  SELECT * INTO v_d FROM demos d WHERE d.id = p_demo_id FOR UPDATE;
  IF v_d.booking_id IS DISTINCT FROM v_bid OR v_d.retailer_id IS DISTINCT FROM p_retailer_id THEN
    RETURN QUERY SELECT false, 'not_found'::text, NULL::integer, NULL::uuid, NULL::text; RETURN;
  END IF;
  IF v_b.retailer_id IS DISTINCT FROM p_retailer_id THEN
    RETURN QUERY SELECT false, 'not_found'::text, NULL::integer, NULL::uuid, NULL::text; RETURN;
  END IF;
  IF coalesce(v_d.status, '') NOT IN ('confirmed', 'scheduled') OR coalesce(v_b.status, 'pending') NOT IN ('pending', 'confirmed') THEN
    RETURN QUERY SELECT false, 'not_active'::text, NULL::integer, v_bid, NULL::text; RETURN;
  END IF;

  SELECT r.timezone INTO v_tz FROM retailers r WHERE r.id = p_retailer_id;
  IF p_new_date IS NULL OR p_new_date < (now() AT TIME ZONE coalesce(nullif(v_tz, ''), 'America/Los_Angeles'))::date THEN
    RETURN QUERY SELECT false, 'date_in_past'::text, NULL::integer, v_bid, NULL::text; RETURN;
  END IF;
  v_time := coalesce(nullif(btrim(p_new_time), ''), v_b.demo_time, v_d.demo_time);

  UPDATE demos
     SET reschedule_to_date = p_new_date, reschedule_to_time = v_time, reschedule_requested_at = now()
   WHERE id = p_demo_id;
  UPDATE bookings
     SET reschedule_proposal_version = reschedule_proposal_version + 1
   WHERE id = v_bid
  RETURNING reschedule_proposal_version INTO v_ver;

  RETURN QUERY SELECT true, NULL::text, v_ver, v_bid, v_time;
END $$;
REVOKE ALL ON FUNCTION public.propose_reschedule(uuid, uuid, date, text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.propose_reschedule(uuid, uuid, date, text) TO service_role;

-- ---------------------------------------------------------------------------------------------
-- 5b. accept_reschedule: the ONE transaction that moves a demo.
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.accept_reschedule(p_booking_id uuid, p_brand_id uuid, p_proposal_version integer)
RETURNS TABLE(ok boolean, reason text, schedule_revision integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_b        bookings%ROWTYPE;
  v_d        demos%ROWTYPE;
  v_brand    brands%ROWTYPE;
  v_tz       text;
  v_today    date;
  v_new_date date;
  v_new_time text;
  v_old_rev  integer;
  v_new_rev  integer;
  v_covered  boolean;
BEGIN
  -- 1. Lock the booking. Everything below reads under this lock; a concurrent cancel (PATCH status)
  --    or a second accept waits here and then sees what we committed.
  SELECT * INTO v_b FROM bookings b WHERE b.id = p_booking_id FOR UPDATE;
  IF NOT FOUND THEN RETURN QUERY SELECT false, 'not_found'::text, NULL::integer; RETURN; END IF;

  -- 2. The projection row (one per booking: demos_one_per_booking). Same lock order everywhere.
  SELECT * INTO v_d FROM demos d WHERE d.booking_id = p_booking_id ORDER BY d.created_at LIMIT 1 FOR UPDATE;
  IF NOT FOUND THEN RETURN QUERY SELECT false, 'no_demo'::text, v_b.schedule_revision; RETURN; END IF;

  -- 3. Identity: the brand the booking (or, for legacy rows without one, the demo) belongs to.
  IF p_brand_id IS NULL OR coalesce(v_b.brand_id, v_d.brand_id) IS DISTINCT FROM p_brand_id THEN
    RETURN QUERY SELECT false, 'forbidden'::text, v_b.schedule_revision; RETURN;
  END IF;

  -- 4. Cancel race: only an active booking can move. A booking cancelled between the brand loading
  --    the page and clicking Accept is refused here, and the demo stays cancelled.
  IF coalesce(v_b.status, 'pending') NOT IN ('pending', 'confirmed') OR coalesce(v_d.status, '') NOT IN ('confirmed', 'scheduled') THEN
    RETURN QUERY SELECT false, 'cancelled'::text, v_b.schedule_revision; RETURN;
  END IF;

  -- 5. Proposal + version. No proposal (already accepted/declined/replayed) and a version other
  --    than the current one (old tab, superseded proposal) are both refusals with no side effect.
  IF v_d.reschedule_to_date IS NULL THEN RETURN QUERY SELECT false, 'no_proposal'::text, v_b.schedule_revision; RETURN; END IF;
  IF p_proposal_version IS NULL OR v_b.reschedule_proposal_version <> p_proposal_version THEN
    RETURN QUERY SELECT false, 'stale_proposal'::text, v_b.schedule_revision; RETURN;
  END IF;

  v_new_date := v_d.reschedule_to_date;
  v_new_time := coalesce(nullif(btrim(v_d.reschedule_to_time), ''), v_b.demo_time, v_d.demo_time);

  -- 6. Destination must not be in the past (retailer-local today).
  SELECT r.timezone INTO v_tz FROM retailers r WHERE r.id = v_b.retailer_id;
  v_tz := coalesce(nullif(btrim(v_tz), ''), 'America/Los_Angeles');
  v_today := (now() AT TIME ZONE v_tz)::date;
  IF v_new_date < v_today THEN RETURN QUERY SELECT false, 'date_in_past'::text, v_b.schedule_revision; RETURN; END IF;

  -- 7. COI on the NEW date — the canonical rule of api/_coi-policy.js coiDecision(), in SQL:
  --      covered <=> (an explicit per-booking waiver)
  --               OR (default_coi_url present AND coi_verification_status in (passed, approved)
  --                   AND default_coi_expires present AND default_coi_expires >= demo date).
  --    pending / flagged / rejected / missing / unreadable expiry never count.
  SELECT * INTO v_brand FROM brands br WHERE br.id = p_brand_id;
  v_covered := (v_b.coi_waived_at IS NOT NULL)
            OR (v_brand.default_coi_url IS NOT NULL
                AND lower(coalesce(v_brand.coi_verification_status, '')) IN ('passed', 'approved')
                AND v_brand.default_coi_expires IS NOT NULL
                AND v_brand.default_coi_expires >= v_new_date);
  IF NOT coalesce(v_covered, false) THEN RETURN QUERY SELECT false, 'coi_not_covered'::text, v_b.schedule_revision; RETURN; END IF;

  -- 8. Move the AUTHORITATIVE row. trg_enforce_slot_capacity_move (0070) locks the venue row and
  --    the destination slot and raises slot_full (check_violation) when it is taken; the exception
  --    block below turns that into ok=false with the UPDATE rolled back (plpgsql sub-transaction),
  --    and nothing after this point has run yet, so the database is exactly as it was.
  v_old_rev := v_b.schedule_revision;
  BEGIN
    UPDATE bookings
       SET demo_date = v_new_date,
           demo_time = v_new_time,
           schedule_revision = bookings.schedule_revision + 1
     WHERE id = p_booking_id
    RETURNING bookings.schedule_revision INTO v_new_rev;
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM LIKE 'slot_full%' THEN RETURN QUERY SELECT false, 'slot_full'::text, v_old_rev; RETURN; END IF;
    RAISE;
  END;
  -- (trg_booking_slot_snapshot recomputed start_at/end_at/timezone in the same UPDATE.)

  -- 9. Project onto the calendar row and consume the proposal.
  UPDATE demos
     SET demo_date = v_new_date, demo_time = v_new_time,
         reschedule_to_date = NULL, reschedule_to_time = NULL, reschedule_requested_at = NULL
   WHERE id = v_d.id;

  -- 10. The event, with both slots, so the fan-out can say "moved from X to Y".
  INSERT INTO notification_events (retailer_id, booking_id, brand_id, kind, transition_id, payload)
  VALUES (v_b.retailer_id, p_booking_id, coalesce(v_b.brand_id, v_d.brand_id), 'demo_rescheduled',
          p_booking_id::text || ':rescheduled:' || v_new_rev::text,
          jsonb_build_object('old_date', v_b.demo_date, 'old_time', v_b.demo_time, 'old_schedule_revision', v_old_rev,
                             'new_date', v_new_date, 'new_time', v_new_time, 'schedule_revision', v_new_rev,
                             'venue_id', v_b.venue_id, 'timezone', v_tz, 'proposal_version', p_proposal_version))
  ON CONFLICT (kind, transition_id) DO NOTHING;

  -- 11. Retire every not-yet-sent delivery of the OLD occurrence (reminders for a slot that no
  --     longer exists, and a confirmation that would now name the wrong day).
  UPDATE notification_deliveries
     SET status = 'skipped', skip_reason = 'rescheduled', updated_at = now()
   WHERE occurrence_key = p_booking_id::text || ':' || v_old_rev::text
     AND status IN ('pending', 'claimed');

  RETURN QUERY SELECT true, NULL::text, v_new_rev;
END $$;
REVOKE ALL ON FUNCTION public.accept_reschedule(uuid, uuid, integer) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.accept_reschedule(uuid, uuid, integer) TO service_role;

-- ---------------------------------------------------------------------------------------------
-- 5c. decline_reschedule: clear the proposal, nothing else moves.
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.decline_reschedule(p_booking_id uuid, p_brand_id uuid, p_proposal_version integer)
RETURNS TABLE(ok boolean, reason text, schedule_revision integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_b bookings%ROWTYPE;
  v_d demos%ROWTYPE;
BEGIN
  SELECT * INTO v_b FROM bookings b WHERE b.id = p_booking_id FOR UPDATE;
  IF NOT FOUND THEN RETURN QUERY SELECT false, 'not_found'::text, NULL::integer; RETURN; END IF;
  SELECT * INTO v_d FROM demos d WHERE d.booking_id = p_booking_id ORDER BY d.created_at LIMIT 1 FOR UPDATE;
  IF NOT FOUND THEN RETURN QUERY SELECT false, 'no_demo'::text, v_b.schedule_revision; RETURN; END IF;
  IF p_brand_id IS NULL OR coalesce(v_b.brand_id, v_d.brand_id) IS DISTINCT FROM p_brand_id THEN
    RETURN QUERY SELECT false, 'forbidden'::text, v_b.schedule_revision; RETURN;
  END IF;
  IF v_d.reschedule_to_date IS NULL THEN RETURN QUERY SELECT false, 'no_proposal'::text, v_b.schedule_revision; RETURN; END IF;
  IF p_proposal_version IS NULL OR v_b.reschedule_proposal_version <> p_proposal_version THEN
    RETURN QUERY SELECT false, 'stale_proposal'::text, v_b.schedule_revision; RETURN;
  END IF;
  UPDATE demos
     SET reschedule_to_date = NULL, reschedule_to_time = NULL, reschedule_requested_at = NULL
   WHERE id = v_d.id;
  RETURN QUERY SELECT true, NULL::text, v_b.schedule_revision;
END $$;
REVOKE ALL ON FUNCTION public.decline_reschedule(uuid, uuid, integer) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.decline_reschedule(uuid, uuid, integer) TO service_role;

-- ---------------------------------------------------------------------------------------------
-- 7. schedule_mismatches(): future booking/demo pairs that disagree. Expected: zero rows.
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.schedule_mismatches()
RETURNS TABLE(booking_id uuid, demo_id uuid, retailer_id uuid, field text, booking_value text, demo_value text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH pairs AS (
    SELECT b.id AS bid, d.id AS did, b.retailer_id AS rid,
           b.venue_id AS b_venue, d.venue_id AS d_venue,
           b.demo_date AS b_date,  d.demo_date AS d_date,
           b.demo_time AS b_time,  d.demo_time AS d_time,
           CASE WHEN coalesce(b.status, 'pending') IN ('cancelled', 'declined', 'expired', 'auth_canceled') THEN 'inactive' ELSE 'active' END AS b_family,
           CASE WHEN coalesce(d.status, 'confirmed') = 'cancelled' THEN 'inactive' ELSE 'active' END AS d_family
      FROM demos d
      JOIN bookings b ON b.id = d.booking_id
     WHERE greatest(b.demo_date, d.demo_date) >= current_date
  )
  SELECT bid, did, rid, 'venue_id',  b_venue::text, d_venue::text FROM pairs WHERE b_venue IS DISTINCT FROM d_venue
  UNION ALL
  SELECT bid, did, rid, 'demo_date', b_date::text,  d_date::text  FROM pairs WHERE b_date  IS DISTINCT FROM d_date
  UNION ALL
  SELECT bid, did, rid, 'demo_time', b_time,        d_time        FROM pairs WHERE b_time  IS DISTINCT FROM d_time
  UNION ALL
  SELECT bid, did, rid, 'status_family', b_family,  d_family      FROM pairs WHERE b_family <> d_family
$$;
REVOKE ALL ON FUNCTION public.schedule_mismatches() FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.schedule_mismatches() TO service_role;

-- ---------------------------------------------------------------------------------------------
-- 6c. Backfill the occurrence snapshot for pending/confirmed bookings. No status changes. Only the
--     three snapshot columns are SET, so neither capacity trigger nor the event trigger fires.
-- ---------------------------------------------------------------------------------------------
DO $$
DECLARE v_done integer; v_defaulted integer; v_null integer;
BEGIN
  SELECT count(*) INTO v_defaulted
    FROM bookings b
   WHERE b.start_at IS NULL AND b.demo_date IS NOT NULL
     AND coalesce(b.status, 'pending') IN ('pending', 'confirmed')
     AND NOT booking_slot_time_parseable(b.demo_time);

  UPDATE bookings b
     SET timezone = coalesce(nullif(btrim(r.timezone), ''), 'America/Los_Angeles'),
         start_at = booking_slot_start(b.demo_date, b.demo_time, r.timezone, 11),
         end_at   = booking_slot_start(b.demo_date, b.demo_time, r.timezone, 11)
                    + make_interval(hours => coalesce((SELECT d.duration_hours FROM demos d WHERE d.booking_id = b.id LIMIT 1), 3))
    FROM retailers r
   WHERE r.id = b.retailer_id
     AND b.start_at IS NULL AND b.demo_date IS NOT NULL
     AND coalesce(b.status, 'pending') IN ('pending', 'confirmed');
  GET DIAGNOSTICS v_done = ROW_COUNT;

  SELECT count(*) INTO v_null
    FROM bookings b
   WHERE b.start_at IS NULL AND coalesce(b.status, 'pending') IN ('pending', 'confirmed');

  RAISE NOTICE '0074 backfill: % pending/confirmed booking(s) got start_at/end_at/timezone; % of those used the 11:00 default (unparseable demo_time); % left NULL (no demo_date)', v_done, v_defaulted, v_null;
END $$;

COMMIT;

-- ---------------------------------------------------------------------------------------------
-- Post-condition: the catalogs must show the intended end state, or this migration has failed.
-- ---------------------------------------------------------------------------------------------
DO $$
DECLARE
  v_col text; v_fn text; v_role text; v_n integer; v_ts timestamptz; v_cols text;
BEGIN
  FOREACH v_col IN ARRAY ARRAY['schedule_revision', 'needs_electricity', 'start_at', 'end_at', 'timezone', 'reschedule_proposal_version'] LOOP
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'bookings' AND column_name = v_col) THEN
      RAISE EXCEPTION 'POST-CONDITION FAILED: bookings.% is missing', v_col;
    END IF;
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'coi_verifications' AND column_name = 'brand_note') THEN
    RAISE EXCEPTION 'POST-CONDITION FAILED: coi_verifications.brand_note is missing';
  END IF;

  -- Outbox tables: exist, RLS on, no browser-role grants, service_role can write.
  FOREACH v_col IN ARRAY ARRAY['notification_events', 'notification_deliveries'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = v_col AND c.relrowsecurity) THEN
      RAISE EXCEPTION 'POST-CONDITION FAILED: % missing or RLS not enabled', v_col;
    END IF;
    SELECT count(*) INTO v_n FROM information_schema.role_table_grants
     WHERE table_schema = 'public' AND table_name = v_col AND grantee IN ('anon', 'authenticated');
    IF v_n <> 0 THEN RAISE EXCEPTION 'POST-CONDITION FAILED: % browser-role grant(s) remain on %', v_n, v_col; END IF;
    IF NOT has_table_privilege('service_role', 'public.' || v_col, 'INSERT') THEN
      RAISE EXCEPTION 'POST-CONDITION FAILED: service_role cannot INSERT into %', v_col;
    END IF;
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.notification_events'::regclass AND conname = 'notification_events_once' AND contype = 'u') THEN
    RAISE EXCEPTION 'POST-CONDITION FAILED: notification_events_once (kind, transition_id) is absent';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.notification_deliveries'::regclass AND contype = 'u'
                   AND pg_get_constraintdef(oid) ILIKE '%(dedupe_key)%') THEN
    RAISE EXCEPTION 'POST-CONDITION FAILED: notification_deliveries.dedupe_key is not UNIQUE';
  END IF;
  IF to_regclass('public.demo_notifications') IS NOT NULL THEN
    RAISE EXCEPTION 'POST-CONDITION FAILED: demo_notifications (0073) still exists';
  END IF;

  -- Triggers.
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_booking_notification_events' AND tgrelid = 'public.bookings'::regclass AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'POST-CONDITION FAILED: trg_booking_notification_events is not installed on bookings';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_booking_slot_snapshot' AND tgrelid = 'public.bookings'::regclass AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'POST-CONDITION FAILED: trg_booking_slot_snapshot is not installed on bookings';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_coi_notification_events' AND tgrelid = 'public.coi_verifications'::regclass AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'POST-CONDITION FAILED: trg_coi_notification_events is not installed on coi_verifications';
  END IF;
  -- The capacity move trigger (0070) is what accept_reschedule relies on; it must still be there.
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_enforce_slot_capacity_move' AND tgrelid = 'public.bookings'::regclass AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'POST-CONDITION FAILED: trg_enforce_slot_capacity_move (0070) is not installed on bookings';
  END IF;
  SELECT string_agg(a.attname, ',' ORDER BY a.attname) INTO v_cols
    FROM pg_trigger t JOIN unnest(t.tgattr::int2[]) AS u(attnum) ON true
    JOIN pg_attribute a ON a.attrelid = t.tgrelid AND a.attnum = u.attnum
   WHERE t.tgname = 'trg_booking_notification_events' AND t.tgrelid = 'public.bookings'::regclass;
  IF v_cols IS DISTINCT FROM 'status' THEN
    RAISE EXCEPTION 'POST-CONDITION FAILED: trg_booking_notification_events fires on (%) not (status)', coalesce(v_cols, '<none>');
  END IF;

  -- review_coi_verification: exactly the 6-arg signature (the 5-arg overload would make rpc/ calls ambiguous).
  SELECT count(*) INTO v_n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'review_coi_verification';
  IF v_n <> 1 OR NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = 'public.review_coi_verification(uuid, text, text, text, date, text)'::regprocedure) THEN
    RAISE EXCEPTION 'POST-CONDITION FAILED: review_coi_verification must exist exactly once, as the 6-arg (…, p_expiry date, p_brand_note text) form; found % overload(s)', v_n;
  END IF;

  -- RPCs + audit: exist, SECURITY DEFINER, service_role only.
  FOREACH v_fn IN ARRAY ARRAY['public.propose_reschedule(uuid, uuid, date, text)', 'public.accept_reschedule(uuid, uuid, integer)',
                              'public.decline_reschedule(uuid, uuid, integer)', 'public.schedule_mismatches()',
                              'public.review_coi_verification(uuid, text, text, text, date, text)'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = v_fn::regprocedure AND prosecdef) THEN
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

  -- booking_slot_start parses both grammars the app writes, and defaults the unparseable.
  v_ts := booking_slot_start(DATE '2026-07-15', '3:00 PM', 'America/Los_Angeles');
  IF v_ts IS DISTINCT FROM TIMESTAMPTZ '2026-07-15 22:00:00+00' THEN
    RAISE EXCEPTION 'POST-CONDITION FAILED: booking_slot_start(''3:00 PM'', PDT) = %, expected 2026-07-15 22:00Z', v_ts;
  END IF;
  v_ts := booking_slot_start(DATE '2026-01-15', '13:00', 'America/Los_Angeles');
  IF v_ts IS DISTINCT FROM TIMESTAMPTZ '2026-01-15 21:00:00+00' THEN
    RAISE EXCEPTION 'POST-CONDITION FAILED: booking_slot_start(''13:00'', PST) = %, expected 2026-01-15 21:00Z', v_ts;
  END IF;
  v_ts := booking_slot_start(DATE '2026-01-15', 'noonish', 'America/Los_Angeles');
  IF v_ts IS DISTINCT FROM TIMESTAMPTZ '2026-01-15 19:00:00+00' THEN
    RAISE EXCEPTION 'POST-CONDITION FAILED: booking_slot_start(unparseable) = %, expected the 11:00 default (19:00Z)', v_ts;
  END IF;
  IF booking_slot_start(DATE '2026-01-15', '12:00 AM', 'UTC') IS DISTINCT FROM TIMESTAMPTZ '2026-01-15 00:00:00+00'
     OR booking_slot_start(DATE '2026-01-15', '12:00 PM', 'UTC') IS DISTINCT FROM TIMESTAMPTZ '2026-01-15 12:00:00+00' THEN
    RAISE EXCEPTION 'POST-CONDITION FAILED: booking_slot_start mishandles 12 AM / 12 PM';
  END IF;

  -- The audit runs (and every existing pair agrees, or the operator must know before go-live).
  SELECT count(*) INTO v_n FROM schedule_mismatches();
  IF v_n > 0 THEN
    RAISE WARNING '0074: schedule_mismatches() reports % future booking/demo disagreement(s) — run tests/schedule_audit.mjs and reconcile', v_n;
  END IF;
END $$;

-- ---------------------------------------------------------------------------------------------
-- Post-condition 2 (rolls itself back): review_coi_verification stores brand_note with the decision,
-- a note-less call still works (default NULL), an unsafe note is refused before any status change.
-- The rejection inside the probe also fires trg_coi_notification_events; that event row is rolled
-- back with the probe.
-- ---------------------------------------------------------------------------------------------
do $$
declare
  v_bid  uuid;
  v_vid  uuid := gen_random_uuid();
  v_slug text := '__pc_brandnote_' || replace(gen_random_uuid()::text, '-', '');
  v_note text;
  v_stat text;
begin
  insert into brands (email, company_name) values (v_slug || '@invalid.test', 'brand_note probe')
  returning id into v_bid;
  perform finalize_coi_upload(v_bid, v_vid, 'brands/' || v_bid || '/' || v_vid || '.pdf', 'sha-x', null, 'pending');

  -- an unsafe note is refused and the record is untouched
  begin
    perform review_coi_verification(v_vid, 'rejected', 'probe@invalid.test', null, null, E'bad\x01note');
    raise exception 'POST-CONDITION FAILED: a note with a control character was accepted';
  exception
    when check_violation then null;
    when others then
      if sqlerrm like 'POST-CONDITION FAILED%' then raise; end if;
      raise exception 'POST-CONDITION FAILED: unexpected error on unsafe note (% / %)', sqlstate, sqlerrm;
  end;
  select status into v_stat from coi_verifications where id = v_vid;
  if v_stat <> 'pending' then
    raise exception 'POST-CONDITION FAILED: refused note still changed status to %', v_stat;
  end if;

  -- a rejection with a note stores the trimmed note alongside the decision
  perform review_coi_verification(v_vid, 'rejected', 'probe@invalid.test', 'private', null, E'  Wrong insured party.\r\nPlease re-upload.  ');
  select brand_note, status into v_note, v_stat from coi_verifications where id = v_vid;
  if v_stat <> 'rejected' or v_note is distinct from E'Wrong insured party.\nPlease re-upload.' then
    raise exception 'POST-CONDITION FAILED: brand_note=% status=% after rejection with note', v_note, v_stat;
  end if;

  raise exception 'POSTCONDITION_ROLLBACK';
exception
  when others then
    if sqlerrm = 'POSTCONDITION_ROLLBACK' then
      raise notice 'Release A §6: review_coi_verification stores brand_note with the decision, refuses unsafe notes before any status change; probe rolled back';
    else
      raise;
    end if;
end $$;
