/* ==========================================================================
   auth.test.js — tests for js/auth/authClient.js using a FAKE supabase-js.
   No network, no real Supabase. initAuth() accepts two test helpers:
   loadSupabase (gives us the fake module) and fetchConfig (the fake api/public-config answer).
   Every test imports a fresh copy of the module (the "?fresh=N" trick) so state never leaks.
   Run with: npm test   (or: node --test tests/auth.test.js)
   ========================================================================== */

import test from 'node:test';
import assert from 'node:assert/strict';

import { FEATURES, AUTH_STORAGE_KEY } from '../js/config.js';

const CONFIG = { configured: true, supabaseUrl: 'https://abcdefgh.supabase.co', supabaseAnonKey: 'public-anon-key' };
const NOT_CONFIGURED = { configured: false };
const SECRET = 'Sentinel-Password-9z!';

let counter = 0;
const tick = (ms = 15) => new Promise((resolve) => setTimeout(resolve, ms));

/* ---------- fake browser storage and address ---------- */

function memoryStorage() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
    dump: () => Object.fromEntries(map),
  };
}

function setBrowser({ saved = false, hash = '', search = '' } = {}) {
  const storage = memoryStorage();
  if (saved) storage.setItem(AUTH_STORAGE_KEY, JSON.stringify({ placeholder: true }));
  Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true, writable: true });
  Object.defineProperty(globalThis, 'location', { value: { hash, search }, configurable: true, writable: true });
  return storage;
}

/* ---------- the fake supabase-js ---------- */

const RAW_USER = { id: 'user-1', email: 'sam@example.com', email_confirmed_at: '2026-01-01T00:00:00Z', user_metadata: { nickname: 'MetaSam' } };
const SESSION = { access_token: 'access-1', user: RAW_USER };

/**
 * A scriptable fake. `script.<method>` can be a function (args) => result to change what a call returns or throws.
 * `fake.calls` records every call by name; `fake.clients` records every createClient() call.
 */
function makeFake({ session = null, profile = { data: { nickname: 'ProfileSam' }, error: null }, script = {} } = {}) {
  const fake = { calls: [], clients: [], session, listeners: new Set(), script, profile };
  const record = (name, args) => fake.calls.push({ name, args });
  const scripted = (name, args, fallback) => {
    record(name, args);
    return script[name] ? script[name](args) : fallback();
  };

  fake.emit = (event, nextSession) => {
    fake.session = nextSession;
    for (const listener of [...fake.listeners]) listener(event, nextSession);
  };

  fake.module = {
    createClient(url, key, options) {
      const instance = { url, key, options, signedOut: false };
      fake.clients.push(instance);
      const auth = {
        onAuthStateChange(callback) {
          fake.listeners.add(callback);
          setTimeout(() => fake.listeners.has(callback) && callback('INITIAL_SESSION', fake.session), 0);
          return { data: { subscription: { unsubscribe: () => fake.listeners.delete(callback) } } };
        },
        getSession: async () => ({ data: { session: fake.session }, error: null }),
        signUp: async (args) => scripted('signUp', args, () => ({ data: { user: { id: 'new' }, session: null }, error: null })),
        signInWithPassword: async (args) =>
          scripted('signInWithPassword', args, () => {
            if (options.auth.persistSession === false) return { data: { session: { access_token: 'temp', user: RAW_USER } }, error: null };
            fake.session = SESSION;
            setTimeout(() => fake.emit('SIGNED_IN', SESSION), 0);
            return { data: { session: SESSION, user: RAW_USER }, error: null };
          }),
        signOut: async (args) =>
          scripted('signOut', args, () => {
            instance.signedOut = true;
            if (options.auth.persistSession !== false) setTimeout(() => fake.emit('SIGNED_OUT', null), 0);
            return { error: null };
          }),
        resetPasswordForEmail: async (email, args) => scripted('resetPasswordForEmail', { email, ...args }, () => ({ data: {}, error: null })),
        resend: async (args) => scripted('resend', args, () => ({ data: {}, error: null })),
        updateUser: async (attributes, args) => scripted('updateUser', { attributes, ...args }, () => ({ data: { user: RAW_USER }, error: null })),
        signInWithOAuth: async (args) => scripted('signInWithOAuth', args, () => ({ data: {}, error: null })),
        stopAutoRefresh: async () => record('stopAutoRefresh', []),
      };
      const from = (table) => {
        const query = { table, action: 'select', values: null, filters: [] };
        const chain = {
          select: () => chain,
          update: (values) => {
            query.action = 'update';
            query.values = values;
            return chain;
          },
          eq: (column, value) => {
            query.filters.push([column, value]);
            return chain;
          },
          maybeSingle: async () => scripted('profileRead', query, () => fake.profile),
          then: (resolve, reject) => Promise.resolve(scripted('profileWrite', query, () => ({ data: [{ nickname: query.values?.nickname }], error: null }))).then(resolve, reject),
        };
        return chain;
      };
      return { auth, from };
    },
  };
  fake.count = (name) => fake.calls.filter((call) => call.name === name).length;
  return fake;
}

/** Set up a fresh authClient wired to the fake. */
async function setup({ config = CONFIG, saved = false, hash = '', search = '', fake = makeFake(), loadError = null } = {}) {
  const storage = setBrowser({ saved, hash, search });
  counter += 1;
  const auth = await import(`../js/auth/authClient.js?fresh=${counter}`);
  const seen = { loads: 0, configFetches: 0 };
  const seams = {
    fetchConfig: async () => {
      seen.configFetches += 1;
      if (config instanceof Error) throw config;
      return config;
    },
    loadSupabase: async () => {
      seen.loads += 1;
      if (loadError) throw loadError;
      return fake.module;
    },
  };
  const events = [];
  auth.onAuthChange((state, event) => events.push({ event, status: state.status, nickname: state.user?.nickname, id: state.user?.id }));
  return { auth, fake, seen, seams, events, storage };
}

/** Sign in through the public API and settle all events. */
async function signedIn(options) {
  const env = await setup(options);
  await env.auth.initAuth(env.seams);
  const result = await env.auth.signIn({ email: 'sam@example.com', password: SECRET });
  assert.equal(result.ok, true);
  await tick();
  env.events.length = 0;
  env.fake.calls.length = 0;
  return env;
}

