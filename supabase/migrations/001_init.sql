-- =============================================================================
-- 001_init.sql  -  BASELINE database for Quantum South Side
-- =============================================================================
-- How to use: Supabase dashboard > SQL Editor > New query > paste this file > Run.
-- Run this file FIRST, then run 002_accounts.sql (it upgrades everything here).
--
-- What this file makes:
--   * 5 small tables that belong to a signed-in user
--   * Row Level Security (RLS) so every user can only touch their own rows
--   * get_impact_stats(): public totals (numbers only, never any person)
--
-- Passwords are NOT stored here. Supabase Auth keeps them safely in its own
-- private "auth" schema. There is no password column anywhere in this project.
--
-- This file is safe to run more than once.
-- =============================================================================


-- ---------------------------------------------------------------------------
-- 1. Tables
-- ---------------------------------------------------------------------------
-- "on delete cascade" means: when an account is deleted, its rows vanish too.

-- One public profile row per account (nickname only, never a real name).
create table if not exists public.profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  nickname    text,
  created_at  timestamptz not null default now()
);

-- Learning progress. One row per "key" (for example 'topicsCompleted').
create table if not exists public.progress (
  user_id     uuid not null references auth.users (id) on delete cascade,
  key         text not null,
  value       jsonb,
  updated_at  timestamptz not null default now(),
  primary key (user_id, key)
);

-- Careers a student bookmarked.
create table if not exists public.saved_careers (
  user_id     uuid not null references auth.users (id) on delete cascade,
  career_id   text not null,
  created_at  timestamptz not null default now(),
  primary key (user_id, career_id)
);

-- Which roadmap steps a student finished.
create table if not exists public.roadmap_steps (
  user_id     uuid not null references auth.users (id) on delete cascade,
  career_id   text not null,
  step_id     text not null,
  done        boolean not null default false,
  updated_at  timestamptz not null default now(),
  primary key (user_id, career_id, step_id)
);

-- Chat history (only saved when the student turns that setting on).
create table if not exists public.chat_messages (
  user_id     uuid not null references auth.users (id) on delete cascade,
  role        text not null,
  content     text not null,
  created_at  timestamptz not null default now()
);


-- ---------------------------------------------------------------------------
-- 2. Row Level Security (RLS)
-- ---------------------------------------------------------------------------
-- With RLS ON and no matching policy, nobody can read or write a row.
-- Each policy below says: "a signed-in user may only touch rows that are theirs".
-- (select auth.uid()) is the id of the signed-in user. Wrapping it in "select"
-- lets Postgres work it out once per query, which is faster.
-- "to authenticated" means signed-in users only. Guests (role "anon") get nothing.

alter table public.profiles       enable row level security;
alter table public.progress       enable row level security;
alter table public.saved_careers  enable row level security;
alter table public.roadmap_steps  enable row level security;
alter table public.chat_messages  enable row level security;

-- profiles (the row id IS the user id)
drop policy if exists "profiles: read own"   on public.profiles;
drop policy if exists "profiles: insert own" on public.profiles;
drop policy if exists "profiles: update own" on public.profiles;
drop policy if exists "profiles: delete own" on public.profiles;
create policy "profiles: read own"   on public.profiles for select to authenticated
  using ((select auth.uid()) = id);
create policy "profiles: insert own" on public.profiles for insert to authenticated
  with check ((select auth.uid()) = id);
create policy "profiles: update own" on public.profiles for update to authenticated
  using ((select auth.uid()) = id) with check ((select auth.uid()) = id);
create policy "profiles: delete own" on public.profiles for delete to authenticated
  using ((select auth.uid()) = id);

-- progress
drop policy if exists "progress: read own"   on public.progress;
drop policy if exists "progress: insert own" on public.progress;
drop policy if exists "progress: update own" on public.progress;
drop policy if exists "progress: delete own" on public.progress;
create policy "progress: read own"   on public.progress for select to authenticated
  using ((select auth.uid()) = user_id);
