-- email_boss core schema.
--
-- Everything lives in its own `email_boss` schema, which Supabase does NOT expose through
-- the public REST/GraphQL API by default. On top of that, RLS is enabled on every table
-- with NO policies, and anon/authenticated have no grants. Only the server (connecting
-- with the database owner / service role via SUPABASE_DB_URL) can read or write.
--
-- Brand isolation is enforced by the database itself, not just by app code:
-- every child row carries brand_id, and composite foreign keys (child_id, brand_id) ->
-- parent(id, brand_id) make it impossible to enroll, tag, or queue a send for a contact
-- that belongs to a different brand than the sequence / broadcast / tag.

create schema if not exists email_boss;

-- ---------------------------------------------------------------------------
-- helpers
-- ---------------------------------------------------------------------------
create or replace function email_boss.touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- Parse 'YYYY-MM-DD...' into a date; null for anything invalid (used by date-triggered sequences).
create or replace function email_boss.try_date(v text) returns date
language plpgsql immutable as $$
begin
  if v is null or v !~ '^\d{4}-\d{2}-\d{2}' then return null; end if;
  return left(v, 10)::date;
exception when others then
  return null;
end $$;

-- Suppression severity. Higher wins when merging; a contact can never be moved
-- to a lower rank by an import (only an explicit re-subscribe can lift `unsubscribed`).
create or replace function email_boss.status_rank(s text) returns int
language sql immutable as $$
  select case s
    when 'subscribed' then 0
    when 'unsubscribed' then 1
    when 'bounced' then 2
    when 'complained' then 3
    else 1
  end
$$;

-- ---------------------------------------------------------------------------
-- brands
-- ---------------------------------------------------------------------------
create table email_boss.brands (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,40}$'),
  name text not null,
  from_name text not null,
  from_email text not null check (from_email = lower(from_email) and from_email ~ '^[^@\s]+@[^@\s]+$'),
  reply_to text,
  sending_domain text not null check (sending_domain = lower(sending_domain)),
  -- CAN-SPAM requires a valid physical postal address in every commercial email.
  physical_address text not null check (char_length(btrim(physical_address)) >= 10),
  timezone text not null default 'America/Los_Angeles',
  -- provider override for this brand: ses | resend | log (null = EMAIL_PROVIDER env)
  provider text check (provider in ('ses', 'resend', 'log')),
  ses_configuration_set text,
  -- base URL used for unsubscribe links (e.g. https://mail.yonisync.com). null = PUBLIC_BASE_URL env
  links_base_url text,
  -- operational fields, managed in the DB (not overwritten by brand sync)
  status text not null default 'paused' check (status in ('active', 'paused')),
  warmup_started_on date,
  daily_cap_override integer check (daily_cap_override >= 0),
  api_key_hash text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- the From address must live on the brand's own authenticated sending domain
  constraint brands_from_on_sending_domain check (
    split_part(from_email, '@', 2) = sending_domain
    or split_part(from_email, '@', 2) like '%.' || sending_domain
  )
);
create trigger brands_touch before update on email_boss.brands
  for each row execute function email_boss.touch_updated_at();

-- ---------------------------------------------------------------------------
-- contacts (per brand; the same address in two brands = two independent rows)
-- ---------------------------------------------------------------------------
create table email_boss.contacts (
  id uuid primary key default gen_random_uuid(),
  brand_id uuid not null references email_boss.brands(id) on delete cascade,
  email text not null check (
    email = lower(btrim(email))
    and char_length(email) between 3 and 254
    and email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'
  ),
  first_name text,
  last_name text,
  status text not null default 'subscribed'
    check (status in ('subscribed', 'unsubscribed', 'bounced', 'complained')),
  source text,
  custom_fields jsonb not null default '{}'::jsonb check (jsonb_typeof(custom_fields) = 'object'),
  consent_at timestamptz,
  consent_ip inet,
  consent_source text,
  status_changed_at timestamptz,
  last_sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (brand_id, email),
  unique (id, brand_id)
);
create index contacts_brand_status_idx on email_boss.contacts (brand_id, status);
create trigger contacts_touch before update on email_boss.contacts
  for each row execute function email_boss.touch_updated_at();

