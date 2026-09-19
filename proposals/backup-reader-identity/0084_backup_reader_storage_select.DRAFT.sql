-- DRAFT — NOT APPLIED ANYWHERE. Proposal for Codex work order BAK-4 "restricted source identity".
-- Needs: David's approval, a test on demohub-rebuild-check, then (separately approved) demohub-prod.
-- It is kept outside demohub/supabase/migrations on purpose so it cannot be applied by accident.
--
-- Goal: the daily backup stops using the service key. It signs in as ONE dedicated Supabase Auth user and can
-- only SELECT (list + download) objects in the three Demohub buckets. No insert/update/delete. No other user,
-- and not anon, gains anything.
--
-- Why this is narrow in THIS database (static audit of migrations 0000–0083, 2026-09-19):
--   * no migration grants anything to `authenticated`; 110 statements revoke from it;
--   * no RLS policy names `authenticated` or uses auth.uid(); the app does not use Supabase Auth at all;
--   * 0049 creates no storage.objects policy, so today anon/authenticated have no object access.
--   A live grant audit on demohub-rebuild-check (tables, functions, policies visible to `authenticated`) is still
--   REQUIRED before approval — a Storage SELECT policy does not by itself make everything else read-only.
--
-- The principal is an immutable UUID chosen in advance and written here as a constant; the Auth user is created
-- with exactly this id (admin API `id` field) by David/Claude with approval, per project. It is never derived from
-- a caller-supplied path, metadata, email or "any authenticated user".

begin;

do $$
begin
  if exists (select 1 from pg_policies where schemaname = 'storage' and policyname in ('demohub_backup_reader_objects', 'demohub_backup_reader_buckets')) then
    raise exception 'backup reader policies already exist';
  end if;
end $$;

-- <BACKUP_PRINCIPAL_UUID> is replaced by the agreed constant before review; the draft must not run as-is.
create policy demohub_backup_reader_objects on storage.objects
  for select to authenticated
  using ( (select auth.uid()) = '<BACKUP_PRINCIPAL_UUID>'::uuid
          and bucket_id in ('coi-docs', 'policy-docs', 'avatars') );

create policy demohub_backup_reader_buckets on storage.buckets
  for select to authenticated
  using ( (select auth.uid()) = '<BACKUP_PRINCIPAL_UUID>'::uuid
          and id in ('coi-docs', 'policy-docs', 'avatars') );

-- Post-conditions: exactly these two policies mention authenticated in the storage schema, both SELECT-only.
do $$
declare n int; w int;
begin
  select count(*) into n from pg_policies where schemaname = 'storage' and policyname like 'demohub_backup_reader_%' and cmd = 'SELECT';
  select count(*) into w from pg_policies where schemaname = 'storage' and roles && array['authenticated','anon','public']::name[] and cmd <> 'SELECT';
  if n <> 2 then raise exception 'POST-CONDITION FAILED: expected 2 SELECT policies, found %', n; end if;
  if w <> 0 then raise exception 'POST-CONDITION FAILED: % write policy(ies) exist for anon/authenticated in storage', w; end if;
end $$;

commit;

-- Rollback (forward-only style: a new migration):  drop policy demohub_backup_reader_objects on storage.objects;
--                                                   drop policy demohub_backup_reader_buckets on storage.buckets;
--                                                   and delete/ban the Auth user.
