-- 0000_baseline_reconstructed.sql
-- ============================================================================
-- RECONSTRUCTED baseline schema (F5-01). Built from the application source, NOT
-- from a production pg_dump. It captures the core tables/columns the app and the
-- later incremental migrations depend on, so a fresh database can be built from
-- migrations alone for staging/CI.
--
-- ⚠ MUST BE RECONCILED against a real production structural dump before it is
-- trusted as authoritative. Column types/defaults/constraints/indexes/RLS
-- policies and any tables not exercised by the code may differ. Reconciliation
-- is a tracked F5-01 exit item.
-- ============================================================================

create extension if not exists pgcrypto;

-- ---- tenants ---------------------------------------------------------------
create table if not exists retailers (
  id uuid primary key default gen_random_uuid(),
  slug text unique,
  name text,
  website text,
  logo_url text,
  description text,
  branding jsonb,
  demo_policy text,
  cancellation_policy text,
  cancellation_mode text default 'refundable',
  auto_confirm_bookings boolean default true,
  monthly_summary_enabled boolean default false,
  platform_keeps_all boolean default false,
  stripe_account_id text,
  stripe_charges_enabled boolean default false,
  billing_status text,
  billing_tier text default 'solo',
  is_demo boolean default false,
  allow_support_access boolean default false,
  support_access_expires_at timestamptz,
  created_at timestamptz default now()
);

create table if not exists venues (
  id uuid primary key default gen_random_uuid(),
  retailer_id uuid references retailers(id) on delete cascade,
  name text,
  address text, city text, state text, zip text, phone text, timezone text,
  hours text, description text, notes text, slug text,
  demo_fee numeric default 0,
  display_order int default 0,
  max_demos_per_slot int default 1,
  active boolean default true,
  availability jsonb,
  created_at timestamptz default now()
);

create table if not exists settings (
  id uuid primary key default gen_random_uuid(),
  retailer_id uuid references retailers(id) on delete cascade,
  demo_fee numeric,
  demo_duration numeric,
  advance_booking_days int,
  created_at timestamptz default now()
);

