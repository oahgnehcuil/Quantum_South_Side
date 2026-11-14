-- =============================================================================
-- 003_rls_tests.sql  -  MANUAL SAFETY TEST for Row Level Security (RLS)
-- =============================================================================
-- OPTIONAL. Run it after 001 and 002 to prove that students can only reach
-- their own data.
--
-- How to use: Supabase dashboard > SQL Editor > New query > paste this whole
-- file > Run.
--
-- What it does:
--   * Pretends to be two students (User A and User B) and a guest (anon).
--   * Tries things that SHOULD be allowed and things that SHOULD be blocked.
--   * Every test is a small "do" block with an "assert". Each block says what
--     the EXPECTED result is. If something is wrong, the script stops at once
--     with an error that starts with "TEST FAILED" or "Assertion failed" and
--     names the problem.
--   * If you reach the last line and see "All RLS tests passed", everything
--     behaved as expected.
--   * The first line is "begin" and the second to last is "rollback", so NOTHING
--     is saved. Your real data is not touched. (If the script stops early with
--     an error, the editor discards the half-finished work for you.)
--
-- How the pretending works:
--   * "set local role authenticated" makes Postgres treat us like a signed-in user.
--   * set_config('request.jwt.claims', ...) tells auth.uid() which user we are.
--     This is the same thing Supabase does for real requests.
--   * "reset role" goes back to being the admin.
--
-- If the editor refuses the first insert into auth.users, create two test users
-- in Authentication > Users instead and put their ids in place of the two
-- uuid values below (search for aaaaaaaa and bbbbbbbb).
-- =============================================================================

begin;

-- ---------------------------------------------------------------------------
-- Step 0. Make two test users (as the admin).
-- ---------------------------------------------------------------------------
-- The sign-up trigger (handle_new_user) creates their profile and settings.
-- These test users disappear at the final rollback.
insert into auth.users (id, email, raw_user_meta_data) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'user-a@rls-test.invalid', '{"nickname":"Test A"}'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'user-b@rls-test.invalid', '{"nickname":"Test B"}');

-- Give both users one row in every table (the admin may write anywhere).
update public.user_settings set save_chat_history = true
  where user_id in ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');

insert into public.progress (user_id, key, value) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'topicsCompleted', '["a"]'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'topicsCompleted', '["b"]');
insert into public.saved_careers (user_id, career_id) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'career-1'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'career-1');
insert into public.roadmap_steps (user_id, career_id, step_id, done) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'career-1', 'step-1', true),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'career-1', 'step-1', true);
insert into public.saved_circuits (user_id, name, circuit) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Circuit A', '{"gates":[]}'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'Circuit B', '{"gates":[]}');
insert into public.chat_messages (user_id, role, content) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'user', 'hello from A'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'user', 'hello from B');


-- ---------------------------------------------------------------------------
-- Test 1. User A can read their own rows.
-- EXPECTED: every table shows exactly 1 row for A (profiles 1, settings 1, ...).
-- ---------------------------------------------------------------------------
do $$
declare
  t text;
  n integer;
begin
  perform set_config('request.jwt.claims',
    '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated"}', true);
  set local role authenticated;

  -- Without any WHERE clause, A still only sees A's rows (RLS filters the rest).
  foreach t in array array['profiles', 'user_settings', 'progress', 'saved_careers',
                           'roadmap_steps', 'saved_circuits', 'chat_messages'] loop
    execute format('select count(*) from public.%I', t) into n;
    assert n = 1, format('TEST FAILED: user A should see exactly 1 row in %s but sees %s', t, n);
  end loop;

  reset role;
end
$$;


-- ---------------------------------------------------------------------------
-- Test 2. User A cannot READ user B's rows.
-- EXPECTED: 0 rows from every table when A asks for B's rows by id.
-- ---------------------------------------------------------------------------
do $$
declare
  t text;
  id_column text;
  n integer;
