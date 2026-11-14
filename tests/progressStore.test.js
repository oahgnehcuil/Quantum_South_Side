/* ==========================================================================
   progressStore.test.js — tests for js/services/progressStore.js:
   guest progress (streaks, saving, damaged data), account mode, syncing,
   the guest-merge offer and resetting.
   Run with: npm test   (or: node --test tests/progressStore.test.js)

   Node has no browser, so we hand the store a fake window.localStorage and a
   fake Supabase client that records every call and can fail on demand.
   No real passwords, keys or network are used anywhere.
   ========================================================================== */

import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

import { getDayKey, daysBetween } from '../js/utils/dailySeed.js';
import { emptyProgress } from '../js/services/progressMerge.js';

const sharedStorage = await import('../js/utils/storage.js'); // the one copy every fresh store uses

/**
 * Load a fresh copy of progressStore.js on top of a fake localStorage.
 * `memory` is the fake localStorage (pre-fill it before loading with `seed`);
 * `behavior.full = true` makes every save fail (quota full);
 * `fire(type, event)` plays a browser event (storage, online, pageshow, pagehide).
 */
async function freshStore(seed = {}) {
  const memory = new Map(Object.entries(seed));
  const behavior = { full: false };
  const handlers = {};
  globalThis.window = {
    localStorage: {
      getItem: (key) => (memory.has(key) ? memory.get(key) : null),
      setItem: (key, value) => {
        if (behavior.full) throw new Error('QuotaExceededError');
        memory.set(key, String(value));
      },
      removeItem: (key) => memory.delete(key),
      key: (index) => [...memory.keys()][index] ?? null,
      get length() {
        return memory.size;
      },
    },
    addEventListener: (type, handler) => (handlers[type] ??= []).push(handler),
  };
  const fire = (type, event = {}) => (handlers[type] ?? []).forEach((handler) => handler(event));
  const loaded = new Map(Object.entries(seed));
  sharedStorage.clearAll(); // forget memory-only values left by an earlier test
  memory.clear();
  loaded.forEach((value, key) => memory.set(key, value));
  const store = await import(`../js/services/progressStore.js?fresh=${Math.random()}`);
  return { store, memory, behavior, fire, read: (key) => (memory.has(key) ? JSON.parse(memory.get(key)) : null) };
}

/** A fake Supabase client holding a fake "progress" table. rows: { userId: { key: value } }. */
function fakeSupabase(rows = {}) {
  const fake = {
    db: structuredClone(rows),
    calls: [],
    offline: false, // true: every request fails like a dropped connection (status 0)
    failWith: null, // e.g. 500: every request fails with that status
    hold: null, // a promise: requests wait for it (to test slow replies)
    answer: async () => {
      if (fake.hold) await fake.hold;
      if (fake.offline) return { data: null, error: { message: 'TypeError: Failed to fetch' }, status: 0 };
      if (fake.failWith) return { data: null, error: { message: 'server says no' }, status: fake.failWith };
      return null;
    },
    count: (name) => fake.calls.filter(([call]) => call === name).length,
    from(table) {
      assert.equal(table, 'progress', 'only the progress table is used');
      return {
        select: () => ({
          eq: async (column, userId) => {
            fake.calls.push(['select', userId]);
            const failed = await fake.answer();
            if (failed) return failed;
            const data = Object.entries(fake.db[userId] ?? {}).map(([key, value]) => ({ key, value: structuredClone(value) }));
            return { data, error: null, status: 200 };
          },
        }),
        upsert: async (list, options) => {
          fake.calls.push(['upsert', list.map((row) => row.key), options]);
          const failed = await fake.answer();
          if (failed) return failed;
          for (const row of list) (fake.db[row.user_id] ??= {})[row.key] = structuredClone(row.value);
          return { data: null, error: null, status: 201 };
        },
        delete: () => ({
          eq: async (column, userId) => {
            fake.calls.push(['delete', userId]);
            const failed = await fake.answer();
            if (failed) return failed;
            delete fake.db[userId];
            return { data: null, error: null, status: 204 };
          },
        }),
      };
    },
  };
  return fake;
}

const daily = (dayKey) => ({ dayKey, score: 3, daily: true });
const practice = (dayKey) => ({ dayKey, score: 3, daily: false });
const USER = { id: 'user-a', email: 'a@example.test' };
const OTHER = { id: 'user-b', email: 'b@example.test' };
const quiet = () => new Promise((resolve) => setImmediate(resolve)); // let waiting promises run

// ------------------------------------------------- safe saving (guest)

test('progress: progress still counts while localStorage is full', async () => {
  const { store, behavior } = await freshStore();
  assert.equal(store.isPersistent(), true); // checked while there is still room
  behavior.full = true;
  store.setTopicComplete('intro');
  store.recordGameResult(daily('2026-11-14'));
  assert.deepEqual(store.getCompletedTopics(), ['intro']);
  assert.equal(store.getGameStats().played, 1);
  assert.equal(store.getCurrentStreak('2026-11-14'), 1);
});

test('progress: resetting clears the memory copy too, even when saving failed', async () => {
  const { store, behavior } = await freshStore();
  assert.equal(store.isPersistent(), true);
  behavior.full = true;
  store.setTopicComplete('intro');
  store.setFlag('someFlag', 1);
  store.resetProgress();
  assert.deepEqual(store.getCompletedTopics(), []);
  assert.equal(store.getFlag('someFlag'), null);
});

test('progress: corrupt JSON in storage acts like nothing was saved', async () => {
  const { store, memory } = await freshStore({ 'qss:progress': '{broken' });
  assert.deepEqual(store.getCompletedTopics(), []);
  assert.equal(store.getGameStats().played, 0);
  store.setTopicComplete('gates');
  assert.deepEqual(store.getCompletedTopics(), ['gates'], 'saving over the damage works');
  assert.match(memory.get('qss:progress'), /gates/);
});

