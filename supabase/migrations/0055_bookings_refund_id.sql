-- 0055_bookings_refund_id.sql
-- ============================================================================
-- LAUNCH BLOCKER on the refund path, found by the Step 4 adversarial ledger suite:
--   column "refund_id" of relation "bookings" does not exist   (42703)
--
-- public.bookings has refunded_at but no refund_id. Six migrations write both in the
-- same statement:
--
--   0029_payment_ledger.sql            UPDATE bookings SET ... refund_id = ..., refunded_at = now()
--   0030_payment_ledger_hardening.sql  "
--   0034_refund_rpcs.sql               "
--   0041_refund_event_fail_closed.sql  "
--   0042_refund_event_fail_closed_fix  "
--   0045_out_of_order_refund_events    "
--
-- Every one of those statements sits on the branch that runs when a refund SUCCEEDS.
-- So apply_refund_event() works right up until the moment it matters, then raises.
--
-- SAME ROOT CAUSE AS 0054. PL/pgSQL parses a function body at CREATE time but does not
-- bind identifiers, so a migration containing a reference to a non-existent column
-- applies cleanly and reports success. The error waits for the branch to execute.
--
-- WHY NOTHING CAUGHT IT
--   * both clean builds were green — they were identically broken
--   * the A/B manifest fingerprints MATCHED — a broken function hashes just as
--     consistently as a correct one
--   * the mocked suites never touch a real refund
--   * a probe that invoked every RPC once reported "no undefined columns", because
--     the dummy arguments never reached this branch. Body coverage is not branch
--     coverage, and treating one as the other is what let this survive.
--
-- THE FIX: add the column. The write is intentional — recording which Stripe refund
-- settled a booking, alongside refunded_at, which already exists. Removing the write
-- instead would discard the audit trail that the refund ledger is built to keep.
--
-- text, not uuid: this holds a Stripe identifier (re_...), not an internal key.
-- Nullable with no default: a booking that has never been refunded must be able to
-- say so by holding NULL, and backfilling a value would fabricate refund history.
--
-- Idempotent.
-- ============================================================================

begin;

alter table public.bookings add column if not exists refund_id text;

-- Partial index: the overwhelming majority of bookings are never refunded, so indexing
-- only the non-null rows keeps this small. Reconciliation looks bookings up BY the
-- Stripe refund id when an event arrives out of order, which is a real query pattern
-- in 0045, not a speculative one.
create index if not exists bookings_refund_id_idx
  on public.bookings (refund_id) where refund_id is not null;

commit;

-- ---------------------------------------------------------------------------
-- POST-CONDITION: execute the write, do not merely assert the column exists.
--
-- Checking information_schema for the column name would pass even if the column were
-- the wrong type for what the refund RPCs assign to it. This performs the actual
-- UPDATE those functions perform, on a probe row, and rolls it back.
-- ---------------------------------------------------------------------------
do $$
declare
  v_rid uuid;
  v_vid uuid;
  v_bid uuid;
  v_slug text := '__postcondition_' || replace(gen_random_uuid()::text, '-', '');
  v_got  text;
begin
  insert into retailers (slug, name, billing_email, billing_tier, billing_status)
  values (v_slug, 'refund_id probe', v_slug || '@invalid.test', 'solo', 'active')
  returning id into v_rid;

  insert into venues (retailer_id, name, address, demo_fee)
  values (v_rid, 'probe venue', '1 Probe St', 30) returning id into v_vid;

  insert into bookings (retailer_id, venue_id, brand_name, contact_name, contact_email,
                        demo_date, demo_time, status, payment_status)
  values (v_rid, v_vid, 'probe brand', 'probe', v_slug || '@invalid.test',
          current_date + 30, '10:00', 'pending_payment', 'unpaid')
  returning id into v_bid;

  -- Exactly the shape the six refund migrations use.
  begin
    update bookings
       set payment_status = 'refunded', refund_id = 're_postcondition_probe', refunded_at = now()
     where id = v_bid;
  exception when others then
    raise exception 'POST-CONDITION FAILED: the refund UPDATE still errors (% / %)', sqlstate, sqlerrm;
  end;

  select refund_id into v_got from bookings where id = v_bid;
  if v_got is distinct from 're_postcondition_probe' then
    raise exception 'POST-CONDITION FAILED: refund_id did not persist (got %)', coalesce(v_got, '<null>');
  end if;

  raise exception 'POSTCONDITION_ROLLBACK';
exception
  when others then
    if sqlerrm = 'POSTCONDITION_ROLLBACK' then
      raise notice 'bookings.refund_id: executed post-condition passed (refund UPDATE succeeds and persists); probe rolled back';
    else
      raise;
    end if;
end $$;