begin
  perform set_config('request.jwt.claims',
    '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated"}', true);
  set local role authenticated;

  foreach t in array array['profiles', 'user_settings', 'progress', 'saved_careers',
                           'roadmap_steps', 'saved_circuits', 'chat_messages'] loop
    id_column := case when t = 'profiles' then 'id' else 'user_id' end;
    execute format('select count(*) from public.%I where %I = $1', t, id_column)
      into n using 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'::uuid;
    assert n = 0, format('TEST FAILED: user A can read %s row(s) of user B in %s', n, t);
  end loop;

  reset role;
end
$$;


-- ---------------------------------------------------------------------------
-- Test 3. User A cannot UPDATE or DELETE user B's rows.
-- EXPECTED: "0 rows changed" for every table (the rows are invisible to A).
-- profiles is skipped for DELETE here: nobody may delete a profile (Test 6).
-- ---------------------------------------------------------------------------
do $$
declare
  n integer;
begin
  perform set_config('request.jwt.claims',
    '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated"}', true);
  set local role authenticated;

  -- UPDATE attempts (one per table)
  update public.profiles       set nickname = 'Hacked'  where id      = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  get diagnostics n = row_count;  assert n = 0, 'TEST FAILED: A updated B''s profile';
  update public.user_settings  set theme = 'dark'       where user_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  get diagnostics n = row_count;  assert n = 0, 'TEST FAILED: A updated B''s settings';
  update public.progress       set value = '{}'         where user_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  get diagnostics n = row_count;  assert n = 0, 'TEST FAILED: A updated B''s progress';
  update public.saved_careers  set career_id = 'x'      where user_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  get diagnostics n = row_count;  assert n = 0, 'TEST FAILED: A updated B''s saved careers';
  update public.roadmap_steps  set done = false         where user_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  get diagnostics n = row_count;  assert n = 0, 'TEST FAILED: A updated B''s roadmap steps';
  update public.saved_circuits set name = 'Hacked'      where user_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  get diagnostics n = row_count;  assert n = 0, 'TEST FAILED: A updated B''s circuits';
  update public.chat_messages  set content = 'Hacked'   where user_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  get diagnostics n = row_count;  assert n = 0, 'TEST FAILED: A updated B''s chat messages';

  -- DELETE attempts (one per table except profiles)
  delete from public.user_settings  where user_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  get diagnostics n = row_count;  assert n = 0, 'TEST FAILED: A deleted B''s settings';
  delete from public.progress       where user_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  get diagnostics n = row_count;  assert n = 0, 'TEST FAILED: A deleted B''s progress';
  delete from public.saved_careers  where user_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  get diagnostics n = row_count;  assert n = 0, 'TEST FAILED: A deleted B''s saved careers';
  delete from public.roadmap_steps  where user_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  get diagnostics n = row_count;  assert n = 0, 'TEST FAILED: A deleted B''s roadmap steps';
  delete from public.saved_circuits where user_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  get diagnostics n = row_count;  assert n = 0, 'TEST FAILED: A deleted B''s circuits';
  delete from public.chat_messages  where user_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  get diagnostics n = row_count;  assert n = 0, 'TEST FAILED: A deleted B''s chat messages';

  reset role;
end
$$;


-- ---------------------------------------------------------------------------
-- Test 4. User A cannot INSERT rows that belong to user B.
-- EXPECTED: every insert is refused with "new row violates row-level security
-- policy" (the script treats that refusal as a PASS).
-- ---------------------------------------------------------------------------
do $$
declare
  refused integer := 0;
begin
  perform set_config('request.jwt.claims',
    '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated"}', true);
  set local role authenticated;

  begin
    insert into public.user_settings (user_id) values ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
    raise exception 'TEST FAILED: A inserted settings for B';
  exception when insufficient_privilege then refused := refused + 1;
  end;
  begin
    insert into public.progress (user_id, key, value) values ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'x', '{}');
    raise exception 'TEST FAILED: A inserted progress for B';
  exception when insufficient_privilege then refused := refused + 1;
  end;
  begin
    insert into public.saved_careers (user_id, career_id) values ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'x');
    raise exception 'TEST FAILED: A inserted a saved career for B';
  exception when insufficient_privilege then refused := refused + 1;
  end;
  begin
    insert into public.roadmap_steps (user_id, career_id, step_id) values ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'x', 'y');
    raise exception 'TEST FAILED: A inserted a roadmap step for B';
  exception when insufficient_privilege then refused := refused + 1;
  end;
  begin
    insert into public.saved_circuits (user_id, name, circuit) values ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'x', '{}');
    raise exception 'TEST FAILED: A inserted a circuit for B';
  exception when insufficient_privilege then refused := refused + 1;
  end;
  begin
    insert into public.chat_messages (user_id, role, content) values ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'user', 'x');
    raise exception 'TEST FAILED: A inserted a chat message for B';
  exception when insufficient_privilege then refused := refused + 1;
  end;

  assert refused = 6, 'TEST FAILED: not all 6 foreign inserts were refused';
  reset role;
