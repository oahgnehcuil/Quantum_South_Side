/* ==========================================================================
   authClient.js — the ONLY file that talks to Supabase Auth (optional accounts).

   Privacy rules this file keeps:
   • The Supabase address and public key are NOT in the code. We ask api/public-config for them.
   • If accounts are not set up there, nothing else happens: no account code is downloaded.
   • supabase-js (from esm.sh) is downloaded, and Supabase is contacted, ONLY when
       (a) the person uses an account action (log in, sign up, reset password, ...),
       (b) a saved sign-in exists in this browser (localStorage key "qss-auth"), or
       (c) the page address carries sign-in tokens (email-confirm or password-reset links).
     A guest who never touches accounts never contacts esm.sh or Supabase.
   • Passwords go straight to supabase-js and nowhere else. They are never stored, logged,
     or put in a returned value or message. All messages shown to people are written here.

   Functions never throw for normal problems. They return { ok: true, ... } or
   { ok: false, code, message }. Codes: 'bad-credentials' | 'email-not-confirmed' |
   'weak-password' | 'same-password' | 'rate-limited' | 'network' | 'unavailable' |
   'invalid-input' | 'unknown'.
   ========================================================================== */
import { FEATURES, SUPABASE_JS_URL, PUBLIC_CONFIG_PATH, AUTH_STORAGE_KEY, PASSWORD_MIN_LENGTH, siteUrl } from '../config.js';
import { validateEmail, validatePassword, validateNickname } from './validators.js';

const MESSAGES = {
  'bad-credentials': 'Email or password is incorrect',
  'email-not-confirmed': 'Please confirm your email first. Check your inbox for the link we sent when you signed up.',
  'weak-password': `Please use a password with at least ${PASSWORD_MIN_LENGTH} characters, a letter and a number.`,
  'same-password': 'Your new password must be different from your old one.',
  'rate-limited': 'Too many tries. Please wait a few minutes and try again.',
  network: 'We could not reach the server. Check your internet connection and try again.',
  unavailable: 'Accounts are not available right now. You can keep using the site as a guest.',
  'invalid-input': 'Please check what you typed and try again.',
  unknown: 'Something went wrong. Please try again.',
};
const SESSION_EXPIRED = 'Your sign-in link has expired or was already used. Please log in again or ask for a new link.';

const PROFILE_TIMEOUT_MS = 6000;
const DEFAULT_NICKNAME = 'Learner';

/* ---- module state ---- */
let state = { ready: false, status: 'unavailable', user: null, sessionUnverified: false };
let config = null; // { supabaseUrl, supabaseAnonKey } once the server says accounts are set up
let seams = {}; // test helpers given to the first initAuth() call
let initPromise = null;
let initDone = false;
let modulePromise = null;
let client = null;
let clientPromise = null;
let subscription = null;
let profileLoadedFor = null; // user id whose nickname came from the profiles table
let queue = Promise.resolve(); // runs auth events one at a time
let resolveFirstSession = null;
const listeners = new Set();

const fail = (code, message) => ({ ok: false, code, message: message || MESSAGES[code] });

function publicState() {
  return { ready: state.ready, status: state.status, user: state.user ? { ...state.user } : null, sessionUnverified: state.sessionUnverified };
}

function notify(event) {
  const snapshot = publicState();
  for (const listener of [...listeners]) {
    try {
      listener(snapshot, event);
    } catch {
      // one broken listener must not stop the others
    }
  }
}

/* ---- the public-config request ---- */

function readConfig(body) {
  if (!body || body.configured !== true) return null;
  const { supabaseUrl, supabaseAnonKey } = body;
  if (typeof supabaseUrl !== 'string' || typeof supabaseAnonKey !== 'string' || !supabaseAnonKey) return null;
  try {
    const url = new URL(supabaseUrl);
    const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
    if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) return null;
  } catch {
    return null;
  }
  return { supabaseUrl, supabaseAnonKey };
}