test('progress: the saved shape is read fresh each time, so another tab or an old save is noticed', async () => {
  const { store, memory } = await freshStore();
  assert.deepEqual(store.getProgressSummary().confidence, { before: null, after: null });
  memory.set('qss:progress', JSON.stringify({ topicsCompleted: ['intro'], confidence: { before: 3 } }));
  assert.deepEqual(store.getCompletedTopics(), ['intro']);
  assert.equal(store.getConfidence().before, 3);
});

test('progress: what you read is a copy, so changing it never changes what is saved', async () => {
  const { store } = await freshStore();
  store.setTopicComplete('intro');
  const list = store.getCompletedTopics();
  list.push('hacked');
  store.getGameStats().played = 99;
  store.getConfidence().before = 5;
  assert.deepEqual(store.getCompletedTopics(), ['intro']);
  assert.equal(store.getGameStats().played, 0);
  assert.equal(store.getConfidence().before, null);
});

test('progress: the old fields still work, and damaged saved data is repaired', async () => {
  const { store, memory } = await freshStore();
  const summary = store.getProgressSummary();
  for (const field of ['topicsCompleted', 'totalTopics', 'quizzesPassed', 'gamesPlayed', 'streak', 'bestStreak', 'bestScore', 'totalStars', 'playedToday', 'confidence']) {
    assert.ok(field in summary, `summary.${field} is there`);
  }
  memory.set('qss:progress', JSON.stringify({ game: { solved: { 3: 2, 4: 9, 5: 'x' }, lastDaily: { dayKey: 'nope' } } }));
  assert.deepEqual(store.getGameStats().solved, { 3: 2 });
  assert.equal(store.getGameStats().lastDaily, null);
  assert.equal(store.getTotalStars(), 2);
});

test('progress: topics, quizzes and confidence behave as before', async () => {
  const { store } = await freshStore();
  assert.deepEqual(store.setTopicComplete('intro'), ['intro']);
  assert.deepEqual(store.setTopicComplete('gates'), ['intro', 'gates']);
  assert.deepEqual(store.setTopicComplete('intro', false), ['gates']);
  assert.equal(store.isTopicComplete('gates'), true);
  assert.equal(store.isTopicComplete('intro'), false);
  assert.deepEqual(store.recordQuizResult('gates', 1, 3), { best: 1, passed: false, newlyPassed: false });
  assert.deepEqual(store.recordQuizResult('gates', 3, 3), { best: 3, passed: true, newlyPassed: true });
  assert.deepEqual(store.recordQuizResult('gates', 2, 3), { best: 3, passed: true, newlyPassed: false }, 'the best score is kept');
  assert.equal(store.getQuizBest('gates'), 3);
  assert.equal(store.getQuizBest('intro'), null);
  assert.equal(store.getQuizzesPassed(), 1);
  assert.deepEqual(store.setConfidence('before', 4), { before: 4, after: null });
  assert.deepEqual(store.setConfidence('before', 9), { before: 4, after: null }, 'a bad rating is ignored');
  assert.deepEqual(store.setConfidence('nope', 2), { before: 4, after: null });
  assert.deepEqual(store.setConfidence('before', null), { before: null, after: null });
  const summary = store.getProgressSummary();
  assert.equal(summary.topicsCompleted, 1);
  assert.equal(summary.quizzesPassed, 1);
});

// ------------------------------------------------- streaks

test('streak: two days in a row make a streak of 2 and best streak 2', async () => {
  const { store } = await freshStore();
  store.recordGameResult(daily('2026-11-14'));
  assert.equal(store.getGameStats().streak, 1);
  store.recordGameResult(daily('2026-11-15'));
  assert.equal(store.getGameStats().streak, 2);
  assert.equal(store.getGameStats().bestStreak, 2);
  assert.equal(store.getGameStats().lastDay, '2026-11-15');
});

test('streak: a missed day starts over at 1 but keeps the best streak', async () => {
  const { store } = await freshStore();
  store.recordGameResult(daily('2026-11-14'));
  store.recordGameResult(daily('2026-11-15'));
  store.recordGameResult(daily('2026-11-17')); // skipped the 16th
  const stats = store.getGameStats();
  assert.equal(stats.streak, 1);
  assert.equal(stats.bestStreak, 2);
  assert.equal(stats.lastDay, '2026-11-17');
});

test('streak: getCurrentStreak shows the streak until a day is skipped, then 0', async () => {
  const { store } = await freshStore();
  store.recordGameResult(daily('2026-11-14'));
  store.recordGameResult(daily('2026-11-15'));
  assert.equal(store.getCurrentStreak('2026-11-15'), 2, 'played today');
  assert.equal(store.getCurrentStreak('2026-11-16'), 2, 'next day: still alive');
  assert.equal(store.getCurrentStreak('2026-11-17'), 0, 'skipped a day: gone');
  assert.equal(store.getGameStats().streak, 2, 'the saved number stays until the next win');
});

test('streak: a first day with only practice leaves the streak at 0 and lastDay empty', async () => {
  const { store } = await freshStore();
  store.recordGameResult({ ...practice('2026-11-14'), puzzleId: 3, stars: 2 });
  const stats = store.getGameStats();
  assert.equal(stats.played, 1);
  assert.equal(stats.streak, 0);
  assert.equal(stats.bestStreak, 0);
  assert.equal(stats.lastDay, null);
  assert.equal(store.hasPlayedToday('2026-11-14'), false);
  assert.equal(store.getCurrentStreak('2026-11-14'), 0);
});

