-- 0061_coi_durable_removal.sql
-- ============================================================================
-- Codex v6-FINAL blocking finding B2: "Remove COI" does not delete the user's document.
--
-- WHAT REMOVE ACTUALLY DID: patched the brand row to null default_coi_url and
-- default_coi_expires. It did not delete the object, did not reset
-- coi_verification_status, did not mark the verification record removed, and did not stop
-- owner-coi-view signing the retained path.
--
-- A certificate of insurance carries legal names, addresses, policy numbers, coverage
-- limits and signatures. A user-facing "remove" that leaves those bytes in storage,
-- still signable by an internal route, is a data-retention defect. It is not cleanup
-- cosmetics, and my test made it look fine by asserting only that a pointer was null.
--
-- ORDER OF OPERATIONS, and the reason for it:
--   DETACH FIRST, DELETE SECOND. Coverage must end the instant the brand asks, and a
--   storage failure must never be able to leave a brand covered. So the transaction below
--   clears entitlement and enqueues the object; the bytes go later, through a queue that
--   retries and stays visible while it fails.
--
-- A failed delete therefore surfaces as a pending or failed cleanup row, not as a 200 with
-- no evidence. That distinction is the whole point: "we could not delete it yet" and "it
-- is gone" must never look the same.
--
-- Idempotent.
-- ============================================================================

begin;

-- The durable, inspectable work queue. Rows persist while they fail, which is what makes
-- a stuck deletion visible instead of silent.
create table if not exists public.storage_cleanup_queue (
  id           uuid primary key default gen_random_uuid(),
  bucket       text not null,
  object_path  text not null,
  reason       text,
  requested_by text,
  status       text not null default 'pending' check (status in ('pending','done','failed')),
  attempts     int  not null default 0,
  last_error   text,
  created_at   timestamptz not null default now(),
  completed_at timestamptz
);

-- One live cleanup task per object. Re-requesting removal is safe and does not fan out.
create unique index if not exists storage_cleanup_queue_pending_uniq
  on public.storage_cleanup_queue (bucket, object_path) where status <> 'done';

create index if not exists storage_cleanup_queue_pending_idx
  on public.storage_cleanup_queue (created_at) where status = 'pending';

alter table public.storage_cleanup_queue enable row level security;
revoke all on public.storage_cleanup_queue from anon, authenticated;

