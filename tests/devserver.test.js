/* ==========================================================================
   devserver.test.js — the dev server must never hand out private files.
   We test the pure path check from scripts/dev-server.js (it does not start the
   server when imported), the .env reader, and the /api routing (a real server on a random port,
   in this same process). path.win32 lets us try the Windows rules on any computer.
   Run with: npm test   (or: node --test tests/devserver.test.js)
   ========================================================================== */

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

import { resolvePublicFile, parseEnv, loadEnvFile, createServer } from '../scripts/dev-server.js';

const PRIVATE = [
  '/.env',
  '/.git/config',
  '/.gitignore',
  '/js/.hidden/file.js',
  '/node_modules/x/index.js',
  '/NODE_MODULES/x/index.js',
  '/node_modules./x/index.js',
  '/node_modules::$INDEX_ALLOCATION/x',
  '/%2Eenv',
  '/%5C.env',
  '/%5C.git/config',
  '/pages%5C..%5C.env',
  '/..%5C.env',
  '/a%00.html',
  '/%E0%A4%A',
];

const PUBLIC = ['/', '/index.html', '/pages/learn.html', '/js/pages/learn.js', '/data/learn/intro.json', '/assets/images/logo.svg'];

for (const [label, lib, root] of [
  ['posix', path.posix, '/site'],
  ['windows', path.win32, 'C:\\site'],
]) {
  test(`dev server (${label} rules): private files and escapes are refused`, () => {
    for (const request of PRIVATE) assert.equal(resolvePublicFile(request, root, lib), null, `${request} must be refused`);
  });

  test(`dev server (${label} rules): normal site files are served from inside the root`, () => {
    for (const request of PUBLIC) {
      const file = resolvePublicFile(request, root, lib);
      assert.ok(file && lib.relative(root, file) && !lib.relative(root, file).startsWith('..'), `${request} must be served`);
    }
    assert.equal(resolvePublicFile('/', root, lib), lib.join(root, 'index.html'));
    assert.equal(resolvePublicFile('/pages/learn.html', root, lib), lib.join(root, 'pages', 'learn.html'));
  });
}

test('dev server: "../" cannot climb out of the site folder', () => {
  assert.equal(resolvePublicFile('/../secret.txt', '/site', path.posix), '/site/secret.txt', 'stays inside the site folder');
  assert.equal(resolvePublicFile('/%2e%2e/%2e%2e/secret.txt', '/site', path.posix), '/site/secret.txt');
  assert.equal(resolvePublicFile('/pages/../../secret.txt', 'C:\\site', path.win32), 'C:\\site\\secret.txt');
});

test('dev server: other Windows drives and network shares are refused', () => {
  assert.equal(resolvePublicFile('/D:/secret.txt', 'C:\\site', path.win32), null);
  assert.equal(resolvePublicFile('/%5C%5Cserver%5Cshare', 'C:\\site', path.win32), null);
});

test('dev server: the api/ folder is never served as text (any capitals, Windows tricks)', () => {
  for (const request of ['/api/public-config.js', '/API/public-config.js', '/Api/x.js', '/api./public-config.js', '/api/', '/%61pi/public-config.js', '/api::$DATA/x.js']) {
    assert.equal(resolvePublicFile(request, '/site', path.posix), null, `${request} must be refused (posix)`);
    assert.equal(resolvePublicFile(request, 'C:\\site', path.win32), null, `${request} must be refused (windows)`);
  }
  assert.ok(resolvePublicFile('/js/api/x.js', '/site', path.posix), 'only the top-level api folder is blocked');
  assert.ok(resolvePublicFile('/pages/api-notes.html', '/site', path.posix));
});

/* ---------- .env reader ---------- */

test('parseEnv: KEY=value lines, comments, quotes, export, blank lines', () => {
  const parsed = parseEnv(
    [
      '# a comment',
      '',
      'PLAIN=hello',
      'SPACED = spaced value  ',
      'DOUBLE="with # hash and = sign"',
      "SINGLE='single quoted'",
      'export EXPORTED=yes',
      'TRAILING=value # a comment after it',
      'EMPTY=',
      'EMPTY_QUOTES=""',
      '1BAD=nope',
      'no equals sign',
      'WINDOWS=crlf\r',
    ].join('\r\n'),
  );
  assert.deepEqual(parsed, {
    PLAIN: 'hello',
    SPACED: 'spaced value',
    DOUBLE: 'with # hash and = sign',
    SINGLE: 'single quoted',
    EXPORTED: 'yes',
    TRAILING: 'value',
    EMPTY: '',
    EMPTY_QUOTES: '',
    WINDOWS: 'crlf',
  });
});

