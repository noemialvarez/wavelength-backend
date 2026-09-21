-- ============================================================
-- Wavelength – people at each lead's company (founders / executive team),
-- LinkedIn connection status, and the LinkedIn Engagement page's data.
-- Run this once in the Supabase SQL editor against the existing database.
-- ============================================================

create table if not exists lead_contacts (
  id            uuid primary key default gen_random_uuid(),
  lead_id       uuid not null references leads(id) on delete cascade,
  kind          text not null default 'person',   -- person | company (the company's LinkedIn page)
  name          text not null,
  role          text,
  linkedin_url  text,
  is_founder    boolean not null default false,

  -- Are we connected on LinkedIn? yes | no | unknown (couldn't be verified)
  connection            text not null default 'unknown',
  connection_checked_at timestamptz,

  -- Picked by the user with "Select"; selecting also sends a connection request
  selected      boolean not null default false,
  request_status text not null default 'none',    -- none | requested | failed
  request_error  text,
  requested_at   timestamptz,

  -- LinkedIn Engagement page
  recent_posts        jsonb not null default '[]',
  post_summary        text,
  post_summary_at     timestamptz,
  comment_suggestions jsonb,                      -- { post_url, post_text, options: [..] }
  last_comment        text,
  commented_at        timestamptz,

  created_at    timestamptz not null default now(),
  unique (lead_id, linkedin_url)
);

create index if not exists lead_contacts_lead_id_idx on lead_contacts(lead_id);
create index if not exists lead_contacts_selected_idx on lead_contacts(selected);
-- At most one company-page entry per lead
create unique index if not exists lead_contacts_one_company_idx
  on lead_contacts(lead_id) where kind = 'company';

alter table lead_contacts enable row level security;