end
$$;


-- ---------------------------------------------------------------------------
-- Test 5. User A CAN change their own data.
-- EXPECTED: each statement changes exactly 1 row.
-- ---------------------------------------------------------------------------
do $$
declare
  n integer;
begin
  perform set_config('request.jwt.claims',
    '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated"}', true);
  set local role authenticated;

  update public.profiles set nickname = 'Test A2' where id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  get diagnostics n = row_count;  assert n = 1, 'TEST FAILED: A cannot update their own profile';

  update public.user_settings set theme = 'dark' where user_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  get diagnostics n = row_count;  assert n = 1, 'TEST FAILED: A cannot update their own settings';

  insert into public.progress (user_id, key, value)
    values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'quizBest', '{"intro":3}');
  get diagnostics n = row_count;  assert n = 1, 'TEST FAILED: A cannot save their own progress';

  delete from public.progress
    where user_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' and key = 'quizBest';
  get diagnostics n = row_count;  assert n = 1, 'TEST FAILED: A cannot delete their own progress';

  reset role;
end
$$;


-- ---------------------------------------------------------------------------
-- Test 6. Profiles: no INSERT and no DELETE for anybody.
-- EXPECTED: both attempts are refused ("permission denied for table profiles").
-- The profile is created by the sign-up trigger and removed when the account is deleted.
-- ---------------------------------------------------------------------------
do $$
declare
  refused integer := 0;
  n integer;
begin
  perform set_config('request.jwt.claims',
    '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated"}', true);
  set local role authenticated;

  begin
    insert into public.profiles (id, nickname) values (gen_random_uuid(), 'Sneaky');
    raise exception 'TEST FAILED: a profile was inserted by a user';
  exception when insufficient_privilege then refused := refused + 1;
  end;
  begin
    delete from public.profiles where id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    raise exception 'TEST FAILED: a profile was deleted by a user';
  exception when insufficient_privilege then refused := refused + 1;
  end;
  assert refused = 2, 'TEST FAILED: profile insert/delete should both be refused';

  reset role;

  -- The profile must still be there (checked as the admin).
  select count(*) into n from public.profiles where id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  assert n = 1, 'TEST FAILED: the profile disappeared';
end
$$;


-- ---------------------------------------------------------------------------
-- Test 7. A nickname cannot be an email address or contain odd characters.
-- EXPECTED: the update is refused by the CHECK rule (error 23514).
-- ---------------------------------------------------------------------------
do $$
begin
  perform set_config('request.jwt.claims',
    '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated"}', true);
  set local role authenticated;

  begin
    update public.profiles set nickname = 'someone@mail.com' where id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    raise exception 'TEST FAILED: an email-like nickname was accepted';
  exception when check_violation then null;
  end;
  begin
    update public.profiles set nickname = 'x' where id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    raise exception 'TEST FAILED: a 1-character nickname was accepted';
  exception when check_violation then null;
  end;

  reset role;
end
$$;


-- ---------------------------------------------------------------------------
-- Test 8. Chat history is only saved when save_chat_history is ON.
-- EXPECTED:
--   * settings OFF  -> insert refused
--   * settings ON   -> insert works (1 row)
--   * settings OFF again -> insert refused again
-- ---------------------------------------------------------------------------
do $$
declare
  n integer;