/* ==========================================================================
   Not configured: quiet guest-only mode
   ========================================================================== */

test('not configured: no supabase-js request, state unavailable, every action says unavailable', async () => {
  for (const config of [NOT_CONFIGURED, null, {}, 'nonsense', new Error('network down'), { configured: true }, { configured: true, supabaseUrl: 'https://x.supabase.co' }, { configured: true, supabaseUrl: 'http://evil.example', supabaseAnonKey: 'k' }, { configured: true, supabaseUrl: 'javascript:alert(1)', supabaseAnonKey: 'k' }, { configured: true, supabaseUrl: 'not a url', supabaseAnonKey: 'k' }, { configured: 'true', supabaseUrl: CONFIG.supabaseUrl, supabaseAnonKey: 'k' }]) {
    const { auth, seen, seams, events, fake } = await setup({ config, saved: true, hash: '#access_token=abc&refresh_token=def' });
    const state = await auth.initAuth(seams);
    assert.deepEqual({ ready: state.ready, status: state.status, user: state.user }, { ready: true, status: 'unavailable', user: null }, String(config instanceof Error ? 'throws' : JSON.stringify(config)));
    assert.equal(seen.loads, 0, 'supabase-js is never requested, even with a saved session or tokens');
    assert.equal(fake.clients.length, 0);
    assert.equal(auth.isAccountsAvailable(), false);
    assert.equal(auth.getClient(), null);
    assert.equal(await auth.getAccessToken(), null);
    assert.deepEqual(events.map((e) => e.event), ['INITIAL_SESSION']);
    for (const result of [await auth.signIn({ email: 'a@b.co', password: SECRET }), await auth.signUp({ email: 'a@b.co', password: 'abcdefghi1', nickname: 'Sam Q' }), await auth.setNewPassword('abcdefghi1'), await auth.signInWithGoogle()]) {
      assert.equal(result.ok, false);
      assert.equal(result.code, 'unavailable');
    }
    assert.equal(seen.loads, 0, 'actions do not load it either');
    assert.deepEqual(await auth.signOut(), { ok: true });
  }
});

test('not configured: loadable only after the config says so (quiet 404 case is a null answer)', async () => {
  const { auth, seams, seen } = await setup({ config: null });
  await auth.initAuth(seams);
  assert.equal(seen.configFetches, 1);
});

test('FEATURES.accounts off: not even the config request is made', async () => {
  const { auth, seen, seams } = await setup();
  FEATURES.accounts = false;
  try {
    const state = await auth.initAuth(seams);
    assert.equal(state.status, 'unavailable');
    assert.equal(seen.configFetches, 0);
    assert.equal(auth.isAccountsAvailable(), false);
  } finally {
    FEATURES.accounts = true;
  }
});

test('the default config request: one same-origin GET, quiet on 404, bad JSON and network errors', async () => {
  const realFetch = globalThis.fetch;
  const urls = [];
  try {
    for (const reply of [() => new Response('Not found', { status: 404 }), () => new Response('<html>', { status: 200 }), () => { throw new TypeError('Failed to fetch'); }, () => Response.json({ configured: false })]) {
      globalThis.fetch = async (url, options) => {
        urls.push([String(url), options?.method]);
        return reply();
      };
      setBrowser();
      counter += 1;
      const auth = await import(`../js/auth/authClient.js?fresh=${counter}`);
      const state = await auth.initAuth({ loadSupabase: async () => assert.fail('must not load') });
      assert.equal(state.status, 'unavailable');
    }
    assert.equal(urls.length, 4);
    assert.ok(urls.every(([url, method]) => /\/api\/public-config$/.test(url) && method === undefined), 'plain GET of api/public-config');
  } finally {
    globalThis.fetch = realFetch;
  }
});

/* ==========================================================================
   Configured: when supabase-js is loaded
   ========================================================================== */

test('configured guest (no saved session, no tokens): ready, guest, supabase-js still NOT requested', async () => {
  const { auth, seen, seams, events } = await setup({ hash: '#section-2', search: '?confirmed=1' });
  const state = await auth.initAuth(seams);
  assert.deepEqual({ ready: state.ready, status: state.status, user: state.user }, { ready: true, status: 'guest', user: null });
  assert.equal(auth.isAccountsAvailable(), true);
  assert.equal(seen.loads, 0);
  assert.equal(auth.getClient(), null);
  assert.deepEqual(events.map((e) => e.event), ['INITIAL_SESSION']);
});

test('a session saved under qss-auth loads supabase-js and signs the person in (nickname from the profile)', async () => {
  const fake = makeFake({ session: SESSION });
  const { auth, seen, seams, events } = await setup({ saved: true, fake });
  const state = await auth.initAuth(seams);
  assert.equal(seen.loads, 1);
  assert.equal(state.status, 'signed-in');
  assert.deepEqual(state.user, { id: 'user-1', email: 'sam@example.com', nickname: 'ProfileSam', emailConfirmed: true });
  assert.deepEqual(events.map((e) => [e.event, e.status]), [['INITIAL_SESSION', 'signed-in']]);
  assert.equal(auth.getClient() !== null, true);

  const [created] = fake.clients;
  assert.equal(created.url, CONFIG.supabaseUrl);
  assert.equal(created.key, CONFIG.supabaseAnonKey);
  assert.deepEqual(created.options, { auth: { storageKey: 'qss-auth', persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } });
});

test('other localStorage keys do not count as a saved session', async () => {
  const env = await setup();
  env.storage.setItem('qss:progress', '{}');
  env.storage.setItem('qss-auth-other', 'x');
  await env.auth.initAuth(env.seams);
  assert.equal(env.seen.loads, 0);
});

test('a saved session with no network or a blocked CDN: guest mode, flagged as unverified, no exception', async () => {
  const { auth, seams, seen, events } = await setup({ saved: true, loadError: new TypeError('Failed to fetch dynamically imported module') });
  const state = await auth.initAuth(seams);
  assert.equal(seen.loads, 1);
  assert.equal(state.ready, true);
  assert.equal(state.status, 'guest');
  assert.equal(state.sessionUnverified, true);
  assert.deepEqual(events.map((e) => e.event), ['INITIAL_SESSION']);
  assert.equal(auth.getAuthState().sessionUnverified, true);
});

