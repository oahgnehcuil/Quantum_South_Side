-- =============================================================================
-- 002_accounts.sql  -  FULL database design for optional accounts
-- =============================================================================
-- How to use: Supabase dashboard > SQL Editor > New query > paste this file > Run.
-- Run 001_init.sql first if you like, but you do not have to:
--   * on a brand new project it builds everything by itself
--   * on a project that already ran 001 it upgrades the tables in place
--   * it is safe to run again and again (nothing is lost, nothing is duplicated)
--
-- Privacy by design:
--   * We keep only: a nickname, progress, settings (and optional saved items).
--   * Passwords are NOT in these tables. Supabase Auth keeps them privately in
--     the "auth" schema. There is no password column here, and there never
--     should be one.
--   * Nothing here reads or exposes auth.users or anyone's email address.
--
-- Contents
--   1. Tables
--   2. Upgrade clean-up for projects that ran 001
--   3. Rules (CHECK constraints)
--   4. Helper functions and triggers
--   5. Row Level Security (RLS)
--   6. Table permissions
--   7. Public impact numbers
--   8. Optional clean-up of old chat messages
-- =============================================================================


-- ---------------------------------------------------------------------------
-- 1. Tables
-- ---------------------------------------------------------------------------
-- "if not exists" keeps existing tables. "add column if not exists" fills in
-- anything an older version was missing. Every user_id points at auth.users and
-- uses "on delete cascade": delete an account and all its rows disappear.

-- Public profile: just a nickname (2-30 letters, numbers, spaces or _).
create table if not exists public.profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  nickname    text not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
alter table public.profiles add column if not exists created_at timestamptz not null default now();
alter table public.profiles add column if not exists updated_at timestamptz not null default now();

-- Settings. Chat history and personalising are OFF until the student turns them on.
create table if not exists public.user_settings (
  user_id            uuid primary key references auth.users (id) on delete cascade,
  save_chat_history  boolean not null default false,
  personalize_chat   boolean not null default false,
  theme              text not null default 'system',
  text_size          text not null default 'medium',
  reduced_motion     boolean not null default false,
  high_contrast      boolean not null default false,
  updated_at         timestamptz not null default now()
);

-- Progress: one row per key (topicsCompleted, quizBest, confidence, game).
create table if not exists public.progress (
  user_id     uuid not null references auth.users (id) on delete cascade,
  key         text not null,
  value       jsonb not null default '{}'::jsonb,
  updated_at  timestamptz not null default now(),
  primary key (user_id, key)
);
alter table public.progress add column if not exists updated_at timestamptz not null default now();

-- Careers a student bookmarked.
create table if not exists public.saved_careers (
  user_id     uuid not null references auth.users (id) on delete cascade,
  career_id   text not null,
  created_at  timestamptz not null default now(),
  primary key (user_id, career_id)
);
alter table public.saved_careers add column if not exists created_at timestamptz not null default now();

-- Roadmap steps a student finished.
create table if not exists public.roadmap_steps (
  user_id     uuid not null references auth.users (id) on delete cascade,
  career_id   text not null,
  step_id     text not null,
  done        boolean not null default false,
  updated_at  timestamptz not null default now(),
  primary key (user_id, career_id, step_id)
);
alter table public.roadmap_steps add column if not exists updated_at timestamptz not null default now();

-- Circuits a student saved from the quantum simulator.
create table if not exists public.saved_circuits (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,
  name        text not null,
  circuit     jsonb not null,
  created_at  timestamptz not null default now()
);

-- Chat history. Rows are only allowed when save_chat_history is ON (see RLS).
create table if not exists public.chat_messages (
  id          bigint generated always as identity primary key,
  user_id     uuid not null references auth.users (id) on delete cascade,
  role        text not null,
  content     text not null,
  created_at  timestamptz not null default now()
);
alter table public.chat_messages add column if not exists created_at timestamptz not null default now();
-- A table made by 001 has no id column yet. Add one, then make it the primary key.
alter table public.chat_messages add column if not exists id bigint generated always as identity;
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.chat_messages'::regclass and contype = 'p'
  ) then
    alter table public.chat_messages add primary key (id);
  end if;
end
$$;

-- Fast lookups of "my newest messages" and "my saved circuits".
create index if not exists chat_messages_user_id_created_at_idx
  on public.chat_messages (user_id, created_at);
create index if not exists saved_circuits_user_id_created_at_idx
  on public.saved_circuits (user_id, created_at);


-- ---------------------------------------------------------------------------
-- 2. Upgrade clean-up (only does something if 001 left odd rows behind)
-- ---------------------------------------------------------------------------
-- The new rules in section 3 would refuse these rows, so fix them first.

