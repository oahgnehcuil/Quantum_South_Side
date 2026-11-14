// Database tests for the Supabase migrations, run on a real in-memory Postgres (PGlite).
//
//   npm install            (once, adds the dev tool @electric-sql/pglite)
//   npm run test:rls
//
// The file name does not end in ".test.js", so plain "npm test" never runs it.
// It builds a tiny stand-in for Supabase (roles, auth.users, auth.uid()), loads the
// REAL SQL files from supabase/migrations/ and checks them three ways:
//   A = 002 on a brand new database
//   B = 001 first, then 002 (an upgrade of an older project, with messy old rows)
//   C = 002 run twice (it must be safe to repeat)
// Every check prints PASS or FAIL. The exit code is 1 if anything fails.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

let PGlite;
try {
  ({ PGlite } = await import('@electric-sql/pglite'));
} catch {
  process.stderr.write(
    'The PGlite package is not installed.\nRun "npm install" in the project folder, then "npm run test:rls" again.\n'
  );
  process.exit(1);
}

const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'supabase', 'migrations');
const sqlFile = (name) => readFileSync(path.join(MIGRATIONS, name), 'utf8');

const TABLES = ['profiles', 'user_settings', 'progress', 'saved_careers', 'roadmap_steps', 'saved_circuits', 'chat_messages'];
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

// ---------------------------------------------------------------------------
// A tiny stand-in for the parts of Supabase the migrations rely on.
// ---------------------------------------------------------------------------
const STUB = `
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin bypassrls;
  create role supabase_auth_admin nologin;

  create schema auth;
  create table auth.users (
    id uuid primary key default gen_random_uuid(),
    email text,
    raw_user_meta_data jsonb
  );
  -- Same logic as Supabase: read the "sub" claim of the request's JWT.
  create function auth.uid() returns uuid language sql stable as $$
    select coalesce(
      nullif(current_setting('request.jwt.claim.sub', true), ''),
      (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
    )::uuid
  $$;

  grant usage on schema public to anon, authenticated, service_role;
  grant usage on schema auth to supabase_auth_admin;
  grant execute on function auth.uid() to anon, authenticated, service_role;
  grant select, insert on auth.users to supabase_auth_admin;

  -- Supabase gives every new table and function in "public" broad rights by default.
  -- Copy that, so the migrations' own REVOKEs are really tested.
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
  alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
`;

// ---------------------------------------------------------------------------
// Result bookkeeping: one row per check, one column per scenario.
// ---------------------------------------------------------------------------
const results = new Map(); // name -> { A, B, C }
const failures = [];

function record(scenario, name, outcome, detail) {
  if (!results.has(name)) results.set(name, {});
  results.get(name)[scenario] = outcome;
  if (outcome === 'FAIL') failures.push(`[${scenario}] ${name}: ${detail ?? ''}`);
}

function makeSession(scenario, db) {
  async function check(name, fn) {
    try {
      const out = await fn();
      if (out === true) record(scenario, name, 'PASS');
      else record(scenario, name, 'FAIL', typeof out === 'string' ? out : 'condition was false');
    } catch (err) {
      record(scenario, name, 'FAIL', `threw: ${String(err.message).slice(0, 200)}`);
    }
  }

  // Run one statement as the database owner (bypasses RLS, like the SQL editor).
  const admin = (sql, params) => db.query(sql, params);

  // Run one statement as a guest ('anon') or as a signed-in user (their uuid).
  async function as(who, sql, params) {
    const claims = who === 'anon' ? { role: 'anon' } : { sub: who, role: 'authenticated' };
    await db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify(claims)]);
    await db.exec(`set role ${who === 'anon' ? 'anon' : 'authenticated'}`);
    try {
      const res = await db.query(sql, params);
      return { ok: true, rows: res.rows, count: res.affectedRows ?? res.rowCount ?? 0 };
    } catch (err) {
      return { ok: false, code: err.code, message: String(err.message) };
    } finally {
      await db.exec('reset role');
      await db.query(`select set_config('request.jwt.claims', '', false)`);
    }
  }

  // Run one statement as another named role.
  async function asRole(role, sql, params) {
    await db.exec(`set role ${role}`);
    try {
      const res = await db.query(sql, params);
      return { ok: true, rows: res.rows, count: res.affectedRows ?? res.rowCount ?? 0 };
    } catch (err) {
      return { ok: false, code: err.code, message: String(err.message) };
    } finally {
      await db.exec('reset role');
    }
  }

  // Run a statement as owner and report the error code (or null if it worked).
  async function adminError(sql, params) {
    try {
      await admin(sql, params);
      return null;
    } catch (err) {
      return err.code ?? 'error';
    }
  }

  const addUser = (id, email, meta) =>
    admin(`insert into auth.users (id, email, raw_user_meta_data) values ($1, $2, $3::jsonb)`, [
      id, email, meta === null ? null : JSON.stringify(meta),
    ]);
  const count = async (sql, params) => Number((await admin(sql, params)).rows[0].n);
  const denied = (r) => (!r.ok && r.code === '42501') || `expected "permission denied" (42501), got ${JSON.stringify(r).slice(0, 160)}`;

  return { check, admin, as, asRole, adminError, addUser, count, denied };
}

// ---------------------------------------------------------------------------
// A snapshot of the database shape, to prove A, B and C end up identical.
// ---------------------------------------------------------------------------
async function snapshot(db) {
  const q = async (sql) => (await db.query(sql)).rows;
  const tableList = TABLES.map((t) => `'${t}'`).join(',');
  const parts = {
    columns: await q(`select table_name, column_name, data_type, is_nullable, column_default, is_identity, identity_generation
      from information_schema.columns where table_schema = 'public' order by 1, 2`),
    constraints: await q(`select conrelid::regclass::text as t, conname, pg_get_constraintdef(oid) as def
      from pg_constraint where connamespace = 'public'::regnamespace order by 1, 2`),
    indexes: await q(`select tablename, indexname, indexdef from pg_indexes where schemaname = 'public' order by 1, 2`),
    policies: await q(`select tablename, policyname, cmd, roles::text, qual, with_check from pg_policies
      where schemaname = 'public' order by 1, 2`),
    triggers: await q(`select tgrelid::regclass::text as t, tgname, pg_get_triggerdef(oid) as def
      from pg_trigger where not tgisinternal order by 1, 2`),
    functions: await q(`select proname, prosecdef, proconfig::text, proacl::text, pg_get_functiondef(oid) as def
      from pg_proc where pronamespace = 'public'::regnamespace order by 1`),
    tableRights: await q(`select relname, relacl::text, relrowsecurity from pg_class
      where relnamespace = 'public'::regnamespace and relname in (${tableList}) order by 1`),
  };
  return Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, JSON.stringify(v)]));
}

function diffSnapshots(a, b) {
  const diffs = Object.keys(a).filter((k) => a[k] !== b[k]);
  return diffs.length === 0 ? true : `differs in: ${diffs.join(', ')}`;
}

