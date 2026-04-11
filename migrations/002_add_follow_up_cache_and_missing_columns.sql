-- ============================================================
-- Clearbox — Migration 002
-- Adds: follow_up_cache table, missing sender_priorities columns,
--        and missing reply_queue snoozed status
-- Run this in the Supabase SQL Editor
-- ============================================================

-- ============ FOLLOW-UP CACHE ============
-- Pre-computed follow-up data (starred sent + awaiting reply)
-- Updated by cron job and on each triage run for instant Follow Up tab loading
create table if not exists public."emailHelperV2_follow_up_cache" (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references auth.users(id) on delete cascade,
  account_email text not null,
  data jsonb not null default '{}',
  computed_at timestamptz default now(),
  starred_count integer default 0,
  awaiting_count integer default 0,
  unique(user_id, account_email)
);

alter table public."emailHelperV2_follow_up_cache" enable row level security;
create policy "ehv2_follow_up_cache_all" on public."emailHelperV2_follow_up_cache"
  for all using (auth.uid() = user_id);

create index if not exists "ehv2_idx_follow_up_cache_user"
  on public."emailHelperV2_follow_up_cache"(user_id);

-- ============ SENDER PRIORITIES — ADD MISSING COLUMNS ============
-- aliases: array of alternative email addresses merged into this sender
alter table public."emailHelperV2_sender_priorities"
  add column if not exists aliases text[] default '{}';

-- auto_archive_updates: when true, triage auto-archives update-only emails from this sender
alter table public."emailHelperV2_sender_priorities"
  add column if not exists auto_archive_updates boolean default false;

-- ============ REPLY QUEUE — ALLOW 'snoozed' STATUS ============
-- The original check constraint only allowed: active, done, snoozed, later
-- This should already work, but ensure it's correct
-- (No change needed — 'snoozed' is already in the check constraint)

-- ============ DONE ============
-- After running this migration, set the ENCRYPTION_SALT environment variable
-- in your Netlify deployment for production-grade encryption:
--   ENCRYPTION_SALT=<your-random-string>
-- Generate one with: openssl rand -hex 32