test('streak: practice on a new day does not start or extend the streak', async () => {
  const { store } = await freshStore();
  store.recordGameResult(daily('2026-11-14'));
  store.recordGameResult(practice('2026-11-15'));
  assert.equal(store.getGameStats().streak, 1);
  assert.equal(store.getGameStats().lastDay, '2026-11-14');
});

test('streak: a second daily on the same day changes nothing about the streak', async () => {
  const { store } = await freshStore();
  store.recordGameResult({ ...daily('2026-11-14'), puzzleId: 4, stars: 3, gatesUsed: 2 });
  store.recordGameResult({ ...daily('2026-11-14'), puzzleId: 5, stars: 1, gatesUsed: 6 });
  const stats = store.getGameStats();
  assert.equal(stats.streak, 1);
  assert.equal(stats.bestStreak, 1);
  assert.equal(stats.played, 2);
  assert.equal(stats.lastDaily.puzzleId, 4, "today's saved result is the first one");
});

test('streak: perfect games are counted', async () => {
  const { store } = await freshStore();
  store.recordGameResult({ ...daily('2026-11-14'), perfect: true });
  store.recordGameResult({ ...practice('2026-11-14'), perfect: false });
  store.recordGameResult({ ...practice('2026-11-14'), perfect: true });
  assert.equal(store.getGameStats().perfect, 2);
});

test('streak: a streak keeps going across the fall-back day', async () => {
  const { store } = await freshStore();
  store.recordGameResult(daily('2026-10-31'));
  store.recordGameResult(daily('2026-11-01'));
  store.recordGameResult(daily('2026-11-02'));
  assert.equal(store.getGameStats().streak, 3);
});

// ------------------------------------------------- Chicago day rollover

test('getDayKey: the day changes at midnight Chicago time (CST, UTC-6)', () => {
  assert.equal(getDayKey(new Date('2026-11-14T05:59:59Z')), '2026-11-13');
  assert.equal(getDayKey(new Date('2026-11-14T06:00:00Z')), '2026-11-14');
});

test('getDayKey: summer time (CDT, UTC-5) moves the rollover one hour earlier', () => {
  assert.equal(getDayKey(new Date('2026-07-04T04:59:59Z')), '2026-07-03');
  assert.equal(getDayKey(new Date('2026-07-04T05:00:00Z')), '2026-07-04');
});

test('getDayKey: spring forward (2026-03-08) switches from CST to CDT at midnight edges', () => {
  assert.equal(getDayKey(new Date('2026-03-08T05:59:59Z')), '2026-03-07');
  assert.equal(getDayKey(new Date('2026-03-08T06:00:00Z')), '2026-03-08');
  assert.equal(getDayKey(new Date('2026-03-08T07:59:59Z')), '2026-03-08', 'just before the clock jumps');
  assert.equal(getDayKey(new Date('2026-03-08T08:00:00Z')), '2026-03-08', 'just after the clock jumps');
  assert.equal(getDayKey(new Date('2026-03-09T04:59:59Z')), '2026-03-08', 'this day is only 23 hours long');
  assert.equal(getDayKey(new Date('2026-03-09T05:00:00Z')), '2026-03-09');
});

test('getDayKey: fall back (2026-11-01) switches from CDT to CST at midnight edges', () => {
  assert.equal(getDayKey(new Date('2026-11-01T04:59:59Z')), '2026-10-31');
  assert.equal(getDayKey(new Date('2026-11-01T05:00:00Z')), '2026-11-01');
  assert.equal(getDayKey(new Date('2026-11-01T06:59:59Z')), '2026-11-01', 'the 1 AM hour happens twice');
  assert.equal(getDayKey(new Date('2026-11-02T05:59:59Z')), '2026-11-01', 'this day is 25 hours long');
  assert.equal(getDayKey(new Date('2026-11-02T06:00:00Z')), '2026-11-02');
});

test('daysBetween: counts whole calendar days, also across the clock changes', () => {
  assert.equal(daysBetween('2026-11-14', '2026-11-14'), 0);
  assert.equal(daysBetween('2026-11-14', '2026-11-15'), 1);
  assert.equal(daysBetween('2026-11-15', '2026-11-14'), -1);
  assert.equal(daysBetween('2026-10-31', '2026-11-01'), 1);
  assert.equal(daysBetween('2026-11-01', '2026-11-02'), 1);
  assert.equal(daysBetween('2026-10-31', '2026-11-02'), 2);
  assert.equal(daysBetween('2026-03-07', '2026-03-09'), 2);
  assert.equal(daysBetween('2026-12-31', '2027-01-01'), 1);
});

// ------------------------------------------------- guest mode: nothing leaves the device

test('guest: the default mode is guest, idle, and no server is ever needed', async () => {
  const { store, memory } = await freshStore();
  assert.equal(store.getMode(), 'guest');
  assert.deepEqual(store.getSyncStatus(), { mode: 'guest', state: 'idle', lastSyncedAt: null });
  store.setTopicComplete('intro');
  await store.flushPending(); // nothing to flush, and nothing breaks
  assert.deepEqual([...memory.keys()], ['qss:progress'], 'guest progress lives under the one old key');
});

test('guest: connectAccount ignores missing users or clients instead of throwing', async () => {
  const { store } = await freshStore();
  await store.connectAccount(null, fakeSupabase());
  await store.connectAccount({ id: '' }, fakeSupabase());
  await store.connectAccount(USER, null);
  assert.equal(store.getMode(), 'guest');
});

// ------------------------------------------------- subscribe

