-- 0090_brands_products_version.sql
-- ============================================================================
-- Database-owned version for a brand's product catalog (Codex product-list closure review PL-C1, 2026-10-07).
--
-- The catalog save is a compare-and-set: the client sends the version it loaded, the write applies only if that
-- is still the current version, and a mismatch is a 409 with the current list. The first implementation used
-- brands.updated_at as that version. Two defects: (1) PostgREST returns the timestamp with microseconds and the
-- application compared a millisecond rounding of it, so a freshly loaded list could conflict with itself;
-- (2) the application clock set the new value, so two saves inside one millisecond could leave the version
-- unchanged and admit a stale third write.
--
-- Fix: an integer revision the DATABASE owns.
--   * brands.products_version bigint, starts at 0.
--   * A BEFORE UPDATE trigger bumps it by exactly one whenever products actually changes (IS DISTINCT FROM), and
--     otherwise keeps the OLD value. Whatever a client sends for products_version in an UPDATE is overwritten, so
--     the version can never be set, lowered or reused by any writer; it only moves forward, one step per change.
--   * The application compares on this integer (products_version=eq.N) and returns the persisted new value.
-- updated_at keeps its existing meaning (any profile change) and is no longer a concurrency token.
--
-- Idempotent. No row rewrites beyond the column default.
-- ============================================================================

begin;

alter table public.brands add column if not exists products_version bigint not null default 0;

create or replace function public.brands_products_version_bump()
returns trigger
language plpgsql
as $$
begin
  if new.products is distinct from old.products then
    new.products_version := coalesce(old.products_version, 0) + 1;
  else
    new.products_version := coalesce(old.products_version, 0);
  end if;
  return new;
end $$;

drop trigger if exists brands_products_version_bump on public.brands;
create trigger brands_products_version_bump
  before update on public.brands
  for each row execute function public.brands_products_version_bump();

do $$
declare v bigint; v2 bigint; v3 bigint; v_id uuid;
begin
  -- postcondition: the trigger bumps on a products change, holds otherwise, and ignores a client-supplied value
  insert into public.brands (email, company_name, products) values ('postcondition-0090@fixture.invalid', 'pc', '[]'::jsonb) returning brands.id, brands.products_version into v_id, v;
  update public.brands set products = '[{"name":"x"}]'::jsonb where brands.id = v_id returning brands.products_version into v2;
  update public.brands set company_name = 'pc2', products_version = 999 where brands.id = v_id returning brands.products_version into v3;
  delete from public.brands where brands.id = v_id;
  if v <> 0 or v2 <> 1 or v3 <> 1 then raise exception '0090 postcondition: versions were %, %, % (expected 0, 1, 1)', v, v2, v3; end if;
end $$;

commit;