begin
  perform set_config('request.jwt.claims',
    '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated"}', true);
  set local role authenticated;

  update public.user_settings set save_chat_history = false
    where user_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  begin
    insert into public.chat_messages (user_id, role, content)
      values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'user', 'should not save');
    raise exception 'TEST FAILED: a chat message was saved while saving is OFF';
  exception when insufficient_privilege then null;
  end;

  update public.user_settings set save_chat_history = true
    where user_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  insert into public.chat_messages (user_id, role, content)
    values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'user', 'should save');
  get diagnostics n = row_count;
  assert n = 1, 'TEST FAILED: a chat message could not be saved while saving is ON';

  update public.user_settings set save_chat_history = false
    where user_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  begin
    insert into public.chat_messages (user_id, role, content)
      values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'user', 'should not save either');
    raise exception 'TEST FAILED: a chat message was saved after turning saving OFF';
  exception when insufficient_privilege then null;
  end;

  reset role;
end
$$;


-- ---------------------------------------------------------------------------
-- Test 9. Guests (role anon) are blocked from every table.
-- EXPECTED: "permission denied" for reading and for writing, on all 7 tables.
-- ---------------------------------------------------------------------------
do $$
declare
  t text;
  n integer;
  refused integer := 0;
begin
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  set local role anon;

  foreach t in array array['profiles', 'user_settings', 'progress', 'saved_careers',
                           'roadmap_steps', 'saved_circuits', 'chat_messages'] loop
    begin
      execute format('select count(*) from public.%I', t) into n;
      raise exception 'TEST FAILED: a guest could read %', t;
    exception when insufficient_privilege then refused := refused + 1;
    end;
  end loop;

  begin
    insert into public.progress (user_id, key, value)
      values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'guest', '{}');
    raise exception 'TEST FAILED: a guest could write progress';
  exception when insufficient_privilege then refused := refused + 1;
  end;

  assert refused = 8, 'TEST FAILED: guests must be refused on all 7 reads and the write';
  reset role;
end
$$;


-- ---------------------------------------------------------------------------
-- Test 10. get_impact_stats() works for guests and only returns numbers.
-- EXPECTED: one json object with exactly 5 keys, all numbers, no names or emails.
-- ---------------------------------------------------------------------------
do $$
declare
  stats json;
  key_count integer;
  non_numbers integer;
begin
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  set local role anon;

  stats := public.get_impact_stats();
  select count(*), count(*) filter (where json_typeof(value) <> 'number')
    into key_count, non_numbers
    from json_each(stats);

  assert key_count = 5, 'TEST FAILED: get_impact_stats should return exactly 5 keys';
  assert non_numbers = 0, 'TEST FAILED: get_impact_stats should return only numbers';
  assert stats::text !~* 'rls-test|Test A|Test B', 'TEST FAILED: get_impact_stats leaked personal data';
  assert (stats ->> 'total_accounts')::integer >= 2, 'TEST FAILED: total_accounts should count the test users';

  reset role;
end
$$;


-- ---------------------------------------------------------------------------
-- Test 11. Old chat clean-up is for admins only.
-- EXPECTED: guests and students are refused; the admin may run it.
-- ---------------------------------------------------------------------------
do $$
declare
  refused integer := 0;
begin
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  set local role anon;
  begin
    perform public.delete_old_chat_messages();
    raise exception 'TEST FAILED: a guest ran delete_old_chat_messages';
  exception when insufficient_privilege then refused := refused + 1;
  end;
  reset role;

  perform set_config('request.jwt.claims',
    '{"sub":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","role":"authenticated"}', true);
  set local role authenticated;
  begin
    perform public.delete_old_chat_messages();
    raise exception 'TEST FAILED: a student ran delete_old_chat_messages';
  exception when insufficient_privilege then refused := refused + 1;
  end;
  reset role;

  assert refused = 2, 'TEST FAILED: guests and students must both be refused';
  perform public.delete_old_chat_messages();   -- the admin can run it
end
$$;


-- ---------------------------------------------------------------------------
-- Finish: throw everything away.
-- ---------------------------------------------------------------------------
rollback;

select 'All RLS tests passed. Nothing was saved (the test data was rolled back).' as result;