test('subscribe: listeners hear "local" after a change, and can stop listening', async () => {
  const { store } = await freshStore();
  const heard = [];
  const stop = store.subscribe((kind) => heard.push(kind));
  store.setTopicComplete('intro');
  store.recordQuizResult('intro', 3);
  assert.deepEqual(heard, ['local', 'local']);
  stop();
  store.setTopicComplete('gates');
  assert.equal(heard.length, 2);
});

test('subscribe: a change that changes nothing is not announced', async () => {
  const { store } = await freshStore();
  store.setTopicComplete('intro');
  const heard = [];
  store.subscribe((kind) => heard.push(kind));
  store.setTopicComplete('intro');
  store.setConfidence('before', null);
  store.recordQuizResult('gates', 0, 3); // best score 0 is still a change the first time
  assert.deepEqual(heard, ['local']);
});

test('subscribe: a listener that throws does not stop the others or break saving', async () => {
  const { store } = await freshStore();
  const heard = [];
  store.subscribe(() => {
    throw new Error('bad listener');
  });
  store.subscribe((kind) => heard.push(kind));
  assert.doesNotThrow(() => store.setTopicComplete('intro'));
  assert.deepEqual(heard, ['local']);
  assert.deepEqual(store.getCompletedTopics(), ['intro']);
  assert.equal(typeof store.subscribe('not a function'), 'function', 'a bad listener gives back a harmless stop function');
});

// ------------------------------------------------- account mode: start-up from the marker and cache

test('account: a returning signed-in visitor sees the cached progress instantly', async () => {
  const cache = { progress: { topicsCompleted: ['intro'], game: { played: 2 } } };
  const { store } = await freshStore({ 'qss:account': JSON.stringify({ userId: 'user-a' }), 'qss:cache:user-a': JSON.stringify(cache) });
  assert.equal(store.getMode(), 'account');
  assert.deepEqual(store.getCompletedTopics(), ['intro']);
  assert.equal(store.getGameStats().played, 2);
  assert.equal(store.getSyncStatus().mode, 'account');
});

test('account: in account mode changes go to the user\'s cache, never to the guest key', async () => {
  const guest = { topicsCompleted: ['gates'] };
  const { store, read } = await freshStore({ 'qss:account': JSON.stringify({ userId: 'user-a' }), 'qss:progress': JSON.stringify(guest) });
  assert.deepEqual(store.getCompletedTopics(), [], 'the guest data is not shown to the account');
  store.setTopicComplete('intro');
  assert.deepEqual(read('qss:cache:user-a').progress.topicsCompleted, ['intro']);
  assert.deepEqual(read('qss:progress'), guest, 'guest data is untouched');
});

test('account: a damaged marker or cache falls back safely', async () => {
  for (const seed of [
    { 'qss:account': '{broken' },
    { 'qss:account': JSON.stringify({ userId: 42 }) },
    { 'qss:account': JSON.stringify(null) },
  ]) {
    const { store } = await freshStore(seed);
    assert.equal(store.getMode(), 'guest');
  }
  const { store } = await freshStore({ 'qss:account': JSON.stringify({ userId: 'u' }), 'qss:cache:u': '{broken' });
  assert.equal(store.getMode(), 'account');
  assert.deepEqual(store.getProgressSummary().confidence, { before: null, after: null });
  assert.deepEqual(store.getCompletedTopics(), []);
  store.setTopicComplete('intro');
  assert.deepEqual(store.getCompletedTopics(), ['intro']);
  const { store: store2 } = await freshStore({ 'qss:account': JSON.stringify({ userId: 'u' }), 'qss:cache:u': JSON.stringify({ progress: 'junk', pendingReset: 'yes' }) });
  assert.deepEqual(store2.getCompletedTopics(), []);
});

// ------------------------------------------------- connectAccount: pull, merge, push

test('connect: switches to account mode, saves the marker, pulls, merges and pushes the differences', async () => {
  const { store, read, memory } = await freshStore({ 'qss:progress': JSON.stringify({ topicsCompleted: ['gates'] }) });
  const server = fakeSupabase({ 'user-a': { topicsCompleted: ['intro'], quizBest: { intro: 3 } } });
  const heard = [];
  store.subscribe((kind) => heard.push(kind));
  await store.connectAccount(USER, server);
  assert.equal(store.getMode(), 'account');
  assert.deepEqual(read('qss:account'), { userId: 'user-a' });
  assert.deepEqual(store.getCompletedTopics(), ['intro'], 'the guest store is NOT merged by connecting');
  assert.equal(store.getQuizBest('intro'), 3, 'server data arrived');
  assert.deepEqual(heard, ['mode', 'remote']);
  assert.equal(server.count('select'), 1);
  assert.equal(server.count('upsert'), 0, 'nothing to push when the server already matches');
  assert.equal(store.getSyncStatus().state, 'idle');
  assert.equal(typeof store.getSyncStatus().lastSyncedAt, 'number');
  assert.ok(memory.has('qss:cache:user-a'));
});

test('connect: cached progress that the server lacks is pushed after the merge', async () => {
  const cache = { progress: { topicsCompleted: ['gates'], game: { played: 2, bestScore: 2 } } };
  const { store } = await freshStore({ 'qss:account': JSON.stringify({ userId: 'user-a' }), 'qss:cache:user-a': JSON.stringify(cache) });
  const server = fakeSupabase({ 'user-a': { topicsCompleted: ['intro'] } });
  await store.connectAccount(USER, server);
  assert.deepEqual([...store.getCompletedTopics()].sort(), ['gates', 'intro']);
  assert.deepEqual(Object.keys(server.db['user-a']).sort(), ['game', 'topicsCompleted']);
  assert.deepEqual([...server.db['user-a'].topicsCompleted].sort(), ['gates', 'intro']);
  assert.equal(server.db['user-a'].game.played, 2);
  const [, keys, options] = server.calls.find(([name]) => name === 'upsert');
  assert.deepEqual(keys.sort(), ['game', 'topicsCompleted'], 'only the differences are sent');
  assert.deepEqual(options, { onConflict: 'user_id,key' });
});