create policy "progress: insert own" on public.progress for insert to authenticated
  with check ((select auth.uid()) = user_id);
create policy "progress: update own" on public.progress for update to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "progress: delete own" on public.progress for delete to authenticated
  using ((select auth.uid()) = user_id);

-- saved_careers
drop policy if exists "saved_careers: read own"   on public.saved_careers;
drop policy if exists "saved_careers: insert own" on public.saved_careers;
drop policy if exists "saved_careers: update own" on public.saved_careers;
drop policy if exists "saved_careers: delete own" on public.saved_careers;
create policy "saved_careers: read own"   on public.saved_careers for select to authenticated
  using ((select auth.uid()) = user_id);
create policy "saved_careers: insert own" on public.saved_careers for insert to authenticated
  with check ((select auth.uid()) = user_id);
create policy "saved_careers: update own" on public.saved_careers for update to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "saved_careers: delete own" on public.saved_careers for delete to authenticated
  using ((select auth.uid()) = user_id);

-- roadmap_steps
drop policy if exists "roadmap_steps: read own"   on public.roadmap_steps;
drop policy if exists "roadmap_steps: insert own" on public.roadmap_steps;
drop policy if exists "roadmap_steps: update own" on public.roadmap_steps;
drop policy if exists "roadmap_steps: delete own" on public.roadmap_steps;
create policy "roadmap_steps: read own"   on public.roadmap_steps for select to authenticated
  using ((select auth.uid()) = user_id);
create policy "roadmap_steps: insert own" on public.roadmap_steps for insert to authenticated
  with check ((select auth.uid()) = user_id);
create policy "roadmap_steps: update own" on public.roadmap_steps for update to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "roadmap_steps: delete own" on public.roadmap_steps for delete to authenticated
  using ((select auth.uid()) = user_id);

-- chat_messages
drop policy if exists "chat_messages: read own"   on public.chat_messages;
drop policy if exists "chat_messages: insert own" on public.chat_messages;
drop policy if exists "chat_messages: update own" on public.chat_messages;
drop policy if exists "chat_messages: delete own" on public.chat_messages;
create policy "chat_messages: read own"   on public.chat_messages for select to authenticated
  using ((select auth.uid()) = user_id);
create policy "chat_messages: insert own" on public.chat_messages for insert to authenticated
  with check ((select auth.uid()) = user_id);
create policy "chat_messages: update own" on public.chat_messages for update to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "chat_messages: delete own" on public.chat_messages for delete to authenticated
  using ((select auth.uid()) = user_id);

-- Guests (role "anon") must never touch these tables.
revoke all on public.profiles, public.progress, public.saved_careers,
              public.roadmap_steps, public.chat_messages from anon;


-- ---------------------------------------------------------------------------
-- 3. Public impact numbers
-- ---------------------------------------------------------------------------
-- Returns ONLY totals (numbers). It never returns a row, email or nickname.
-- "security definer" lets it count rows that RLS hides from guests.
-- "set search_path = ''" is a safety rule for security definer functions, so
-- every table name below is written in full (public.something).
create or replace function public.get_impact_stats()
returns json
language sql
stable
security definer
set search_path = ''
as $$
  select json_build_object(
    'total_accounts',   (select count(*) from public.profiles),
    'topics_completed', (select coalesce(sum(jsonb_array_length(value)), 0)::bigint
                         from public.progress
                         where key = 'topicsCompleted' and jsonb_typeof(value) = 'array'),
    'roadmaps_started', (select count(*) from (
                           select distinct user_id, career_id
                           from public.roadmap_steps where done
                         ) as started),
    'puzzles_solved',   (select coalesce(sum(
                           case jsonb_typeof(value -> 'solved')
                             when 'object' then (select count(*) from jsonb_object_keys(value -> 'solved'))
                             when 'array'  then jsonb_array_length(value -> 'solved')
                             else 0
                           end), 0)::bigint
                         from public.progress where key = 'game')
  );
$$;

revoke execute on function public.get_impact_stats() from public;
grant  execute on function public.get_impact_stats() to anon, authenticated;
