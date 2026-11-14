/* ==========================================================================
   progressMerge.test.js — tests for js/services/progressMerge.js (pure functions).
   Run with: npm test   (or: node --test tests/progressMerge.test.js)
   ========================================================================== */
import test from 'node:test';
import assert from 'node:assert/strict';

import { PROGRESS_KEYS, emptyProgress, normalizeProgress, mergeProgress, changedKeys, isProgressEmpty, cleanLastDaily } from '../js/services/progressMerge.js';

/** A progress object with some fields changed. */
function make({ topics = [], quizBest = {}, confidence = {}, game = {} } = {}) {
  const base = emptyProgress();
  return { topicsCompleted: topics, quizBest, confidence: { ...base.confidence, ...confidence }, game: { ...base.game, ...game } };
}

const daily = (dayKey, stars = 2, gatesUsed = 3, puzzleId = 4) => ({ dayKey, puzzleId, stars, gatesUsed });

const SAMPLES = [
  make(),
  make({ topics: ['intro', 'gates'], quizBest: { intro: 3, gates: 1 }, confidence: { before: 2 }, game: { played: 3, perfect: 1, bestScore: 3, streak: 2, bestStreak: 4, lastDay: '2026-11-13', solved: { 1: 2, 2: 3 }, lastDaily: daily('2026-11-13', 3, 2) } }),
  make({ topics: ['gates', 'computing'], quizBest: { gates: 3, computing: 2 }, confidence: { before: 4, after: 5 }, game: { played: 5, perfect: 0, bestScore: 2, streak: 1, bestStreak: 1, lastDay: '2026-11-14', solved: { 2: 1, 3: 3 }, lastDaily: daily('2026-11-14', 1, 6, 9) } }),
  make({ game: { played: 2, streak: 3, bestStreak: 3, lastDay: '2026-11-14', lastDaily: daily('2026-11-14', 3, 1, 7) } }),
];

// ------------------------------------------------- each rule

test('merge: topics are the union of both sides', () => {
  const merged = mergeProgress(make({ topics: ['intro', 'gates'] }), make({ topics: ['gates', 'computing'] }));
  assert.deepEqual([...merged.topicsCompleted].sort(), ['computing', 'gates', 'intro']);
  assert.equal(merged.topicsCompleted.length, 3, 'no duplicates');
});

test('merge: quiz scores keep the best per topic', () => {
  const merged = mergeProgress(make({ quizBest: { intro: 3, gates: 1 } }), make({ quizBest: { gates: 2, computing: 0 } }));
  assert.deepEqual(merged.quizBest, { intro: 3, gates: 2, computing: 0 });
});

test('merge: confidence prefers b (the account) when both are set, otherwise whichever exists', () => {
  const merged = mergeProgress(make({ confidence: { before: 1, after: 5 } }), make({ confidence: { before: 3 } }));
  assert.deepEqual(merged.confidence, { before: 3, after: 5 }, 'before: b wins; after: only a has it');
  assert.deepEqual(mergeProgress(make({ confidence: { before: 2 } }), make()).confidence, { before: 2, after: null });
  assert.deepEqual(mergeProgress(make(), make({ confidence: { after: 4 } })).confidence, { before: null, after: 4 });
  assert.deepEqual(mergeProgress(make(), make()).confidence, { before: null, after: null });
});

test('merge: game counters take the larger number, not the sum', () => {
  const merged = mergeProgress(
    make({ game: { played: 3, perfect: 2, bestScore: 1, bestStreak: 5 } }),
    make({ game: { played: 7, perfect: 1, bestScore: 3, bestStreak: 2 } }),
  );
  assert.equal(merged.game.played, 7);
  assert.equal(merged.game.perfect, 2);
  assert.equal(merged.game.bestScore, 3);
  assert.equal(merged.game.bestStreak, 5);
});

test('merge: solved puzzles keep the best stars per puzzle', () => {
  const merged = mergeProgress(make({ game: { solved: { 1: 2, 2: 3 } } }), make({ game: { solved: { 2: 1, 3: 3 } } }));
  assert.deepEqual(merged.game.solved, { 1: 2, 2: 3, 3: 3 });
});

test('merge: the streak and last day come from the side that played later', () => {
  const older = make({ game: { streak: 9, bestStreak: 9, lastDay: '2026-11-10' } });
  const newer = make({ game: { streak: 2, bestStreak: 2, lastDay: '2026-11-14' } });
  for (const merged of [mergeProgress(older, newer), mergeProgress(newer, older)]) {
    assert.equal(merged.game.streak, 2);
    assert.equal(merged.game.lastDay, '2026-11-14');
    assert.equal(merged.game.bestStreak, 9, 'the best streak ever is never lost');
  }
});