test('connect: a brand-new account with no progress creates no server rows', async () => {
  const { store } = await freshStore();
  const server = fakeSupabase();
  await store.connectAccount(USER, server);
  assert.equal(server.count('upsert'), 0);
  assert.deepEqual(server.db, {});
});

test('connect: calling it again and again is safe and does not pull again', async () => {
  const { store } = await freshStore();
  const server = fakeSupabase({ 'user-a': { topicsCompleted: ['intro'] } });
  const heard = [];
  store.subscribe((kind) => heard.push(kind));
  await Promise.all([store.connectAccount(USER, server), store.connectAccount(USER, server), store.connectAccount(USER, server)]);
  await store.connectAccount(USER, server);
  assert.equal(server.count('select'), 1, 'one pull no matter how many calls');
  assert.equal(heard.filter((kind) => kind === 'mode').length, 1);
  assert.deepEqual(store.getCompletedTopics(), ['intro']);
});

test('connect: a returning visitor (marker + cache) does not flash: no mode change, no events when the server agrees', async () => {
  const cache = { progress: { topicsCompleted: ['intro'] } };
  const { store } = await freshStore({ 'qss:account': JSON.stringify({ userId: 'user-a' }), 'qss:cache:user-a': JSON.stringify(cache) });
  const server = fakeSupabase({ 'user-a': { topicsCompleted: ['intro'] } });
  const heard = [];
  store.subscribe((kind) => heard.push(kind));
  await store.connectAccount(USER, server);
  assert.deepEqual(heard, []);
});

test('connect: changes made while the server answers slowly are not lost', async () => {
  const { store } = await freshStore();
  const server = fakeSupabase({ 'user-a': { topicsCompleted: ['intro'] } });
  let release;
  server.hold = new Promise((resolve) => (release = resolve));
  const connecting = store.connectAccount(USER, server);
  await quiet();
  store.setTopicComplete('gates'); // the learner clicks while we wait
  release();
  await connecting;
  assert.deepEqual([...store.getCompletedTopics()].sort(), ['gates', 'intro']);
  assert.deepEqual([...server.db['user-a'].topicsCompleted].sort(), ['gates', 'intro']);
});

// ------------------------------------------------- saving in the background

test('sync: changes are saved about one second later, in one request', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const { store } = await freshStore();
    const server = fakeSupabase();
    await store.connectAccount(USER, server);
    store.setTopicComplete('intro');
    store.setTopicComplete('gates');
    store.recordQuizResult('intro', 3);
    assert.equal(server.count('upsert'), 0, 'not yet');
    mock.timers.tick(999);
    assert.equal(server.count('upsert'), 0, 'still waiting');
    mock.timers.tick(1);
    await store.flushPending();
    assert.equal(server.count('upsert'), 1, 'one request for all three changes');
    assert.deepEqual(server.db['user-a'].topicsCompleted, ['intro', 'gates']);
    assert.deepEqual(server.db['user-a'].quizBest, { intro: 3 });
  } finally {
    mock.timers.reset();
  }
});

test('sync: flushPending sends waiting changes right away', async () => {
  const { store } = await freshStore();
  const server = fakeSupabase();
  await store.connectAccount(USER, server);
  store.setConfidence('before', 2);
  await store.flushPending();
  assert.deepEqual(server.db['user-a'].confidence, { before: 2, after: null });
  assert.equal(store.getSyncStatus().state, 'idle');
});

test('sync: unmarking a topic is saved too (the server list shrinks)', async () => {
  const { store } = await freshStore();
  const server = fakeSupabase();
  await store.connectAccount(USER, server);
  store.setTopicComplete('intro');
  store.setTopicComplete('gates');
  await store.flushPending();
  store.setTopicComplete('intro', false);
  await store.flushPending();
  assert.deepEqual(server.db['user-a'].topicsCompleted, ['gates']);
});

test('sync: offline at connect shows "offline", keeps working, and the "online" event retries', async () => {
  const { store, fire } = await freshStore();
  const server = fakeSupabase({ 'user-a': { topicsCompleted: ['intro'] } });
  server.offline = true;
  await store.connectAccount(USER, server); // never throws
  assert.equal(store.getSyncStatus().state, 'offline');
  assert.equal(store.getSyncStatus().lastSyncedAt, null);
  store.setTopicComplete('gates'); // still works locally
  assert.deepEqual(store.getCompletedTopics(), ['gates']);
  server.offline = false;
  fire('online');
  await store.flushPending();
  assert.equal(store.getSyncStatus().state, 'idle');
  assert.deepEqual([...store.getCompletedTopics()].sort(), ['gates', 'intro'], 'merged once the connection came back');
  assert.deepEqual([...server.db['user-a'].topicsCompleted].sort(), ['gates', 'intro']);
});

test('sync: a server error shows "error", and the next change tries again', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const { store } = await freshStore();
    const server = fakeSupabase();
    await store.connectAccount(USER, server);
    server.failWith = 500;
    store.setTopicComplete('intro');
    mock.timers.tick(1000);
    await store.flushPending();
    assert.equal(store.getSyncStatus().state, 'error');
    server.failWith = null;
    store.setTopicComplete('gates');
    mock.timers.tick(1000);
    await store.flushPending();
    assert.equal(store.getSyncStatus().state, 'idle');
    assert.deepEqual(server.db['user-a'].topicsCompleted, ['intro', 'gates'], 'both changes arrived');
  } finally {
    mock.timers.reset();
  }
});