test('sign-in tokens or errors in the address load supabase-js (hash and query forms)', async () => {
  const cases = [{ hash: '#access_token=a&refresh_token=b&type=signup' }, { hash: '#type=recovery' }, { hash: '#error=access_denied&error_code=otp_expired&error_description=Link+expired' }, { search: '?code=abc123' }, { search: '?type=recovery' }, { search: '?refresh_token=x' }, { search: '?error_description=oops' }];
  for (const where of cases) {
    const { auth, seen, seams } = await setup(where);
    await auth.initAuth(seams);
    assert.equal(seen.loads, 1, JSON.stringify(where));
  }
});

test('concurrent callers share ONE supabase-js load and ONE client', async () => {
  const { auth, seen, seams, fake } = await setup();
  await auth.initAuth(seams);
  const results = await Promise.all([auth.signIn({ email: 'a@b.co', password: SECRET }), auth.signIn({ email: 'a@b.co', password: SECRET }), auth.requestPasswordReset('a@b.co'), auth.resendConfirmation('a@b.co'), auth.prepareAuth()]);
  assert.equal(seen.loads, 1);
  assert.equal(fake.clients.filter((c) => c.options.auth.persistSession).length, 1);
  assert.equal(results[2].ok, true);
  assert.equal(results[4], true);
});

test('a failed load is reported as a network error and can be retried', async () => {
  const fake = makeFake();
  const { auth, seams } = await setup({ fake });
  let attempts = 0;
  seams.loadSupabase = async () => {
    attempts += 1;
    if (attempts === 1) throw new TypeError('Failed to fetch dynamically imported module');
    return fake.module;
  };
  await auth.initAuth(seams);
  const first = await auth.signIn({ email: 'a@b.co', password: SECRET });
  assert.deepEqual([first.ok, first.code], [false, 'network']);
  assert.match(first.message, /internet/);
  assert.equal(await auth.prepareAuth(), true);
  assert.equal((await auth.signIn({ email: 'a@b.co', password: SECRET })).ok, true);
  assert.equal(attempts, 2);
});

test('a broken supabase-js module (no createClient) is a network error, not an exception', async () => {
  const { auth, seams } = await setup();
  seams.loadSupabase = async () => ({});
  await auth.initAuth(seams);
  const result = await auth.signIn({ email: 'a@b.co', password: SECRET });
  assert.deepEqual([result.ok, result.code], [false, 'network']);
  assert.equal(await auth.prepareAuth(), false);
});

test('initAuth is idempotent: same promise, one config request', async () => {
  const { auth, seams, seen } = await setup();
  const first = auth.initAuth(seams);
  const second = auth.initAuth(seams);
  assert.equal(first, second);
  await first;
  assert.equal(await auth.initAuth(), await first);
  assert.equal(seen.configFetches, 1);
});

test('getAuthState before init is unavailable and not ready; returned objects are copies', async () => {
  const { auth, seams } = await setup({ saved: true, fake: makeFake({ session: SESSION }) });
  assert.deepEqual({ ready: auth.getAuthState().ready, status: auth.getAuthState().status, user: auth.getAuthState().user }, { ready: false, status: 'unavailable', user: null });
  await auth.initAuth(seams);
  const state = auth.getAuthState();
  state.user.nickname = 'Hacked';
  state.status = 'guest';
  assert.equal(auth.getAuthState().user.nickname, 'ProfileSam');
  assert.equal(auth.getAuthState().status, 'signed-in');
});

/* ==========================================================================
   State machine and events
   ========================================================================== */

test('state machine: guest -> signed-in -> guest, with the right events', async () => {
  const { auth, seams, events } = await setup();
  await auth.initAuth(seams);
  assert.equal(auth.getAuthState().status, 'guest');

  const result = await auth.signIn({ email: '  sam@example.com ', password: SECRET });
  await tick();
  assert.equal(result.ok, true);
  assert.deepEqual(result.user, { id: 'user-1', email: 'sam@example.com', nickname: 'ProfileSam', emailConfirmed: true });
  assert.equal(auth.getAuthState().status, 'signed-in');

  assert.deepEqual(await auth.signOut(), { ok: true });
  await tick();
  assert.equal(auth.getAuthState().status, 'guest');
  assert.equal(auth.getAuthState().user, null);
  assert.deepEqual(events.map((e) => e.event), ['INITIAL_SESSION', 'SIGNED_IN', 'SIGNED_OUT'], 'one event per real change, no duplicates');
});

test('signIn sends the trimmed email and the password only to supabase-js signInWithPassword', async () => {
  const { auth, seams, fake } = await setup();
  await auth.initAuth(seams);
  await auth.signIn({ email: ' Sam@Example.com ', password: SECRET });
  const [call] = fake.calls.filter((c) => c.name === 'signInWithPassword');
  assert.deepEqual(call.args, { email: 'Sam@Example.com', password: SECRET });
});

test('signIn with empty fields makes no request', async () => {
  const { auth, seams, seen } = await setup();
  await auth.initAuth(seams);
  for (const input of [{}, { email: '', password: SECRET }, { email: 'a@b.co', password: '' }, { email: '  ', password: SECRET }, { email: 5, password: SECRET }, undefined]) {
    const result = await auth.signIn(input);
    assert.deepEqual([result.ok, result.code], [false, 'invalid-input']);
  }
  assert.equal(seen.loads, 0);
});