test('merge: on the same last day the higher streak wins; a side that never played loses', () => {
  const a = make({ game: { streak: 3, bestStreak: 3, lastDay: '2026-11-14' } });
  const b = make({ game: { streak: 5, bestStreak: 5, lastDay: '2026-11-14' } });
  assert.equal(mergeProgress(a, b).game.streak, 5);
  assert.equal(mergeProgress(b, a).game.streak, 5);
  const never = make({ game: { played: 1 } });
  assert.equal(mergeProgress(a, never).game.lastDay, '2026-11-14');
  assert.equal(mergeProgress(never, a).game.streak, 3);
  assert.equal(mergeProgress(never, never).game.lastDay, null);
});

test('merge: the daily result comes from the later day; on the same day, more stars', () => {
  const day13 = make({ game: { lastDaily: daily('2026-11-13', 3) } });
  const day14 = make({ game: { lastDaily: daily('2026-11-14', 1) } });
  assert.equal(mergeProgress(day13, day14).game.lastDaily.dayKey, '2026-11-14');
  assert.equal(mergeProgress(day14, day13).game.lastDaily.dayKey, '2026-11-14');
  const low = make({ game: { lastDaily: daily('2026-11-14', 1, 4, 5) } });
  const high = make({ game: { lastDaily: daily('2026-11-14', 3, 2, 6) } });
  assert.equal(mergeProgress(low, high).game.lastDaily.stars, 3);
  assert.equal(mergeProgress(high, low).game.lastDaily.stars, 3);
  assert.equal(mergeProgress(make(), high).game.lastDaily.stars, 3, 'one side has none: take the other');
  assert.equal(mergeProgress(make(), make()).game.lastDaily, null);
});

test('merge: a daily tie on day and stars picks the same one in both directions', () => {
  const x = make({ game: { lastDaily: daily('2026-11-14', 2, 4, 5) } });
  const y = make({ game: { lastDaily: daily('2026-11-14', 2, 2, 6) } });
  assert.deepEqual(mergeProgress(x, y).game.lastDaily, mergeProgress(y, x).game.lastDaily);
  assert.equal(mergeProgress(x, y).game.lastDaily.gatesUsed, 2, 'fewer gates is the better result');
  const p = make({ game: { lastDaily: daily('2026-11-14', 2, 2, 5) } });
  const q = make({ game: { lastDaily: daily('2026-11-14', 2, 2, 6) } });
  assert.deepEqual(mergeProgress(p, q).game.lastDaily, mergeProgress(q, p).game.lastDaily);
});

// ------------------------------------------------- algebra

test('merge: merging the same data twice changes nothing (idempotent)', () => {
  for (const a of SAMPLES) {
    assert.deepEqual(mergeProgress(a, a), normalizeProgress(a));
    for (const b of SAMPLES) {
      const once = mergeProgress(a, b);
      assert.deepEqual(mergeProgress(once, b), once, 're-merging b');
      assert.deepEqual(mergeProgress(a, once), once, 'merging the result back into a');
      assert.deepEqual(mergeProgress(once, once), once);
    }
  }
});

test('merge: everything except confidence gives the same result in either order', () => {
  for (const a of SAMPLES) {
    for (const b of SAMPLES) {
      const ab = mergeProgress(a, b);
      const ba = mergeProgress(b, a);
      assert.deepEqual([...ab.topicsCompleted].sort(), [...ba.topicsCompleted].sort());
      assert.deepEqual(ab.quizBest, ba.quizBest);
      assert.deepEqual(ab.game, ba.game);
    }
  }
});

test('merge: an empty side changes nothing', () => {
  for (const a of SAMPLES) {
    assert.deepEqual(mergeProgress(a, emptyProgress()), normalizeProgress(a));
    assert.deepEqual(mergeProgress(emptyProgress(), a), normalizeProgress(a));
  }
});

test('merge: the inputs are never changed', () => {
  const a = SAMPLES[1];
  const b = SAMPLES[2];
  const copyA = structuredClone(a);
  const copyB = structuredClone(b);
  mergeProgress(a, b);
  assert.deepEqual(a, copyA);
  assert.deepEqual(b, copyB);
});

test('merge: best streak is never below the current streak', () => {
  const merged = mergeProgress(make({ game: { streak: 4, bestStreak: 0, lastDay: '2026-11-14' } }), make());
  assert.equal(merged.game.bestStreak, 4);
});

// ------------------------------------------------- damaged input