/** One same-origin GET. A 404 (plain static host), a network problem or bad JSON all mean "not set up", quietly. */
async function fetchConfigDefault() {
  try {
    const response = await fetch(siteUrl(PUBLIC_CONFIG_PATH), { cache: 'no-store', headers: { Accept: 'application/json' } });
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
}

/* ---- the three reasons to load supabase-js ---- */

function hasSavedSession() {
  try {
    return globalThis.localStorage?.getItem(AUTH_STORAGE_KEY) != null;
  } catch {
    return false;
  }
}

function hasSignInTokensInUrl() {
  const loc = globalThis.location;
  if (!loc) return false;
  const hash = new URLSearchParams(String(loc.hash || '').replace(/^#/, ''));
  const query = new URLSearchParams(String(loc.search || ''));
  const names = ['access_token', 'refresh_token', 'error_description', 'code'];
  return names.some((name) => hash.has(name) || query.has(name)) || hash.get('type') === 'recovery' || query.get('type') === 'recovery';
}

function loadModule() {
  if (!modulePromise) {
    const load = seams.loadSupabase || (() => import(SUPABASE_JS_URL));
    modulePromise = Promise.resolve()
      .then(load)
      .then((mod) => {
        if (typeof mod?.createClient !== 'function') throw new Error('supabase-js did not load correctly');
        return mod;
      })
      .catch((error) => {
        modulePromise = null; // allow a retry later (for example when the network is back)
        throw error;
      });
  }
  return modulePromise;
}

/* ---- nickname and user ---- */

function cleanNickname(value) {
  const result = validateNickname(value);
  return result.ok ? result.value : null;
}

async function fetchProfileNickname(activeClient, userId) {
  try {
    const request = activeClient.from('profiles').select('nickname').eq('id', userId).maybeSingle();
    const timeout = new Promise((resolve) => setTimeout(() => resolve(null), PROFILE_TIMEOUT_MS));
    const reply = await Promise.race([request, timeout]);
    return reply && !reply.error ? cleanNickname(reply.data?.nickname) : null;
  } catch {
    return null;
  }
}

async function buildUser(session) {
  const raw = session.user;
  const previous = state.user && state.user.id === raw.id ? state.user : null;
  let nickname = previous && profileLoadedFor === raw.id ? previous.nickname : null;
  if (!nickname && client) {
    nickname = await fetchProfileNickname(client, raw.id);
    if (nickname) profileLoadedFor = raw.id;
  }
  nickname = nickname || cleanNickname(raw.user_metadata?.nickname) || DEFAULT_NICKNAME;
  return { id: raw.id, email: typeof raw.email === 'string' ? raw.email : '', nickname, emailConfirmed: Boolean(raw.email_confirmed_at || raw.confirmed_at) };
}

const sameUser = (a, b) => Boolean(a && b) && a.id === b.id && a.email === b.email && a.nickname === b.nickname && a.emailConfirmed === b.emailConfirmed;

/* ---- turning supabase-js events into our state ---- */

async function processEvent(event, session) {
  if (!session?.user) {
    profileLoadedFor = null;
    const wasSignedIn = state.status === 'signed-in';
    state = { ...state, status: 'guest', user: null };
    if (initDone && wasSignedIn) notify('SIGNED_OUT');
    return;
  }
  const user = await buildUser(session);
  const changed = state.status !== 'signed-in' || !sameUser(state.user, user);
  state = { ...state, status: 'signed-in', user, sessionUnverified: false };
  if (!initDone) return; // the first INITIAL_SESSION is announced when initAuth finishes
  if (event === 'USER_UPDATED' || event === 'PASSWORD_RECOVERY') notify(event);
  else if (event === 'SIGNED_IN' || event === 'INITIAL_SESSION') {
    if (changed) notify('SIGNED_IN'); // supabase-js repeats SIGNED_IN when a tab is focused again; we only report real changes
  }
}

function handleSupabaseEvent(event, session) {
  if (event === 'MFA_CHALLENGE_VERIFIED') return;
  // Run later, outside supabase-js's own lock: calling supabase-js from inside its callback can freeze it.
  setTimeout(() => {
    queue = queue
      .then(() => processEvent(event, session))
      .catch(() => {})
      .then(() => {
        if (event === 'INITIAL_SESSION' && resolveFirstSession) {
          resolveFirstSession();
          resolveFirstSession = null;
        }
      });
  }, 0);
}

function applySession(event, session) {
  queue = queue.then(() => processEvent(event, session)).catch(() => {});
  return queue;
}

/* ---- creating the client ---- */

function ensureClient() {
  if (!config) return Promise.reject(new Error('accounts are not available'));
  if (client) return Promise.resolve(client);
  if (!clientPromise) {
    clientPromise = loadModule()
      .then((mod) => {
        const created = mod.createClient(config.supabaseUrl, config.supabaseAnonKey, {
          auth: { storageKey: AUTH_STORAGE_KEY, persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
        });
        const { data } = created.auth.onAuthStateChange(handleSupabaseEvent);
        subscription = data?.subscription || null;
        client = created;
        return created;
      })
      .finally(() => {
        clientPromise = null;
      });
  }
  return clientPromise;
}

/** Run an account action: load the client if needed, turn surprises into a result object. */
async function withClient(action) {
  if (!config || !FEATURES.accounts) return fail('unavailable');
  let active;
  try {
    active = await ensureClient();
  } catch {
    return fail('network');
  }
  try {
    return await action(active);
  } catch (error) {
    const { code, message } = describeError(error);
    return fail(code, message);
  }
}

/* ---- mapping supabase-js errors to our codes (error.code and error.status first, message text last) ---- */

const BY_CODE = {
  invalid_credentials: 'bad-credentials',
  email_not_confirmed: 'email-not-confirmed',
  weak_password: 'weak-password',
  same_password: 'same-password',
  over_request_rate_limit: 'rate-limited',
  over_email_send_rate_limit: 'rate-limited',
  over_sms_send_rate_limit: 'rate-limited',
  validation_failed: 'invalid-input',
  email_address_invalid: 'invalid-input',
  bad_json: 'invalid-input',
  signup_disabled: 'unavailable',
  email_provider_disabled: 'unavailable',
  provider_disabled: 'unavailable',
  email_address_not_authorized: 'unavailable',
  request_timeout: 'network',
};
const SESSION_CODES = new Set(['session_not_found', 'session_expired', 'refresh_token_not_found', 'refresh_token_already_used', 'otp_expired', 'bad_jwt', 'no_authorization', 'user_not_found']);

function describeError(error) {
  const code = typeof error?.code === 'string' ? error.code : '';
  const status = Number.isInteger(error?.status) ? error.status : null;
  const name = String(error?.name || '');
  const text = String(error?.message || '');

  if (name === 'AuthRetryableFetchError' || (error instanceof TypeError && /fetch|network|load failed/i.test(text))) return { code: 'network' };
  if (name === 'AuthSessionMissingError' || SESSION_CODES.has(code)) return { code: 'unknown', message: SESSION_EXPIRED };
  if (BY_CODE[code]) return { code: BY_CODE[code] };
  if (status === 429) return { code: 'rate-limited' };
  if (status === 0 || status === 502 || status === 503 || status === 504) return { code: 'network' };
  if (/invalid login credentials/i.test(text)) return { code: 'bad-credentials' };
  if (/email not confirmed/i.test(text)) return { code: 'email-not-confirmed' };
  if (/different from the old password/i.test(text)) return { code: 'same-password' };
  if (/password should be at least|weak password/i.test(text)) return { code: 'weak-password' };
  if (/rate limit|too many requests|only request this after/i.test(text)) return { code: 'rate-limited' };
  if (/failed to fetch|networkerror|network request failed|load failed/i.test(text)) return { code: 'network' };
  return { code: 'unknown' };
}

const failFrom = (error) => {
  const { code, message } = describeError(error);
  return fail(code, message);
};

/* ==========================================================================
   Public functions
   ========================================================================== */

/**
 * Start accounts. Safe to call many times (the same promise comes back).
 * Order of events: ask api/public-config, then (only if needed) load supabase-js, then announce
 * 'INITIAL_SESSION' once to the listeners that exist by then. Test helpers: { loadSupabase, fetchConfig }.
 */
export function initAuth(options = {}) {
  if (!initPromise) {
    seams = options || {};
    initPromise = start();
  }
  return initPromise;
}

async function start() {
  if (FEATURES.accounts) {
    try {
      config = readConfig(await (seams.fetchConfig || fetchConfigDefault)());
    } catch {
      config = null;
    }
  }
  if (!config) {
    state = { ready: true, status: 'unavailable', user: null, sessionUnverified: false };
    initDone = true;
    notify('INITIAL_SESSION');
    return publicState();
  }

  state = { ...state, status: 'guest' };
  if (hasSavedSession() || hasSignInTokensInUrl()) {
    try {
      const firstSession = new Promise((resolve) => {
        resolveFirstSession = resolve;
      });
      await ensureClient();
      await firstSession;
    } catch {
      // supabase-js could not be loaded (offline or blocked). Keep guest mode, but say the saved sign-in was not checked.
      state = { ...state, sessionUnverified: true };
    }
  }
  state = { ...state, ready: true };
  initDone = true;
  notify('INITIAL_SESSION');
  return publicState();
}

/** { ready, status: 'unavailable' | 'guest' | 'signed-in', user: null | { id, email, nickname, emailConfirmed }, sessionUnverified } */
export function getAuthState() {
  return publicState();
}

/** Listen for changes: listener(state, event). Returns a function that stops listening. */
export function onAuthChange(listener) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** True when the server has Supabase set up and the accounts feature flag is on. */
export function isAccountsAvailable() {
  return Boolean(config) && FEATURES.accounts;
}

/** Download supabase-js now (for example when a log-in form opens). Resolves true when the client is ready. */
export async function prepareAuth() {
  await initAuth();
  if (!isAccountsAvailable()) return false;
  try {
    await ensureClient();
    return true;
  } catch {
    return false;
  }
}

export function getClient() {
  return client;
}

/** The current access token (supabase-js refreshes it when needed), or null. */
export async function getAccessToken() {
  if (!client) return null;
  try {
    const { data } = await client.auth.getSession();
    return data?.session?.access_token || null;
  } catch {
    return null;
  }
}

/** Create an account. The answer is the same whether or not the email already has one. */
export async function signUp({ email, password, nickname } = {}) {
  const emailCheck = validateEmail(email);
  if (!emailCheck.ok) return fail('invalid-input', emailCheck.message);
  const nicknameCheck = validateNickname(nickname, { email: emailCheck.value });
  if (!nicknameCheck.ok) return fail('invalid-input', nicknameCheck.message);
  const passwordCheck = validatePassword(password);
  if (!passwordCheck.ok) return fail('weak-password', passwordCheck.message);

  return withClient(async (active) => {
    const { error } = await active.auth.signUp({
      email: emailCheck.value,
      password,
      options: { data: { nickname: nicknameCheck.value }, emailRedirectTo: siteUrl('pages/login.html?confirmed=1') },
    });
    if (!error) return { ok: true };
    if (error.code === 'user_already_exists' || error.code === 'email_exists') return { ok: true }; // never reveal that an email has an account
    return failFrom(error);
  });
}

export async function signIn({ email, password } = {}) {
  if (typeof email !== 'string' || email.trim() === '' || typeof password !== 'string' || password === '') {
    return fail('invalid-input', 'Please enter your email and your password.');
  }
  return withClient(async (active) => {
    const { data, error } = await active.auth.signInWithPassword({ email: email.trim(), password });
    if (error) return failFrom(error);
    if (!data?.session?.user) return fail('unknown');
    await applySession('SIGNED_IN', data.session);
    return { ok: true, user: { ...state.user } };
  });
}

/**
 * Sign out. This device is ALWAYS signed out (shared school computers), even if the network is down.
 * { everywhere: true } also ends the session on every other device. If the server could not be
 * reached the answer is { ok: true, revoked: false }.
 */
export async function signOut({ everywhere = false } = {}) {
  if (!client) {
    if (state.status === 'signed-in') await applySession('SIGNED_OUT', null);
    return { ok: true };
  }
  let serverOk = true;
  try {
    const { error } = await client.auth.signOut({ scope: everywhere ? 'global' : 'local' });
    if (error) serverOk = false;
  } catch {
    serverOk = false;
  }
  if (!serverOk || state.status === 'signed-in') await clearLocalSession();
  return serverOk ? { ok: true } : { ok: true, revoked: false };
}

/** Forget the saved sign-in in this browser and drop the client, so it cannot sign itself in again. */
async function clearLocalSession() {
  try {
    globalThis.localStorage?.removeItem(AUTH_STORAGE_KEY);
  } catch {
    // storage blocked: nothing saved to remove
  }
  const old = client;
  subscription?.unsubscribe?.();
  subscription = null;
  client = null;
  try {
    await old?.auth.stopAutoRefresh?.();
  } catch {
    // nothing else to do
  }
  await applySession('SIGNED_OUT', null);
}

export async function resendConfirmation(email) {
  const check = validateEmail(email);
  if (!check.ok) return fail('invalid-input', check.message);
  const result = await withClient(async (active) => {
    const { error } = await active.auth.resend({ type: 'signup', email: check.value, options: { emailRedirectTo: siteUrl('pages/login.html?confirmed=1') } });
    return error ? failFrom(error) : { ok: true };
  });
  return quietly(result);
}

export async function requestPasswordReset(email) {
  const check = validateEmail(email);
  if (!check.ok) return fail('invalid-input', check.message);
  const result = await withClient(async (active) => {
    const { error } = await active.auth.resetPasswordForEmail(check.value, { redirectTo: siteUrl('pages/reset-password.html') });
    return error ? failFrom(error) : { ok: true };
  });
  return quietly(result);
}

/** For "send an email" actions only network and unavailable problems are shown. Anything else could reveal whether an account exists. */
function quietly(result) {
  if (result.ok || result.code === 'network' || result.code === 'unavailable' || result.code === 'invalid-input') return result;
  return { ok: true };
}

/** Set a new password for the signed-in (or password-recovery) session. */
export async function setNewPassword(newPassword) {
  const check = validatePassword(newPassword);
  if (!check.ok) return fail('weak-password', check.message);
  return withClient(async (active) => {
    const { error } = await active.auth.updateUser({ password: newPassword });
    return error ? failFrom(error) : { ok: true };
  });
}

/** Ask Supabase to change the email. It sends a confirmation link; the answer does not say if the address is taken. */
export async function changeEmail(newEmail) {
  const check = validateEmail(newEmail);
  if (!check.ok) return fail('invalid-input', check.message);
  return withClient(async (active) => {
    const { error } = await active.auth.updateUser({ email: check.value }, { emailRedirectTo: siteUrl('pages/login.html?confirmed=1') });
    if (!error || error.code === 'email_exists' || error.code === 'user_already_exists') return { ok: true };
    return failFrom(error);
  });
}

/**
 * Check the current password again (before a risky change). Uses a throw-away client that keeps
 * nothing in storage, so the visible signed-in state does not change.
 */
export async function verifyCurrentPassword(password) {
  const email = state.user?.email;
  if (state.status !== 'signed-in' || !email) return fail('unknown', 'Please log in first.');
  if (typeof password !== 'string' || password === '') return fail('invalid-input', 'Please enter your current password.');
  return withClient(async () => {
    const mod = await loadModule();
    const temp = mod.createClient(config.supabaseUrl, config.supabaseAnonKey, {
      auth: { storageKey: `${AUTH_STORAGE_KEY}-verify`, persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    const { error } = await temp.auth.signInWithPassword({ email, password });
    if (error) return failFrom(error);
    await temp.auth.signOut({ scope: 'local' }); // end the extra session straight away
    return { ok: true };
  });
}

/** Change the nickname (profiles table; the database checks the same rules again). */
export async function updateNickname(nickname) {
  const user = state.user;
  if (state.status !== 'signed-in' || !user) return fail('unknown', 'Please log in first.');
  const check = validateNickname(nickname, { email: user.email });
  if (!check.ok) return fail('invalid-input', check.message);
  return withClient(async (active) => {
    const { data, error } = await active.from('profiles').update({ nickname: check.value }).eq('id', user.id).select('nickname');
    if (error) {
      if (error.code === '23514') return fail('invalid-input', 'That nickname is not allowed. Try another one.');
      if (/failed to fetch|network/i.test(String(error.message))) return fail('network');
      return fail('unknown');
    }
    if (!Array.isArray(data) || data.length === 0) return fail('unknown');
    profileLoadedFor = user.id;
    state = { ...state, user: { ...user, nickname: check.value } };
    notify('USER_UPDATED');
    return { ok: true };
  });
}

/** Optional "Continue with Google" (only when FEATURES.googleSignIn is on and Google is enabled in Supabase). */
export async function signInWithGoogle() {
  if (!FEATURES.googleSignIn) return fail('unavailable');
  return withClient(async (active) => {
    const { error } = await active.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: siteUrl('index.html') } });
    return error ? failFrom(error) : { ok: true };
  });
}