test('events from supabase-js are mapped: repeats are hidden, real changes are reported', async () => {
  const env = await signedIn();
  const { fake, events, auth } = env;

  fake.emit('SIGNED_IN', SESSION); // supabase-js repeats this when a tab is focused again
  fake.emit('TOKEN_REFRESHED', { ...SESSION, access_token: 'access-2' });
  fake.emit('MFA_CHALLENGE_VERIFIED', SESSION);
  await tick();
  assert.deepEqual(events, [], 'nothing reported');

  fake.emit('PASSWORD_RECOVERY', SESSION);
  await tick();
  assert.deepEqual(events.map((e) => [e.event, e.status]), [['PASSWORD_RECOVERY', 'signed-in']]);

  fake.emit('USER_UPDATED', { ...SESSION, user: { ...RAW_USER, email: 'new@example.com' } });
  await tick();
  assert.equal(events.at(-1).event, 'USER_UPDATED');
  assert.equal(auth.getAuthState().user.email, 'new@example.com');

  fake.emit('SIGNED_OUT', null);
  fake.emit('SIGNED_OUT', null);
  await tick();
  assert.deepEqual(events.slice(-1).map((e) => [e.event, e.status]), [['SIGNED_OUT', 'guest']]);
  assert.equal(events.filter((e) => e.event === 'SIGNED_OUT').length, 1);
});

test('a different person signing in on another tab is reported as SIGNED_IN with the new user', async () => {
  const env = await signedIn();
  env.fake.emit('SIGNED_IN', { access_token: 'x', user: { id: 'user-2', email: 'kim@example.com', email_confirmed_at: 'now', user_metadata: {} } });
  await tick();
  assert.deepEqual(env.events.map((e) => [e.event, e.id]), [['SIGNED_IN', 'user-2']]);
});

test('recovery link: INITIAL_SESSION carries the recovery session, then PASSWORD_RECOVERY follows', async () => {
  const fake = makeFake({ session: SESSION });
  const { auth, seams, events } = await setup({ hash: '#access_token=a&refresh_token=b&type=recovery', fake });
  await auth.initAuth(seams);
  fake.emit('PASSWORD_RECOVERY', SESSION);
  fake.emit('SIGNED_IN', SESSION);
  await tick();
  assert.deepEqual(events.map((e) => e.event), ['INITIAL_SESSION', 'PASSWORD_RECOVERY']);
  assert.equal(events[0].status, 'signed-in');
});

test('onAuthChange: unsubscribe works, and a throwing listener does not stop the others', async () => {
  const { auth, seams } = await setup();
  const heard = [];
  const off = auth.onAuthChange((state, event) => heard.push(['first', event]));
  auth.onAuthChange(() => {
    throw new Error('listener bug');
  });
  auth.onAuthChange((state, event) => heard.push(['third', event]));
  await auth.initAuth(seams);
  assert.deepEqual(heard, [['first', 'INITIAL_SESSION'], ['third', 'INITIAL_SESSION']]);
  off();
  await auth.signIn({ email: 'a@b.co', password: SECRET });
  await tick();
  assert.deepEqual(heard.map((h) => h[0]), ['first', 'third', 'third'], 'the first listener no longer hears anything');
  assert.equal(typeof off, 'function');
});

/* ==========================================================================
   Nickname rules after sign-in
   ========================================================================== */

test('nickname: profiles table first, then user metadata, then "Learner"', async () => {
  const cases = [
    [{ data: { nickname: 'FromProfile' }, error: null }, 'FromProfile'],
    [{ data: null, error: { message: 'network down', code: '' } }, 'MetaSam'],
    [{ data: null, error: null }, 'MetaSam'],
    [{ data: { nickname: 'bad@name.com' }, error: null }, 'MetaSam'],
    [{ data: { nickname: 42 }, error: null }, 'MetaSam'],
  ];
  for (const [profile, expected] of cases) {
    const { auth, seams } = await setup({ saved: true, fake: makeFake({ session: SESSION, profile }) });
    const state = await auth.initAuth(seams);
    assert.equal(state.user.nickname, expected, JSON.stringify(profile));
  }
  for (const metadata of [{}, { nickname: 'a@b.co' }, { nickname: '' }, { nickname: 'x' }, { nickname: 7 }, undefined]) {
    const session = { access_token: 'a', user: { ...RAW_USER, user_metadata: metadata } };
    const fake = makeFake({ session, profile: { data: null, error: { message: 'x' } } });
    const { auth, seams } = await setup({ saved: true, fake });
    assert.equal((await auth.initAuth(seams)).user.nickname, 'Learner', JSON.stringify(metadata));
  }
});

test('nickname: a profile request that throws falls back quietly', async () => {
  const fake = makeFake({ session: SESSION, script: { profileRead: () => { throw new Error('boom'); } } });
  const { auth, seams } = await setup({ saved: true, fake });
  assert.equal((await auth.initAuth(seams)).user.nickname, 'MetaSam');
});

test('emailConfirmed is false when the user has no confirmation time', async () => {
  const session = { access_token: 'a', user: { ...RAW_USER, email_confirmed_at: null } };
  const { auth, seams } = await setup({ saved: true, fake: makeFake({ session }) });
  assert.equal((await auth.initAuth(seams)).user.emailConfirmed, false);
});

/* ==========================================================================
   Error mapping
   ========================================================================== */

