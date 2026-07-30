-- 0057_missing_runtime_columns.sql
-- ============================================================================
-- Three more columns that live application code reads and writes, and that the schema
-- does not have. Found by tools/check-js-columns.mjs, which was written after 0056
-- because the SQL checker cannot see column names that exist only in JS strings.
--
-- 1. bookings.stripe_session_id      — PAYMENT PATH
--    api/checkout.js:191 writes it after creating a Stripe Checkout Session:
--        PATCH bookings?id=eq.<id>  { stripe_session_id: session.id }
--    api/_checkout-guard.js:9 reads it back to decide whether an in-flight session can
--    be reused instead of opening a second one.
--    The write is wrapped in Promise.allSettled, so it fails SILENTLY — no log, no
--    throw. The read then 400s. Net effect: a brand who returns to an abandoned
--    checkout gets a NEW Stripe session against the same bookings, because the guard
--    can never see that one already exists.
--    This one is added, not removed: both sides are intentional and current.
--
-- 2/3. internal_contacts.notification_prefs, internal_contacts.venue_ids
--    Read by three handlers to route staff notifications:
--        api/booking.js:712        select=id,name,email,notification_prefs,venue_ids
--        api/coi-enforcement.js:126 select=email,notification_prefs,venue_ids
--        api/stripe-webhook.js:380  select=id,name,email,notification_prefs,venue_ids
--    All three 400 today, so staff notification routing does not work at all: no
--    per-contact opt-outs, no per-venue scoping. Every one of those call sites treats a
--    missing prefs object as "notify" (`const p = s.notification_prefs || {}`), so the
--    failure mode once the column exists is inclusive, not silent suppression.
--
--    venue_ids mirrors retailer_admins.venue_ids (added in 0025), same type, same
--    meaning: NULL means every venue, a non-empty array scopes to those venues.
--
-- WHY THE PATTERN KEEPS REPEATING: PostgREST returns 400 for an unknown column, and
-- most of these call sites are inside try/catch or allSettled. A schema mismatch
-- therefore surfaces as "no staff email arrived" or "a second checkout session opened",
-- never as "column does not exist". The two new checkers exist so these are found by a
-- command instead of by a customer.
--
-- Idempotent.
-- ============================================================================

begin;

alter table public.bookings          add column if not exists stripe_session_id  text;
alter table public.internal_contacts add column if not exists notification_prefs jsonb;
alter table public.internal_contacts add column if not exists venue_ids          uuid[];

-- Partial: only bookings with an in-flight session are ever looked up this way.
create index if not exists bookings_stripe_session_id_idx
  on public.bookings (stripe_session_id) where stripe_session_id is not null;

-- GIN for array containment, matching the retailer_admins.venue_ids index from 0025.
create index if not exists internal_contacts_venue_scope_idx
  on public.internal_contacts using gin (venue_ids) where venue_ids is not null;

commit;

-- ---------------------------------------------------------------------------
-- POST-CONDITION: perform the reads and writes the handlers perform.
-- ---------------------------------------------------------------------------
do $$
declare
  v_rid uuid; v_vid uuid; v_bid uuid; v_cid uuid;
  v_slug text := '__postcondition_' || replace(gen_random_uuid()::text, '-', '');
  v_got text; v_prefs jsonb; v_venues uuid[];
begin
  insert into retailers (slug, name, billing_email, billing_tier, billing_status)
  values (v_slug, 'runtime cols probe', v_slug || '@invalid.test', 'solo', 'active') returning id into v_rid;
  insert into venues (retailer_id, name, address, demo_fee)
  values (v_rid, 'probe venue', '1 Probe St', 30) returning id into v_vid;
  insert into bookings (retailer_id, venue_id, brand_name, contact_name, contact_email,
                        demo_date, demo_time, status, payment_status)
  values (v_rid, v_vid, 'probe', 'probe', v_slug || '@invalid.test',
          current_date + 30, '10:00', 'pending_payment', 'unpaid') returning id into v_bid;

  -- api/checkout.js writes this, api/_checkout-guard.js reads it back.
  update bookings set stripe_session_id = 'cs_test_postcondition' where id = v_bid;
  select stripe_session_id into v_got from bookings where id = v_bid;
  if v_got is distinct from 'cs_test_postcondition' then
    raise exception 'POST-CONDITION FAILED: bookings.stripe_session_id did not round-trip (got %)', coalesce(v_got, '<null>');
  end if;

  -- staff notification routing
  insert into internal_contacts (retailer_id, name, email, notification_prefs, venue_ids)
  values (v_rid, 'probe staff', v_slug || '@invalid.test', '{"booking_created": false}'::jsonb, array[v_vid])
  returning id into v_cid;
  select notification_prefs, venue_ids into v_prefs, v_venues from internal_contacts where id = v_cid;
  if v_prefs is null or v_prefs->>'booking_created' is distinct from 'false' then
    raise exception 'POST-CONDITION FAILED: internal_contacts.notification_prefs did not round-trip (got %)', coalesce(v_prefs::text, '<null>');
  end if;
  if v_venues is null or array_length(v_venues, 1) <> 1 then
    raise exception 'POST-CONDITION FAILED: internal_contacts.venue_ids did not round-trip';
  end if;

  raise exception 'POSTCONDITION_ROLLBACK';
exception
  when others then
    if sqlerrm = 'POSTCONDITION_ROLLBACK' then
      raise notice '0057: executed post-conditions passed (checkout session id + staff routing round-trip); probe rolled back';
    else
      raise;
    end if;
end $$;