-- ---- brands (the other tenant side) ---------------------------------------
create table if not exists brands (
  id uuid primary key default gen_random_uuid(),
  company_name text,
  contact_name text,
  email text,
  phone text,
  website text,
  password_hash text,
  is_verified boolean default false,
  default_coi_url text,
  default_coi_expires date,
  default_coi_filename text,
  default_coi_mime text,
  coi_verification_status text,
  default_product_info text,
  default_categories text,
  products jsonb,
  notification_prefs jsonb,
  needs_electricity boolean default false,
  coi_warn_30_sent_at timestamptz,
  coi_warn_14_sent_at timestamptz,
  coi_warn_3_sent_at timestamptz,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists brand_members (
  id uuid primary key default gen_random_uuid(),
  brand_id uuid references brands(id) on delete cascade,
  email text,
  name text,
  role text default 'owner',
  created_at timestamptz default now()
);

-- ---- bookings + demos ------------------------------------------------------
create table if not exists bookings (
  id uuid primary key default gen_random_uuid(),
  retailer_id uuid references retailers(id) on delete cascade,
  venue_id uuid references venues(id),
  brand_id uuid references brands(id),
  brand_name text, contact_name text, contact_email text, contact_phone text,
  product text, product_skus jsonb,
  demo_date date, demo_time text,
  notes text,
  status text default 'pending',
  payment_status text default 'unpaid',
  payment_intent_id text,
  stripe_session_id text,
  amount_paid numeric,
  amount_refunded numeric,
  refund_id text,
  coi_waived_at timestamptz,
  coi_waived_by text,
  cancelled_at timestamptz,
  created_at timestamptz default now()
);

create table if not exists demos (
  id uuid primary key default gen_random_uuid(),
  retailer_id uuid references retailers(id) on delete cascade,
  venue_id uuid references venues(id),
  brand_id uuid references brands(id),
  booking_id uuid,
  company_name text, contact_name text, contact_email text, contact_phone text,
  product text, product_skus jsonb,
  demo_date date, demo_time text,
  duration_hours int default 3,
  demo_fee numeric,
  status text default 'confirmed',
  notes text,
  confirmed_at timestamptz,
  reschedule_to_date date, reschedule_to_time text, reschedule_requested_at timestamptz,
  created_at timestamptz default now()
);

-- ---- retailer staff + admin auth ------------------------------------------
create table if not exists retailer_admins (
  id uuid primary key default gen_random_uuid(),
  retailer_id uuid references retailers(id) on delete cascade,
  email text,
  role text default 'admin',
  venue_ids uuid[],
  created_at timestamptz default now()
);

create table if not exists admin_sessions (
  session_id uuid primary key default gen_random_uuid(),
  retailer_id uuid,
  email text,
  expires_at timestamptz,
  created_at timestamptz default now()
);

create table if not exists admin_tokens (
  token uuid primary key default gen_random_uuid(),
  retailer_id uuid,
  email text,
  used_at timestamptz,
  created_at timestamptz default now()
);

create table if not exists admin_login_codes (
  id uuid primary key default gen_random_uuid(),
  retailer_id uuid,
  email text,
  code text,
  used_at timestamptz,
  expires_at timestamptz,
  created_at timestamptz default now()
);

-- ---- brand auth ------------------------------------------------------------
create table if not exists brand_account_sessions (
  session_token uuid primary key default gen_random_uuid(),
  brand_id uuid references brands(id) on delete cascade,
  email text,
  expires_at timestamptz,
  created_at timestamptz default now()
);

create table if not exists brand_account_tokens (
  token uuid primary key default gen_random_uuid(),
  brand_id uuid,
  email text,
  used_at timestamptz,
  expires_at timestamptz,
  created_at timestamptz default now()
);

-- ---- contacts + compliance -------------------------------------------------
create table if not exists brand_contacts (
  id uuid primary key default gen_random_uuid(),
  retailer_id uuid references retailers(id) on delete cascade,
  name text, company text, venue text, email text, phone text, address text,
  created_at timestamptz default now()
);

create table if not exists internal_contacts (
  id uuid primary key default gen_random_uuid(),
  retailer_id uuid references retailers(id) on delete cascade,
  name text, role text, venue text, email text, phone text,
  created_at timestamptz default now()
);

create table if not exists compliance_records (
  id uuid primary key default gen_random_uuid(),
  retailer_id uuid references retailers(id) on delete cascade,
  brand_contact_id uuid,
  doc_type text, doc_number text,
  issued_at date, expires_at date,
  file_url text,
  verified boolean default false,
  coi_warn_30_sent_at timestamptz,
  coi_warn_14_sent_at timestamptz,
  coi_warn_3_sent_at timestamptz,
  created_at timestamptz default now()
);

create table if not exists coi_verifications (
  id uuid primary key default gen_random_uuid(),
  brand_id uuid references brands(id) on delete cascade,
  coi_url text, status text, confidence numeric, is_coi boolean,
  insured_name text, insurer_name text, insurer_naic text, policy_expiry date,
  gl_each_occurrence numeric, gl_general_aggregate numeric,
  flags jsonb, raw jsonb,
  created_at timestamptz default now()
);

create table if not exists brand_retailer_agreements (
  id uuid primary key default gen_random_uuid(),
  brand_id uuid references brands(id) on delete cascade,
  retailer_id uuid references retailers(id) on delete cascade,
  signed_name text, signed_email text, signed_ip text, signed_user_agent text,
  policy_snapshot jsonb,
  signed_at timestamptz default now(),
  superseded_at timestamptz
);

-- ---- ops / infra -----------------------------------------------------------
create table if not exists cron_heartbeat ( id uuid primary key default gen_random_uuid(), ran_at timestamptz, outcome text, duration_ms int );
create table if not exists error_log ( id uuid primary key default gen_random_uuid(), occurred_at timestamptz default now(), detail jsonb );
create table if not exists status_incidents ( id uuid primary key default gen_random_uuid(), title text, body text, severity text, started_at timestamptz default now(), resolved_at timestamptz );
create table if not exists rate_limits ( id uuid primary key default gen_random_uuid(), bucket text, window_start timestamptz, count int default 0 );

-- NOTE: RLS policies, storage buckets (coi-docs, avatars, policy-docs), and some
-- indexes/constraints are NOT reproduced here — they come from later migrations
-- (e.g. 0017_security-rls-fix) and from the reconciliation step against the real dump.