-- ---------------------------------------------------------------------------
-- tags
-- ---------------------------------------------------------------------------
create table email_boss.tags (
  id uuid primary key default gen_random_uuid(),
  brand_id uuid not null references email_boss.brands(id) on delete cascade,
  name text not null check (name = lower(name) and name ~ '^[a-z0-9][a-z0-9_:./-]{0,79}$'),
  created_at timestamptz not null default now(),
  unique (brand_id, name),
  unique (id, brand_id)
);

create table email_boss.contact_tags (
  contact_id uuid not null,
  tag_id uuid not null,
  brand_id uuid not null,
  added_at timestamptz not null default now(),
  primary key (contact_id, tag_id),
  foreign key (contact_id, brand_id) references email_boss.contacts (id, brand_id) on delete cascade,
  foreign key (tag_id, brand_id) references email_boss.tags (id, brand_id) on delete cascade
);
create index contact_tags_tag_idx on email_boss.contact_tags (tag_id);

-- ---------------------------------------------------------------------------
-- sequences (definitions come from each brand repo; synced by scripts/sync-brands-to-db.ts)
-- ---------------------------------------------------------------------------
create table email_boss.sequences (
  id uuid primary key default gen_random_uuid(),
  brand_id uuid not null references email_boss.brands(id) on delete cascade,
  key text not null check (key ~ '^[a-z0-9][a-z0-9_-]{0,79}$'),
  name text not null,
  trigger_type text not null check (trigger_type in ('tag_added', 'signup_source', 'manual', 'date')),
  -- tag_added: {"tag": "quiz:kidney_yin"} | signup_source: {"source": "fertility-quiz"}
  -- date: {"field": "due_date", "offset_days": -7, "annual": false} | manual: {}
  trigger_config jsonb not null default '{}'::jsonb,
  status text not null default 'paused' check (status in ('active', 'paused', 'archived')),
  allow_reenroll boolean not null default false,
  exit_tags text[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (brand_id, key),
  unique (id, brand_id)
);
create trigger sequences_touch before update on email_boss.sequences
  for each row execute function email_boss.touch_updated_at();

create table email_boss.sequence_steps (
  id uuid primary key default gen_random_uuid(),
  sequence_id uuid not null,
  brand_id uuid not null,
  position integer not null check (position >= 0),
  key text not null,
  -- wait this long after the previous step was sent (or after enrollment for step 0)
  delay_minutes integer not null default 0 check (delay_minutes >= 0),
  template_id text not null,
  subject_override text,
  created_at timestamptz not null default now(),
  unique (sequence_id, position) deferrable initially deferred,
  unique (sequence_id, key),
  foreign key (sequence_id, brand_id) references email_boss.sequences (id, brand_id) on delete cascade
);

create table email_boss.enrollments (
  id uuid primary key default gen_random_uuid(),
  brand_id uuid not null,
  sequence_id uuid not null,
  contact_id uuid not null,
  -- '' for one-shot sequences; e.g. '2027' for annual date-triggered sequences
  cycle_key text not null default '',
  status text not null default 'active' check (status in ('active', 'completed', 'exited', 'paused')),
  current_position integer not null default 0,
  next_run_at timestamptz,
  enrolled_at timestamptz not null default now(),
  completed_at timestamptz,
  exit_reason text,
  unique (sequence_id, contact_id, cycle_key),
  unique (id, brand_id),
  foreign key (sequence_id, brand_id) references email_boss.sequences (id, brand_id) on delete cascade,
  foreign key (contact_id, brand_id) references email_boss.contacts (id, brand_id) on delete cascade
);
create index enrollments_due_idx on email_boss.enrollments (next_run_at) where status = 'active';

-- ---------------------------------------------------------------------------
-- broadcasts (one-off campaigns to a tag segment of ONE brand)
-- ---------------------------------------------------------------------------
create table email_boss.broadcasts (
  id uuid primary key default gen_random_uuid(),
  brand_id uuid not null references email_boss.brands(id) on delete cascade,
  name text not null,
  template_id text not null,
  subject_override text,
  -- {"include_tags": ["expo-2026"], "exclude_tags": ["vip"], "match": "any" | "all"}
  segment jsonb not null default '{}'::jsonb check (jsonb_typeof(segment) = 'object'),
  status text not null default 'draft'
    check (status in ('draft', 'scheduled', 'sending', 'sent', 'canceled')),
  scheduled_at timestamptz,
  materialized_at timestamptz,
  completed_at timestamptz,
  recipient_count integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, brand_id)
);
create trigger broadcasts_touch before update on email_boss.broadcasts
  for each row execute function email_boss.touch_updated_at();

