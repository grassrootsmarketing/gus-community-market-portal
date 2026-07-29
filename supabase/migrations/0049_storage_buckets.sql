-- 0049_storage_buckets.sql — R1: make Storage reproducible from source control.
--
-- WHY THIS EXISTS: across migrations 0000-0048 there was NO executable bucket creation. Every
-- reference was prose (0000 L250 "not captured", 0004 L27/L33 a commented-out INSERT). A clean
-- project therefore could not reproduce COI file storage, which is a closed-launch requirement.
--
-- VISIBILITY DECISIONS — approved by Codex, not chosen unilaterally:
--   coi-docs     PRIVATE     certificates carry legal entity names, addresses, policy numbers,
--                            insurers and limits. Served ONLY via /api/coi-file + short-lived
--                            signed URL.
--   avatars      PUBLIC READ retailer/brand logos, intended for public display.
--   policy-docs  PUBLIC READ retailer demo policies, customer-facing by design.
--
-- SECURITY MODEL: the bucket's `public` flag carries the read decision; storage.objects carries RLS
-- with NO policies for anon/authenticated. RLS enabled + zero policies = deny-all for those roles,
-- while service_role bypasses RLS entirely. So:
--   * anonymous/authenticated upload, replace, delete and LIST are denied on all three buckets;
--   * object reads on the two public buckets are served by the public-object path, not by a policy;
--   * every application write goes through a server handler using the validated service binding.
-- We deliberately do NOT write a storage.objects policy keyed on a caller-supplied path — Codex
-- §4.10 forbids it, and it is the classic way this gets reopened later.
--
-- Idempotent: safe to re-run; re-running updates limits rather than erroring.

begin;

-- ---------------------------------------------------------------------------
-- 1. Buckets
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'coi-docs', 'coi-docs', false, 10485760,                       -- 10 MB
  array['application/pdf','image/jpeg','image/png','image/webp']
)
on conflict (id) do update set
  public             = excluded.public,
  file_size_limit    = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'avatars', 'avatars', true, 2097152,                           -- 2 MB
  array['image/png','image/jpeg','image/webp','image/gif']
)
on conflict (id) do update set
  public             = excluded.public,
  file_size_limit    = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'policy-docs', 'policy-docs', true, 5242880,                   -- 5 MB
  array['application/pdf','image/png','image/jpeg']
)
on conflict (id) do update set
  public             = excluded.public,
  file_size_limit    = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- ---------------------------------------------------------------------------
-- 2. Object-level posture
-- ---------------------------------------------------------------------------
-- NOTE: storage.objects is owned by supabase_storage_admin, not by the role the SQL editor or a
-- normal migration runs as. ALTER TABLE storage.objects therefore fails with 42501
-- "must be owner of table objects". That is a platform boundary, not something to work around.
--
-- It is also unnecessary: Supabase ships storage.objects with RLS already enabled. What matters
-- for us is that NO policy grants anon/authenticated access to our buckets — and since we create
-- no such policy, the default is deny. We assert both facts instead of trying to set them.

do $$
declare
  v_rls  boolean;
  v_open integer;
begin
  select c.relrowsecurity into v_rls
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'storage' and c.relname = 'objects';

  if v_rls is distinct from true then
    raise exception 'PRE-CONDITION FAILED: RLS is not enabled on storage.objects. Enable it via the Supabase dashboard (Storage -> Policies) before continuing; this migration cannot set it.';
  end if;

  select count(*) into v_open
  from pg_policies
  where schemaname = 'storage' and tablename = 'objects'
    and ('anon' = any(roles) or 'authenticated' = any(roles) or 'public' = any(roles));

  if v_open > 0 then
    raise warning 'REVIEW: % storage.objects policy(ies) grant anon/authenticated/public access. On a clean project this should be 0. Verify none of them targets coi-docs.', v_open;
  end if;
end $$;

-- Intentionally NO CREATE POLICY statements.
-- Deny-by-default for anon/authenticated IS the control. Server code uses service_role.
-- Public READ on avatars/policy-docs is carried by the bucket's `public` flag above, which is
-- served by the storage API's public-object path and does not require a policy.

commit;

-- ---------------------------------------------------------------------------
-- 3. Post-conditions — raise rather than silently drift
-- ---------------------------------------------------------------------------
do $$
declare
  v_coi_public    boolean;
  v_avatar_pub    boolean;
  v_policy_pub    boolean;
  v_open_policies integer;
begin
  select public into v_coi_public from storage.buckets where id = 'coi-docs';
  select public into v_avatar_pub from storage.buckets where id = 'avatars';
  select public into v_policy_pub from storage.buckets where id = 'policy-docs';

  if v_coi_public is distinct from false then
    raise exception 'POST-CONDITION FAILED: coi-docs must be private';
  end if;
  if v_avatar_pub is distinct from true then
    raise exception 'POST-CONDITION FAILED: avatars must be public-read';
  end if;
  if v_policy_pub is distinct from true then
    raise exception 'POST-CONDITION FAILED: policy-docs must be public-read';
  end if;

  select count(*) into v_open_policies
  from pg_policies
  where schemaname = 'storage'
    and tablename = 'objects'
    and ('anon' = any(roles) or 'authenticated' = any(roles));

  if v_open_policies > 0 then
    raise warning 'REVIEW: % storage.objects policy(ies) grant anon/authenticated access. Confirm none apply to demohub buckets.', v_open_policies;
  end if;
end $$;