const ERROR_CASES = [
  [{ name: 'AuthApiError', code: 'invalid_credentials', status: 400, message: 'Invalid login credentials' }, 'bad-credentials'],
  [{ name: 'AuthApiError', code: 'email_not_confirmed', status: 400, message: 'Email not confirmed' }, 'email-not-confirmed'],
  [{ name: 'AuthWeakPasswordError', code: 'weak_password', status: 422, message: 'Password should be at least 10 characters.' }, 'weak-password'],
  [{ name: 'AuthApiError', code: 'same_password', status: 422, message: 'New password should be different from the old password.' }, 'same-password'],
  [{ name: 'AuthApiError', code: 'over_request_rate_limit', status: 429, message: 'Request rate limit reached' }, 'rate-limited'],
  [{ name: 'AuthApiError', code: 'over_email_send_rate_limit', status: 429, message: 'Email rate limit exceeded' }, 'rate-limited'],
  [{ name: 'AuthApiError', code: 'unexpected_other', status: 429, message: 'whatever' }, 'rate-limited'],
  [{ name: 'AuthApiError', code: 'validation_failed', status: 400, message: 'bad' }, 'invalid-input'],
  [{ name: 'AuthApiError', code: 'email_address_invalid', status: 400, message: 'bad' }, 'invalid-input'],
  [{ name: 'AuthApiError', code: 'signup_disabled', status: 422, message: 'Signups not allowed' }, 'unavailable'],
  [{ name: 'AuthApiError', code: 'email_provider_disabled', status: 422, message: 'x' }, 'unavailable'],
  [{ name: 'AuthRetryableFetchError', message: 'Failed to fetch', status: 0 }, 'network'],
  [{ name: 'AuthRetryableFetchError', message: 'x', status: 503 }, 'network'],
  [{ name: 'AuthApiError', code: 'request_timeout', status: 504, message: 'x' }, 'network'],
  [{ name: 'AuthApiError', status: 502, message: 'Bad gateway' }, 'network'],
  [{ name: 'AuthApiError', status: 500, code: 'unexpected_failure', message: 'x' }, 'unknown'],
  // message text is only a fallback when there is no code or status
  [{ name: 'AuthApiError', message: 'Invalid login credentials' }, 'bad-credentials'],
  [{ name: 'AuthApiError', message: 'Email not confirmed' }, 'email-not-confirmed'],
  [{ name: 'AuthApiError', message: 'Password should be at least 10 characters.' }, 'weak-password'],
  [{ name: 'AuthApiError', message: 'New password should be different from the old password.' }, 'same-password'],
  [{ name: 'AuthApiError', message: 'For security purposes, you can only request this after 33 seconds.' }, 'rate-limited'],
  [{ name: 'Error', message: 'Failed to fetch' }, 'network'],
  [{ name: 'Error', message: 'something odd' }, 'unknown'],
  // codes beat message text
  [{ name: 'AuthApiError', code: 'over_request_rate_limit', status: 429, message: 'Invalid login credentials' }, 'rate-limited'],
];

test('signIn: supabase-js errors map to our codes (error.code and error.status first, message text last)', async () => {
  for (const [error, expected] of ERROR_CASES) {
    const fake = makeFake({ script: { signInWithPassword: () => ({ data: { session: null }, error }) } });
    const { auth, seams } = await setup({ fake });
    await auth.initAuth(seams);
    const result = await auth.signIn({ email: 'a@b.co', password: SECRET });
    assert.equal(result.ok, false, JSON.stringify(error));
    assert.equal(result.code, expected, JSON.stringify(error));
    assert.equal(typeof result.message, 'string');
    assert.ok(result.message.length > 5);
    assert.equal(auth.getAuthState().status, 'guest');
  }
});

test('signIn: thrown errors (not just returned ones) also become result objects', async () => {
  for (const [thrown, expected] of [[new TypeError('Failed to fetch'), 'network'], [new Error('weird'), 'unknown'], [Object.assign(new Error('x'), { name: 'AuthRetryableFetchError', status: 0 }), 'network'], [undefined, 'unknown'], ['a string', 'unknown']]) {
    const fake = makeFake({ script: { signInWithPassword: () => { throw thrown; } } });
    const { auth, seams } = await setup({ fake });
    await auth.initAuth(seams);
    const result = await auth.signIn({ email: 'a@b.co', password: SECRET });
    assert.deepEqual([result.ok, result.code], [false, expected]);
  }
});

test('wrong email and wrong password give the SAME message: "Email or password is incorrect"', async () => {
  const messages = new Set();
  for (const error of [{ code: 'invalid_credentials', status: 400, message: 'Invalid login credentials' }, { message: 'Invalid login credentials' }]) {
    const { auth, seams } = await setup({ fake: makeFake({ script: { signInWithPassword: () => ({ data: {}, error }) } }) });
    await auth.initAuth(seams);
    const result = await auth.signIn({ email: 'a@b.co', password: SECRET });
    messages.add(result.message);
    assert.equal(result.code, 'bad-credentials');
  }
  assert.deepEqual([...messages], ['Email or password is incorrect']);
});

test('signIn with a success reply that has no session is "unknown", not a crash', async () => {
  const fake = makeFake({ script: { signInWithPassword: () => ({ data: { session: null }, error: null }) } });
  const { auth, seams } = await setup({ fake });
  await auth.initAuth(seams);
  assert.equal((await auth.signIn({ email: 'a@b.co', password: SECRET })).code, 'unknown');
});

/* ==========================================================================
   signUp
   ========================================================================== */

test('signUp: sends the cleaned nickname in options.data and the confirm redirect, returns { ok: true }', async () => {
  const { auth, seams, fake } = await setup();
  await auth.initAuth(seams);
  const result = await auth.signUp({ email: ' Sam@Example.com ', password: 'apples12345', nickname: '  Quantum   Sam ' });
  assert.deepEqual(result, { ok: true });
  const [call] = fake.calls.filter((c) => c.name === 'signUp');
  assert.equal(call.args.email, 'Sam@Example.com');
  assert.equal(call.args.password, 'apples12345');
  assert.deepEqual(call.args.options.data, { nickname: 'Quantum Sam' });
  assert.match(call.args.options.emailRedirectTo, /^(https?|file):\/\/.+\/pages\/login\.html\?confirmed=1$/);
  assert.deepEqual(Object.keys(call.args.options).sort(), ['data', 'emailRedirectTo']);
});

test('signUp: checks the form on this side first (no request when something is wrong)', async () => {
  const { auth, seams, seen, fake } = await setup();
  await auth.initAuth(seams);
  const good = { email: 'sam@example.com', password: 'apples12345', nickname: 'Sam Q' };
  const bad = [
    [{ ...good, email: 'nope' }, 'invalid-input'],
    [{ ...good, nickname: 'a' }, 'invalid-input'],
    [{ ...good, nickname: 'x@y.com' }, 'invalid-input'],
    [{ ...good, nickname: '😀😀' }, 'invalid-input'],
    [{ ...good, password: 'short1' }, 'weak-password'],
    [{ ...good, password: 'onlyletterspassword' }, 'weak-password'],
    [{ ...good, password: 'a1'.repeat(40) }, 'weak-password'],
    [{ ...good, password: undefined }, 'weak-password'],
    [undefined, 'invalid-input'],
  ];
  for (const [input, code] of bad) {
    const result = await auth.signUp(input);
    assert.deepEqual([result.ok, result.code], [false, code], JSON.stringify(input));
    assert.equal(typeof result.message, 'string');
  }
  const same = await auth.signUp({ ...good, email: 'sam@example.com', nickname: 'SAM' });
  assert.deepEqual([same.ok, same.code], [false, 'invalid-input'], 'nickname equal to the email name');
  assert.equal(seen.loads, 0);
  assert.equal(fake.count('signUp'), 0);
});