-- Bad or missing nicknames become 'Learner'.
update public.profiles
set nickname = 'Learner'
where nickname is null
   or not (char_length(nickname) between 2 and 30
           and nickname ~ '^[[:alnum:]_ ]+$'
           and btrim(nickname) <> '');

-- Empty progress values become an empty object.
update public.progress set value = '{}'::jsonb where value is null;

-- Throw away rows with impossible text (they cannot come from the website).
delete from public.progress      where char_length(key) not between 1 and 100;
delete from public.saved_careers where char_length(career_id) not between 1 and 100;
delete from public.roadmap_steps where char_length(career_id) not between 1 and 100
                                    or char_length(step_id)   not between 1 and 100;
delete from public.chat_messages where role not in ('user', 'assistant')
                                    or char_length(content) = 0;
-- Very long chat messages are shortened instead of deleted.
update public.chat_messages set content = left(content, 4000) where char_length(content) > 4000;

-- Make sure columns that older versions left loose now have the final shape.
alter table public.profiles       alter column nickname set not null;
alter table public.progress       alter column value set not null;
alter table public.progress       alter column value set default '{}'::jsonb;
alter table public.roadmap_steps  alter column done set not null;
alter table public.roadmap_steps  alter column done set default false;
alter table public.chat_messages  alter column role set not null;
alter table public.chat_messages  alter column content set not null;

-- Every existing account gets a profile and a default settings row.
insert into public.profiles (id, nickname)
select u.id, 'Learner' from auth.users u
on conflict (id) do nothing;

insert into public.user_settings (user_id)
select p.id from public.profiles p
on conflict (user_id) do nothing;


-- ---------------------------------------------------------------------------
-- 3. Rules (CHECK constraints)
-- ---------------------------------------------------------------------------
-- The database refuses bad data even if the website has a bug.
-- Each rule is dropped first so this file can run again.

-- Nickname: 2-30 characters; letters, numbers, spaces and _ only.
-- Because "@" is not in that list, an email address can never be a nickname.
alter table public.profiles drop constraint if exists profiles_nickname_length;
alter table public.profiles add  constraint profiles_nickname_length
  check (char_length(nickname) between 2 and 30);
alter table public.profiles drop constraint if exists profiles_nickname_chars;
alter table public.profiles add  constraint profiles_nickname_chars
  check (nickname ~ '^[[:alnum:]_ ]+$');
alter table public.profiles drop constraint if exists profiles_nickname_not_blank;
alter table public.profiles add  constraint profiles_nickname_not_blank
  check (btrim(nickname) <> '');

-- Settings: only the allowed choices.
alter table public.user_settings drop constraint if exists user_settings_theme_check;
alter table public.user_settings add  constraint user_settings_theme_check
  check (theme in ('system', 'light', 'dark'));
alter table public.user_settings drop constraint if exists user_settings_text_size_check;
alter table public.user_settings add  constraint user_settings_text_size_check
  check (text_size in ('small', 'medium', 'large'));

-- Short keys and ids (stops people filling the database with junk).
alter table public.progress drop constraint if exists progress_key_length;
alter table public.progress add  constraint progress_key_length
  check (char_length(key) between 1 and 100);
alter table public.saved_careers drop constraint if exists saved_careers_career_id_length;
alter table public.saved_careers add  constraint saved_careers_career_id_length
  check (char_length(career_id) between 1 and 100);
alter table public.roadmap_steps drop constraint if exists roadmap_steps_ids_length;
alter table public.roadmap_steps add  constraint roadmap_steps_ids_length
  check (char_length(career_id) between 1 and 100 and char_length(step_id) between 1 and 100);

-- Circuits: a name of 1-60 characters.
alter table public.saved_circuits drop constraint if exists saved_circuits_name_length;
alter table public.saved_circuits add  constraint saved_circuits_name_length
  check (char_length(name) between 1 and 60);

-- Chat: only two speakers, and 1-4000 characters per message.
alter table public.chat_messages drop constraint if exists chat_messages_role_check;
alter table public.chat_messages add  constraint chat_messages_role_check
  check (role in ('user', 'assistant'));
alter table public.chat_messages drop constraint if exists chat_messages_content_length;
alter table public.chat_messages add  constraint chat_messages_content_length
  check (char_length(content) between 1 and 4000);


-- ---------------------------------------------------------------------------
-- 4. Helper functions and triggers
-- ---------------------------------------------------------------------------

-- 4a. set_updated_at(): stamps "updated_at" with the current time on every update.
create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists set_updated_at on public.profiles;
create trigger set_updated_at before update on public.profiles
  for each row execute function public.set_updated_at();

drop trigger if exists set_updated_at on public.user_settings;
create trigger set_updated_at before update on public.user_settings
  for each row execute function public.set_updated_at();

drop trigger if exists set_updated_at on public.progress;
create trigger set_updated_at before update on public.progress
  for each row execute function public.set_updated_at();

