/* ==========================================================================
   dev-server.js — a tiny local web server for working on the site.
   No installs needed. Start it with:   npm run dev
   Then open http://localhost:8000       (use another port with:  PORT=3000 npm run dev)

   Why we need a server at all: browsers refuse to load JavaScript modules and
   fetch() JSON when you double-click index.html (a file:// address).

   It also runs the serverless functions in the api/ folder the way Vercel does:
   a request to /api/public-config runs api/public-config.js. Settings for those
   functions are read from a .env file (see .env.example) when the server starts.

   Safety: this server NEVER serves private files. Anything starting with a dot
   (like .env, which holds the keys) and the .git and node_modules folders return
   404, even to other computers on your Wi-Fi. The api/ folder is never served as
   text either: its files only ever run.
   ========================================================================== */
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAX_BODY_BYTES = 1024 * 1024;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.woff2': 'font/woff2',
};

/** The name of a folder or file the way Windows and macOS see it: capitals ignored, trailing dots, spaces and ":stream" endings dropped. */
const plainName = (part) => part.split(':')[0].replace(/[. ]+$/, '').toLowerCase();

/**
 * True if any folder or file name in the path is private (dotfiles, .git, node_modules).
 * Names are compared the way Windows and macOS see them ("node_modules." is node_modules there).
 */
export function isPrivate(parts) {
  return parts.some((part) => part.startsWith('.') || plainName(part) === 'node_modules');
}

/**
 * Turn a request path ("/pages/learn.html") into a file path inside `root`,
 * or return null if the file must not be served. The private-file check runs on the
 * RESOLVED path, so tricks like "%5C.env" (a backslash, which Windows treats as "/") cannot slip past.
 * The top-level api/ folder is never served (any capitals): those files only run as functions.
 * (pathLib is only changed by the tests, to try the Windows rules on any computer.)
 */
export function resolvePublicFile(urlPath, root = ROOT, pathLib = path) {
  let requested;
  try {
    requested = decodeURIComponent(urlPath);
  } catch {
    return null; // broken %-codes
  }
  if (requested.includes('\\') || requested.includes('\0')) return null;
  if (requested.endsWith('/')) requested += 'index.html';

  const file = pathLib.join(root, pathLib.normalize(requested));
  const relative = pathLib.relative(root, file);
  // Block "../" tricks (and other drives on Windows) and the root folder itself
  if (relative === '' || relative.startsWith('..') || pathLib.isAbsolute(relative)) return null;
  const parts = relative.split(/[\\/]/);
  if (isPrivate(parts)) return null;
  if (plainName(parts[0]) === 'api') return null;
  return file;
}

/* ---- .env loader (no packages needed) ---- */

/** Read KEY=value lines. Understands comments (#), blank lines, "export KEY=...", and 'single' or "double" quotes. */
export function parseEnv(text) {
  const result = {};
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2].trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.indexOf(quote, 1) > 0) {
      value = value.slice(1, value.indexOf(quote, 1));
    } else {
      value = value.replace(/\s+#.*$/, '').trim(); // a trailing comment on an unquoted value
    }
    result[match[1]] = value;
  }
  return result;
}

/**
 * Copy the settings from a .env file into `env`. A variable that is already set is NEVER replaced
 * (so real environment settings win). Values are never printed. Returns how many names were added.
 */
export function loadEnvFile(file, env = process.env) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return 0; // no .env file: that is fine
  }
  let added = 0;
  for (const [name, value] of Object.entries(parseEnv(text))) {
    if (env[name] === undefined) {
      env[name] = value;
      added += 1;
    }
  }
  return added;
}

/* ---- api/ functions, shaped like Vercel's ---- */

const API_PATH = /^\/api\/([A-Za-z0-9_-]+)\/?$/;

function sendJson(res, status, body) {
  if (res.headersSent) return res.end();
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('too large'), { status: 413 }));
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function parseQuery(searchParams) {
  const query = {};
  for (const key of new Set(searchParams.keys())) {
    if (key === '__proto__') continue;
    const values = searchParams.getAll(key);
    query[key] = values.length === 1 ? values[0] : values;
  }
  return query;
}

/** Add the helpers Vercel gives to functions: res.status(n).json(obj), res.send(body). */
function addResponseHelpers(res) {
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (body) => {
    if (!res.hasHeader('Content-Type')) res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(body));
    return res;
  };
  res.send = (body) => {
    if (body !== null && typeof body === 'object' && !Buffer.isBuffer(body)) return res.json(body);
    if (!res.hasHeader('Content-Type')) res.setHeader('Content-Type', Buffer.isBuffer(body) ? 'application/octet-stream' : 'text/html; charset=utf-8');
    res.end(body);
    return res;
  };
}

async function runApi(name, req, res, url, root, logger) {
  const file = path.join(root, 'api', `${name}.js`);
  let stat;
  try {
    stat = await fsp.stat(file);
  } catch {
    return sendJson(res, 404, { error: 'Not found' });
  }
  if (!stat.isFile()) return sendJson(res, 404, { error: 'Not found' });

  try {
    req.query = parseQuery(url.searchParams);
    const text = await readBody(req);
    if (text !== '' && /\bjson\b/i.test(req.headers['content-type'] || '')) {
      try {
        req.body = JSON.parse(text);
      } catch {
        return sendJson(res, 400, { error: 'Invalid JSON' });
      }
    } else if (text !== '') req.body = text;
    addResponseHelpers(res);
    // The file's change time in the address makes edits reload without restarting the server.
    const mod = await import(`${pathToFileURL(file).href}?v=${stat.mtimeMs}`);
    if (typeof mod.default !== 'function') throw new Error(`api/${name}.js has no default function`);
    await mod.default(req, res);
  } catch (error) {
    if (error?.status === 413) return sendJson(res, 413, { error: 'Request too large' });
    logger(error); // the details stay in this terminal; the browser only gets a generic message
    sendJson(res, 500, { error: 'Server error' });
  }
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}

/** Build the server (it does not listen yet). Options are for the tests: another site folder, a quieter logger. */
export function createServer({ root = ROOT, logger = console.error } = {}) {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');

      if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
        const match = API_PATH.exec(url.pathname);
        if (!match) return sendJson(res, 404, { error: 'Not found' });
        return await runApi(match[1], req, res, url, root, logger);
      }

      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
      const file = resolvePublicFile(url.pathname, root);
      if (!file) return send(res, 404, 'Not found');

      const data = await fsp.readFile(file);
      const type = TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
      send(res, 200, req.method === 'HEAD' ? undefined : data, { 'Content-Type': type });
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'EISDIR') return send(res, 404, 'Not found');
      logger(error);
      send(res, 500, 'Server error');
    }
  });
}

function start() {
  loadEnvFile(path.join(ROOT, '.env')); // before reading PORT, so .env can set it too
  const port = Number(process.env.PORT) || 8000;
  const server = createServer();

  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') console.error(`Port ${port} is already in use. Try another one, for example:  PORT=${port + 1} npm run dev`);
    else console.error(error);
    process.exit(1);
  });

  server.listen(port, () => {
    console.log(`Quantum South Side is running at http://localhost:${port}`);
    console.log('Press Ctrl+C to stop.');
  });
}

// Start only when run with "npm run dev", not when the tests import this file.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) start();