test('sync: a client that throws never throws into page code', async () => {
  const { store } = await freshStore();
  const broken = { from: () => { throw new Error('boom'); } };
  await assert.doesNotReject(store.connectAccount(USER, broken));
  assert.equal(store.getSyncStatus().state, 'error');
  assert.doesNotThrow(() => store.setTopicComplete('intro'));
  assert.equal(store.isTopicComplete('intro'), true);
});

test('sync: leaving the page sends pending changes at once', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const { store, fire } = await freshStore();
    const server = fakeSupabase();
    await store.connectAccount(USER, server);
    store.setTopicComplete('intro');
    fire('pagehide');
    await store.flushPending();
    assert.deepEqual(server.db['user-a'].topicsCompleted, ['intro']);
  } finally {
    mock.timers.reset();
  }
});

// ------------------------------------------------- disconnect: nothing stays behind

test('disconnect: deletes the account cache and the marker and returns to the guest store', async () => {
  const { store, memory } = await freshStore({ 'qss:progress': JSON.stringify({ topicsCompleted: ['gates'] }) });
  const server = fakeSupabase();
  await store.connectAccount(USER, server);
  store.setTopicComplete('intro');
  assert.ok(memory.has('qss:cache:user-a'));
  const heard = [];
  store.subscribe((kind) => heard.push(kind));
  store.disconnectAccount();
  assert.equal(memory.has('qss:cache:user-a'), false, 'the account cache is gone (shared computers!)');
  assert.equal(memory.has('qss:account'), false);
  assert.equal(store.getMode(), 'guest');
  assert.deepEqual(store.getCompletedTopics(), ['gates'], 'the guest progress is back');
  assert.deepEqual(heard, ['mode']);
  assert.deepEqual(store.getSyncStatus(), { mode: 'guest', state: 'idle', lastSyncedAt: null });
});

test('disconnect: no stray cache of any user is left, and it is safe as a guest', async () => {
  const { store, memory } = await freshStore({ 'qss:cache:ghost': '{}', 'qss:cache:other': '{}', 'qss:progress': '{}' });
  const heard = [];
  store.subscribe((kind) => heard.push(kind));
  store.disconnectAccount();
  store.disconnectAccount();
  assert.deepEqual([...memory.keys()], ['qss:progress']);
  assert.deepEqual(heard, [], 'nothing changed for a guest');
});

test('disconnect: a slow reply that arrives AFTER sign-out cannot bring the cache back', async () => {
  const { store, memory } = await freshStore();
  const server = fakeSupabase({ 'user-a': { topicsCompleted: ['intro'] } });
  let release;
  server.hold = new Promise((resolve) => (release = resolve));
  const connecting = store.connectAccount(USER, server);
  await quiet();
  store.disconnectAccount();
  release();
  await connecting;
  await quiet();
  assert.equal(memory.has('qss:cache:user-a'), false);
  assert.equal(memory.has('qss:account'), false);
  assert.equal(store.getMode(), 'guest');
  assert.deepEqual(store.getCompletedTopics(), [], "the account's progress never leaks into the guest store");
  assert.equal(server.count('upsert'), 0);
});

test('disconnect: after sign-out, changes are guest changes and are never sent', async () => {
  const { store } = await freshStore();
  const server = fakeSupabase();
  await store.connectAccount(USER, server);
  store.disconnectAccount();
  store.setTopicComplete('intro');
  await store.flushPending();
  assert.equal(server.count('upsert'), 0);
  assert.deepEqual(server.db, {});
});

test('connect: signing in as someone else deletes the first person\'s cache and data stays apart', async () => {
  const { store, memory } = await freshStore();
  const server = fakeSupabase({ 'user-b': { topicsCompleted: ['computing'] } });
  await store.connectAccount(USER, server);
  store.setTopicComplete('intro');
  await store.connectAccount(OTHER, server);
  assert.equal(memory.has('qss:cache:user-a'), false);
  assert.ok(memory.has('qss:cache:user-b'));
  assert.deepEqual(store.getCompletedTopics(), ['computing'], 'user B does not see user A\'s progress');
  assert.equal(server.db['user-b'].topicsCompleted.includes('intro'), false);
});

test('connect: leftover caches of other people are removed when somebody signs in', async () => {
  const { store, memory } = await freshStore({ 'qss:cache:ghost': '{}' });
  await store.connectAccount(USER, fakeSupabase());
  assert.equal(memory.has('qss:cache:ghost'), false);
});

// ------------------------------------------------- the guest merge offer

const GUEST_DATA = {
  topicsCompleted: ['intro', 'gates', 'not-a-topic'],
  quizBest: { intro: 3, gates: 1 },
  confidence: { before: 2, after: 4 },
  game: { played: 5, bestStreak: 3, solved: { 1: 3, 2: 2 } },
};

test('merge offer: no guest data means no summary and no offer', async () => {
  const { store } = await freshStore();
  assert.equal(store.getGuestProgressSummary(), null);
  assert.equal(store.shouldOfferGuestMerge('user-a'), false);
});

test('merge offer: the summary describes the guest data', async () => {
  const { store } = await freshStore({ 'qss:progress': JSON.stringify(GUEST_DATA) });
  assert.deepEqual(store.getGuestProgressSummary(), { topicsCompleted: 2, quizzesPassed: 1, gamesPlayed: 5, bestStreak: 3, totalStars: 5, confidenceSet: 2 });
  assert.equal(store.shouldOfferGuestMerge('user-a'), true);
  assert.equal(store.shouldOfferGuestMerge(''), false);
  assert.equal(store.shouldOfferGuestMerge(undefined), false);
});