drop trigger if exists set_updated_at on public.roadmap_steps;
create trigger set_updated_at before update on public.roadmap_steps
  for each row execute function public.set_updated_at();

-- 4b. handle_new_user(): runs right after someone signs up.
-- It creates their profile (from the nickname sent at sign-up) and a default
-- settings row.
--   * "security definer" lets it write the rows even though the new user has no
--     rights yet. "set search_path = ''" is the safety rule for that, so every
--     name is written in full (public.profiles).
--   * It must NEVER fail, or nobody could sign up. A missing, too short, too long
--     or odd nickname quietly becomes 'Learner' (the user can change it later).
--   * We read ONLY the nickname from the sign-up data. Nothing else is copied.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  chosen_nickname text;
begin
  chosen_nickname := btrim(new.raw_user_meta_data ->> 'nickname');

  if chosen_nickname is null
     or char_length(chosen_nickname) not between 2 and 30
     or chosen_nickname !~ '^[[:alnum:]_ ]+$' then
    chosen_nickname := 'Learner';
  end if;

  insert into public.profiles (id, nickname)
  values (new.id, chosen_nickname)
  on conflict (id) do nothing;

  insert into public.user_settings (user_id)
  values (new.id)
  on conflict (user_id) do nothing;

  return new;
exception when others then
  -- Last safety net: log a warning (no personal data) and let the sign-up go on.
  raise warning 'handle_new_user could not create a profile (SQLSTATE %)', sqlstate;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Trigger functions are not meant to be called by hand, so nobody gets EXECUTE.
-- (Triggers still fire normally.)
revoke execute on function public.handle_new_user() from public, anon, authenticated;
revoke execute on function public.set_updated_at()  from public, anon, authenticated;


-- ---------------------------------------------------------------------------
-- 5. Row Level Security (RLS)
-- ---------------------------------------------------------------------------
-- RLS ON + no policy = nobody gets in. Each policy below lets a SIGNED-IN user
-- ("to authenticated") work only with their own rows.
-- (select auth.uid()) is the signed-in user's id; the "select" wrapper makes it
-- faster. There is NO policy for guests (role "anon"): guests use their own
-- device storage and never touch the database.

alter table public.profiles        enable row level security;
alter table public.user_settings   enable row level security;
alter table public.progress        enable row level security;
alter table public.saved_careers   enable row level security;
alter table public.roadmap_steps   enable row level security;
alter table public.saved_circuits  enable row level security;
alter table public.chat_messages   enable row level security;

-- Start clean: remove every old policy on these tables (including the ones 001
-- made), then create the final ones below.
do $$
declare
  old_policy record;
begin
  for old_policy in
    select policyname, tablename from pg_policies
    where schemaname = 'public'
      and tablename in ('profiles', 'user_settings', 'progress', 'saved_careers',
                        'roadmap_steps', 'saved_circuits', 'chat_messages')
  loop
    execute format('drop policy %I on public.%I', old_policy.policyname, old_policy.tablename);
  end loop;
end
$$;

-- profiles: read and update your own row. No INSERT policy (the trigger above
-- creates the row) and no DELETE policy (deleting the account does that).
create policy "profiles: read own" on public.profiles
  for select to authenticated
  using ((select auth.uid()) = id);
create policy "profiles: update own" on public.profiles
  for update to authenticated
  using ((select auth.uid()) = id)
  with check ((select auth.uid()) = id);

-- user_settings
create policy "user_settings: read own" on public.user_settings
  for select to authenticated
  using ((select auth.uid()) = user_id);
create policy "user_settings: insert own" on public.user_settings
  for insert to authenticated
  with check ((select auth.uid()) = user_id);
create policy "user_settings: update own" on public.user_settings
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
create policy "user_settings: delete own" on public.user_settings
  for delete to authenticated
  using ((select auth.uid()) = user_id);

-- progress
create policy "progress: read own" on public.progress
  for select to authenticated
  using ((select auth.uid()) = user_id);
create policy "progress: insert own" on public.progress
  for insert to authenticated
  with check ((select auth.uid()) = user_id);
create policy "progress: update own" on public.progress
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
create policy "progress: delete own" on public.progress
  for delete to authenticated
  using ((select auth.uid()) = user_id);

-- saved_careers
create policy "saved_careers: read own" on public.saved_careers
  for select to authenticated
  using ((select auth.uid()) = user_id);
create policy "saved_careers: insert own" on public.saved_careers
  for insert to authenticated
  with check ((select auth.uid()) = user_id);
create policy "saved_careers: update own" on public.saved_careers
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
create policy "saved_careers: delete own" on public.saved_careers
  for delete to authenticated
  using ((select auth.uid()) = user_id);

-- roadmap_steps
create policy "roadmap_steps: read own" on public.roadmap_steps
  for select to authenticated
  using ((select auth.uid()) = user_id);
