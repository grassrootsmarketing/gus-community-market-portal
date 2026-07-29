-- 0000_baseline_true.sql
-- ============================================================================
-- REPLACES 0000_baseline_reconstructed.sql
--
-- PROVENANCE: generated from the live Demohub production schema
-- (ecapmcyumpjjgjwuokyv) on 2026-07-29 via a read-only catalog query, not by
-- reading application source. The previous baseline was hand-written from app
-- code and was missing at least 56 columns — including retailers.billing_email,
-- which is what broke the first clean-build attempt.
--
-- DELIBERATE OMISSIONS — production's posture is NOT copied wholesale:
--   * retailers_anon_read      (SELECT to anon, USING true) — NOT reproduced.
--     It exposes billing_email, stripe_customer_id, stripe_subscription_id,
--     stripe_account_id and cal_feed_key to any holder of the publishable key,
--     which is committed in a public repository.
--   * "anon select venues"     (SELECT to anon, USING true) — NOT reproduced.
--   * coi-docs bucket public=true — NOT reproduced; see 0049.
--   Whatever the public booking page needs from these tables must be served by
--   a server route with explicit column selection, not by blanket anon read.
--
-- RLS is enabled on every table with NO policies, i.e. service-role only.
-- That is the safe default; any table needing anon access gets an explicit,
-- reviewed, column-scoped policy in a later migration.
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- Extensions
-- ---------------------------------------------------------------------------
create extension if not exists pg_stat_statements;
create extension if not exists pgcrypto;
create extension if not exists "uuid-ossp";
-- supabase_vault is provisioned by the platform; create defensively.
create extension if not exists supabase_vault;

-- Sequence required by rate_limit.id's default. The generated DDL referenced
-- nextval('rate_limit_id_seq') without creating it — an easy clean-build failure.
create sequence if not exists public.rate_limit_id_seq;

-- ---------------------------------------------------------------------------
-- Level 0 — no outbound foreign keys
-- ---------------------------------------------------------------------------

create table if not exists public.brands (
  id uuid not null default gen_random_uuid(),
  email text not null,
  company_name text not null,
  contact_name text,
  phone text,
  default_coi_url text,
  default_coi_expires date,
  default_product_info text,
  default_categories text,
  website text,
  is_verified boolean not null default false,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now(),
  logo_url text,
  default_coi_filename text,
  default_coi_mime text,
  notification_prefs jsonb default '{"confirm": true, "decline": true, "coi_expiring": true}'::jsonb,
  welcome_day0_sent_at timestamp with time zone,
  welcome_firstdemo_sent_at timestamp with time zone,
  coi_warn_30_sent_at timestamp with time zone,
  coi_warn_14_sent_at timestamp with time zone,
  coi_warn_3_sent_at timestamp with time zone,
  password_hash text,
  coi_verification_status text,
  products jsonb not null default '[]'::jsonb
);

create table if not exists public.retailers (
  id uuid not null default gen_random_uuid(),
  slug text not null,
  name text not null,
  billing_email text,
  branding jsonb default '{}'::jsonb,
  created_at timestamp with time zone default now(),
  updated_at timestamp with time zone default now(),
  cancellation_policy text default 'Cancellations accepted up to 48 hours before the demo. After that, fees are non-refundable. Reschedules are welcome anytime.'::text,
  logo_url text,
  welcome_day0_sent_at timestamp with time zone,
  welcome_day3_sent_at timestamp with time zone,
  stripe_customer_id text,
  stripe_subscription_id text,
  billing_tier text,
  billing_status text,
  billing_period_end timestamp with time zone,
  billing_period_interval text,
  stripe_account_id text,
  stripe_charges_enabled boolean default false,
  stripe_payouts_enabled boolean default false,
  stripe_account_status text,
  demo_policy text,
  monthly_summary_enabled boolean not null default true,
  monthly_summary_last_sent_at timestamp with time zone,
  auto_confirm_bookings boolean not null default false,
  cancellation_mode text not null default '14_day_refund'::text,
  allow_support_access boolean not null default false,
  support_access_expires_at timestamp with time zone,
  platform_keeps_all boolean not null default false,
  timezone text not null default 'America/Los_Angeles'::text,
  cal_feed_key text
);

create table if not exists public.cron_heartbeat (
  id uuid not null default gen_random_uuid(),
  cron_name text not null,
  ran_at timestamp with time zone not null default now(),
  duration_ms integer,
  outcome text,
  summary jsonb
);