test('merge offer: the summary still works in account mode (the guest data waits on the device)', async () => {
  const { store } = await freshStore({ 'qss:progress': JSON.stringify(GUEST_DATA) });
  await store.connectAccount(USER, fakeSupabase());
  assert.equal(store.getGuestProgressSummary().gamesPlayed, 5);
  assert.equal(store.shouldOfferGuestMerge('user-a'), true);
});

test('merge offer: "No thanks" is remembered per user and keeps the guest data', async () => {
  const { store, read } = await freshStore({ 'qss:progress': JSON.stringify(GUEST_DATA) });
  await store.connectAccount(USER, fakeSupabase());
  store.dismissGuestMergeOffer();
  assert.equal(store.shouldOfferGuestMerge('user-a'), false, 'never asked again');
  assert.equal(store.shouldOfferGuestMerge('user-b'), true, 'another person on the same device is still asked');
  assert.deepEqual(read('qss:progress').topicsCompleted, GUEST_DATA.topicsCompleted, 'guest data kept as is');
  store.disconnectAccount();
  assert.equal(store.shouldOfferGuestMerge('user-a'), false, 'the decision survives signing out');
  assert.equal(store.getGuestProgressSummary().gamesPlayed, 5);
});

test('merge offer: dismissing as a guest does nothing', async () => {
  const { store } = await freshStore({ 'qss:progress': JSON.stringify(GUEST_DATA) });
  store.dismissGuestMergeOffer();
  assert.equal(store.shouldOfferGuestMerge('user-a'), true);
});

test('merge: "Yes" merges guest data into the account, pushes it, clears the guest data and never asks again', async () => {
  const { store, memory, read } = await freshStore({ 'qss:progress': JSON.stringify(GUEST_DATA) });
  const server = fakeSupabase({ 'user-a': { topicsCompleted: ['computing'], confidence: { before: 5, after: null }, quizBest: { gates: 3 } } });
  await store.connectAccount(USER, server);
  assert.equal(await store.mergeGuestIntoAccount(), true);
  assert.deepEqual([...store.getCompletedTopics()].sort(), ['computing', 'gates', 'intro', 'not-a-topic']);
  assert.equal(store.getQuizBest('gates'), 3, 'the better score wins');
  assert.deepEqual(store.getConfidence(), { before: 5, after: 4 }, 'the account rating wins where both exist');
  assert.equal(store.getGameStats().played, 5);
  assert.equal(server.db['user-a'].game.played, 5, 'pushed to the server');
  assert.equal(memory.has('qss:progress'), false, 'the guest data is cleared');
  assert.equal(read('qss:merge:user-a'), 'merged');
  assert.equal(store.getGuestProgressSummary(), null);
  assert.equal(store.shouldOfferGuestMerge('user-a'), false);
});

test('merge: merging twice changes nothing', async () => {
  const { store } = await freshStore({ 'qss:progress': JSON.stringify(GUEST_DATA) });
  const server = fakeSupabase();
  await store.connectAccount(USER, server);
  await store.mergeGuestIntoAccount();
  const before = JSON.stringify(server.db);
  assert.equal(await store.mergeGuestIntoAccount(), true);
  assert.equal(JSON.stringify(server.db), before);
});

test('merge: if the server cannot be reached, the guest data is KEPT and the answer is false', async () => {
  const { store, memory } = await freshStore({ 'qss:progress': JSON.stringify(GUEST_DATA) });
  const server = fakeSupabase();
  await store.connectAccount(USER, server);
  server.offline = true;
  assert.equal(await store.mergeGuestIntoAccount(), false);
  assert.ok(memory.has('qss:progress'), 'guest data is not deleted before the server has it');
  assert.equal(store.shouldOfferGuestMerge('user-a'), true, 'the offer comes back');
  assert.equal(store.getGameStats().played, 5, 'but the account copy on this device already has it');
  server.offline = false;
  assert.equal(await store.mergeGuestIntoAccount(), true);
  assert.equal(memory.has('qss:progress'), false);
});

test('merge: without an account it does nothing', async () => {
  const { store, memory } = await freshStore({ 'qss:progress': JSON.stringify(GUEST_DATA) });
  assert.equal(await store.mergeGuestIntoAccount(), false);
  assert.ok(memory.has('qss:progress'));
});

test('merge: signed in but not connected yet (cache only) keeps the guest data', async () => {
  const { store, memory } = await freshStore({ 'qss:account': JSON.stringify({ userId: 'user-a' }), 'qss:progress': JSON.stringify(GUEST_DATA) });
  assert.equal(await store.mergeGuestIntoAccount(), false);
  assert.ok(memory.has('qss:progress'));
});

// ------------------------------------------------- reset

test('reset (guest): wipes everything this site saved and tells the pages', async () => {
  const { store, memory } = await freshStore();
  store.setTopicComplete('intro');
  store.recordGameResult(daily('2026-11-14'));
  store.setFlag('gameHelpSeen', true);
  memory.set('qss-auth', '{"session":"keep"}');
  const heard = [];
  store.subscribe((kind) => heard.push(kind));
  store.resetProgress();
  assert.deepEqual(store.getCompletedTopics(), []);
  assert.equal(store.getGameStats().played, 0);
  assert.equal(store.getFlag('gameHelpSeen'), null);
  assert.deepEqual(heard, ['local']);
  assert.equal(memory.get('qss-auth'), '{"session":"keep"}', 'resetting progress never signs anybody out');
});

