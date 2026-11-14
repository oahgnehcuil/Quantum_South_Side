/* ==========================================================================
   progressRemote.test.js — tests for js/services/progressRemote.js using a fake
   Supabase client (no network). The fake records every call and can fail on demand.
   Run with: npm test   (or: node --test tests/progressRemote.test.js)
   ========================================================================== */
import test from 'node:test';
import assert from 'node:assert/strict';

import { pullProgress, pushProgress, deleteProgress } from '../js/services/progressRemote.js';
import { emptyProgress } from '../js/services/progressMerge.js';

/** A fake client that only knows client.from('progress').select/upsert/delete. */
function fakeClient({ rows = [], fail = null, throws = false } = {}) {
  const calls = [];
  const answer = () => {
    if (throws) throw new TypeError('boom');
    return fail ? { data: null, error: { message: 'nope' }, status: fail.status ?? 500 } : { data: rows, error: null, status: 200 };
  };
  return {
    calls,
    from(table) {
      calls.push(['from', table]);
      return {
        select(columns) {
          calls.push(['select', columns]);
          return { eq: async (column, value) => (calls.push(['eq', column, value]), answer()) };
        },
        async upsert(values, options) {
          calls.push(['upsert', values, options]);
          return answer();
        },
        delete() {
          calls.push(['delete']);
          return { eq: async (column, value) => (calls.push(['eq', column, value]), answer()) };
        },
      };
    },
  };
}

const ROWS = [
  { key: 'topicsCompleted', value: ['intro', 'gates'] },
  { key: 'quizBest', value: { intro: 3 } },
  { key: 'confidence', value: { before: 2, after: null } },
  { key: 'game', value: { played: 4, bestStreak: 2 } },
];

test('pull: asks only for this user\'s rows of the progress table', async () => {
  const client = fakeClient({ rows: ROWS });
  await pullProgress(client, 'user-1');
  assert.deepEqual(client.calls, [['from', 'progress'], ['select', 'key, value'], ['eq', 'user_id', 'user-1']]);
});

test('pull: builds a full, valid progress object from the rows', async () => {
  const result = await pullProgress(fakeClient({ rows: ROWS }), 'u');
  assert.equal(result.ok, true);
  assert.deepEqual(result.progress.topicsCompleted, ['intro', 'gates']);
  assert.deepEqual(result.progress.quizBest, { intro: 3 });
  assert.deepEqual(result.progress.confidence, { before: 2, after: null });
  assert.equal(result.progress.game.played, 4);
  assert.deepEqual(result.progress.game.solved, {}, 'fields missing inside a row are filled in');
});

test('pull: no rows means empty progress, and unknown or damaged rows are ignored', async () => {
  assert.deepEqual((await pullProgress(fakeClient({ rows: [] }), 'u')).progress, emptyProgress());
  const messy = [null, { key: 'somethingElse', value: [1] }, { key: 'topicsCompleted', value: 'not a list' }, { key: 'quizBest', value: { intro: 'x' } }];
  assert.deepEqual((await pullProgress(fakeClient({ rows: messy }), 'u')).progress, emptyProgress());
});

test('pull: failures come back as plain objects and never throw', async () => {
  assert.deepEqual(await pullProgress(fakeClient({ fail: { status: 500 } }), 'u'), { ok: false, offline: false });
  assert.deepEqual(await pullProgress(fakeClient({ fail: { status: 0 } }), 'u'), { ok: false, offline: true }, 'status 0 means the request never got an answer');
  assert.deepEqual((await pullProgress(fakeClient({ throws: true }), 'u')).ok, false);
  assert.deepEqual((await pullProgress({ from: () => ({ select: () => ({ eq: async () => null }) }) }, 'u')).ok, false);
  assert.deepEqual((await pullProgress({ from: () => ({ select: () => ({ eq: async () => ({ data: 'x', error: null }) }) }) }, 'u')).ok, false);
});

test('push: one upsert with one row per changed key, conflict on user_id,key', async () => {
  const client = fakeClient();
  const state = { ...emptyProgress(), topicsCompleted: ['intro'], quizBest: { intro: 2 } };
  const result = await pushProgress(client, 'user-1', ['topicsCompleted', 'quizBest'], state);
  assert.deepEqual(result, { ok: true });
  const upserts = client.calls.filter(([name]) => name === 'upsert');
  assert.equal(upserts.length, 1);
  const [, rows, options] = upserts[0];
  assert.deepEqual(options, { onConflict: 'user_id,key' });
  assert.deepEqual(rows.map((row) => [row.user_id, row.key, row.value]), [
    ['user-1', 'topicsCompleted', ['intro']],
    ['user-1', 'quizBest', { intro: 2 }],
  ]);
});

test('push: unchanged keys, unknown keys and duplicates are not sent; nothing to send means no request', async () => {
  const client = fakeClient();
  await pushProgress(client, 'u', ['game', 'game', 'password', 'user_id'], emptyProgress());
  const rows = client.calls.find(([name]) => name === 'upsert')[1];
  assert.deepEqual(rows.map((row) => row.key), ['game']);
  const quiet = fakeClient();
  assert.deepEqual(await pushProgress(quiet, 'u', [], emptyProgress()), { ok: true });
  assert.deepEqual(await pushProgress(quiet, 'u', ['nope'], emptyProgress()), { ok: true });
  assert.deepEqual(quiet.calls, []);
});

test('push: damaged state is repaired before it is sent', async () => {
  const client = fakeClient();
  await pushProgress(client, 'u', ['quizBest'], { quizBest: { intro: 3, bad: 'x' } });
  assert.deepEqual(client.calls.find(([name]) => name === 'upsert')[1][0].value, { intro: 3 });
});

test('push: failures say whether the device is offline', async () => {
  assert.deepEqual(await pushProgress(fakeClient({ fail: { status: 401 } }), 'u', ['game'], emptyProgress()), { ok: false, offline: false });
  assert.deepEqual(await pushProgress(fakeClient({ fail: { status: 0 } }), 'u', ['game'], emptyProgress()), { ok: false, offline: true });
  assert.equal((await pushProgress(fakeClient({ throws: true }), 'u', ['game'], emptyProgress())).ok, false);
});

test('delete: removes only this user\'s rows', async () => {
  const client = fakeClient();
  assert.deepEqual(await deleteProgress(client, 'user-1'), { ok: true });
  assert.deepEqual(client.calls, [['from', 'progress'], ['delete'], ['eq', 'user_id', 'user-1']]);
  assert.deepEqual(await deleteProgress(fakeClient({ fail: { status: 0 } }), 'u'), { ok: false, offline: true });
  assert.equal((await deleteProgress(fakeClient({ throws: true }), 'u')).ok, false);
});

test('offline: a browser that says it is offline marks any failure as offline', async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { value: { onLine: false }, configurable: true });
  try {
    assert.equal((await pullProgress(fakeClient({ fail: { status: 500 } }), 'u')).offline, true);
    assert.equal((await pushProgress(fakeClient({ throws: true }), 'u', ['game'], emptyProgress())).offline, true);
  } finally {
    if (original) Object.defineProperty(globalThis, 'navigator', original);
    else delete globalThis.navigator;
  }
});
