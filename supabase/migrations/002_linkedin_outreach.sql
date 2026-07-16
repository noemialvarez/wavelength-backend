-- ============================================================
-- Wavelength – LinkedIn outreach funnel (Option 4: "by name")
-- Run this once in the Supabase SQL editor against the existing
-- database (schema.sql alone won't retroactively add these columns
-- to a table that already exists).
-- ============================================================

alter table leads
  add column if not exists purpose_of_contact text,

  -- not_sent | requested | accepted | declined
  add column if not exists linkedin_connection_status text not null default 'not_sent',
  add column if not exists linkedin_connection_requested_at timestamptz,
  add column if not exists linkedin_connection_accepted_at timestamptz,

  -- waiting | ready | drafted | sent
  add column if not exists linkedin_message_status text not null default 'waiting',
  add column if not exists linkedin_message_draft text,
  add column if not exists linkedin_message_sent_at timestamptz,

  add column if not exists linkedin_replied_at timestamptz,
  add column if not exists linkedin_reminder_sent_at timestamptz,
  add column if not exists linkedin_reminder_draft text;

create index if not exists leads_linkedin_connection_status_idx on leads(linkedin_connection_status);
create index if not exists leads_linkedin_message_status_idx on leads(linkedin_message_status);
