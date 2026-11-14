/* ==========================================================================
   storage.test.js — tests for js/utils/storage.js, the low-level safe wrapper
   around localStorage. (Progress, streaks and accounts are tested in
   progressStore.test.js.)
   Run with: npm test   (or: node --test tests/storage.test.js)

   Node has no browser, so we hand storage.js a fake window.localStorage.
   ========================================================================== */

import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * Load a fresh copy of storage.js on top of a fake localStorage.
 * Set `memory` entries first to pre-fill it; set `behavior.full = true` to make every save fail (quota full);
 * set `behavior.blocked = true` before loading to make localStorage unusable (private mode).
 */
async function freshStorage({ blocked = false } = {}) {
  const memory = new Map();
  const behavior = { full: false };
  globalThis.window = {
    localStorage: {
      getItem: (key) => {
        if (blocked) throw new Error('SecurityError');
        return memory.has(key) ? memory.get(key) : null;
      },
      setItem: (key, value) => {
        if (blocked || behavior.full) throw new Error('QuotaExceededError');
        memory.set(key, String(value));
      },
      removeItem: (key) => memory.delete(key),
      key: (index) => [...memory.keys()][index] ?? null,
      get length() {
        return memory.size;
      },
    },
  };
  return { storage: await import(`../js/utils/storage.js?fresh=${Math.random()}`), memory, behavior };
}

test('storage: a normal save is written to localStorage and read back', async () => {
  const { storage, memory } = await freshStorage();
  assert.equal(storage.setItem('thing', { a: 1 }), true);
  assert.equal(memory.get('qss:thing'), '{"a":1}');
  assert.deepEqual(storage.getItem('thing'), { a: 1 });
  assert.equal(storage.getItem('missing', 'nope'), 'nope');
});

test('storage: when localStorage is full, new values are still read back for the session', async () => {
  const { storage, behavior } = await freshStorage();
  assert.equal(storage.setItem('thing', 1), true);
  behavior.full = true;
  assert.equal(storage.setItem('thing', 2), false, 'the save reports that it failed');
  assert.equal(storage.getItem('thing'), 2, 'the newer value is read from memory');
  assert.equal(storage.setItem('other', 'x'), false);
  assert.equal(storage.getItem('other'), 'x');
});

test('storage: after a failed save, a later good save takes over again', async () => {
  const { storage, memory, behavior } = await freshStorage();
  storage.setItem('thing', 'first'); // the first save also tests that localStorage works
  behavior.full = true;
  storage.setItem('thing', 'memory only');
  assert.equal(storage.getItem('thing'), 'memory only');
  behavior.full = false;
  assert.equal(storage.setItem('thing', 'saved'), true);
  assert.equal(memory.get('qss:thing'), '"saved"');
  memory.set('qss:thing', '"changed elsewhere"');
  assert.equal(storage.getItem('thing'), 'changed elsewhere', 'the memory copy was dropped, so localStorage is read again');
});

test('storage: when localStorage is blocked, values live in memory and isPersistent says so', async () => {
  const { storage, memory } = await freshStorage({ blocked: true });
  assert.equal(storage.isPersistent(), false);
  storage.setItem('thing', [1, 2]);
  assert.deepEqual(storage.getItem('thing'), [1, 2]);
  assert.equal(memory.size, 0, 'nothing reached localStorage');
  assert.deepEqual(storage.listKeys(''), ['thing']);
});

test('storage: removing a value and clearing also clear the memory copy', async () => {
  const { storage, behavior } = await freshStorage();
  assert.equal(storage.isPersistent(), true); // checked while there is still room
  behavior.full = true;
  storage.setItem('a', 1);
  storage.setItem('b', 2);
  storage.removeItem('a');
  assert.equal(storage.getItem('a'), null);
  storage.clearAll();
  assert.equal(storage.getItem('b'), null);
});

test('storage: clearAll only deletes keys that start with our prefix', async () => {
  const { storage, memory } = await freshStorage();
  storage.setItem('a', 1);
  memory.set('qss-auth', '{"keep":"me"}'); // the sign-in session must survive "Reset my progress"
  memory.set('other-site', 'x');
  storage.clearAll();
  assert.equal(memory.has('qss:a'), false);
  assert.equal(memory.get('qss-auth'), '{"keep":"me"}');
  assert.equal(memory.get('other-site'), 'x');
});

test('storage: corrupt JSON in storage acts like nothing was saved', async () => {
  const { storage, memory } = await freshStorage();
  memory.set('qss:thing', '{not json');
  assert.equal(storage.getItem('thing', 'fallback'), 'fallback');
  assert.equal(storage.setItem('thing', { fixed: true }), true, 'saving over the damage works');
  assert.deepEqual(storage.getItem('thing'), { fixed: true });
});

test('storage: listKeys finds keys by prefix, without our own prefix', async () => {
  const { storage, memory } = await freshStorage();
  storage.setItem('cache:u1', 1);
  storage.setItem('cache:u2', 2);
  storage.setItem('progress', 3);
  memory.set('other-site:cache:x', 'x');
  assert.deepEqual(storage.listKeys('cache:').sort(), ['cache:u1', 'cache:u2']);
  assert.deepEqual(storage.listKeys('').sort(), ['cache:u1', 'cache:u2', 'progress']);
  assert.deepEqual(storage.listKeys('nothing:'), []);
});

test('storage: removeByPrefix deletes only matching keys, also ones held in memory after a failed save', async () => {
  const { storage, behavior } = await freshStorage();
  storage.setItem('cache:u1', 1);
  storage.setItem('progress', 3);
  behavior.full = true;
  storage.setItem('cache:u2', 2); // only reached memory
  storage.removeByPrefix('cache:');
  assert.equal(storage.getItem('cache:u1'), null);
  assert.equal(storage.getItem('cache:u2'), null);
  assert.equal(storage.getItem('progress'), 3);
});
