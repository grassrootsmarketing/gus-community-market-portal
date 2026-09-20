-- 0084_backup_reader_storage_select.sql
-- Codex storage-backup work order (2026-09-19), BAK-4 "restricted source identity". David approved 2026-09-20.
--
-- The daily uploaded-file backup no longer uses the service key. It signs in as ONE dedicated Supabase Auth user
-- (fixed, immutable id below; created per project through the Auth admin API, never by a migration) and may only
-- SELECT (list + download) objects in the three Demohub buckets. No INSERT/UPDATE/DELETE policy is added; no other
-- user and not anon gains anything. 0049 deliberately created no storage policy; these two are the only ones.
-- The principal is a constant, never a caller-supplied path, metadata, email or "any authenticated user".
--
-- Proven on demohub-rebuild-check (list/download ok; every write, move, copy and bucket change refused; no REST rows;
-- cannot widen its own role; a second authenticated user and anon see nothing): demohub-docs
-- evidence/backup/2026-09-19-reader-identity-test-project.md. Applied to demohub-prod 2026-09-20 through the guarded
-- paste (ledger head 0083, zero storage policies, exactly one Auth user, no public grants / definer functions for
-- authenticated).
--
-- Rollback (forward-only): a new migration dropping both policies, and delete the Auth user.

create policy demohub_backup_reader_objects on storage.objects
  for select to authenticated
  using ( (select auth.uid()) = '49245ab8-bc78-484e-b8ac-51b301a05553'::uuid
          and bucket_id in ('coi-docs', 'policy-docs', 'avatars') );

create policy demohub_backup_reader_buckets on storage.buckets
  for select to authenticated
  using ( (select auth.uid()) = '49245ab8-bc78-484e-b8ac-51b301a05553'::uuid
          and id in ('coi-docs', 'policy-docs', 'avatars') );

do $$
declare n int; w int;
begin
  select count(*) into n from pg_policies where schemaname = 'storage' and policyname like 'demohub_backup_reader_%' and cmd = 'SELECT' and roles = array['authenticated']::name[];
  select count(*) into w from pg_policies where schemaname = 'storage' and not (policyname like 'demohub_backup_reader_%' and cmd = 'SELECT');
  if n <> 2 then raise exception 'POST-CONDITION FAILED: expected 2 SELECT policies, found % — rolled back', n; end if;
  if w <> 0 then raise exception 'POST-CONDITION FAILED: % unexpected storage policy(ies) — rolled back', w; end if;
end $$;