-- ---------------------------------------------------------------------------
-- sends (the outbound queue + delivery log)
-- ---------------------------------------------------------------------------
create table email_boss.sends (
  id uuid primary key default gen_random_uuid(),
  brand_id uuid not null references email_boss.brands(id) on delete cascade,
  contact_id uuid not null,
  kind text not null check (kind in ('sequence', 'broadcast')),
  enrollment_id uuid,
  step_id uuid references email_boss.sequence_steps(id) on delete set null,
  broadcast_id uuid,
  template_id text not null,
  subject_override text,
  -- lower = sent first. sequence emails (10) go before broadcasts (50).
  priority smallint not null default 50,
  status text not null default 'queued'
    check (status in ('queued', 'sending', 'sent', 'failed', 'skipped', 'canceled')),
  scheduled_for timestamptz not null default now(),
  attempts integer not null default 0,
  provider text,
  provider_message_id text unique,
  subject text,
  error text,
  created_at timestamptz not null default now(),
  claimed_at timestamptz,
  sent_at timestamptz,
  unique (id, brand_id),
  unique (enrollment_id, step_id),
  unique (broadcast_id, contact_id),
  check ((kind = 'sequence') = (enrollment_id is not null)),
  check ((kind = 'broadcast') = (broadcast_id is not null)),
  foreign key (contact_id, brand_id) references email_boss.contacts (id, brand_id) on delete cascade,
  foreign key (enrollment_id, brand_id) references email_boss.enrollments (id, brand_id) on delete cascade,
  foreign key (broadcast_id, brand_id) references email_boss.broadcasts (id, brand_id) on delete cascade
);
create index sends_queue_idx on email_boss.sends (brand_id, priority, scheduled_for) where status = 'queued';
create index sends_brand_sent_idx on email_boss.sends (brand_id, sent_at desc);

-- ---------------------------------------------------------------------------
-- events (delivery / engagement / list events)
-- ---------------------------------------------------------------------------
create table email_boss.events (
  id bigint generated always as identity primary key,
  brand_id uuid not null references email_boss.brands(id) on delete cascade,
  contact_id uuid,
  send_id uuid,
  type text not null check (type in (
    'subscribe', 'resubscribe', 'unsubscribe', 'sent', 'delivered', 'open', 'click',
    'bounce', 'soft_bounce', 'complaint', 'reject', 'delivery_delay', 'failed'
  )),
  occurred_at timestamptz not null default now(),
  data jsonb not null default '{}'::jsonb,
  -- e.g. SNS MessageId; makes webhook processing idempotent
  provider_event_id text unique,
  foreign key (contact_id, brand_id) references email_boss.contacts (id, brand_id) on delete cascade,
  foreign key (send_id, brand_id) references email_boss.sends (id, brand_id) on delete set null (send_id)
);
create index events_brand_time_idx on email_boss.events (brand_id, occurred_at desc);
create index events_contact_idx on email_boss.events (contact_id);

-- ---------------------------------------------------------------------------
-- lock it down: RLS on, no policies, no grants for the public API roles
-- ---------------------------------------------------------------------------
alter table email_boss.brands enable row level security;
alter table email_boss.contacts enable row level security;
alter table email_boss.tags enable row level security;
alter table email_boss.contact_tags enable row level security;
alter table email_boss.sequences enable row level security;
alter table email_boss.sequence_steps enable row level security;
alter table email_boss.enrollments enable row level security;
alter table email_boss.broadcasts enable row level security;
alter table email_boss.sends enable row level security;
alter table email_boss.events enable row level security;

revoke all on schema email_boss from public;
do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on schema email_boss from %I', r);
      execute format('revoke all on all tables in schema email_boss from %I', r);
      execute format('revoke all on all sequences in schema email_boss from %I', r);
      execute format('revoke all on all functions in schema email_boss from %I', r);
      execute format('alter default privileges in schema email_boss revoke all on tables from %I', r);
    end if;
  end loop;
end $$;