-- ---------------------------------------------------------------------------
-- remove_current_coi: end coverage and enqueue the bytes, in one transaction.
-- ---------------------------------------------------------------------------
create or replace function public.remove_current_coi(
  p_brand_id uuid,
  p_actor    text
) returns table (removed_verification_id uuid, enqueued_path text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_brand public.brands;
  v_row   public.coi_verifications;
begin
  if p_brand_id is null then
    raise exception 'brand id is required' using errcode = 'check_violation';
  end if;

  select * into v_brand from brands where id = p_brand_id for update;
  if not found then
    raise exception 'brand not found' using errcode = 'no_data_found';
  end if;

  if v_brand.current_coi_verification_id is not null then
    select * into v_row from coi_verifications
     where id = v_brand.current_coi_verification_id for update;
  end if;

  -- Entitlement ends here, unconditionally, before any storage work is attempted.
  update brands
     set current_coi_verification_id = null,
         default_coi_url             = null,
         default_coi_expires         = null,
         default_coi_filename        = null,
         default_coi_mime            = null,
         coi_verification_status     = null
   where id = p_brand_id;

  if v_row.id is not null then
    update coi_verifications
       set removed_at = coalesce(removed_at, now()),
           removed_by = coalesce(removed_by, btrim(p_actor))
     where id = v_row.id;

    -- Audit metadata stays; the document does not.
    if v_row.storage_path is not null then
      insert into storage_cleanup_queue (bucket, object_path, reason, requested_by)
      values ('coi-docs', v_row.storage_path, 'coi_removed_by_brand', btrim(p_actor))
      on conflict do nothing;
    end if;
  end if;

  -- Any other version of this brand's certificate is also removed and enqueued. Switching
  -- file extension used to strand an older object at an older deterministic path; nothing
  -- of this brand's may survive a removal.
  insert into storage_cleanup_queue (bucket, object_path, reason, requested_by)
  select 'coi-docs', c.storage_path, 'coi_removed_by_brand_sweep', btrim(p_actor)
    from coi_verifications c
   where c.brand_id = p_brand_id
     and c.storage_path is not null
     and c.removed_at is null
  on conflict do nothing;

  update coi_verifications
     set removed_at = coalesce(removed_at, now()),
         removed_by = coalesce(removed_by, btrim(p_actor))
   where brand_id = p_brand_id and removed_at is null;

  return query select v_row.id, v_row.storage_path;
end $$;

revoke all on function public.remove_current_coi(uuid, text) from public, anon, authenticated;
grant execute on function public.remove_current_coi(uuid, text) to service_role;

-- Mark a queued object done or failed. Separate from the delete itself so the worker can
-- record a failure without losing the task.
create or replace function public.complete_storage_cleanup(
  p_id uuid, p_ok boolean, p_error text default null
) returns void
language sql
security definer
set search_path = public
as $$
  update storage_cleanup_queue
     set status       = case when p_ok then 'done' else 'failed' end,
         attempts     = attempts + 1,
         last_error   = case when p_ok then null else left(coalesce(p_error, ''), 300) end,
         completed_at = case when p_ok then now() else null end
   where id = p_id;
$$;

revoke all on function public.complete_storage_cleanup(uuid, boolean, text) from public, anon, authenticated;
grant execute on function public.complete_storage_cleanup(uuid, boolean, text) to service_role;

commit;

-- ---------------------------------------------------------------------------
-- POST-CONDITION: remove for real, and prove coverage ends and the bytes are queued.
-- ---------------------------------------------------------------------------
do $$
declare
  v_bid uuid;
  v_v   uuid := gen_random_uuid();
  v_slug text := '__postcondition_' || replace(gen_random_uuid()::text, '-', '');
  v_path text;
  v_n   int;
  v_st  text;
begin
  insert into brands (email, company_name) values (v_slug || '@invalid.test', 'B2 probe')
  returning id into v_bid;

  v_path := 'brands/' || v_bid || '/' || v_v || '.pdf';
  perform finalize_coi_upload(v_bid, v_v, v_path, 'sha-x', null, 'pending');
  perform review_coi_verification(v_v, 'approved', 'probe@invalid.test', null);

  select coi_verification_status into v_st from brands where id = v_bid;
  if v_st <> 'approved' then
    raise exception 'POST-CONDITION FAILED: setup did not leave the brand approved (%)', v_st;
  end if;

  perform remove_current_coi(v_bid, 'probe@invalid.test');

  -- Coverage must be gone immediately, without waiting for any storage operation.
  select coi_verification_status into v_st from brands where id = v_bid;
  if v_st is not null then
    raise exception 'POST-CONDITION FAILED: brand still has status % after removal', v_st;
  end if;
  if (select current_coi_verification_id from brands where id = v_bid) is not null then
    raise exception 'POST-CONDITION FAILED: current pointer survived removal';
  end if;
  if (select default_coi_url from brands where id = v_bid) is not null then
    raise exception 'POST-CONDITION FAILED: certificate path survived removal';
  end if;

  if (select removed_at from coi_verifications where id = v_v) is null then
    raise exception 'POST-CONDITION FAILED: the version was not marked removed';
  end if;

  select count(*) into v_n from storage_cleanup_queue
   where object_path = v_path and bucket = 'coi-docs' and status = 'pending';
  if v_n <> 1 then
    raise exception 'POST-CONDITION FAILED: expected exactly one pending cleanup task, found %', v_n;
  end if;

  -- A removed version can never be approved again.
  begin
    perform review_coi_verification(v_v, 'approved', 'probe@invalid.test', null);
    raise exception 'POST-CONDITION FAILED: a REMOVED record was reviewed';
  exception
    when check_violation then null;
    when others then
      if sqlerrm like 'POST-CONDITION FAILED%' then raise; end if;
      raise exception 'POST-CONDITION FAILED: unexpected error reviewing a removed record (% / %)', sqlstate, sqlerrm;
  end;

  -- Idempotent: removing twice does not duplicate the task or error.
  perform remove_current_coi(v_bid, 'probe@invalid.test');
  select count(*) into v_n from storage_cleanup_queue where object_path = v_path;
  if v_n <> 1 then
    raise exception 'POST-CONDITION FAILED: repeated removal produced % cleanup tasks', v_n;
  end if;

  raise exception 'POSTCONDITION_ROLLBACK';
exception
  when others then
    if sqlerrm = 'POSTCONDITION_ROLLBACK' then
      raise notice 'B2: removal proven (coverage ends immediately, version marked removed, exactly one cleanup task, removed record unreviewable, repeat is idempotent); probe rolled back';
    else
      raise;
    end if;
end $$;