test('signUp: an email that already has an account looks exactly like a new one (no enumeration)', async () => {
  const results = [];
  for (const error of [null, { code: 'user_already_exists', status: 422, message: 'User already registered' }, { code: 'email_exists', status: 422, message: 'Email address already exists' }]) {
    const fake = makeFake({ script: { signUp: () => ({ data: { user: { id: 'x', identities: [] }, session: null }, error }) } });
    const { auth, seams } = await setup({ fake });
    await auth.initAuth(seams);
    results.push(await auth.signUp({ email: 'sam@example.com', password: 'apples12345', nickname: 'Sam Q' }));
  }
  assert.deepEqual(results, [{ ok: true }, { ok: true }, { ok: true }]);
});

test('signUp: server-side errors map to codes (weak password, rate limit, network, signup disabled)', async () => {
  const cases = [
    [{ code: 'weak_password', status: 422, message: 'x' }, 'weak-password'],
    [{ code: 'over_email_send_rate_limit', status: 429, message: 'x' }, 'rate-limited'],
    [{ name: 'AuthRetryableFetchError', status: 0, message: 'Failed to fetch' }, 'network'],
    [{ code: 'signup_disabled', status: 422, message: 'x' }, 'unavailable'],
    [{ code: 'email_address_invalid', status: 400, message: 'x' }, 'invalid-input'],
  ];
  for (const [error, expected] of cases) {
    const fake = makeFake({ script: { signUp: () => ({ data: {}, error }) } });
    const { auth, seams } = await setup({ fake });
    await auth.initAuth(seams);
    const result = await auth.signUp({ email: 'sam@example.com', password: 'apples12345', nickname: 'Sam Q' });
    assert.deepEqual([result.ok, result.code], [false, expected]);
  }
});

/* ==========================================================================
   Reset, resend, new password, email, nickname, google
   ========================================================================== */

test('requestPasswordReset: redirectTo is the reset page; unknown errors still say ok; network errors show', async () => {
  const fake = makeFake();
  const { auth, seams } = await setup({ fake });
  await auth.initAuth(seams);
  assert.deepEqual(await auth.requestPasswordReset(' sam@example.com '), { ok: true });
  const [call] = fake.calls.filter((c) => c.name === 'resetPasswordForEmail');
  assert.equal(call.args.email, 'sam@example.com');
  assert.match(call.args.redirectTo, /^(https?|file):\/\/.+\/pages\/reset-password\.html$/);

  for (const error of [{ code: 'over_email_send_rate_limit', status: 429, message: 'x' }, { code: 'user_not_found', status: 404, message: 'x' }, { status: 500, message: 'x' }, { message: 'weird' }]) {
    fake.script.resetPasswordForEmail = () => ({ data: null, error });
    assert.deepEqual(await auth.requestPasswordReset('sam@example.com'), { ok: true }, JSON.stringify(error));
  }
  fake.script.resetPasswordForEmail = () => ({ data: null, error: { name: 'AuthRetryableFetchError', status: 0, message: 'Failed to fetch' } });
  const offline = await auth.requestPasswordReset('sam@example.com');
  assert.deepEqual([offline.ok, offline.code], [false, 'network']);

  const invalid = await auth.requestPasswordReset('nope');
  assert.deepEqual([invalid.ok, invalid.code], [false, 'invalid-input']);
});

test('requestPasswordReset: says the same thing (ok) for rate limits, so nothing reveals an account', async () => {
  const known = makeFake({ script: { resetPasswordForEmail: () => ({ data: null, error: { code: 'over_email_send_rate_limit', status: 429 } }) } });
  const unknown = makeFake();
  const answers = [];
  for (const fake of [known, unknown]) {
    const { auth, seams } = await setup({ fake });
    await auth.initAuth(seams);
    answers.push(await auth.requestPasswordReset('someone@example.com'));
  }
  assert.deepEqual(answers[0], answers[1]);
});

test('resendConfirmation: asks for a "signup" email with the confirm redirect', async () => {
  const fake = makeFake();
  const { auth, seams } = await setup({ fake });
  await auth.initAuth(seams);
  assert.deepEqual(await auth.resendConfirmation('sam@example.com'), { ok: true });
  const [call] = fake.calls.filter((c) => c.name === 'resend');
  assert.equal(call.args.type, 'signup');
  assert.equal(call.args.email, 'sam@example.com');
  assert.match(call.args.options.emailRedirectTo, /pages\/login\.html\?confirmed=1$/);
  fake.script.resend = () => ({ data: null, error: { code: 'over_email_send_rate_limit', status: 429 } });
  assert.deepEqual(await auth.resendConfirmation('sam@example.com'), { ok: true });
  assert.equal((await auth.resendConfirmation('')).code, 'invalid-input');
});

test('setNewPassword: same rules as sign-up, then updateUser({ password })', async () => {
  const env = await signedIn();
  const { auth, fake } = env;
  for (const weak of ['short1', 'nonumbersatall', '', undefined]) {
    const result = await auth.setNewPassword(weak);
    assert.deepEqual([result.ok, result.code], [false, 'weak-password']);
  }
  assert.equal(fake.count('updateUser'), 0);

  assert.deepEqual(await auth.setNewPassword('brand-new-pass-77'), { ok: true });
  assert.deepEqual(fake.calls.find((c) => c.name === 'updateUser').args, { attributes: { password: 'brand-new-pass-77' } });

  fake.script.updateUser = () => ({ data: null, error: { code: 'same_password', status: 422, message: 'x' } });
  assert.equal((await auth.setNewPassword('brand-new-pass-77')).code, 'same-password');
  fake.script.updateUser = () => ({ data: null, error: { name: 'AuthSessionMissingError', status: 400, message: 'Auth session missing!' } });
  const expired = await auth.setNewPassword('brand-new-pass-77');
  assert.equal(expired.ok, false);
  assert.match(expired.message, /expired/);
  fake.script.updateUser = () => ({ data: null, error: { code: 'weak_password', status: 422, message: 'x' } });
  assert.equal((await auth.setNewPassword('brand-new-pass-77')).code, 'weak-password');
});

