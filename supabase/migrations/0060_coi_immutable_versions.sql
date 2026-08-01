-- 0060_coi_immutable_versions.sql
-- ============================================================================
-- Codex v6-FINAL blocking finding B1: a verification record is not bound to immutable
-- document bytes.
--
-- THE ATTACK HE FOUND, which my 0059 fix does not stop:
--   1. upload A  -> pending record A, bytes at brands/<id>.pdf
--   2. upload B  -> OVERWRITES the same path, pending record B
--   3. owner REJECTS B
--   4. A is now the newest UNREVIEWED row, because B has been decided
--   5. owner-coi-view(A) signs the shared path and shows B's bytes
--   6. approving A passes 0059's check -- no newer *unreviewed* row exists
--   7. the brand becomes approved although the current document was REJECTED
--
-- 0059 made staleness a question about review ORDER. It should have been a question
-- about IDENTITY: is this record the brand's current document? My route test stopped
-- immediately after step 3, one operation short of the step that fails.
--
-- WHAT THIS MIGRATION CHANGES
--   * every upload gets its own immutable object path, keyed by verification id, so
--     bytes are never overwritten and a record always refers to the document reviewed
--   * brands.current_coi_verification_id is the single authoritative pointer
--   * finalize_coi_upload() does storage-pointer + audit-row + brand-status in ONE
--     transaction, so an upload can never report success without a durable review row
--   * review_coi_verification() approves ONLY the current version, and refuses to
--     re-decide a record that already has a decision
--
-- Nothing here deletes bytes. B2 (durable removal) builds on this and is a separate
-- migration, because detaching and deleting are different failure domains.
--
-- Idempotent.
-- ============================================================================

begin;

-- --- immutable identity on every verification row --------------------------
alter table public.coi_verifications add column if not exists storage_path   text;
alter table public.coi_verifications add column if not exists content_sha256 text;
alter table public.coi_verifications add column if not exists superseded_at  timestamptz;
alter table public.coi_verifications add column if not exists superseded_by  uuid;
alter table public.coi_verifications add column if not exists removed_at     timestamptz;
alter table public.coi_verifications add column if not exists removed_by     text;

-- One object path is owned by exactly one verification row. This is what makes
-- "the bytes I reviewed" a meaningful phrase.
create unique index if not exists coi_verifications_storage_path_uniq
  on public.coi_verifications (storage_path) where storage_path is not null;

-- --- the authoritative current-document pointer ---------------------------
alter table public.brands add column if not exists current_coi_verification_id uuid;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'brands_current_coi_fk') then
    alter table public.brands
      add constraint brands_current_coi_fk
      foreign key (current_coi_verification_id)
      references public.coi_verifications(id) on delete set null;
  end if;
end $$;

create index if not exists coi_verifications_open_queue_idx
  on public.coi_verifications (created_at desc)
  where review_decision is null and superseded_at is null and removed_at is null;

-- ---------------------------------------------------------------------------
-- finalize_coi_upload: one transaction, or nothing.
--
-- The route uploads to a UNIQUE path first, then calls this. If this fails, the caller
-- deletes the object it just wrote and returns failure. That ordering matters: a brand
-- must never be left pointing at bytes with no audit row, and must never be told an
-- upload succeeded when no reviewable record exists.
-- ---------------------------------------------------------------------------
create or replace function public.finalize_coi_upload(
  p_brand_id       uuid,
  p_verification_id uuid,
  p_storage_path   text,
  p_content_sha256 text,
  p_expires        date default null,
  p_status         text default 'pending'
) returns public.coi_verifications
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.coi_verifications;
begin
  if p_brand_id is null or p_verification_id is null or p_storage_path is null then
    raise exception 'brand, verification id and storage path are required' using errcode = 'check_violation';
  end if;
  if p_status not in ('pending','flagged','passed') then
    raise exception 'status must be pending, flagged or passed' using errcode = 'check_violation';
  end if;

  -- Serialise against a concurrent upload or review for this brand.
  perform 1 from brands where id = p_brand_id for update;

  -- Every older OPEN version is superseded by this one. Superseded rows can never be
  -- approved, so a reviewer looking at a stale queue entry cannot grant coverage.
  update coi_verifications
     set superseded_at = now(), superseded_by = p_verification_id
   where brand_id = p_brand_id
     and id <> p_verification_id
     and review_decision is null
     and superseded_at is null
     and removed_at is null;

  insert into coi_verifications (id, brand_id, coi_url, storage_path, content_sha256, status)
  values (p_verification_id, p_brand_id, p_storage_path, p_storage_path, p_content_sha256, p_status)
  on conflict (id) do update
    set storage_path   = excluded.storage_path,
        coi_url        = excluded.coi_url,
        content_sha256 = excluded.content_sha256,
        status         = excluded.status
  returning * into v_row;

  update brands
     set current_coi_verification_id = p_verification_id,
         default_coi_url             = p_storage_path,
         default_coi_expires         = coalesce(p_expires, default_coi_expires),
         coi_verification_status     = p_status
   where id = p_brand_id;

  return v_row;
end $$;

revoke all on function public.finalize_coi_upload(uuid, uuid, text, text, date, text) from public, anon, authenticated;
grant execute on function public.finalize_coi_upload(uuid, uuid, text, text, date, text) to service_role;