create table if not exists public.error_log (
  id uuid not null default gen_random_uuid(),
  occurred_at timestamp with time zone not null default now(),
  endpoint text,
  method text,
  status_code integer,
  message text,
  stack text,
  request_meta jsonb
);

create table if not exists public.processed_stripe_events (
  event_id text not null,
  event_type text,
  processed_at timestamp with time zone not null default now(),
  status text not null default 'completed'::text,
  last_error text
);

create table if not exists public.stripe_events_processed (
  event_id text not null,
  event_type text not null,
  processed_at timestamp with time zone not null default now()
);

create table if not exists public.rate_limit (
  id bigint not null default nextval('public.rate_limit_id_seq'::regclass),
  bucket_key text not null,
  window_start timestamp with time zone not null,
  count integer not null default 1
);
alter sequence public.rate_limit_id_seq owned by public.rate_limit.id;

create table if not exists public.status_incidents (
  id uuid not null default gen_random_uuid(),
  title text not null,
  body text,
  severity text not null default 'minor'::text,
  started_at timestamp with time zone not null default now(),
  resolved_at timestamp with time zone,
  created_at timestamp with time zone not null default now()
);

-- ---------------------------------------------------------------------------
-- Level 1 — depend on brands / retailers
-- ---------------------------------------------------------------------------

create table if not exists public.admin_sessions (
  session_id uuid not null default gen_random_uuid(),
  email text not null,
  retailer_id uuid not null,
  expires_at timestamp with time zone not null default (now() + '30 days'::interval),
  created_at timestamp with time zone default now()
);

create table if not exists public.admin_tokens (
  token uuid not null default gen_random_uuid(),
  email text not null,
  retailer_id uuid not null,
  expires_at timestamp with time zone not null default (now() + '24:00:00'::interval),
  used_at timestamp with time zone,
  created_at timestamp with time zone default now(),
  code text
);

create table if not exists public.brand_account_sessions (
  id uuid not null default gen_random_uuid(),
  brand_id uuid not null,
  session_token text not null,
  expires_at timestamp with time zone not null,
  created_at timestamp with time zone not null default now(),
  email text
);

create table if not exists public.brand_account_tokens (
  id uuid not null default gen_random_uuid(),
  brand_id uuid not null,
  token text not null,
  expires_at timestamp with time zone not null,
  used_at timestamp with time zone,
  created_at timestamp with time zone not null default now(),
  email text
);

create table if not exists public.brand_contacts (
  id uuid not null default gen_random_uuid(),
  retailer_id uuid not null,
  name text not null,
  company text,
  venue text,
  address text,
  email text,
  phone text,
  notes text,
  created_at timestamp with time zone default now(),
  updated_at timestamp with time zone default now(),
  brand_id uuid
);

create table if not exists public.brand_members (
  id uuid not null default gen_random_uuid(),
  brand_id uuid not null,
  email text not null,
  name text,
  role text not null default 'admin'::text,
  invited_by_email text,
  created_at timestamp with time zone not null default now()
);

create table if not exists public.brand_retailer_agreements (
  id uuid not null default gen_random_uuid(),
  brand_id uuid not null,
  retailer_id uuid not null,
  signed_name text not null,
  signed_email text not null,
  signed_at timestamp with time zone not null default now(),
  signed_ip text,
  signed_user_agent text,
  demo_policy_snapshot text,
  cancellation_policy_snapshot text,
  policy_hash text not null,
  expires_at timestamp with time zone not null default (now() + '365 days'::interval),
  superseded_at timestamp with time zone,
  superseded_by uuid,
  created_at timestamp with time zone default now()
);

create table if not exists public.brand_sessions (
  session_id uuid not null default gen_random_uuid(),
  email text not null,
  retailer_id uuid not null,
  expires_at timestamp with time zone not null default (now() + '30 days'::interval),
  created_at timestamp with time zone default now()
);

create table if not exists public.brand_tokens (
  token uuid not null default gen_random_uuid(),
  email text not null,
  retailer_id uuid not null,
  expires_at timestamp with time zone not null default (now() + '24:00:00'::interval),
  used_at timestamp with time zone,
  created_at timestamp with time zone default now()
);

create table if not exists public.coi_verifications (
  id uuid not null default gen_random_uuid(),
  brand_id uuid,
  coi_url text,
  status text,
  confidence numeric,
  is_coi boolean,
  insured_name text,
  insurer_name text,
  insurer_naic text,
  policy_expiry date,
  gl_each_occurrence numeric,
  gl_general_aggregate numeric,
  flags jsonb default '[]'::jsonb,
  raw jsonb,
  created_at timestamp with time zone not null default now()
);