test('reset (account): clears the account progress here AND deletes the server rows; guest data and the marker stay', async () => {
  const { store, memory, read } = await freshStore({ 'qss:progress': JSON.stringify({ topicsCompleted: ['gates'] }) });
  const server = fakeSupabase({ 'user-a': { topicsCompleted: ['intro'], game: { played: 3 } } });
  await store.connectAccount(USER, server);
  store.resetProgress();
  await store.flushPending();
  assert.deepEqual(store.getCompletedTopics(), []);
  assert.equal(store.getGameStats().played, 0);
  assert.deepEqual(server.db, {}, 'the server rows are gone');
  assert.equal(server.count('delete'), 1);
  assert.equal(store.getMode(), 'account');
  assert.deepEqual(read('qss:account'), { userId: 'user-a' });
  assert.deepEqual(read('qss:progress').topicsCompleted, ['gates'], 'guest data is not part of the account');
  assert.equal(read('qss:cache:user-a').pendingReset, false);
  assert.equal(store.getSyncStatus().state, 'idle');
  assert.ok(memory.has('qss:cache:user-a'));
});

test('reset (account): new progress after a reset is saved normally', async () => {
  const { store } = await freshStore();
  const server = fakeSupabase({ 'user-a': { topicsCompleted: ['intro'] } });
  await store.connectAccount(USER, server);
  store.resetProgress();
  store.setTopicComplete('gates');
  await store.flushPending();
  assert.deepEqual(server.db['user-a'].topicsCompleted, ['gates']);
});

test('reset (account): if offline, it is remembered and the old server data does NOT come back later', async () => {
  const { store, read } = await freshStore();
  const server = fakeSupabase({ 'user-a': { topicsCompleted: ['intro'] } });
  await store.connectAccount(USER, server);
  server.offline = true;
  store.resetProgress();
  await store.flushPending();
  assert.equal(store.getSyncStatus().state, 'offline');
  assert.equal(read('qss:cache:user-a').pendingReset, true, 'saved on this device so a reload cannot forget it');

  // The learner reloads the page while still holding the pending reset.
  const reloaded = await freshStore({ 'qss:account': JSON.stringify({ userId: 'user-a' }), 'qss:cache:user-a': JSON.stringify(read('qss:cache:user-a')) });
  server.offline = false;
  await reloaded.store.connectAccount(USER, server);
  assert.deepEqual(server.db, {}, 'rows deleted first');
  assert.deepEqual(reloaded.store.getCompletedTopics(), [], 'nothing was merged back from the old rows');
  assert.equal(reloaded.read('qss:cache:user-a').pendingReset, false);
  assert.equal(server.count('select'), 1);
});

test('reset (account): a reset pressed while the server is still being read wins', async () => {
  const { store } = await freshStore();
  const server = fakeSupabase({ 'user-a': { topicsCompleted: ['intro'] } });
  let release;
  server.hold = new Promise((resolve) => (release = resolve));
  const connecting = store.connectAccount(USER, server);
  await quiet();
  store.resetProgress();
  server.hold = null;
  release();
  await connecting;
  await store.flushPending();
  assert.deepEqual(store.getCompletedTopics(), [], 'the old rows were not merged back in');
  assert.deepEqual(server.db, {});
});

// ------------------------------------------------- other tabs

test('other tabs: a change in another tab is noticed ("local") and unrelated keys are ignored', async () => {
  const { store, memory, fire } = await freshStore();
  const heard = [];
  store.subscribe((kind) => heard.push(kind));
  memory.set('qss:progress', JSON.stringify({ topicsCompleted: ['intro'] }));
  fire('storage', { key: 'qss:progress' });
  assert.deepEqual(heard, ['local']);
  assert.deepEqual(store.getCompletedTopics(), ['intro']);
  fire('storage', { key: 'someone-elses-key' });
  fire('storage', { key: 'qss:progress' }); // same data again
  assert.deepEqual(heard, ['local']);
});

test('other tabs: signing out in another tab switches this one to guest', async () => {
  const { store, memory, fire } = await freshStore({ 'qss:account': JSON.stringify({ userId: 'user-a' }), 'qss:cache:user-a': JSON.stringify({ progress: { topicsCompleted: ['intro'] } }) });
  const heard = [];
  store.subscribe((kind) => heard.push(kind));
  memory.delete('qss:account');
  memory.delete('qss:cache:user-a');
  fire('storage', { key: null }); // "everything was cleared" events have no key
  assert.equal(store.getMode(), 'guest');
  assert.deepEqual(store.getCompletedTopics(), []);
  assert.deepEqual(heard, ['mode']);
});

test('other tabs: coming back from the back/forward cache re-reads, a normal pageshow does not', async () => {
  const { store, memory, fire } = await freshStore();
  const heard = [];
  store.subscribe((kind) => heard.push(kind));
  memory.set('qss:progress', JSON.stringify({ topicsCompleted: ['intro'] }));
  fire('pageshow', { persisted: false });
  assert.deepEqual(heard, []);
  fire('pageshow', { persisted: true });
  assert.deepEqual(heard, ['local']);
});

// ------------------------------------------------- small flags

test('flags: simple names work, reserved names and odd names are refused', async () => {
  const { store, memory } = await freshStore();
  store.setFlag('gameHelpSeen', true);
  assert.equal(store.getFlag('gameHelpSeen', false), true);
  assert.equal(store.getFlag('missing', 'x'), 'x');
  store.setFlag('progress', 'evil');
  store.setFlag('account', { userId: 'someone-else' });
  store.setFlag('cache:user-a', 1);
  store.setFlag('a b', 1);
  assert.equal(store.getMode(), 'guest');
  assert.deepEqual(store.getProgress(), emptyProgress());
  assert.deepEqual([...memory.keys()], ['qss:gameHelpSeen']);
  assert.equal(store.getFlag('progress', 'safe'), 'safe');
});
