-- ============================================================
-- Wavelength – Supabase schema
-- Run this in the Supabase SQL editor (or supabase db push)
-- ============================================================

-- Enable UUID generation
create extension if not exists "pgcrypto";

-- ============================================================
-- 1. LEADS
-- ============================================================
create table if not exists leads (
  id            uuid primary key default gen_random_uuid(),
  created_by    uuid references auth.users(id) on delete cascade,
  name          text not null,
  email         text,
  company       text,
  role          text,
  linkedin_url  text,
  source        text,                        -- wellfound | startupticker | manual | import
  signal_id     uuid,                        -- FK to discovery_signals if promoted
  status        text not null default 'new', -- new | enriched | contacted | replied | closed
  notes         text,
  enrichment_data jsonb default '{}',
  enriched_at   timestamptz,
  purpose_of_contact text,
  linkedin_connection_status text not null default 'not_sent', -- not_sent | requested | accepted | declined
  linkedin_connection_requested_at timestamptz,
  linkedin_connection_accepted_at  timestamptz,
  linkedin_message_status text not null default 'waiting',     -- waiting | ready | drafted | sent
  linkedin_message_draft  text,
  linkedin_message_sent_at timestamptz,
  linkedin_replied_at      timestamptz,
  linkedin_reminder_sent_at timestamptz,
  linkedin_reminder_draft  text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index on leads(created_by);
create index on leads(status);
create index on leads(linkedin_connection_status);
create index on leads(linkedin_message_status);

-- ============================================================
-- 2. DISCOVERY
-- ============================================================
create table if not exists discovery_runs (
  id            uuid primary key default gen_random_uuid(),
  created_by    uuid references auth.users(id) on delete cascade,
  sources       text[] not null,
  status        text not null default 'pending', -- pending | running | completed | failed
  signal_count  int default 0,
  completed_at  timestamptz,
  created_at    timestamptz not null default now()
);

create table if not exists discovery_signals (
  id            uuid primary key default gen_random_uuid(),
  run_id        uuid references discovery_runs(id) on delete cascade,
  source        text not null,
  company_name  text,
  founder_name  text,
  founder_email text,
  linkedin_url  text,
  signal_url    text,
  raw_data      jsonb default '{}',
  status        text not null default 'new',   -- new | promoted | dismissed
  lead_id       uuid references leads(id) on delete set null,
  created_at    timestamptz not null default now()
);

create index on discovery_signals(run_id);
create index on discovery_signals(status);

-- ============================================================
-- 3. OUTREACH
-- ============================================================
create table if not exists positioning (
  id                   uuid primary key default gen_random_uuid(),
  user_id              uuid references auth.users(id) on delete cascade unique,
  content              text not null,
  lemlist_campaign_id  text,
  updated_at           timestamptz not null default now()
);

create table if not exists outreach_drafts (
  id           uuid primary key default gen_random_uuid(),
  created_by   uuid references auth.users(id) on delete cascade,
  lead_id      uuid references leads(id) on delete cascade,
  subject      text not null,
  body         text not null,
  status       text not null default 'draft', -- draft | sent | rejected
  lemlist_id   text,
  sent_at      timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index on outreach_drafts(lead_id);
create index on outreach_drafts(status);

-- ============================================================
-- 4. PROSPECT ENGAGEMENT
-- ============================================================
create table if not exists watched_prospects (
  id           uuid primary key default gen_random_uuid(),
  created_by   uuid references auth.users(id) on delete cascade,
  linkedin_url text not null,
  name         text,
  company      text,
  created_at   timestamptz not null default now(),
  unique(created_by, linkedin_url)
);

create table if not exists prospect_activity (
  id            uuid primary key default gen_random_uuid(),
  prospect_id   uuid references watched_prospects(id) on delete cascade,
  type          text,                          -- post | like | comment | share
  content       text,
  post_url      text,
  activity_date timestamptz,
  created_at    timestamptz not null default now(),
  unique(prospect_id, post_url)
);

create index on prospect_activity(prospect_id);

create table if not exists engagement_comments (
  id           uuid primary key default gen_random_uuid(),
  created_by   uuid references auth.users(id) on delete cascade,
  activity_id  uuid references prospect_activity(id) on delete cascade,
  prospect_id  uuid references watched_prospects(id) on delete cascade,
  body         text not null,
  status       text not null default 'draft',  -- draft | posted | rejected
  posted_at    timestamptz,
  created_at   timestamptz not null default now()
);

-- ============================================================
-- 5. SEQUENCES (Lemlist sync)
-- ============================================================
create table if not exists sequences (
  id           uuid primary key default gen_random_uuid(),
  lemlist_id   text unique not null,
  name         text not null,
  status       text,
  synced_at    timestamptz,
  created_at   timestamptz not null default now()
);

create table if not exists sequence_leads (
  id               uuid primary key default gen_random_uuid(),
  sequence_id      uuid references sequences(id) on delete cascade,
  lemlist_lead_id  text,
  lead_id          uuid references leads(id) on delete set null,
  email            text,
  name             text,
  company          text,
  status           text,
  step             text,
  last_event_at    timestamptz,
  added_at         timestamptz not null default now(),
  unique(sequence_id, lemlist_lead_id)
);

create index on sequence_leads(sequence_id);
create index on sequence_leads(lead_id);

-- ============================================================
-- Row-Level Security (enable, then add policies per table)
-- ============================================================
alter table leads                enable row level security;
alter table discovery_runs       enable row level security;
alter table discovery_signals    enable row level security;
alter table positioning          enable row level security;
alter table outreach_drafts      enable row level security;
alter table watched_prospects    enable row level security;
alter table prospect_activity    enable row level security;
alter table engagement_comments  enable row level security;
alter table sequences            enable row level security;
alter table sequence_leads       enable row level security;

-- Leads: owner can do everything
create policy "leads_owner" on leads
  for all using (auth.uid() = created_by);

-- Discovery runs: owner only
create policy "runs_owner" on discovery_runs
  for all using (auth.uid() = created_by);

-- Signals: visible if user owns the parent run
create policy "signals_owner" on discovery_signals
  for all using (
    exists (
      select 1 from discovery_runs r
      where r.id = discovery_signals.run_id and r.created_by = auth.uid()
    )
  );

-- Positioning: personal
create policy "positioning_owner" on positioning
  for all using (auth.uid() = user_id);

-- Outreach drafts: owner
create policy "drafts_owner" on outreach_drafts
  for all using (auth.uid() = created_by);

-- Watched prospects: owner
create policy "prospects_owner" on watched_prospects
  for all using (auth.uid() = created_by);

-- Prospect activity: visible if user owns the prospect
create policy "activity_owner" on prospect_activity
  for all using (
    exists (
      select 1 from watched_prospects p
      where p.id = prospect_activity.prospect_id and p.created_by = auth.uid()
    )
  );

-- Engagement comments: owner
create policy "comments_owner" on engagement_comments
  for all using (auth.uid() = created_by);

-- Sequences: all authenticated users can read (shared Lemlist data)
create policy "sequences_read" on sequences
  for select using (auth.role() = 'authenticated');

create policy "sequence_leads_read" on sequence_leads
  for select using (auth.role() = 'authenticated');

-- ============================================================
-- updated_at trigger
-- ============================================================
create or replace function set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger leads_updated_at before update on leads
  for each row execute function set_updated_at();

create trigger drafts_updated_at before update on outreach_drafts
  for each row execute function set_updated_at();
