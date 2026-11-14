/* ==========================================================================
   publicConfig.test.js — api/public-config.js must hand out ONLY the Supabase address and
   public key, only when both are set, and never any other environment variable.
   Run with: npm test   (or: node --test tests/publicConfig.test.js)
   ========================================================================== */

import test from 'node:test';
import assert from 'node:assert/strict';

import handler from '../api/public-config.js';

const NAMES = ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'OPENAI_API_KEY', 'SOME_OTHER_SECRET'];

/** A fake Vercel response that records what the function does. */
function fakeResponse() {
  const res = { statusCode: 200, headers: {}, body: undefined };
  res.setHeader = (name, value) => {
    res.headers[name.toLowerCase()] = value;
  };
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (body) => {
    res.body = body;
    return res;
  };
  return res;
}

/** Run the handler with exactly these environment variables set (the rest of NAMES unset), then restore them. */
function call(env, method = 'GET') {
  const saved = Object.fromEntries(NAMES.map((name) => [name, process.env[name]]));
  for (const name of NAMES) delete process.env[name];
  Object.assign(process.env, env);
  try {
    const res = fakeResponse();
    handler({ method }, res);
    return res;
  } finally {
    for (const name of NAMES) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  }
}

const URL_VALUE = 'https://abcdefgh.supabase.co';
const KEY_VALUE = 'public-anon-key-value';

test('public-config: both variables set gives configured:true with just those two values', () => {
  const res = call({ SUPABASE_URL: URL_VALUE, SUPABASE_ANON_KEY: KEY_VALUE });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { configured: true, supabaseUrl: URL_VALUE, supabaseAnonKey: KEY_VALUE });
});

test('public-config: a missing variable means configured:false (nothing else in the answer)', () => {
  assert.deepEqual(call({}).body, { configured: false });
  assert.deepEqual(call({ SUPABASE_URL: URL_VALUE }).body, { configured: false });
  assert.deepEqual(call({ SUPABASE_ANON_KEY: KEY_VALUE }).body, { configured: false });
  assert.equal(call({}).statusCode, 200);
});

test('public-config: empty or blank values count as missing, and values are trimmed', () => {
  assert.deepEqual(call({ SUPABASE_URL: '', SUPABASE_ANON_KEY: KEY_VALUE }).body, { configured: false });
  assert.deepEqual(call({ SUPABASE_URL: URL_VALUE, SUPABASE_ANON_KEY: '   ' }).body, { configured: false });
  assert.deepEqual(call({ SUPABASE_URL: ' \n', SUPABASE_ANON_KEY: ' \t ' }).body, { configured: false });
  const res = call({ SUPABASE_URL: `  ${URL_VALUE}\n`, SUPABASE_ANON_KEY: `\t${KEY_VALUE} ` });
  assert.deepEqual(res.body, { configured: true, supabaseUrl: URL_VALUE, supabaseAnonKey: KEY_VALUE });
});

test('public-config: the service-role key and other variables NEVER appear, configured or not', () => {
  const secrets = { SUPABASE_SERVICE_ROLE_KEY: 'service-role-SECRET-123', OPENAI_API_KEY: 'sk-SECRET-456', SOME_OTHER_SECRET: 'SECRET-789' };
  for (const env of [secrets, { ...secrets, SUPABASE_URL: URL_VALUE, SUPABASE_ANON_KEY: KEY_VALUE }]) {
    const res = call(env);
    const text = JSON.stringify({ body: res.body, headers: res.headers });
    assert.ok(!text.includes('SECRET'), 'no secret value anywhere in the response');
    assert.ok(!/service/i.test(text), 'no service-role mention');
    assert.deepEqual(Object.keys(res.body).sort(), env.SUPABASE_URL ? ['configured', 'supabaseAnonKey', 'supabaseUrl'] : ['configured']);
  }
});

test('public-config: only GET is allowed (405 with an Allow header otherwise)', () => {
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'HEAD']) {
    const res = call({ SUPABASE_URL: URL_VALUE, SUPABASE_ANON_KEY: KEY_VALUE }, method);
    assert.equal(res.statusCode, 405, method);
    assert.equal(res.headers.allow, 'GET');
    assert.ok(!JSON.stringify(res.body).includes(KEY_VALUE), 'a refused request never gets the key');
  }
});

test('public-config: answers are never cached (Cache-Control: no-store)', () => {
  assert.equal(call({}).headers['cache-control'], 'no-store');
  assert.equal(call({ SUPABASE_URL: URL_VALUE, SUPABASE_ANON_KEY: KEY_VALUE }).headers['cache-control'], 'no-store');
  assert.equal(call({}, 'POST').headers['cache-control'], 'no-store');
});