-- ---------------------------------------------------------------------------
-- review_coi_verification: approve ONLY the current version, decide ONLY once.
-- ---------------------------------------------------------------------------
create or replace function public.review_coi_verification(
  p_verification_id uuid,
  p_decision        text,
  p_reviewer        text,
  p_notes           text default null
) returns public.coi_verifications
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row   public.coi_verifications;
  v_brand public.brands;
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

  select * into v_row from coi_verifications where id = p_verification_id for update;
  if not found then
    raise exception 'verification record not found' using errcode = 'no_data_found';
  end if;
  if v_row.brand_id is null then
    raise exception 'verification record has no brand' using errcode = 'check_violation';
  end if;

  -- IMMUTABLE REVIEWS. A decided record is history. Changing approved to rejected by
  -- overwriting reviewed_at/reviewed_by destroys the audit trail that makes the decision
  -- meaningful, and lets one actor silently reverse another. A new decision requires a
  -- new upload.
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
    -- STALE IS AN IDENTITY QUESTION, NOT AN ORDERING ONE. This is the correction to 0059.
    -- Approval is permitted only for the brand's CURRENT version. Whether some other row
    -- happens to be reviewed or unreviewed is irrelevant.
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
         status          = case when p_decision = 'approved' then 'approved' else 'rejected' end
   where id = p_verification_id
  returning * into v_row;

  -- Only the current version may move the brand's status. Rejecting a superseded record
  -- is allowed for housekeeping but must not change what the brand is entitled to.
  if v_brand.current_coi_verification_id is not distinct from v_row.id then
    update brands
       set coi_verification_status = case when p_decision = 'approved' then 'approved' else 'rejected' end
     where id = v_row.brand_id;
  end if;

  return v_row;
end $$;

revoke all on function public.review_coi_verification(uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.review_coi_verification(uuid, text, text, text) to service_role;

commit;

-- ---------------------------------------------------------------------------
-- POST-CONDITION: execute Codex's exact attack, and prove it is refused.
-- ---------------------------------------------------------------------------
do $$
declare
  v_bid uuid;
  v_a   uuid := gen_random_uuid();
  v_b   uuid := gen_random_uuid();
  v_slug text := '__postcondition_' || replace(gen_random_uuid()::text, '-', '');
  v_st  text;
  v_row public.coi_verifications;
begin
  insert into brands (email, company_name) values (v_slug || '@invalid.test', 'B1 probe')
  returning id into v_bid;

  -- Upload A, then upload B. Distinct immutable paths.
  perform finalize_coi_upload(v_bid, v_a, 'brands/' || v_bid || '/' || v_a || '.pdf', 'sha-a', null, 'pending');
  perform finalize_coi_upload(v_bid, v_b, 'brands/' || v_bid || '/' || v_b || '.pdf', 'sha-b', null, 'pending');

  select superseded_at is not null into v_st from coi_verifications where id = v_a;
  if (select superseded_at from coi_verifications where id = v_a) is null then
    raise exception 'POST-CONDITION FAILED: upload B did not supersede A';
  end if;

  -- CODEX'S SEQUENCE: reject B, then try to approve A.
  v_row := review_coi_verification(v_b, 'rejected', 'probe@invalid.test', null);
  begin
    perform review_coi_verification(v_a, 'approved', 'probe@invalid.test', null);
    raise exception 'POST-CONDITION FAILED: approving the SUPERSEDED record A succeeded after B was rejected';
  exception
    when check_violation then null;
    when others then
      if sqlerrm like 'POST-CONDITION FAILED%' then raise; end if;
      raise exception 'POST-CONDITION FAILED: unexpected error on stale approval (% / %)', sqlstate, sqlerrm;
  end;

  select coi_verification_status into v_st from brands where id = v_bid;
  if v_st <> 'rejected' then
    raise exception 'POST-CONDITION FAILED: brand is % after its current document was rejected', v_st;
  end if;

  -- RE-DECISION must be refused.
  begin
    perform review_coi_verification(v_b, 'approved', 'probe@invalid.test', null);
    raise exception 'POST-CONDITION FAILED: a decided record was re-decided';
  exception
    when check_violation then null;
    when others then
      if sqlerrm like 'POST-CONDITION FAILED%' then raise; end if;
      raise exception 'POST-CONDITION FAILED: unexpected error on re-decision (% / %)', sqlstate, sqlerrm;
  end;

  -- A fresh upload becomes current and approves normally.
  declare v_c uuid := gen_random_uuid();
  begin
    perform finalize_coi_upload(v_bid, v_c, 'brands/' || v_bid || '/' || v_c || '.pdf', 'sha-c', null, 'pending');
    select coi_verification_status into v_st from brands where id = v_bid;
    if v_st <> 'pending' then
      raise exception 'POST-CONDITION FAILED: a replacement left the brand at %, not pending', v_st;
    end if;
    v_row := review_coi_verification(v_c, 'approved', 'probe@invalid.test', null);
    if v_row.review_decision <> 'approved' then
      raise exception 'POST-CONDITION FAILED: the current record could not be approved';
    end if;
    select coi_verification_status into v_st from brands where id = v_bid;
    if v_st <> 'approved' then
      raise exception 'POST-CONDITION FAILED: brand is % after approving its current document', v_st;
    end if;
  end;

  raise exception 'POSTCONDITION_ROLLBACK';
exception
  when others then
    if sqlerrm = 'POSTCONDITION_ROLLBACK' then
      raise notice 'B1: immutable versions proven (supersede on upload, reject-newest/approve-old REFUSED, re-decision refused, fresh upload approves); probe rolled back';
    else
      raise;
    end if;
end $$;