test('merge: damaged or missing input counts as empty and never throws', () => {
  const good = SAMPLES[1];
  for (const bad of [null, undefined, 5, 'text', [], true, { topicsCompleted: 'x', quizBest: [], confidence: 7, game: 'no' }]) {
    assert.deepEqual(mergeProgress(good, bad), normalizeProgress(good));
    assert.deepEqual(mergeProgress(bad, good), normalizeProgress(good));
    assert.deepEqual(mergeProgress(bad, bad), emptyProgress());
  }
});

test('normalize: nonsense inside valid containers is dropped', () => {
  const clean = normalizeProgress({
    topicsCompleted: ['intro', 'intro', 5, null, '', 'x'.repeat(101), 'gates'],
    quizBest: { intro: 3, bad: -1, worse: 1.5, text: 'x' },
    confidence: { before: 0, after: 6 },
    game: { played: -3, perfect: NaN, bestScore: Infinity, streak: '2', bestStreak: 4, lastDay: '14-11-2026', solved: { 1: 4, 2: 2, 3: 'x' }, lastDaily: { dayKey: 'no' } },
  });
  assert.deepEqual(clean.topicsCompleted, ['intro', 'gates']);
  assert.deepEqual(clean.quizBest, { intro: 3 });
  assert.deepEqual(clean.confidence, { before: null, after: null });
  assert.deepEqual(clean.game, { played: 0, perfect: 0, bestScore: 0, streak: 0, bestStreak: 4, lastDay: null, solved: { 2: 2 }, lastDaily: null });
});

test('normalize: a __proto__ key from outside cannot poison anything', () => {
  const hostile = JSON.parse('{"quizBest":{"__proto__":3,"intro":2},"game":{"solved":{"__proto__":2,"1":3}}}');
  const clean = normalizeProgress(hostile);
  assert.deepEqual(clean.quizBest, { intro: 2 });
  assert.deepEqual(clean.game.solved, { 1: 3 });
  assert.equal(Object.getPrototypeOf(clean.quizBest), Object.prototype);
  assert.equal({}.intro, undefined);
});

test('normalize: huge lists from outside are capped', () => {
  const many = Array.from({ length: 2000 }, (_, i) => `t${i}`);
  assert.equal(normalizeProgress({ topicsCompleted: many }).topicsCompleted.length, 500);
});

test('normalize: always returns a fresh copy that is safe to change', () => {
  const saved = make({ topics: ['intro'], game: { solved: { 1: 2 } } });
  const copy = normalizeProgress(saved);
  copy.topicsCompleted.push('x');
  copy.game.solved[9] = 3;
  assert.deepEqual(saved.topicsCompleted, ['intro']);
  assert.deepEqual(saved.game.solved, { 1: 2 });
});

test('cleanLastDaily: accepts numbers or text as puzzle id and rejects bad results', () => {
  assert.deepEqual(cleanLastDaily(daily('2026-11-14', 3, 2, 'p1')), daily('2026-11-14', 3, 2, 'p1'));
  assert.equal(cleanLastDaily(daily('2026-11-14', 4)), null);
  assert.equal(cleanLastDaily(daily('2026-11-14', 2, -1)), null);
  assert.equal(cleanLastDaily({ ...daily('2026-11-14'), puzzleId: {} }), null);
  assert.equal(cleanLastDaily(null), null);
  assert.equal(cleanLastDaily([]), null);
});

// ------------------------------------------------- comparing

test('changedKeys: lists the saved parts that differ, ignoring key order', () => {
  const a = make({ quizBest: { a: 1, b: 2 }, game: { solved: { 1: 1, 2: 2 } } });
  const b = make({ quizBest: { b: 2, a: 1 }, game: { solved: { 2: 2, 1: 1 } } });
  assert.deepEqual(changedKeys(a, b), []);
  assert.deepEqual(changedKeys(a, make({ quizBest: { a: 1, b: 3 }, game: { solved: { 1: 1, 2: 2 } } })), ['quizBest']);
  assert.deepEqual(changedKeys(make(), SAMPLES[2]), PROGRESS_KEYS);
  assert.deepEqual(changedKeys(null, undefined), []);
});

test('isProgressEmpty: true only when nothing has been saved', () => {
  assert.equal(isProgressEmpty(emptyProgress()), true);
  assert.equal(isProgressEmpty(null), true);
  assert.equal(isProgressEmpty({ garbage: 1 }), true);
  assert.equal(isProgressEmpty(make({ topics: ['intro'] })), false);
  assert.equal(isProgressEmpty(make({ game: { played: 1 } })), false);
  assert.equal(isProgressEmpty(make({ confidence: { after: 3 } })), false);
});