create table if not exists public.internal_contacts (
  id uuid not null default gen_random_uuid(),
  retailer_id uuid not null,
  name text not null,
  role text,
  venue text,
  email text,
  phone text,
  notes text,
  created_at timestamp with time zone default now(),
  updated_at timestamp with time zone default now()
);

create table if not exists public.retailer_admins (
  id uuid not null default gen_random_uuid(),
  retailer_id uuid not null,
  email text not null,
  name text,
  role text not null default 'admin'::text,
  invited_by_email text,
  created_at timestamp with time zone not null default now()
);

create table if not exists public.settings (
  id uuid not null default gen_random_uuid(),
  retailer_id uuid not null,
  demo_fee numeric(8,2) default 30.00,
  demo_duration text default '3 hours'::text,
  advance_booking_days integer default 14,
  custom jsonb default '{}'::jsonb,
  created_at timestamp with time zone default now(),
  updated_at timestamp with time zone default now()
);

create table if not exists public.venues (
  id uuid not null default gen_random_uuid(),
  retailer_id uuid not null,
  name text not null,
  address text,
  demo_fee numeric(8,2) default 30.00,
  availability jsonb default '{}'::jsonb,
  active boolean default true,
  display_order integer default 0,
  created_at timestamp with time zone default now(),
  max_demos_per_slot integer not null default 1
);

create table if not exists public.support_sessions (
  id uuid not null default gen_random_uuid(),
  owner_email text not null,
  target_retailer_id uuid not null,
  target_session_id uuid,
  started_at timestamp with time zone not null default now(),
  ended_at timestamp with time zone,
  writes_count integer not null default 0,
  last_action_at timestamp with time zone,
  ip_address text,
  user_agent text
);

-- ---------------------------------------------------------------------------
-- Level 2 — depend on venues / brand_contacts
-- ---------------------------------------------------------------------------

create table if not exists public.bookings (
  id uuid not null default gen_random_uuid(),
  retailer_id uuid not null,
  venue_id uuid,
  brand_name text,
  contact_name text,
  contact_email text,
  contact_phone text,
  product text,
  demo_date date,
  demo_time text,
  notes text,
  status text default 'pending'::text,
  created_at timestamp with time zone default now(),
  brand_id uuid,
  payment_status text,
  payment_intent_id text,
  paid_at timestamp with time zone,
  amount_paid integer,
  refunded_at timestamp with time zone,
  cancelled_at timestamp with time zone,
  cancel_reason text,
  coi_reminder_sent_at timestamp with time zone,
  coi_final_warn_sent_at timestamp with time zone,
  coi_waived_at timestamp with time zone,
  coi_waived_by text,
  product_skus jsonb
);

create table if not exists public.compliance_records (
  id uuid not null default gen_random_uuid(),
  retailer_id uuid not null,
  brand_contact_id uuid,
  doc_type text not null,
  doc_number text,
  issued_at date,
  expires_at date,
  file_url text,
  verified boolean default false,
  notes text,
  created_at timestamp with time zone default now(),
  updated_at timestamp with time zone default now(),
  coi_warn_30_sent_at timestamp with time zone,
  coi_warn_14_sent_at timestamp with time zone,
  coi_warn_3_sent_at timestamp with time zone
);

create table if not exists public.demos (
  id uuid not null default gen_random_uuid(),
  retailer_id uuid not null,
  brand_contact_id uuid,
  venue_id uuid,
  company_name text not null,
  contact_name text,
  product text,
  demo_date date not null,
  demo_time text,
  duration_hours integer default 3,
  status text default 'confirmed'::text,
  demo_fee numeric(8,2),
  notes text,
  created_at timestamp with time zone default now(),
  brand_id uuid,
  confirmed_at timestamp with time zone,
  product_skus jsonb,
  contact_email text,
  contact_phone text,
  reschedule_to_date date,
  reschedule_to_time text,
  reschedule_requested_at timestamp with time zone,
  booking_id uuid
);

commit;

-- ---------------------------------------------------------------------------
-- Primary keys / unique / check constraints
-- Wrapped so re-running is safe (ADD CONSTRAINT has no IF NOT EXISTS).
-- ---------------------------------------------------------------------------
do $$
declare
  s text;
  v_name text;
  v_tbl  text;