// ---------------------------------------------------------------------------
// The checks. They run once per scenario.
// ---------------------------------------------------------------------------
async function runSuite(scenario, db) {
  const { check, admin, as, asRole, adminError, addUser, count, denied } = makeSession(scenario, db);
  const A = uid(1);
  const B = uid(2);
  const long = (n, ch = 'a') => ch.repeat(n);

  // ===== 0. Structure =====
  await check('structure: RLS is enabled on all 7 tables', async () => {
    const r = await admin(`select relname from pg_class where relnamespace = 'public'::regnamespace
      and relname = any($1) and relrowsecurity`, [TABLES]);
    return r.rows.length === TABLES.length || `only ${r.rows.map((x) => x.relname)}`;
  });
  await check('structure: every policy is TO authenticated only (none for anon or public)', async () => {
    const r = await admin(`select policyname, roles::text from pg_policies where schemaname = 'public'`);
    const bad = r.rows.filter((x) => x.roles !== '{authenticated}');
    return (r.rows.length > 0 && bad.length === 0) || `bad: ${JSON.stringify(bad)}`;
  });
  await check('structure: every policy uses (select auth.uid())', async () => {
    const r = await admin(`select policyname, coalesce(qual, '') || coalesce(with_check, '') as expr
      from pg_policies where schemaname = 'public'`);
    const bad = r.rows.filter((x) => !/SELECT auth\.uid\(\)/i.test(x.expr));
    return bad.length === 0 || `bad: ${JSON.stringify(bad)}`;
  });
  await check('structure: profiles has only SELECT and UPDATE policies', async () => {
    const r = await admin(`select cmd from pg_policies where schemaname = 'public' and tablename = 'profiles' order by cmd`);
    return JSON.stringify(r.rows.map((x) => x.cmd)) === '["SELECT","UPDATE"]' || JSON.stringify(r.rows);
  });
  await check('structure: the other 6 tables each have SELECT, INSERT, UPDATE and DELETE policies', async () => {
    const r = await admin(`select tablename, count(distinct cmd)::int as n from pg_policies
      where schemaname = 'public' and tablename <> 'profiles' group by 1`);
    return (r.rows.length === 6 && r.rows.every((x) => x.n === 4)) || JSON.stringify(r.rows);
  });
  await check('structure: anon has no privileges on any table', async () => {
    const r = await admin(`select t, p from unnest($1::text[]) t, unnest(array['select','insert','update','delete']) p
      where has_table_privilege('anon', 'public.' || t, p)`, [TABLES]);
    return r.rows.length === 0 || JSON.stringify(r.rows);
  });
  await check('structure: authenticated cannot INSERT or DELETE on profiles', async () => {
    const r = await admin(`select has_table_privilege('authenticated', 'public.profiles', 'insert') as i,
      has_table_privilege('authenticated', 'public.profiles', 'delete') as d,
      has_table_privilege('authenticated', 'public.profiles', 'select') as s,
      has_table_privilege('authenticated', 'public.profiles', 'update') as u`);
    const x = r.rows[0];
    return (!x.i && !x.d && x.s && x.u) || JSON.stringify(x);
  });
  await check('structure: no views anywhere (nothing exposes auth.users or emails)', async () => {
    const r = await admin(`select schemaname, viewname from pg_views where schemaname in ('public', 'auth')
      union all select schemaname, matviewname from pg_matviews where schemaname in ('public', 'auth')`);
    return r.rows.length === 0 || JSON.stringify(r.rows);
  });
  await check('structure: no password or secret column in the public schema', async () => {
    const r = await admin(`select table_name, column_name from information_schema.columns
      where table_schema = 'public' and column_name ~* '(pass|pwd|secret|hash|token|email)'`);
    return r.rows.length === 0 || JSON.stringify(r.rows);
  });
  await check('structure: only the 7 expected tables exist in public', async () => {
    const r = await admin(`select tablename from pg_tables where schemaname = 'public' order by 1`);
    return JSON.stringify(r.rows.map((x) => x.tablename)) === JSON.stringify([...TABLES].sort()) || JSON.stringify(r.rows);
  });
  await check('structure: chat_messages.id is bigint generated always as identity and the primary key', async () => {
    const r = await admin(`select a.attidentity, format_type(a.atttypid, a.atttypmod) as typ,
      (select pg_get_constraintdef(c.oid) from pg_constraint c where c.conrelid = a.attrelid and c.contype = 'p') as pk
      from pg_attribute a where a.attrelid = 'public.chat_messages'::regclass and a.attname = 'id'`);
    const x = r.rows[0];
    return (x && x.attidentity === 'a' && x.typ === 'bigint' && x.pk === 'PRIMARY KEY (id)') || JSON.stringify(x);
  });
  await check('structure: index on chat_messages (user_id, created_at)', async () => {
    const r = await admin(`select indexdef from pg_indexes where schemaname = 'public' and tablename = 'chat_messages'`);
    return r.rows.some((x) => /\(user_id, created_at\)/.test(x.indexdef)) || JSON.stringify(r.rows);
  });
  await check('structure: every user_id column references auth.users with ON DELETE CASCADE', async () => {
    const r = await admin(`select conrelid::regclass::text as t, pg_get_constraintdef(oid) as def from pg_constraint
      where contype = 'f' and connamespace = 'public'::regnamespace`);
    const bad = r.rows.filter((x) => !/REFERENCES auth\.users\(id\) ON DELETE CASCADE/.test(x.def));
    return (r.rows.length === TABLES.length && bad.length === 0) || JSON.stringify({ n: r.rows.length, bad });
  });
  await check('structure: user_settings has the documented columns and defaults', async () => {
    const r = await admin(`select column_name, column_default, is_nullable from information_schema.columns
      where table_schema = 'public' and table_name = 'user_settings' order by 1`);
    const m = Object.fromEntries(r.rows.map((x) => [x.column_name, x.column_default]));
    const want = {
      save_chat_history: 'false', personalize_chat: 'false', theme: "'system'::text", text_size: "'medium'::text",
      reduced_motion: 'false', high_contrast: 'false',
    };
    const wrong = Object.entries(want).filter(([k, v]) => m[k] !== v);
    const cols = r.rows.map((x) => x.column_name).sort().join();
    return (wrong.length === 0 && cols === 'high_contrast,personalize_chat,reduced_motion,save_chat_history,text_size,theme,updated_at,user_id')
      || JSON.stringify({ wrong, cols });
  });
  await check('structure: progress.value is jsonb not null default {}', async () => {
    const r = await admin(`select data_type, is_nullable, column_default from information_schema.columns
      where table_schema = 'public' and table_name = 'progress' and column_name = 'value'`);
    const x = r.rows[0];
    return (x.data_type === 'jsonb' && x.is_nullable === 'NO' && x.column_default === "'{}'::jsonb") || JSON.stringify(x);
  });

  // ===== 1. Functions and triggers in the catalog =====
  for (const fn of ['handle_new_user', 'get_impact_stats', 'delete_old_chat_messages', 'set_updated_at']) {
    await check(`functions: ${fn} has search_path set to empty`, async () => {
      const r = await admin(`select proconfig from pg_proc where proname = $1 and pronamespace = 'public'::regnamespace`, [fn]);
      const cfg = r.rows[0]?.proconfig ?? [];
      return cfg.includes('search_path=""') || JSON.stringify(cfg);
    });
  }
  for (const fn of ['handle_new_user', 'get_impact_stats', 'delete_old_chat_messages']) {
    await check(`functions: ${fn} is SECURITY DEFINER`, async () => {
      const r = await admin(`select prosecdef from pg_proc where proname = $1 and pronamespace = 'public'::regnamespace`, [fn]);
      return r.rows[0]?.prosecdef === true;
    });
  }
  await check('functions: trigger on_auth_user_created is AFTER INSERT on auth.users, FOR EACH ROW', async () => {
    const r = await admin(`select pg_get_triggerdef(oid) as def from pg_trigger
      where tgrelid = 'auth.users'::regclass and tgname = 'on_auth_user_created'`);
    const d = r.rows[0]?.def ?? '';
    return (/AFTER INSERT ON auth\.users FOR EACH ROW EXECUTE FUNCTION (public\.)?handle_new_user\(\)/.test(d)) || d;
  });
  await check('functions: set_updated_at trigger exists on all 4 tables that have updated_at', async () => {
    const r = await admin(`select tgrelid::regclass::text as t from pg_trigger where tgname = 'set_updated_at' and not tgisinternal order by 1`);
    return JSON.stringify(r.rows.map((x) => x.t)) === '["profiles","progress","roadmap_steps","user_settings"]' || JSON.stringify(r.rows);
  });
  await check('functions: anon and authenticated may run get_impact_stats', async () => {
    const r = await admin(`select has_function_privilege('anon', 'public.get_impact_stats()', 'execute') as a,
      has_function_privilege('authenticated', 'public.get_impact_stats()', 'execute') as b`);
    return (r.rows[0].a && r.rows[0].b) || JSON.stringify(r.rows[0]);
  });
  await check('functions: anon and authenticated cannot run delete_old_chat_messages, handle_new_user, set_updated_at', async () => {
    const r = await admin(`select f, r from unnest(array['public.delete_old_chat_messages(integer)', 'public.handle_new_user()', 'public.set_updated_at()']) f,
      unnest(array['anon', 'authenticated']) r where has_function_privilege(r, f, 'execute')`);
    return r.rows.length === 0 || JSON.stringify(r.rows);
  });
  await check('functions: PUBLIC has no EXECUTE on any of the 4 functions (checked in the ACL)', async () => {
    const acl = await admin(`select proname, coalesce(proacl::text, '') as acl from pg_proc where pronamespace = 'public'::regnamespace`);
    const open = acl.rows.filter((x) => x.acl === '' || /(^|[{,])=X/.test(x.acl));
    return (acl.rows.length === 4 && open.length === 0) || JSON.stringify(acl.rows);
  });

  // ===== 2. Users and the signup trigger =====
  await addUser(A, 'alice@example.test', { nickname: 'Alice' });
  await addUser(B, 'bob@example.test', { nickname: 'Bob' });

  await check('trigger: a valid nickname creates a profile with that nickname', async () => {
    const r = await admin(`select nickname from public.profiles where id = $1`, [A]);
    return r.rows[0]?.nickname === 'Alice' || JSON.stringify(r.rows);
  });
  await check('trigger: a default settings row is created (all flags false, system, medium)', async () => {
    const r = await admin(`select * from public.user_settings where user_id = $1`, [A]);
    const s = r.rows[0];
    return (s && s.save_chat_history === false && s.personalize_chat === false && s.reduced_motion === false
      && s.high_contrast === false && s.theme === 'system' && s.text_size === 'medium') || JSON.stringify(s);
  });

  const nicknameCases = [
    ['missing nickname key', {}, 'Learner'],
    ['no metadata at all (null)', null, 'Learner'],
    ["too short ('x')", { nickname: 'x' }, 'Learner'],
    ['41 characters', { nickname: long(41) }, 'Learner'],
    ['31 characters', { nickname: long(31) }, 'Learner'],
    ["an email address ('a@b.c')", { nickname: 'a@b.c' }, 'Learner'],
    ['a script tag', { nickname: '<script>alert(1)</script>' }, 'Learner'],
    ['only spaces', { nickname: '      ' }, 'Learner'],
    ['an empty string', { nickname: '' }, 'Learner'],
    ['a number instead of text with symbols (object)', { nickname: { a: 1 } }, 'Learner'],
    ['a list', { nickname: ['x'] }, 'Learner'],
    ['punctuation', { nickname: 'Maya!!' }, 'Learner'],
    ['exactly 2 characters', { nickname: 'Jo' }, 'Jo'],
    ['exactly 30 characters', { nickname: long(30) }, long(30)],
    ['letters from other languages', { nickname: 'José Мария' }, 'José Мария'],
    ['underscore and numbers', { nickname: 'maya_j_2' }, 'maya_j_2'],
    ['spaces around the nickname are trimmed', { nickname: '   Maya   ' }, 'Maya'],
  ];
  let n = 100;
  for (const [label, meta, expected] of nicknameCases) {
    const id = uid(n++);
    await check(`trigger: ${label} -> '${expected.length > 12 ? expected.slice(0, 8) + '...' : expected}'`, async () => {
      await addUser(id, `t${n}@example.test`, meta);
      const r = await admin(`select p.nickname, (select count(*) from public.user_settings s where s.user_id = p.id)::int as s
        from public.profiles p where p.id = $1`, [id]);
      const x = r.rows[0];
      return (x && x.nickname === expected && x.s === 1) || JSON.stringify(x);
    });
  }
  await check('trigger: a failing profile insert never blocks the sign-up', async () => {
    const id = uid(199);
    await admin(`alter table public.profiles add constraint zz_always_fails check (false) not valid`);
    let err;
    try {
      await addUser(id, 'blocked@example.test', { nickname: 'Fine Name' });
    } catch (e) {
      err = e;
    } finally {
      await admin(`alter table public.profiles drop constraint zz_always_fails`);
    }
    const u = await count(`select count(*) as n from auth.users where id = $1`, [id]);
    const p = await count(`select count(*) as n from public.profiles where id = $1`, [id]);
    await admin(`delete from auth.users where id = $1`, [id]);
    return (!err && u === 1 && p === 0) || `err=${err?.message} users=${u} profiles=${p}`;
  });
  await check('trigger: works when the auth service role inserts the user (no EXECUTE needed)', async () => {
    const id = uid(198);
    const r = await asRole('supabase_auth_admin', `insert into auth.users (id, email, raw_user_meta_data) values ($1, 'svc@example.test', '{"nickname":"Svc"}'::jsonb)`, [id]);
    const p = await admin(`select nickname from public.profiles where id = $1`, [id]);
    return (r.ok && p.rows[0]?.nickname === 'Svc') || JSON.stringify({ r, p: p.rows });
  });
  await check('trigger: nobody can call handle_new_user() by hand', async () => {
    const guest = await as('anon', `select public.handle_new_user()`);
    const user = await as(A, `select public.handle_new_user()`);
    return (!guest.ok && !user.ok) || 'a direct call worked';
  });

  // ===== 3. Row Level Security for every table =====
  // Give A and B one row in each table. (profiles and user_settings come from the trigger.)
  for (const u of [A, B]) {
    await admin(`update public.user_settings set save_chat_history = true where user_id = $1`, [u]);
    await admin(`insert into public.progress (user_id, key, value) values ($1, 'topicsCompleted', '["a"]')`, [u]);
    await admin(`insert into public.saved_careers (user_id, career_id) values ($1, 'career-1')`, [u]);
    await admin(`insert into public.roadmap_steps (user_id, career_id, step_id, done) values ($1, 'career-1', 'step-1', true)`, [u]);
    await admin(`insert into public.saved_circuits (user_id, name, circuit) values ($1, 'Bell pair', '{"gates":[]}')`, [u]);
    await admin(`insert into public.chat_messages (user_id, role, content) values ($1, 'user', 'hello')`, [u]);
  }

  const spec = {
    user_settings: {
      insertAsOther: `insert into public.user_settings (user_id) values ($1)`,
      update: `update public.user_settings set theme = 'dark' where user_id = $1`,
      reassign: `update public.user_settings set user_id = $2 where user_id = $1`,
      positive: [
        [`update public.user_settings set theme = 'light' where user_id = $1`, 'update own row'],
        [`delete from public.user_settings where user_id = $1`, 'delete own row'],
        [`insert into public.user_settings (user_id) values ($1)`, 'insert own row'],
      ],
    },
    progress: {
      insertAsOther: `insert into public.progress (user_id, key, value) values ($1, 'hacked', '{}')`,
      update: `update public.progress set value = '{"hacked":true}' where user_id = $1`,
      reassign: `update public.progress set user_id = $2 where user_id = $1`,
      positive: [
        [`insert into public.progress (user_id, key, value) values ($1, 'extra', '{"n":1}')`, 'insert own row'],
        [`update public.progress set value = '{"n":2}' where user_id = $1 and key = 'extra'`, 'update own row'],
        [`delete from public.progress where user_id = $1 and key = 'extra'`, 'delete own row'],
      ],
    },
    saved_careers: {
      insertAsOther: `insert into public.saved_careers (user_id, career_id) values ($1, 'hacked')`,
      update: `update public.saved_careers set career_id = 'hacked' where user_id = $1`,
      reassign: `update public.saved_careers set user_id = $2 where user_id = $1`,
      positive: [
        [`insert into public.saved_careers (user_id, career_id) values ($1, 'career-2')`, 'insert own row'],
        [`update public.saved_careers set career_id = 'career-3' where user_id = $1 and career_id = 'career-2'`, 'update own row'],
        [`delete from public.saved_careers where user_id = $1 and career_id = 'career-3'`, 'delete own row'],
      ],
    },
    roadmap_steps: {
      insertAsOther: `insert into public.roadmap_steps (user_id, career_id, step_id) values ($1, 'hacked', 's')`,
      update: `update public.roadmap_steps set done = false where user_id = $1`,
      reassign: `update public.roadmap_steps set user_id = $2 where user_id = $1`,
      positive: [
        [`insert into public.roadmap_steps (user_id, career_id, step_id, done) values ($1, 'career-2', 'step-1', true)`, 'insert own row'],
        [`update public.roadmap_steps set done = false where user_id = $1 and career_id = 'career-2'`, 'update own row'],
        [`delete from public.roadmap_steps where user_id = $1 and career_id = 'career-2'`, 'delete own row'],
      ],
    },
    saved_circuits: {
      insertAsOther: `insert into public.saved_circuits (user_id, name, circuit) values ($1, 'hacked', '{}')`,
      update: `update public.saved_circuits set name = 'hacked' where user_id = $1`,
      reassign: `update public.saved_circuits set user_id = $2 where user_id = $1`,
      positive: [
        [`insert into public.saved_circuits (user_id, name, circuit) values ($1, 'Second', '{"gates":["H"]}')`, 'insert own row'],
        [`update public.saved_circuits set name = 'Renamed' where user_id = $1 and name = 'Second'`, 'update own row'],
        [`delete from public.saved_circuits where user_id = $1 and name = 'Renamed'`, 'delete own row'],
      ],
    },
    chat_messages: {
      insertAsOther: `insert into public.chat_messages (user_id, role, content) values ($1, 'user', 'hacked')`,
      update: `update public.chat_messages set content = 'hacked' where user_id = $1`,
      reassign: `update public.chat_messages set user_id = $2 where user_id = $1`,
      positive: [
        [`insert into public.chat_messages (user_id, role, content) values ($1, 'assistant', 'hi there')`, 'insert own row (saving is on)'],
        [`update public.chat_messages set content = 'edited' where user_id = $1 and role = 'assistant'`, 'update own row'],
        [`delete from public.chat_messages where user_id = $1 and role = 'assistant'`, 'delete own row'],
      ],
    },
  };

  for (const [table, s] of Object.entries(spec)) {
    const T = `public.${table}`;
    await check(`rls ${table}: A sees only A's rows`, async () => {
      const r = await as(A, `select user_id from ${T}`);
      return (r.ok && r.rows.length >= 1 && r.rows.every((x) => x.user_id === A)) || JSON.stringify(r).slice(0, 200);
    });
    await check(`rls ${table}: B sees none of A's rows`, async () => {
      const r = await as(B, `select user_id from ${T} where user_id = $1`, [A]);
      const own = await as(B, `select user_id from ${T}`);
      return (r.ok && r.rows.length === 0 && own.rows.length >= 1 && own.rows.every((x) => x.user_id === B)) || JSON.stringify(r).slice(0, 200);
    });
    await check(`rls ${table}: B cannot insert a row for A`, async () => {
      const r = await as(B, s.insertAsOther, [A]);
      return (!r.ok && r.code === '42501') || JSON.stringify(r).slice(0, 200);
    });
    await check(`rls ${table}: B cannot update A's rows (0 rows changed)`, async () => {
      const r = await as(B, s.update, [A]);
      return (r.ok && r.count === 0) || JSON.stringify(r).slice(0, 200);
    });
    await check(`rls ${table}: B cannot delete A's rows (0 rows changed)`, async () => {
      const r = await as(B, `delete from ${T} where user_id = $1`, [A]);
      return (r.ok && r.count === 0) || JSON.stringify(r).slice(0, 200);
    });
    await check(`rls ${table}: A cannot hand a row over to B`, async () => {
      const r = await as(A, s.reassign, [A, B]);
      return (!r.ok && r.code === '42501') || JSON.stringify(r).slice(0, 200);
    });
    await check(`rls ${table}: anon cannot read`, async () => denied(await as('anon', `select * from ${T}`)));
    await check(`rls ${table}: anon cannot write`, async () => denied(await as('anon', s.insertAsOther, [A])));
    await check(`rls ${table}: A's own rows are still there afterwards`, async () => {
      const a = await count(`select count(*) as n from ${T} where user_id = $1`, [A]);
      return a >= 1 || `A has ${a} rows`;
    });
    // The user_settings checks above re-created A's settings row, so switch saving back on for chat.
    if (table === 'chat_messages') await admin(`update public.user_settings set save_chat_history = true where user_id = $1`, [A]);
    for (const [sql, label] of s.positive) {
      await check(`rls ${table}: A can ${label}`, async () => {
        const r = await as(A, sql, [A]);
        return (r.ok && r.count === 1) || JSON.stringify(r).slice(0, 200);
      });
    }
    await check(`rls ${table}: B's rows were never touched`, async () => {
      const r = await admin(`select count(*)::int as n from ${T} where user_id = $1`, [B]);
      return r.rows[0].n >= 1 || `B has ${r.rows[0].n}`;
    });
  }

  // profiles is special: read and update only.
  await check('rls profiles: A reads their own profile', async () => {
    const r = await as(A, `select id, nickname from public.profiles`);
    return (r.ok && r.rows.length === 1 && r.rows[0].id === A && r.rows[0].nickname === 'Alice') || JSON.stringify(r).slice(0, 200);
  });
  await check("rls profiles: B cannot see A's profile", async () => {
    const r = await as(B, `select id from public.profiles where id = $1`, [A]);
    return (r.ok && r.rows.length === 0) || JSON.stringify(r).slice(0, 200);
  });
  await check('rls profiles: A can update their own nickname', async () => {
    const r = await as(A, `update public.profiles set nickname = 'Alice Two' where id = $1`, [A]);
    const p = await admin(`select nickname from public.profiles where id = $1`, [A]);
    return (r.ok && r.count === 1 && p.rows[0].nickname === 'Alice Two') || JSON.stringify(r).slice(0, 200);
  });
  await check("rls profiles: B cannot update A's nickname (0 rows changed)", async () => {
    const r = await as(B, `update public.profiles set nickname = 'Hacked' where id = $1`, [A]);
    const p = await admin(`select nickname from public.profiles where id = $1`, [A]);
    return (r.ok && r.count === 0 && p.rows[0].nickname === 'Alice Two') || JSON.stringify(r).slice(0, 200);
  });
  await check('rls profiles: A cannot change their profile id to B', async () => {
    const r = await as(A, `update public.profiles set id = $2 where id = $1`, [A, B]);
    return !r.ok || 'the id change worked';
  });
  await check('rls profiles: nobody can insert a profile (own id or a made-up id)', async () => {
    const own = await as(A, `insert into public.profiles (id, nickname) values ($1, 'Dupe')`, [A]);
    const fake = await as(A, `insert into public.profiles (id, nickname) values ($1, 'Fake')`, [uid(900)]);
    return (denied(own) === true && denied(fake) === true) || JSON.stringify({ own, fake }).slice(0, 200);
  });
  await check('rls profiles: nobody can delete a profile', async () => {
    const own = await as(A, `delete from public.profiles where id = $1`, [A]);
    const other = await as(A, `delete from public.profiles where id = $1`, [B]);
    const still = await count(`select count(*) as n from public.profiles where id in ($1, $2)`, [A, B]);
    return (denied(own) === true && denied(other) === true && still === 2) || JSON.stringify({ own, other, still }).slice(0, 200);
  });
  await check('rls profiles: anon cannot read, update or insert', async () => {
    const a = await as('anon', `select * from public.profiles`);
    const b = await as('anon', `update public.profiles set nickname = 'x2'`);
    const c = await as('anon', `insert into public.profiles (id, nickname) values ($1, 'Anon')`, [uid(901)]);
    return (denied(a) === true && denied(b) === true && denied(c) === true) || JSON.stringify({ a, b, c }).slice(0, 200);
  });
  await check('rls profiles: a signed-in user with no matching rows (wrong role claim) sees nothing', async () => {
    const r = await as(uid(777), `select * from public.profiles`);
    return (r.ok && r.rows.length === 0) || JSON.stringify(r).slice(0, 200);
  });

  // ===== 4. chat_messages needs save_chat_history =====
  const C = uid(3);
  await addUser(C, 'carol@example.test', { nickname: 'Carol' });
  const chatInsert = `insert into public.chat_messages (user_id, role, content) values ($1, 'user', 'a question')`;
  await check('chat: insert is denied while save_chat_history is false (the default)', async () => {
    const r = await as(C, chatInsert, [C]);
    return (!r.ok && r.code === '42501') || JSON.stringify(r).slice(0, 200);
  });
  await check('chat: a user can turn the setting on for themselves', async () => {
    const r = await as(C, `update public.user_settings set save_chat_history = true where user_id = $1`, [C]);
    return (r.ok && r.count === 1) || JSON.stringify(r).slice(0, 200);
  });
  await check('chat: insert is allowed once save_chat_history is true', async () => {
    const r = await as(C, chatInsert, [C]);
    return (r.ok && r.count === 1) || JSON.stringify(r).slice(0, 200);
  });
  await check("chat: someone else's setting does not help (B cannot insert as C while C is on)", async () => {
    const r = await as(B, chatInsert, [C]);
    return (!r.ok && r.code === '42501') || JSON.stringify(r).slice(0, 200);
  });
  await check('chat: insert is denied again after turning the setting off, old rows stay readable', async () => {
    await as(C, `update public.user_settings set save_chat_history = false where user_id = $1`, [C]);
    const r = await as(C, chatInsert, [C]);
    const mine = await as(C, `select content from public.chat_messages`);
    return (!r.ok && r.code === '42501' && mine.rows.length === 1) || JSON.stringify({ r, mine }).slice(0, 200);
  });
  await check('chat: insert is denied when the user has no settings row at all', async () => {
    await admin(`delete from public.user_settings where user_id = $1`, [C]);
    const r = await as(C, chatInsert, [C]);
    return (!r.ok && r.code === '42501') || JSON.stringify(r).slice(0, 200);
  });
  await check('chat: ids are assigned automatically and are unique', async () => {
    const r = await admin(`select count(distinct id)::int as d, count(*)::int as n from public.chat_messages`);
    return (r.rows[0].d === r.rows[0].n && r.rows[0].n >= 3) || JSON.stringify(r.rows[0]);
  });
  await check('chat: users cannot set the id themselves (generated always)', async () => {
    await admin(`insert into public.user_settings (user_id) values ($1) on conflict do nothing`, [C]);
    await admin(`update public.user_settings set save_chat_history = true where user_id = $1`, [C]);
    const r = await as(C, `insert into public.chat_messages (id, user_id, role, content) values (999999, $1, 'user', 'x')`, [C]);
    return !r.ok || 'id override worked';
  });

  // ===== 5. CHECK constraints (as the owner, so only the CHECKs can say no) =====
  const rejects = async (name, sql, params, code = '23514') =>
    check(`check: ${name}`, async () => (await adminError(sql, params)) === code || `expected ${code}`);
  const nick = `update public.profiles set nickname = $2 where id = $1`;
  await rejects('nickname of 1 character is rejected', nick, [A, 'x']);
  await rejects('nickname of 31 characters is rejected', nick, [A, long(31)]);
  await rejects("nickname containing '@' is rejected", nick, [A, 'me@mail']);
  await rejects('nickname with <script> characters is rejected', nick, [A, '<b>hi</b>']);
  await rejects('nickname with a dash or dot is rejected', nick, [A, 'a.b-c']);
  await rejects('nickname of only spaces is rejected', nick, [A, '   ']);
  await rejects('nickname that is NULL is rejected', nick, [A, null], '23502');
  await check('check: nickname of exactly 2 and exactly 30 characters is accepted', async () => {
    const a = await adminError(nick, [A, 'Ab']);
    const b = await adminError(nick, [A, long(30)]);
    await admin(nick, [A, 'Alice']);
    return (a === null && b === null) || `${a} ${b}`;
  });
  await rejects("theme 'purple' is rejected", `update public.user_settings set theme = 'purple' where user_id = $1`, [B]);
  await rejects("text_size 'huge' is rejected", `update public.user_settings set text_size = 'huge' where user_id = $1`, [B]);
  await check('check: every allowed theme and text size is accepted', async () => {
    for (const v of ['system', 'light', 'dark']) if (await adminError(`update public.user_settings set theme = $2 where user_id = $1`, [B, v])) return `theme ${v}`;
    for (const v of ['small', 'medium', 'large']) if (await adminError(`update public.user_settings set text_size = $2 where user_id = $1`, [B, v])) return `size ${v}`;
    return true;
  });
  await rejects('progress key of 101 characters is rejected', `insert into public.progress (user_id, key) values ($1, $2)`, [B, long(101)]);
  await check('check: progress key of 100 characters is accepted, and value defaults to {}', async () => {
    const e = await adminError(`insert into public.progress (user_id, key) values ($1, $2)`, [B, long(100)]);
    const v = await admin(`select value from public.progress where user_id = $1 and key = $2`, [B, long(100)]);
    return (e === null && JSON.stringify(v.rows[0].value) === '{}') || `${e} ${JSON.stringify(v.rows)}`;
  });
  await rejects('progress key that is empty is rejected', `insert into public.progress (user_id, key) values ($1, '')`, [B]);
  await rejects('progress value NULL is rejected', `insert into public.progress (user_id, key, value) values ($1, 'nullval', null)`, [B], '23502');
  await rejects('career_id of 101 characters is rejected', `insert into public.saved_careers (user_id, career_id) values ($1, $2)`, [B, long(101)]);
  await rejects('roadmap step_id of 101 characters is rejected', `insert into public.roadmap_steps (user_id, career_id, step_id) values ($1, 'c', $2)`, [B, long(101)]);
  await rejects('chat content of 4001 characters is rejected', `insert into public.chat_messages (user_id, role, content) values ($1, 'user', $2)`, [B, long(4001)]);
  await rejects('chat content that is empty is rejected', `insert into public.chat_messages (user_id, role, content) values ($1, 'user', '')`, [B]);
  await rejects("chat role 'system' is rejected", `insert into public.chat_messages (user_id, role, content) values ($1, 'system', 'x')`, [B]);
  await check('check: chat content of exactly 4000 characters and both roles are accepted', async () => {
    const a = await adminError(`insert into public.chat_messages (user_id, role, content) values ($1, 'user', $2)`, [B, long(4000)]);
    const b = await adminError(`insert into public.chat_messages (user_id, role, content) values ($1, 'assistant', 'ok')`, [B]);
    return (a === null && b === null) || `${a} ${b}`;
  });
  await rejects('circuit name of 61 characters is rejected', `insert into public.saved_circuits (user_id, name, circuit) values ($1, $2, '{}')`, [B, long(61)]);
  await rejects('circuit name that is empty is rejected', `insert into public.saved_circuits (user_id, name, circuit) values ($1, '', '{}')`, [B]);
  await rejects('circuit that is NULL is rejected', `insert into public.saved_circuits (user_id, name, circuit) values ($1, 'x', null)`, [B], '23502');
  await check('check: circuit name of exactly 60 characters is accepted', async () => (await adminError(`insert into public.saved_circuits (user_id, name, circuit) values ($1, $2, '{}')`, [B, long(60)])) === null);

  // ===== 6. updated_at is stamped by set_updated_at() =====
  const stamped = [
    ['profiles', `update public.profiles set updated_at = '2000-01-01' where id = $1`, `select updated_at from public.profiles where id = $1`],
    ['user_settings', `update public.user_settings set updated_at = '2000-01-01' where user_id = $1`, `select updated_at from public.user_settings where user_id = $1`],
    ['progress', `update public.progress set updated_at = '2000-01-01' where user_id = $1 and key = 'topicsCompleted'`, `select updated_at from public.progress where user_id = $1 and key = 'topicsCompleted'`],
    ['roadmap_steps', `update public.roadmap_steps set updated_at = '2000-01-01' where user_id = $1`, `select updated_at from public.roadmap_steps where user_id = $1`],
  ];
  for (const [table, upd, sel] of stamped) {
    await check(`updated_at: ${table} gets the current time on every update`, async () => {
      await admin(upd, [A]);
      const r = await admin(sel, [A]);
      return r.rows.every((x) => new Date(x.updated_at).getFullYear() >= 2024) || JSON.stringify(r.rows);
    });
  }

  // ===== 7. get_impact_stats() =====
  const statsKeys = ['circuits_saved', 'puzzles_solved', 'roadmaps_started', 'topics_completed', 'total_accounts'];
  const getStats = async () => (await admin(`select public.get_impact_stats() as s`)).rows[0].s;
  const base = await getStats();
  const X = uid(50);
  const Y = uid(51);
  const Z = uid(52);
  await addUser(X, 'xavier@example.test', { nickname: 'Xavier' });
  await addUser(Y, 'yara@example.test', { nickname: 'Yara' });
  await addUser(Z, 'zed@example.test', { nickname: 'Zed' });
  const put = (u, key, value) => admin(`insert into public.progress (user_id, key, value) values ($1, $2, $3::jsonb)`, [u, key, JSON.stringify(value)]);
  await put(X, 'topicsCompleted', ['a', 'b', 'c']);
  await put(Y, 'topicsCompleted', ['d', 'e']);
  await put(Z, 'topicsCompleted', 'oops');
  await put(Y, 'quizBest', ['1', '2', '3', '4', '5', '6', '7', '8', '9']);
  await put(X, 'game', { played: 4, solved: { p1: 3, p2: 1 } });
  await put(Y, 'game', { played: 1, solved: { p1: 2 } });
  await put(Z, 'game', { played: 1, solved: 'nope' });
  await admin(`insert into public.roadmap_steps (user_id, career_id, step_id, done) values
    ($1, 'career-a', 's1', true), ($1, 'career-a', 's2', true), ($1, 'career-b', 's1', false),
    ($2, 'career-a', 's1', true), ($3, 'career-a', 's1', false)`, [X, Y, Z]);
  await admin(`insert into public.saved_circuits (user_id, name, circuit) values ($1, 'one', '{}'), ($1, 'two', '{}')`, [X]);
  const after = await getStats();

  await check('stats: result has exactly the five documented keys', async () => JSON.stringify(Object.keys(after).sort()) === JSON.stringify(statsKeys) || JSON.stringify(Object.keys(after)));
  await check('stats: every value is a number', async () => Object.values(after).every((v) => typeof v === 'number') || JSON.stringify(after));
  await check('stats: total_accounts counts the 3 new accounts', async () => after.total_accounts - base.total_accounts === 3 || JSON.stringify({ base, after }));
  await check('stats: topics_completed adds up array lengths (3 + 2) and ignores non-arrays and other keys', async () => after.topics_completed - base.topics_completed === 5 || JSON.stringify({ base, after }));
  await check('stats: roadmaps_started counts (user, career) pairs with a done step (2)', async () => after.roadmaps_started - base.roadmaps_started === 2 || JSON.stringify({ base, after }));
  await check('stats: puzzles_solved counts solved entries (2 + 1) and ignores bad data', async () => after.puzzles_solved - base.puzzles_solved === 3 || JSON.stringify({ base, after }));
  await check('stats: circuits_saved counts saved circuits (2)', async () => after.circuits_saved - base.circuits_saved === 2 || JSON.stringify({ base, after }));
  await check('stats: callable by anon and the answer is the same', async () => {
    const r = await as('anon', `select public.get_impact_stats() as s`);
    return (r.ok && JSON.stringify(r.rows[0].s) === JSON.stringify(after)) || JSON.stringify(r).slice(0, 200);
  });
  await check('stats: callable by a signed-in user and the answer is the same', async () => {
    const r = await as(A, `select public.get_impact_stats() as s`);
    return (r.ok && JSON.stringify(r.rows[0].s) === JSON.stringify(after)) || JSON.stringify(r).slice(0, 200);
  });
  await check('stats: the answer contains no email, nickname or id', async () => {
    const text = JSON.stringify(after);
    return !/example\.test|Alice|Xavier|Yara|[0-9a-f]{8}-[0-9a-f]{4}/i.test(text) || text;
  });
  await check('stats: it does not let anon read the tables behind it', async () => {
    const rows = await as('anon', `select * from public.progress`);
    const users = await as('anon', `select * from auth.users`);
    return (denied(rows) === true && !users.ok) || JSON.stringify({ rows, users }).slice(0, 200);
  });

  // ===== 8. delete_old_chat_messages() =====
  const D = uid(60);
  await addUser(D, 'dana@example.test', { nickname: 'Dana' });
  await admin(`insert into public.chat_messages (user_id, role, content, created_at) values
    ($1, 'user', 'a hundred days old', now() - interval '100 days'),
    ($1, 'user', 'ninety-one days old', now() - interval '91 days'),
    ($1, 'user', 'eighty-nine days old', now() - interval '89 days'),
    ($1, 'user', 'new', now())`, [D]);
  await check('cleanup: anon cannot run delete_old_chat_messages', async () => denied(await as('anon', `select public.delete_old_chat_messages()`)));
  await check('cleanup: a signed-in user cannot run delete_old_chat_messages', async () => denied(await as(D, `select public.delete_old_chat_messages()`)));
  await check('cleanup: the service role (admin) can run it', async () => {
    const r = await asRole('service_role', `select public.delete_old_chat_messages(100000) as n`);
    return (r.ok && r.rows[0].n === 0) || JSON.stringify(r).slice(0, 200);
  });
  await check('cleanup: the default (90 days) deletes only the 2 old rows', async () => {
    const before = await count(`select count(*) as n from public.chat_messages where user_id = $1`, [D]);
    const r = await admin(`select public.delete_old_chat_messages() as n`);
    const left = await admin(`select content from public.chat_messages where user_id = $1 order by created_at`, [D]);
    return (before === 4 && r.rows[0].n === 2 && left.rows.length === 2 && left.rows[0].content === 'eighty-nine days old') || JSON.stringify({ before, n: r.rows[0].n, left: left.rows });
  });
  await check('cleanup: other users\' recent messages are untouched', async () => {
    const a = await count(`select count(*) as n from public.chat_messages where user_id = $1`, [A]);
    return a >= 1 || `A has ${a}`;
  });
  await check('cleanup: a custom number of days works (30 days deletes the 89-day-old row)', async () => {
    const r = await admin(`select public.delete_old_chat_messages(30) as n`);
    const left = await count(`select count(*) as n from public.chat_messages where user_id = $1`, [D]);
    return (r.rows[0].n === 1 && left === 1) || JSON.stringify({ n: r.rows[0].n, left });
  });
  await check('cleanup: 0, negative and NULL days are refused (nothing deleted)', async () => {
    const codes = [await adminError(`select public.delete_old_chat_messages(0)`), await adminError(`select public.delete_old_chat_messages(-5)`),
      await adminError(`select public.delete_old_chat_messages(null)`)];
    const left = await count(`select count(*) as n from public.chat_messages where user_id = $1`, [D]);
    return (codes.every((c) => c !== null) && left === 1) || JSON.stringify({ codes, left });
  });

  // ===== 9. Deleting an account removes everything =====
  const E = uid(70);
  await addUser(E, 'erin@example.test', { nickname: 'Erin' });
  await admin(`update public.user_settings set save_chat_history = true where user_id = $1`, [E]);
  await admin(`insert into public.progress (user_id, key) values ($1, 'k')`, [E]);
  await admin(`insert into public.saved_careers (user_id, career_id) values ($1, 'c')`, [E]);
  await admin(`insert into public.roadmap_steps (user_id, career_id, step_id) values ($1, 'c', 's')`, [E]);
  await admin(`insert into public.saved_circuits (user_id, name, circuit) values ($1, 'n', '{}')`, [E]);
  await admin(`insert into public.chat_messages (user_id, role, content) values ($1, 'user', 'hi')`, [E]);
  await check('cascade: before deleting, the user has a row in all 7 tables', async () => {
    for (const t of TABLES) {
      const col = t === 'profiles' ? 'id' : 'user_id';
      if ((await count(`select count(*) as n from public.${t} where ${col} = $1`, [E])) < 1) return `${t} empty`;
    }
    return true;
  });
  await admin(`delete from auth.users where id = $1`, [E]);
  for (const t of TABLES) {
    const col = t === 'profiles' ? 'id' : 'user_id';
    await check(`cascade: deleting the auth user removes their ${t} rows`, async () => (await count(`select count(*) as n from public.${t} where ${col} = $1`, [E])) === 0);
  }
  await check("cascade: other users' rows survive the deletion", async () => (await count(`select count(*) as n from public.profiles where id = $1`, [A])) === 1);

  // ===== 10. The manual test script for the SQL editor works too =====
  await check('003_rls_tests.sql runs from start to finish without an error', async () => {
    try {
      await db.exec(sqlFile('003_rls_tests.sql'));
      return true;
    } catch (err) {
      await db.exec('rollback').catch(() => {});
      await db.exec('reset role').catch(() => {});
      return `threw: ${String(err.message).slice(0, 300)}`;
    } finally {
      await db.exec('reset role').catch(() => {});
    }
  });
  await check('003_rls_tests.sql leaves no data behind (it rolls back)', async () => (await count(`select count(*) as n from auth.users where email like '%rls-test.invalid'`)) === 0);
}

// ---------------------------------------------------------------------------
// Scenario setup
// ---------------------------------------------------------------------------
async function freshDb() {
  const db = new PGlite();
  await db.exec(STUB);
  return db;
}

const dbs = {};
const snaps = {};

// A: fresh database, 002 only
dbs.A = await freshDb();
await dbs.A.exec(sqlFile('002_accounts.sql'));

// B: 001 first, then messy old rows, then 002
dbs.B = await freshDb();
await dbs.B.exec(sqlFile('001_init.sql'));
const L1 = uid(801);
const L2 = uid(802);
const L3 = uid(803);
const L4 = uid(804);
for (const [id, mail] of [[L1, 'l1'], [L2, 'l2'], [L3, 'l3'], [L4, 'l4']]) {
  await dbs.B.query(`insert into auth.users (id, email) values ($1, $2)`, [id, `${mail}@legacy.test`]);
}
await dbs.B.query(`insert into public.profiles (id, nickname) values ($1, null), ($2, 'ok name'), ($3, 'bad@name')`, [L1, L2, L3]);
await dbs.B.query(`insert into public.progress (user_id, key, value) values ($1, 'nullval', null), ($1, 'topicsCompleted', '["x","y"]'), ($1, $2, '{}')`, [L1, 'k'.repeat(101)]);
await dbs.B.query(`insert into public.saved_careers (user_id, career_id) values ($1, 'quantum-engineer')`, [L2]);
await dbs.B.query(`insert into public.chat_messages (user_id, role, content) values
  ($1, 'user', 'hi'), ($1, 'system', 'junk'), ($1, 'user', $2), ($1, 'user', '')`, [L1, 'z'.repeat(5000)]);
await dbs.B.exec(sqlFile('002_accounts.sql'));

// C: 002 twice, with a change in between that must survive the second run
dbs.C = await freshDb();
await dbs.C.exec(sqlFile('002_accounts.sql'));
const keep = uid(810);
await dbs.C.query(`insert into auth.users (id, email, raw_user_meta_data) values ($1, 'keep@example.test', '{"nickname":"Keeper"}')`, [keep]);
await dbs.C.query(`update public.user_settings set theme = 'dark', save_chat_history = true where user_id = $1`, [keep]);
await dbs.C.query(`insert into public.progress (user_id, key, value) values ($1, 'marker', '{"v":1}')`, [keep]);
const settingsBefore = JSON.stringify((await dbs.C.query(`select * from public.user_settings where user_id = $1`, [keep])).rows);
await dbs.C.exec(sqlFile('002_accounts.sql'));

for (const s of ['A', 'B', 'C']) snaps[s] = await snapshot(dbs[s]);

// Extra checks that only make sense for one scenario.
{
  const { check, admin, count } = makeSession('A', dbs.A);
  await check('empty database: get_impact_stats returns zeros', async () => {
    const x = (await admin(`select public.get_impact_stats() as s`)).rows[0].s;
    return Object.values(x).every((v) => v === 0) && Object.keys(x).length === 5 || JSON.stringify(x);
  });
  void count;
}
{
  const { check, admin, count } = makeSession('B', dbs.B);
  const nick = async (id) => (await admin(`select nickname from public.profiles where id = $1`, [id])).rows[0]?.nickname;
  await check('upgrade: a NULL nickname from 001 becomes Learner', async () => (await nick(L1)) === 'Learner');
  await check('upgrade: a valid old nickname is kept', async () => (await nick(L2)) === 'ok name');
  await check("upgrade: an old nickname containing '@' becomes Learner", async () => (await nick(L3)) === 'Learner');
  await check('upgrade: an old account with no profile gets one', async () => (await nick(L4)) === 'Learner');
  await check('upgrade: every old account gets a default settings row', async () => (await count(`select count(*) as n from public.user_settings where user_id in ($1,$2,$3,$4)`, [L1, L2, L3, L4])) === 4);
  await check('upgrade: a NULL progress value becomes {}', async () => JSON.stringify((await admin(`select value from public.progress where user_id = $1 and key = 'nullval'`, [L1])).rows[0]?.value) === '{}');
  await check('upgrade: good progress rows survive, the 101-character key is dropped', async () => {
    const r = await admin(`select key from public.progress where user_id = $1 order by key`, [L1]);
    return JSON.stringify(r.rows.map((x) => x.key)) === '["nullval","topicsCompleted"]' || JSON.stringify(r.rows);
  });
  await check('upgrade: other old tables keep their rows', async () => (await count(`select count(*) as n from public.saved_careers where user_id = $1`, [L2])) === 1);
  await check('upgrade: chat rows get ids; bad role and empty rows are dropped; long text is cut to 4000', async () => {
    const r = await admin(`select id, length(content)::int as len from public.chat_messages where user_id = $1 order by id`, [L1]);
    const ok = r.rows.length === 2 && r.rows.every((x) => x.id !== null) && r.rows[0].len === 2 && r.rows[1].len === 4000;
    return ok || JSON.stringify(r.rows);
  });
  await check('upgrade: the old 001 profile INSERT and DELETE policies are gone', async () => {
    const r = await admin(`select cmd from pg_policies where tablename = 'profiles' order by cmd`);
    return JSON.stringify(r.rows.map((x) => x.cmd)) === '["SELECT","UPDATE"]' || JSON.stringify(r.rows);
  });
  await check('upgrade: the old get_impact_stats now returns circuits_saved too', async () => 'circuits_saved' in (await admin(`select public.get_impact_stats() as s`)).rows[0].s);
}
{
  const { check, admin } = makeSession('C', dbs.C);
  await check('run twice: settings and progress changed between the runs are kept', async () => {
    const after = JSON.stringify((await admin(`select * from public.user_settings where user_id = $1`, [keep])).rows);
    const marker = (await admin(`select value from public.progress where user_id = $1 and key = 'marker'`, [keep])).rows[0]?.value;
    return (after === settingsBefore && marker?.v === 1) || 'data changed by the second run';
  });
  await check('run twice: still exactly one trigger on auth.users and 26 policies', async () => {
    const t = Number((await admin(`select count(*) as n from pg_trigger where tgrelid = 'auth.users'::regclass and not tgisinternal`)).rows[0].n);
    const p = Number((await admin(`select count(*) as n from pg_policies where schemaname = 'public'`)).rows[0].n);
    return (t === 1 && p === 26) || `triggers=${t} policies=${p}`;
  });
}
for (const s of ['B', 'C']) {
  const { check } = makeSession(s, dbs[s]);
  await check(`same final shape: scenario ${s} matches scenario A (columns, constraints, indexes, policies, triggers, functions, rights)`, async () => diffSnapshots(snaps.A, snaps[s]));
}

for (const s of ['A', 'B', 'C']) await runSuite(s, dbs[s]);

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
const names = [...results.keys()];
const width = Math.min(98, Math.max(...names.map((x) => x.length)));
const cell = (v) => (v ?? '-').padEnd(4);
process.stdout.write(`\n${'Check'.padEnd(width)}  A     B     C\n${'-'.repeat(width)}  ----  ----  ----\n`);
for (const name of names) {
  const r = results.get(name);
  const label = name.length > width ? `${name.slice(0, width - 3)}...` : name.padEnd(width);
  process.stdout.write(`${label}  ${cell(r.A)}  ${cell(r.B)}  ${cell(r.C)}\n`);
}

let pass = 0;
let fail = 0;
for (const r of results.values()) {
  for (const v of Object.values(r)) {
    if (v === 'PASS') pass++;
    else fail++;
  }
}
process.stdout.write(`\nA = 002 on a fresh database | B = 001 then 002 (upgrade) | C = 002 run twice\n`);
process.stdout.write(`${names.length} distinct checks, ${pass + fail} runs: ${pass} passed, ${fail} failed\n`);
if (failures.length > 0) {
  process.stdout.write('\nFailures:\n');
  for (const f of failures) process.stdout.write(`  - ${f}\n`);
  process.exit(1);
}
process.stdout.write('All database checks passed.\n');