test('changeEmail: updateUser({ email }); an email that is taken still says ok', async () => {
  const env = await signedIn();
  const { auth, fake } = env;
  assert.equal((await auth.changeEmail('nope')).code, 'invalid-input');
  assert.deepEqual(await auth.changeEmail(' new@example.com '), { ok: true });
  const call = fake.calls.find((c) => c.name === 'updateUser');
  assert.deepEqual(call.args.attributes, { email: 'new@example.com' });
  assert.match(call.args.emailRedirectTo, /pages\/login\.html\?confirmed=1$/);
  for (const code of ['email_exists', 'user_already_exists']) {
    fake.script.updateUser = () => ({ data: null, error: { code, status: 422, message: 'x' } });
    assert.deepEqual(await auth.changeEmail('taken@example.com'), { ok: true });
  }
  fake.script.updateUser = () => ({ data: null, error: { name: 'AuthRetryableFetchError', status: 0, message: 'x' } });
  assert.equal((await auth.changeEmail('x@example.com')).code, 'network');
});

test('verifyCurrentPassword: a throw-away client with no storage; the visible state does not change', async () => {
  const env = await signedIn();
  const { auth, fake, events, storage } = env;
  const before = JSON.stringify(auth.getAuthState());
  const clientsBefore = fake.clients.length;

  assert.deepEqual(await auth.verifyCurrentPassword(SECRET), { ok: true });
  await tick();
  const temp = fake.clients[clientsBefore];
  assert.deepEqual(temp.options.auth, { storageKey: 'qss-auth-verify', persistSession: false, autoRefreshToken: false, detectSessionInUrl: false });
  assert.equal(temp.signedOut, true, 'the extra session is ended straight away');
  const [signInCall] = fake.calls.filter((c) => c.name === 'signInWithPassword');
  assert.deepEqual(signInCall.args, { email: 'sam@example.com', password: SECRET }, 'uses the CURRENT email');
  assert.equal(JSON.stringify(auth.getAuthState()), before);
  assert.deepEqual(events, []);
  assert.ok(!JSON.stringify(storage.dump()).includes(SECRET));

  fake.script.signInWithPassword = () => ({ data: {}, error: { code: 'invalid_credentials', status: 400, message: 'Invalid login credentials' } });
  const wrong = await auth.verifyCurrentPassword('wrong-password-1');
  assert.deepEqual([wrong.ok, wrong.code], [false, 'bad-credentials']);
  assert.equal((await auth.verifyCurrentPassword('')).code, 'invalid-input');
});

test('verifyCurrentPassword: needs a signed-in person', async () => {
  const { auth, seams, fake } = await setup();
  await auth.initAuth(seams);
  const result = await auth.verifyCurrentPassword(SECRET);
  assert.equal(result.ok, false);
  assert.equal(fake.count('signInWithPassword'), 0);
});

test('updateNickname: updates the profile row for this user, updates the state, emits USER_UPDATED', async () => {
  const env = await signedIn();
  const { auth, fake, events } = env;
  assert.deepEqual(await auth.updateNickname('  New   Name '), { ok: true });
  const write = fake.calls.find((c) => c.name === 'profileWrite');
  assert.equal(write.args.table, 'profiles');
  assert.deepEqual(write.args.values, { nickname: 'New Name' });
  assert.deepEqual(write.args.filters, [['id', 'user-1']]);
  assert.equal(auth.getAuthState().user.nickname, 'New Name');
  assert.deepEqual(events.map((e) => [e.event, e.nickname]), [['USER_UPDATED', 'New Name']]);

  fake.calls.length = 0;
  for (const bad of ['a', 'x@y.com', '😀😀', '', 'sam']) {
    const result = await auth.updateNickname(bad);
    assert.deepEqual([result.ok, result.code], [false, 'invalid-input'], bad);
  }
  assert.equal(fake.count('profileWrite'), 0, 'no request for invalid nicknames');

  fake.script.profileWrite = () => ({ data: null, error: { code: '23514', message: 'violates check constraint' } });
  assert.equal((await auth.updateNickname('Valid Name')).code, 'invalid-input');
  fake.script.profileWrite = () => ({ data: null, error: { code: '', message: 'TypeError: Failed to fetch' } });
  assert.equal((await auth.updateNickname('Valid Name')).code, 'network');
  fake.script.profileWrite = () => ({ data: [], error: null });
  assert.equal((await auth.updateNickname('Valid Name')).ok, false, 'no row changed');
  fake.script.profileWrite = () => ({ data: null, error: { code: '42501', message: 'denied' } });
  assert.equal((await auth.updateNickname('Valid Name')).code, 'unknown');
  assert.equal(auth.getAuthState().user.nickname, 'New Name', 'failed updates change nothing');
});

test('updateNickname: needs a signed-in person', async () => {
  const { auth, seams } = await setup();
  await auth.initAuth(seams);
  assert.equal((await auth.updateNickname('Valid Name')).ok, false);
});

