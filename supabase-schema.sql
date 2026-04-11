-- ============================================================
-- Email Helper — Supabase Database Schema
-- All tables prefixed with emailHelperV2_ to coexist with other data
-- Run this in the Supabase SQL Editor
-- ============================================================

-- Enable UUID generation
create extension if not exists "uuid-ossp";

-- ============ USERS (extends Supabase auth.users) ============
create table public."emailHelperV2_user_profiles" (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  display_name text,
  primary_account text,
  active_inboxes text[] default '{}',
  created_at timestamptz default now()
);

alter table public."emailHelperV2_user_profiles" enable row level security;
create policy "ehv2_users_select" on public."emailHelperV2_user_profiles"
  for select using (auth.uid() = id);
create policy "ehv2_users_update" on public."emailHelperV2_user_profiles"
  for update using (auth.uid() = id);
create policy "ehv2_users_insert" on public."emailHelperV2_user_profiles"
  for insert with check (auth.uid() = id);

-- ============ GMAIL ACCOUNTS ============
create table public."emailHelperV2_gmail_accounts" (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references auth.users(id) on delete cascade,
  email text not null,
  access_token text not null,
  refresh_token text,
  token_expires_at timestamptz,
  is_primary boolean default false,
  is_active_inbox boolean default false,
  senders_found integer default 0,
  status text default 'connected' check (status in ('connected', 'scanned', 'disconnected')),
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique(user_id, email)
);

alter table public."emailHelperV2_gmail_accounts" enable row level security;
create policy "ehv2_gmail_accounts_all" on public."emailHelperV2_gmail_accounts"
  for all using (auth.uid() = user_id);

-- ============ SENDER PRIORITIES ============
create table public."emailHelperV2_sender_priorities" (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references auth.users(id) on delete cascade,
  sender_email text not null,
  display_name text,
  reply_count integer default 0,
  last_reply date,
  tier text default 'D' check (tier in ('A', 'B', 'C', 'D')),
  accounts_seen text[] default '{}',
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique(user_id, sender_email)
);

alter table public."emailHelperV2_sender_priorities" enable row level security;
create policy "ehv2_sender_priorities_all" on public."emailHelperV2_sender_priorities"
  for all using (auth.uid() = user_id);

-- ============ NOTIFICATION RULES ============
create table public."emailHelperV2_notification_rules" (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references auth.users(id) on delete cascade,
  pattern text not null,
  category text not null,
  description text not null,
  default_priority integer default 5 check (default_priority between 0 and 10),
  user_priority integer check (user_priority between 0 and 10),
  created_at timestamptz default now(),
  unique(user_id, pattern)
);

alter table public."emailHelperV2_notification_rules" enable row level security;
create policy "ehv2_notification_rules_all" on public."emailHelperV2_notification_rules"
  for all using (auth.uid() = user_id);

-- ============ TRIAGE RESULTS ============
create table public."emailHelperV2_triage_results" (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references auth.users(id) on delete cascade,
  account_email text not null,
  triaged_at timestamptz default now(),
  total_unread integer default 0,
  data jsonb not null default '{}',
  unique(user_id, account_email)
);

alter table public."emailHelperV2_triage_results" enable row level security;
create policy "ehv2_triage_results_all" on public."emailHelperV2_triage_results"
  for all using (auth.uid() = user_id);

-- ============ REPLY QUEUE ============
create table public."emailHelperV2_reply_queue" (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references auth.users(id) on delete cascade,
  message_id text not null,
  thread_id text,
  account_email text not null,
  sender text not null,
  sender_email text not null,
  subject text not null,
  summary text,
  tier text default 'D',
  priority text default 'normal' check (priority in ('urgent', 'important', 'normal', 'low')),
  priority_score integer default 5,
  received timestamptz,
  gmail_url text,
  draft_id text,
  draft_url text,
  status text default 'active' check (status in ('active', 'done', 'snoozed', 'later')),
  snoozed_until timestamptz,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Unique constraint needed for triage upsert
alter table public."emailHelperV2_reply_queue"
  add constraint "ehv2_reply_queue_user_message_unique" unique (user_id, message_id);

alter table public."emailHelperV2_reply_queue" enable row level security;
create policy "ehv2_reply_queue_all" on public."emailHelperV2_reply_queue"
  for all using (auth.uid() = user_id);

-- ============ CLEANUP REPORTS ============
create table public."emailHelperV2_cleanup_reports" (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references auth.users(id) on delete cascade,
  account_email text not null,
  scanned_at timestamptz default now(),
  data jsonb not null default '{}',
  actions_taken jsonb default '[]',
  unique(user_id, account_email)
);

alter table public."emailHelperV2_cleanup_reports" enable row level security;
create policy "ehv2_cleanup_reports_all" on public."emailHelperV2_cleanup_reports"
  for all using (auth.uid() = user_id);

-- ============ DEFAULT NOTIFICATION RULES ============
create or replace function public."emailHelperV2_seed_default_rules"(p_user_id uuid)
returns void as $$
begin
  insert into public."emailHelperV2_notification_rules" (user_id, pattern, category, description, default_priority)
  values
    (p_user_id, 'from:*@github.com', 'Code & DevOps', 'GitHub notifications', 6),
    (p_user_id, 'Security alerts', 'Security', 'Google security alerts', 9),
    (p_user_id, 'from:*@stripe.com', 'Billing & Payments', 'Payment notifications', 7),
    (p_user_id, 'Calendar invites', 'Calendar', 'Google Calendar updates', 5),
    (p_user_id, 'from:*@docs.google.com', 'Collaboration', 'Google Docs activity', 5),
    (p_user_id, 'from:*@slack.com', 'Messaging', 'Slack email notifications', 4),
    (p_user_id, 'from:*@linkedin.com', 'Social / Professional', 'LinkedIn notifications', 2),
    (p_user_id, 'Social media', 'Social Media', 'Facebook, Twitter/X notifications', 1),
    (p_user_id, 'Shopping', 'Shopping', 'Order confirmations & promos', 3),
    (p_user_id, 'Newsletters', 'Newsletters', 'Mailing lists and newsletters', 1)
  on conflict (user_id, pattern) do nothing;
end;
$$ language plpgsql security definer;

-- ============ TRIGGER: Auto-create profile on signup ============
create or replace function public."emailHelperV2_handle_new_user"()
returns trigger as $$
begin
  insert into public."emailHelperV2_user_profiles" (id, email, display_name)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name', split_part(new.email, '@', 1))
  );
  perform public."emailHelperV2_seed_default_rules"(new.id);
  return new;
end;
$$ language plpgsql security definer;

-- Drop existing trigger if it exists (safe for shared projects)
drop trigger if exists "emailHelperV2_on_auth_user_created" on auth.users;
create trigger "emailHelperV2_on_auth_user_created"
  after insert on auth.users
  for each row execute procedure public."emailHelperV2_handle_new_user"();

-- ============ INDEXES ============
create index "ehv2_idx_gmail_accounts_user" on public."emailHelperV2_gmail_accounts"(user_id);
create index "ehv2_idx_sender_priorities_user" on public."emailHelperV2_sender_priorities"(user_id);
create index "ehv2_idx_sender_priorities_tier" on public."emailHelperV2_sender_priorities"(user_id, tier);
create index "ehv2_idx_reply_queue_user_status" on public."emailHelperV2_reply_queue"(user_id, status);
create index "ehv2_idx_triage_results_user" on public."emailHelperV2_triage_results"(user_id);