begin
  foreach s in array array[
    'alter table public.admin_sessions add constraint admin_sessions_pkey primary key (session_id)',
    'alter table public.admin_tokens add constraint admin_tokens_pkey primary key (token)',
    'alter table public.bookings add constraint bookings_pkey primary key (id)',
    'alter table public.brand_account_sessions add constraint brand_account_sessions_pkey primary key (id)',
    'alter table public.brand_account_tokens add constraint brand_account_tokens_pkey primary key (id)',
    'alter table public.brand_contacts add constraint brand_contacts_pkey primary key (id)',
    'alter table public.brand_members add constraint brand_members_pkey primary key (id)',
    'alter table public.brand_retailer_agreements add constraint brand_retailer_agreements_pkey primary key (id)',
    'alter table public.brand_sessions add constraint brand_sessions_pkey primary key (session_id)',
    'alter table public.brand_tokens add constraint brand_tokens_pkey primary key (token)',
    'alter table public.brands add constraint brands_pkey primary key (id)',
    'alter table public.coi_verifications add constraint coi_verifications_pkey primary key (id)',
    'alter table public.compliance_records add constraint compliance_records_pkey primary key (id)',
    'alter table public.cron_heartbeat add constraint cron_heartbeat_pkey primary key (id)',
    'alter table public.demos add constraint demos_pkey primary key (id)',
    'alter table public.error_log add constraint error_log_pkey primary key (id)',
    'alter table public.internal_contacts add constraint internal_contacts_pkey primary key (id)',
    'alter table public.processed_stripe_events add constraint processed_stripe_events_pkey primary key (event_id)',
    'alter table public.rate_limit add constraint rate_limit_pkey primary key (id)',
    'alter table public.retailer_admins add constraint retailer_admins_pkey primary key (id)',
    'alter table public.retailers add constraint retailers_pkey primary key (id)',
    'alter table public.settings add constraint settings_pkey primary key (id)',
    'alter table public.status_incidents add constraint status_incidents_pkey primary key (id)',
    'alter table public.stripe_events_processed add constraint stripe_events_processed_pkey primary key (event_id)',
    'alter table public.support_sessions add constraint support_sessions_pkey primary key (id)',
    'alter table public.venues add constraint venues_pkey primary key (id)',
    'alter table public.brand_account_sessions add constraint brand_account_sessions_session_token_key unique (session_token)',
    'alter table public.brand_account_tokens add constraint brand_account_tokens_token_key unique (token)',
    'alter table public.brands add constraint brands_email_key unique (email)',
    'alter table public.retailers add constraint retailers_slug_key unique (slug)',
    'alter table public.settings add constraint settings_retailer_id_key unique (retailer_id)',
    'alter table public.status_incidents add constraint status_incidents_severity_check check ((severity = any (array[''minor''::text, ''major''::text, ''maintenance''::text])))',
    -- foreign keys last
    'alter table public.admin_sessions add constraint admin_sessions_retailer_id_fkey foreign key (retailer_id) references public.retailers(id) on delete cascade',
    'alter table public.admin_tokens add constraint admin_tokens_retailer_id_fkey foreign key (retailer_id) references public.retailers(id) on delete cascade',
    'alter table public.bookings add constraint bookings_brand_id_fkey foreign key (brand_id) references public.brands(id) on delete set null',
    'alter table public.bookings add constraint bookings_venue_id_fkey foreign key (venue_id) references public.venues(id) on delete set null',
    'alter table public.bookings add constraint bookings_retailer_id_fkey foreign key (retailer_id) references public.retailers(id) on delete cascade',
    'alter table public.brand_account_sessions add constraint brand_account_sessions_brand_id_fkey foreign key (brand_id) references public.brands(id) on delete cascade',
    'alter table public.brand_account_tokens add constraint brand_account_tokens_brand_id_fkey foreign key (brand_id) references public.brands(id) on delete cascade',
    'alter table public.brand_contacts add constraint brand_contacts_brand_id_fkey foreign key (brand_id) references public.brands(id) on delete set null',
    'alter table public.brand_contacts add constraint brand_contacts_retailer_id_fkey foreign key (retailer_id) references public.retailers(id) on delete cascade',
    'alter table public.brand_members add constraint brand_members_brand_id_fkey foreign key (brand_id) references public.brands(id) on delete cascade',
    'alter table public.brand_retailer_agreements add constraint brand_retailer_agreements_brand_id_fkey foreign key (brand_id) references public.brands(id) on delete cascade',
    'alter table public.brand_retailer_agreements add constraint brand_retailer_agreements_retailer_id_fkey foreign key (retailer_id) references public.retailers(id) on delete cascade',
    'alter table public.brand_retailer_agreements add constraint brand_retailer_agreements_superseded_by_fkey foreign key (superseded_by) references public.brand_retailer_agreements(id) on delete set null',
    'alter table public.brand_sessions add constraint brand_sessions_retailer_id_fkey foreign key (retailer_id) references public.retailers(id)',
    'alter table public.brand_tokens add constraint brand_tokens_retailer_id_fkey foreign key (retailer_id) references public.retailers(id)',
    'alter table public.coi_verifications add constraint coi_verifications_brand_id_fkey foreign key (brand_id) references public.brands(id) on delete cascade',
    'alter table public.compliance_records add constraint compliance_records_retailer_id_fkey foreign key (retailer_id) references public.retailers(id) on delete cascade',
    'alter table public.compliance_records add constraint compliance_records_brand_contact_id_fkey foreign key (brand_contact_id) references public.brand_contacts(id) on delete cascade',
    'alter table public.demos add constraint demos_venue_id_fkey foreign key (venue_id) references public.venues(id) on delete set null',
    'alter table public.demos add constraint demos_brand_id_fkey foreign key (brand_id) references public.brands(id) on delete set null',
    'alter table public.demos add constraint demos_brand_contact_id_fkey foreign key (brand_contact_id) references public.brand_contacts(id) on delete set null',
    'alter table public.demos add constraint demos_retailer_id_fkey foreign key (retailer_id) references public.retailers(id) on delete cascade',
    'alter table public.internal_contacts add constraint internal_contacts_retailer_id_fkey foreign key (retailer_id) references public.retailers(id) on delete cascade',
    'alter table public.retailer_admins add constraint retailer_admins_retailer_id_fkey foreign key (retailer_id) references public.retailers(id) on delete cascade',
    'alter table public.settings add constraint settings_retailer_id_fkey foreign key (retailer_id) references public.retailers(id) on delete cascade',
    'alter table public.support_sessions add constraint support_sessions_target_session_id_fkey foreign key (target_session_id) references public.admin_sessions(session_id) on delete set null',
    'alter table public.support_sessions add constraint support_sessions_target_retailer_id_fkey foreign key (target_retailer_id) references public.retailers(id) on delete cascade',
    'alter table public.venues add constraint venues_retailer_id_fkey foreign key (retailer_id) references public.retailers(id) on delete cascade'
  ]
  loop
    -- Idempotency without swallowing real errors: pull the constraint + table name out of the
    -- statement and skip only when that exact constraint already exists. Catching exceptions
    -- broadly would hide genuine failures; catching duplicate_object alone is not enough,
    -- because re-adding a PRIMARY KEY raises invalid_table_definition (42P16), not a duplicate.
    v_name := substring(s from 'add constraint ([a-z0-9_]+)');
    v_tbl  := substring(s from 'alter table public\.([a-z0-9_]+)');
    if v_name is null or v_tbl is null then
      raise exception 'baseline: could not parse constraint statement: %', s;
    end if;
    if not exists (
      select 1 from pg_constraint c
      join pg_class t on t.oid = c.conrelid
      join pg_namespace n on n.oid = t.relnamespace
      where n.nspname = 'public' and t.relname = v_tbl and c.conname = v_name
    ) then
      execute s;
    end if;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------