create policy "roadmap_steps: insert own" on public.roadmap_steps
  for insert to authenticated
  with check ((select auth.uid()) = user_id);
create policy "roadmap_steps: update own" on public.roadmap_steps
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
create policy "roadmap_steps: delete own" on public.roadmap_steps
  for delete to authenticated
  using ((select auth.uid()) = user_id);

-- saved_circuits
create policy "saved_circuits: read own" on public.saved_circuits
  for select to authenticated
  using ((select auth.uid()) = user_id);
create policy "saved_circuits: insert own" on public.saved_circuits
  for insert to authenticated
  with check ((select auth.uid()) = user_id);
create policy "saved_circuits: update own" on public.saved_circuits
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
create policy "saved_circuits: delete own" on public.saved_circuits
  for delete to authenticated
  using ((select auth.uid()) = user_id);

-- chat_messages
create policy "chat_messages: read own" on public.chat_messages
  for select to authenticated
  using ((select auth.uid()) = user_id);
-- Saving a message is only allowed while "save_chat_history" is ON for that user.
create policy "chat_messages: insert own when saving is on" on public.chat_messages
  for insert to authenticated
  with check (
    (select auth.uid()) = user_id
    and exists (
      select 1 from public.user_settings s
      where s.user_id = (select auth.uid())
        and s.save_chat_history
    )
  );
create policy "chat_messages: update own" on public.chat_messages
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
create policy "chat_messages: delete own" on public.chat_messages
  for delete to authenticated
  using ((select auth.uid()) = user_id);


-- ---------------------------------------------------------------------------
-- 6. Table permissions
-- ---------------------------------------------------------------------------
-- Supabase gives new tables broad permissions by default. RLS already blocks the
-- rows, but we also take the permissions away (belt and braces).
--   * Guests (anon): nothing at all.
--   * Signed-in users: only what the app needs. Profiles: read and update only.
revoke all on public.profiles, public.user_settings, public.progress,
              public.saved_careers, public.roadmap_steps, public.saved_circuits,
              public.chat_messages
  from anon, authenticated;

grant select, update on public.profiles to authenticated;
grant select, insert, update, delete on public.user_settings, public.progress,
              public.saved_careers, public.roadmap_steps, public.saved_circuits,
              public.chat_messages
  to authenticated;

-- The counter behind chat_messages.id is internal; nobody needs it directly.
do $$
declare
  id_sequence text := pg_get_serial_sequence('public.chat_messages', 'id');
begin
  if id_sequence is not null then
    execute format('revoke all on sequence %s from anon, authenticated', id_sequence);
  end if;
end
$$;


-- ---------------------------------------------------------------------------
-- 7. Public impact numbers
-- ---------------------------------------------------------------------------
-- Returns ONLY five totals (numbers). Never a row, an email or a nickname.
-- It is safe to show to guests, so anon and authenticated may call it.
--   total_accounts    = number of accounts
--   topics_completed  = all finished topics added together
--   roadmaps_started  = (student, career) pairs with at least one finished step
--   puzzles_solved    = all solved Collapse Challenge puzzles added together
--   circuits_saved    = number of saved circuits
-- Note: with very few users the totals are tiny, so show them only when it is
-- fine for people to guess how many students there are.
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
                         from public.progress where key = 'game'),
    'circuits_saved',   (select count(*) from public.saved_circuits)
  );
$$;

revoke execute on function public.get_impact_stats() from public;
grant  execute on function public.get_impact_stats() to anon, authenticated;


-- ---------------------------------------------------------------------------
-- 8. OPTIONAL: delete old chat messages
-- ---------------------------------------------------------------------------
-- Chat history is only kept for students who turn it on, and we do not need it
-- forever. This function deletes messages older than N days (default 90) and
-- returns how many it deleted.
--
-- It is for admins only: guests and signed-in students cannot run it.
-- You can run it by hand in the SQL Editor:   select public.delete_old_chat_messages();
--
-- To run it automatically (optional): Supabase dashboard > Integrations >
-- Cron (pg_cron), then add a job that runs once a day:
--   select cron.schedule('delete-old-chat', '17 3 * * *',
--                        $job$ select public.delete_old_chat_messages(90) $job$);
-- If you never schedule it, nothing breaks. Old messages simply stay.
create or replace function public.delete_old_chat_messages(days integer default 90)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  deleted_count integer;
begin
  -- Refuse silly values so a typo cannot wipe every message.
  if days is null or days < 1 then
    raise exception 'days must be 1 or more';
  end if;

  delete from public.chat_messages
  where created_at < now() - make_interval(days => days);

  get diagnostics deleted_count = row_count;
  return deleted_count;
end;
$$;

revoke execute on function public.delete_old_chat_messages(integer) from public, anon, authenticated;