test('loadEnvFile: never overrides variables that are already set, never prints values, missing file is fine', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qss-env-'));
  const file = path.join(dir, '.env');
  fs.writeFileSync(file, 'SUPABASE_URL=https://from-file.example\nSUPABASE_ANON_KEY=file-key\nALREADY=file\n');
  const printed = [];
  const originals = { log: console.log, error: console.error, warn: console.warn, info: console.info };
  for (const name of Object.keys(originals)) console[name] = (...args) => printed.push(args.join(' '));
  try {
    const env = { ALREADY: 'from-real-environment', EMPTY_BUT_SET: '' };
    assert.equal(loadEnvFile(file, env), 2);
    assert.equal(env.SUPABASE_URL, 'https://from-file.example');
    assert.equal(env.ALREADY, 'from-real-environment', 'real environment wins');
    const env2 = { SUPABASE_URL: '' };
    loadEnvFile(file, env2);
    assert.equal(env2.SUPABASE_URL, '', 'an empty but set variable is also kept');
    assert.equal(loadEnvFile(path.join(dir, 'missing.env'), {}), 0);
  } finally {
    Object.assign(console, originals);
    fs.rmSync(dir, { recursive: true, force: true });
  }
  assert.deepEqual(printed, [], 'nothing is printed');
});

/* ---------- /api routing (real server, random port) ---------- */