create index if not exists idx_admin_sessions_email on public.admin_sessions using btree (email, retailer_id);
create index if not exists idx_admin_tokens_email on public.admin_tokens using btree (email, retailer_id);
create index if not exists admin_tokens_code_lookup on public.admin_tokens using btree (code, email) where ((code is not null) and (used_at is null));
create index if not exists bookings_retailer_idx on public.bookings using btree (retailer_id);
create index if not exists idx_bookings_payment_intent_id on public.bookings using btree (payment_intent_id);
create index if not exists idx_bookings_venue_id on public.bookings using btree (venue_id);
create index if not exists bookings_brand_idx on public.bookings using btree (brand_id);
create index if not exists brand_account_sessions_brand_idx on public.brand_account_sessions using btree (brand_id);
create index if not exists brand_account_tokens_brand_idx on public.brand_account_tokens using btree (brand_id);
create index if not exists brand_contacts_retailer_idx on public.brand_contacts using btree (retailer_id);
create index if not exists brand_contacts_brand_idx on public.brand_contacts using btree (brand_id);
create index if not exists brand_members_email_idx on public.brand_members using btree (lower(email));
create unique index if not exists brand_members_unique_idx on public.brand_members using btree (brand_id, lower(email));
create unique index if not exists idx_one_active_brand_retailer_agreement on public.brand_retailer_agreements using btree (brand_id, retailer_id) where (superseded_at is null);
create index if not exists idx_brand_retailer_agreements_retailer on public.brand_retailer_agreements using btree (retailer_id);
create index if not exists idx_bra_superseded_by on public.brand_retailer_agreements using btree (superseded_by);
create index if not exists idx_brand_retailer_agreements_brand on public.brand_retailer_agreements using btree (brand_id);
create index if not exists idx_brand_sessions_email on public.brand_sessions using btree (email, retailer_id);
create index if not exists idx_brand_tokens_email on public.brand_tokens using btree (email, retailer_id);
create index if not exists brands_email_idx on public.brands using btree (lower(email));
create unique index if not exists brands_email_unique on public.brands using btree (lower(email)) where ((email is not null) and (email <> ''::text));
create index if not exists idx_brands_coi_expires on public.brands using btree (default_coi_expires) where ((default_coi_url is not null) and (default_coi_expires is not null));
create index if not exists brands_company_idx on public.brands using btree (lower(company_name));
create index if not exists idx_coi_verifications_brand on public.coi_verifications using btree (brand_id, created_at desc);
create index if not exists compliance_retailer_idx on public.compliance_records using btree (retailer_id);
create index if not exists compliance_brand_idx on public.compliance_records using btree (brand_contact_id);
create index if not exists compliance_expires_idx on public.compliance_records using btree (expires_at);
create index if not exists idx_compliance_records_coi_expires on public.compliance_records using btree (expires_at) where ((doc_type = 'coi'::text) and (expires_at is not null));
create index if not exists idx_cron_heartbeat_ran_at on public.cron_heartbeat using btree (cron_name, ran_at desc);
create index if not exists idx_demos_venue_id on public.demos using btree (venue_id);
create index if not exists demos_retailer_idx on public.demos using btree (retailer_id);
create index if not exists demos_date_idx on public.demos using btree (demo_date);
create index if not exists demos_brand_idx on public.demos using btree (brand_id);
create index if not exists idx_demos_brand_contact_id on public.demos using btree (brand_contact_id);
create unique index if not exists demos_one_per_booking on public.demos using btree (booking_id) where (booking_id is not null);
create index if not exists idx_error_log_occurred_at on public.error_log using btree (occurred_at desc);
create index if not exists internal_contacts_retailer_idx on public.internal_contacts using btree (retailer_id);
create index if not exists idx_rate_limit_key_window on public.rate_limit using btree (bucket_key, window_start);
create unique index if not exists retailer_admins_unique_idx on public.retailer_admins using btree (retailer_id, lower(email));
create index if not exists retailer_admins_email_idx on public.retailer_admins using btree (lower(email));
create unique index if not exists idx_retailers_stripe_customer on public.retailers using btree (stripe_customer_id) where (stripe_customer_id is not null);
create index if not exists idx_retailers_stripe_subscription on public.retailers using btree (stripe_subscription_id) where (stripe_subscription_id is not null);
create unique index if not exists retailers_billing_email_unique on public.retailers using btree (lower(billing_email)) where ((billing_email is not null) and (billing_email <> ''::text));
create unique index if not exists idx_retailers_stripe_account on public.retailers using btree (stripe_account_id) where (stripe_account_id is not null);
create index if not exists idx_status_incidents_active on public.status_incidents using btree (started_at desc) where (resolved_at is null);
create index if not exists idx_stripe_events_processed_at on public.stripe_events_processed using btree (processed_at);
create index if not exists support_sessions_retailer_idx on public.support_sessions using btree (target_retailer_id, started_at desc);
create index if not exists support_sessions_owner_idx on public.support_sessions using btree (owner_email, started_at desc);
create index if not exists venues_retailer_idx on public.venues using btree (retailer_id);

-- ---------------------------------------------------------------------------
-- RLS: enabled everywhere, ZERO policies => service-role only.
-- Any anon access must be added later, explicitly, column-scoped, and reviewed.
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  for t in
    select c.relname from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'
  loop
    execute format('alter table public.%I enable row level security', t);
  end loop;
end $$;