test('signInWithGoogle: only when the feature flag is on', async () => {
  const { auth, seams, fake } = await setup();
  await auth.initAuth(seams);
  const off = await auth.signInWithGoogle();
  assert.deepEqual([off.ok, off.code], [false, 'unavailable']);
  assert.equal(fake.count('signInWithOAuth'), 0);
  FEATURES.googleSignIn = true;
  try {
    assert.deepEqual(await auth.signInWithGoogle(), { ok: true });
    const call = fake.calls.find((c) => c.name === 'signInWithOAuth');
    assert.equal(call.args.provider, 'google');
    assert.match(call.args.options.redirectTo, /^(https?|file):\/\//);
  } finally {
    FEATURES.googleSignIn = false;
  }
});

/* ==========================================================================
   signOut and access token
   ========================================================================== */

test('signOut: local by default, scope "global" when everywhere is true', async () => {
  for (const [options, scope] of [[undefined, 'local'], [{}, 'local'], [{ everywhere: false }, 'local'], [{ everywhere: true }, 'global']]) {
    const env = await signedIn();
    assert.deepEqual(await env.auth.signOut(options), { ok: true });
    await tick();
    assert.deepEqual(env.fake.calls.find((c) => c.name === 'signOut').args, { scope });
    assert.equal(env.auth.getAuthState().status, 'guest');
    assert.deepEqual(env.events.map((e) => e.event), ['SIGNED_OUT'], 'exactly one SIGNED_OUT');
    assert.equal(env.storage.getItem(AUTH_STORAGE_KEY), null);
  }
});

test('signOut: this device is signed out even when the server cannot be reached', async () => {
  for (const failure of [() => ({ error: { name: 'AuthRetryableFetchError', status: 0, message: 'Failed to fetch' } }), () => { throw new TypeError('Failed to fetch'); }]) {
    const env = await signedIn();
    env.storage.setItem(AUTH_STORAGE_KEY, JSON.stringify({ saved: 'session' }));
    env.fake.script.signOut = failure;
    const result = await env.auth.signOut({ everywhere: true });
    await tick();
    assert.deepEqual(result, { ok: true, revoked: false });
    assert.equal(env.auth.getAuthState().status, 'guest');
    assert.equal(env.auth.getAuthState().user, null);
    assert.equal(env.storage.getItem(AUTH_STORAGE_KEY), null, 'the saved sign-in is removed');
    assert.equal(env.auth.getClient(), null, 'the old client (and its refresh timer) is dropped');
    assert.ok(env.fake.count('stopAutoRefresh') >= 1);
    assert.deepEqual(env.events.map((e) => e.event), ['SIGNED_OUT']);
    // a later log-in builds a new client
    const again = await env.auth.signIn({ email: 'sam@example.com', password: SECRET });
    assert.equal(again.ok, true);
  }
});

test('signOut when not signed in is harmless', async () => {
  const { auth, seams, events } = await setup();
  await auth.initAuth(seams);
  assert.deepEqual(await auth.signOut(), { ok: true });
  assert.deepEqual(events.map((e) => e.event), ['INITIAL_SESSION']);
});

test('getAccessToken: null with no client, otherwise the current token from getSession()', async () => {
  const { auth, seams, fake } = await setup();
  await auth.initAuth(seams);
  assert.equal(await auth.getAccessToken(), null);
  await auth.signIn({ email: 'a@b.co', password: SECRET });
  assert.equal(await auth.getAccessToken(), 'access-1');
  fake.session = null;
  assert.equal(await auth.getAccessToken(), null);
});

/* ==========================================================================
   Passwords never leak
   ========================================================================== */

test('passwords never appear in returned values, messages, console output or storage (even if a library error echoes them)', async () => {
  const consoleCalls = [];
  const originals = {};
  for (const name of ['log', 'info', 'warn', 'error', 'debug', 'trace']) {
    originals[name] = console[name];
    console[name] = (...args) => consoleCalls.push(args.map(String).join(' '));
  }
  const outputs = [];
  try {
    const echoing = (name) => ({ name: 'AuthApiError', status: 400, message: `bad password ${SECRET} for user`, code: name });
    const scenarios = [
      {},
      { signInWithPassword: () => ({ data: {}, error: echoing('invalid_credentials') }), signUp: () => ({ data: {}, error: echoing('weak_password') }), updateUser: () => ({ data: {}, error: echoing('same_password') }) },
      { signInWithPassword: () => ({ data: {}, error: echoing('something_new') }), signUp: () => ({ data: {}, error: echoing('something_new') }), updateUser: () => ({ data: {}, error: echoing('something_new') }) },
      { signInWithPassword: () => { throw new Error(`Failed ${SECRET}`); }, signUp: () => { throw new Error(`Failed ${SECRET}`); }, updateUser: () => { throw new Error(`Failed ${SECRET}`); } },
      { signInWithPassword: () => { throw Object.assign(new TypeError(`Failed to fetch ${SECRET}`), { password: SECRET }); } },
    ];
    for (const script of scenarios) {
      const env = await setup({ fake: makeFake({ script }) });
      await env.auth.initAuth(env.seams);
      outputs.push(await env.auth.signIn({ email: 'sam@example.com', password: SECRET }));
      outputs.push(await env.auth.signUp({ email: 'sam@example.com', password: SECRET, nickname: 'Sam Q' }));
      outputs.push(await env.auth.setNewPassword(SECRET));
      outputs.push(await env.auth.verifyCurrentPassword(SECRET));
      outputs.push(env.auth.getAuthState(), env.events);
      outputs.push(env.storage.dump(), globalThis.localStorage.dump());
    }
    const env = await signedIn();
    outputs.push(await env.auth.verifyCurrentPassword(SECRET), await env.auth.setNewPassword(SECRET), env.auth.getAuthState(), env.events, env.storage.dump());
  } finally {
    Object.assign(console, originals);
  }
  const everything = JSON.stringify(outputs);
  assert.ok(!everything.includes(SECRET), 'no password in any result, state, event or storage value');
  assert.deepEqual(consoleCalls, [], 'nothing is logged');
  assert.ok(outputs.length > 20);
});

test('passwords are passed to supabase-js methods only (signUp, signInWithPassword, updateUser) and nowhere else', async () => {
  const env = await signedIn();
  await env.auth.signUp({ email: 'kim@example.com', password: SECRET, nickname: 'Kim Q' });
  await env.auth.setNewPassword(SECRET);
  await env.auth.verifyCurrentPassword(SECRET);
  await env.auth.requestPasswordReset('kim@example.com');
  await env.auth.resendConfirmation('kim@example.com');
  await env.auth.updateNickname('Kim Q');
  await env.auth.changeEmail('kim2@example.com');
  for (const call of env.fake.calls) {
    const carries = JSON.stringify(call.args).includes(SECRET);
    assert.equal(carries, ['signUp', 'updateUser', 'signInWithPassword'].includes(call.name) && !(call.name === 'updateUser' && call.args.attributes.email), `${call.name}`);
  }
});