async function withServer(options, run) {
  const server = createServer(options);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await run(base);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function makeSite(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qss-site-'));
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  return root;
}

test('dev server API: the real api/public-config function runs, with the Vercel-like helpers', async () => {
  const saved = { url: process.env.SUPABASE_URL, key: process.env.SUPABASE_ANON_KEY };
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_ANON_KEY;
  try {
    await withServer({}, async (base) => {
      let res = await fetch(`${base}/api/public-config`);
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type'), /application\/json/);
      assert.equal(res.headers.get('cache-control'), 'no-store');
      assert.deepEqual(await res.json(), { configured: false });

      process.env.SUPABASE_URL = 'https://project.example.supabase.co';
      process.env.SUPABASE_ANON_KEY = 'anon-key-value';
      res = await fetch(`${base}/api/public-config/?x=1`);
      assert.deepEqual(await res.json(), { configured: true, supabaseUrl: 'https://project.example.supabase.co', supabaseAnonKey: 'anon-key-value' });

      res = await fetch(`${base}/api/public-config`, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
      assert.equal(res.status, 405, 'POST reaches the function (which refuses it)');
    });
  } finally {
    for (const [name, value] of [['SUPABASE_URL', saved.url], ['SUPABASE_ANON_KEY', saved.key]]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test('dev server API: unknown names give a 404 JSON, odd names never reach the disk', async () => {
  await withServer({}, async (base) => {
    for (const request of ['/api/nope', '/api/', '/api', '/api/a.b', '/api/a/b', '/api/%2e%2e%2fpackage', '/api/..%5Cpackage', '/api/public-config.js']) {
      const res = await fetch(`${base}${request}`);
      assert.equal(res.status, 404, `${request} -> 404`);
      assert.match(res.headers.get('content-type'), /application\/json/);
      assert.deepEqual(await res.json(), { error: 'Not found' });
    }
  });
});

test('dev server API: req.query, JSON req.body, res.status().json(), res.send(), headers', async () => {
  const root = makeSite({
    'api/echo.js': `export default function handler(req, res) {
      res.setHeader('X-Test', 'yes');
      if (req.query.mode === 'send') return res.status(201).send('plain text');
      if (req.query.mode === 'end') { res.statusCode = 202; return res.end('raw'); }
      res.status(200).json({ method: req.method, query: req.query, body: req.body ?? null });
    }`,
    'api/async-name_2.js': 'export default async function handler(req, res) { await new Promise((r) => setTimeout(r, 5)); res.status(200).json({ ok: true }); }',
  });
  try {
    await withServer({ root }, async (base) => {
      let res = await fetch(`${base}/api/echo?a=1&b=2&b=3&c=%C3%A9`, { method: 'PUT', body: JSON.stringify({ hi: [1, 2] }), headers: { 'content-type': 'application/json; charset=utf-8' } });
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('x-test'), 'yes');
      assert.deepEqual(await res.json(), { method: 'PUT', query: { a: '1', b: ['2', '3'], c: 'é' }, body: { hi: [1, 2] } });

      res = await fetch(`${base}/api/echo?mode=send`);
      assert.equal(res.status, 201);
      assert.match(res.headers.get('content-type'), /text\/html/);
      assert.equal(await res.text(), 'plain text');

      res = await fetch(`${base}/api/echo?mode=end`);
      assert.equal(res.status, 202);
      assert.equal(await res.text(), 'raw');

      res = await fetch(`${base}/api/echo`, { method: 'POST', body: 'just text', headers: { 'content-type': 'text/plain' } });
      assert.equal((await res.json()).body, 'just text', 'non-JSON bodies stay text');

      res = await fetch(`${base}/api/echo`, { method: 'POST', body: '{broken', headers: { 'content-type': 'application/json' } });
      assert.equal(res.status, 400);
      assert.deepEqual(await res.json(), { error: 'Invalid JSON' });

      res = await fetch(`${base}/api/async-name_2`);
      assert.deepEqual(await res.json(), { ok: true });

      res = await fetch(`${base}/api/echo`, { method: 'HEAD' });
      assert.equal(res.status, 200);
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('dev server API: a crashing function gives a generic 500 with no message or stack', async () => {
  const root = makeSite({
    'api/boom.js': "export default function handler() { throw new Error('secret-detail-do-not-leak'); }",
    'api/reject.js': "export default async function handler() { throw new Error('secret-detail-do-not-leak'); }",
    'api/syntax.js': 'export default function ( {',
    'api/nofunction.js': 'export default 42;',
    'api/late.js': "export default function handler(req, res) { res.status(200); res.write('partial'); throw new Error('secret-detail-do-not-leak'); }",
  });
  const logged = [];
  try {
    await withServer({ root, logger: (error) => logged.push(error) }, async (base) => {
      for (const name of ['boom', 'reject', 'syntax', 'nofunction']) {
        const res = await fetch(`${base}/api/${name}`);
        const text = await res.text();
        assert.equal(res.status, 500, name);
        assert.deepEqual(JSON.parse(text), { error: 'Server error' });
        assert.ok(!/secret-detail|at \w|\.js:\d|node:/.test(text), `${name}: no details in the response`);
      }
      const res = await fetch(`${base}/api/late`);
      assert.equal(res.status, 200, 'headers already sent: the connection just ends');
      assert.ok(!(await res.text()).includes('secret-detail'));
    });
    assert.equal(logged.length, 5, 'the details are logged on the server side');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('dev server API: edits to a function are picked up without a restart', async () => {
  const root = makeSite({ 'api/live.js': "export default (req, res) => res.status(200).json({ v: 1 });" });
  const file = path.join(root, 'api', 'live.js');
  try {
    await withServer({ root }, async (base) => {
      assert.deepEqual(await (await fetch(`${base}/api/live`)).json(), { v: 1 });
      fs.writeFileSync(file, 'export default (req, res) => res.status(200).json({ v: 2 });');
      const later = new Date(Date.now() + 5000);
      fs.utimesSync(file, later, later);
      assert.deepEqual(await (await fetch(`${base}/api/live`)).json(), { v: 2 });
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('dev server API: oversized bodies are refused', async () => {
  const root = makeSite({ 'api/echo.js': 'export default (req, res) => res.status(200).json({ n: String(req.body ?? "").length });' });
  try {
    await withServer({ root }, async (base) => {
      const res = await fetch(`${base}/api/echo`, { method: 'POST', body: 'x'.repeat(1024 * 1024 + 10), headers: { 'content-type': 'text/plain' } }).catch(() => null);
      assert.ok(res === null || res.status === 413, 'refused (413) or the connection is closed');
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('dev server static: pages still work, private files and api sources are not served, other methods are refused', async () => {
  await withServer({}, async (base) => {
    let res = await fetch(`${base}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
    assert.equal((await fetch(`${base}/js/config.js`)).status, 200);

    for (const request of ['/.env', '/.git/config', '/%2Eenv', '/node_modules/x', '/api/public-config.js', '/API/public-config.js', '/Api/public-config.js', '/%61pi/public-config.js', '/%41PI/public-config.js']) {
      res = await fetch(`${base}${request}`);
      const text = await res.text();
      assert.equal(res.status, 404, `${request} -> 404`);
      assert.ok(!text.includes('export default') && !text.includes('SUPABASE'), `${request}: no source in the response`);
    }

    res = await fetch(`${base}/index.html`, { method: 'POST', body: 'x' });
    assert.equal(res.status, 405, 'non-GET static requests are refused');
    res = await fetch(`${base}/index.html`, { method: 'HEAD' });
    assert.equal(res.status, 200);
  });
});
