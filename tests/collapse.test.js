/* ==========================================================================
   collapse.test.js — tests for the Collapse Challenge rules (js/games/collapseChallenge.js)
   and the game helpers in js/utils/storage.js.
   Run with: npm test   (or: node --test tests/collapse.test.js)

   Randomness is always a fixed rng here, so peeks give the same answer every run.

   Example: fixedRng(0.9) makes a 50/50 peek come out as 1; fixedRng(0.1) makes it 0.
   ========================================================================== */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { createState } from '../js/quantum/state.js';
import { isSameState } from '../js/quantum/compare.js';
import {
  createGame, addGate, canUndo, undo, reset, peek, check, starsFor, shareText, stepLabel, gatesUsed, describeOdds, validatePuzzle, buildPuzzleStates,
} from '../js/games/collapseChallenge.js';

const data = JSON.parse(readFileSync(new URL('../data/game-puzzles.json', import.meta.url), 'utf8'));
const puzzle = (id) => data.puzzles.find((p) => p.id === id);
const PLUS = createState(1, ['1/√2', '1/√2']);
const MINUS = createState(1, ['1/√2', '-1/√2']);

/** A rng that returns the given numbers one after another (and then repeats the last), and counts its calls. */
function fixedRng(...values) {
  let calls = 0;
  const rng = () => values[Math.min(calls++, values.length - 1)];
  rng.calls = () => calls;
  return rng;
}

/** A game on a puzzle with the given gates already pressed. */
function played(id, ...gates) {
  const game = createGame(puzzle(id));
  gates.forEach((gate) => addGate(game, gate));
  return game;
}

// ------------------------------------------------- stars

test('starsFor: 3 stars at or under par, 2 for par + 1, 1 otherwise', () => {
  assert.equal(starsFor({ gatesUsed: 3, par: 3, peeked: false }), 3);
  assert.equal(starsFor({ gatesUsed: 2, par: 3, peeked: false }), 3);
  assert.equal(starsFor({ gatesUsed: 4, par: 3, peeked: false }), 2);
  assert.equal(starsFor({ gatesUsed: 5, par: 3, peeked: false }), 1);
  assert.equal(starsFor({ gatesUsed: 12, par: 3, peeked: false }), 1);
});

test('starsFor: a peek costs one star but never goes below 1', () => {
  assert.equal(starsFor({ gatesUsed: 3, par: 3, peeked: true }), 2);
  assert.equal(starsFor({ gatesUsed: 4, par: 3, peeked: true }), 1);
  assert.equal(starsFor({ gatesUsed: 5, par: 3, peeked: true }), 1);
  assert.equal(starsFor({ gatesUsed: 1, par: 1, peeked: true }), 2);
});

// ------------------------------------------------- sharing

test('shareText says the puzzle, stars and gates, never the solution, and adds the link on a second line', () => {
  assert.equal(shareText({ puzzleId: 12, stars: 3, gatesUsed: 3 }), 'Collapse Challenge #12 ⭐⭐⭐ in 3 gates');
  assert.equal(shareText({ puzzleId: 1, stars: 1, gatesUsed: 1 }), 'Collapse Challenge #1 ⭐ in 1 gate');
  const withLink = shareText({ puzzleId: 6, stars: 2, gatesUsed: 3, url: 'https://example.org/pages/game.html' });
  assert.equal(withLink, 'Collapse Challenge #6 ⭐⭐ in 3 gates\nhttps://example.org/pages/game.html');
  assert.ok(!/\b[XYZH]\b/.test(withLink), 'no gate letters in the share text');
});

// ------------------------------------------------- building a puzzle

test('buildPuzzleStates builds engine states from the data, and createGame starts at the start', () => {
  const { start, target } = buildPuzzleStates(puzzle(6));
  assert.equal(start.numQubits, 1);
  assert.ok(isSameState(start, createState(1, '0')));
  assert.ok(isSameState(target, MINUS));
  const game = createGame(puzzle(6));
  assert.equal(game.steps.length, 0);
  assert.equal(game.peeked, false);
  assert.equal(game.collapsed, false);
  assert.ok(isSameState(game.current, game.start));
});

test('addGate applies the gate with the engine and rejects gates the puzzle does not allow', () => {
  const game = createGame(puzzle(2)); // |0⟩ -> |+⟩ with X or H
  addGate(game, 'H');
  assert.ok(isSameState(game.current, PLUS));
  assert.equal(gatesUsed(game), 1);
  assert.throws(() => addGate(game, 'Z'), /not part of this puzzle/);
  assert.throws(() => addGate(game, { gate: 'H', target: 3 }), /out of range/);
  assert.equal(gatesUsed(game), 1);
});

// ------------------------------------------------- check: success

test('check: solving at par gives 3 stars and a happy message', () => {
  const game = played(6, 'H', 'Z'); // |0⟩ -> |−⟩
  const result = check(game);
  assert.equal(result.solved, true);
  assert.equal(result.kind, 'solved');
  assert.equal(result.stars, 3);
  assert.equal(result.gatesUsed, 2);
  assert.equal(result.par, 2);
  assert.match(result.message, /which is par\. Perfect/);
});

test('success wording: "par" only when gates used equal par, and never "Perfect" under par', () => {
  const atPar = check(played(6, 'H', 'Z'));
  assert.match(atPar.message, /which is par/);
  // A puzzle whose par is higher than the real shortest path (used < par) must not say "par" or "Perfect".
  const loose = createGame({ ...puzzle(2), par: 2 });
  addGate(loose, 'H');
  const under = check(loose);
  assert.equal(under.solved, true);
  assert.equal(under.stars, 3);
  assert.ok(!/par\b.*Perfect|Perfect|which is par/.test(under.message), under.message);
  const over = check(played(6, 'H', 'X', 'Z'));
  assert.ok(!/which is par|Perfect/.test(over.message), over.message);
});

test('check: par + 1 gives 2 stars and points at a shorter path without spelling it out; par + 2 gives 1 star', () => {
  const closer = played(6, 'H', 'X', 'Z'); // H -> |+⟩, X leaves |+⟩ alone, Z -> |−⟩: 3 gates, par 2
  const second = check(closer);
  assert.equal(second.stars, 2);
  assert.match(second.message, /2-gate path/);
  assert.ok(!/ Z\b| H\b|\bXH\b/.test(second.message), 'the solution is not spelled out');
  const wasteful = check(played(2, 'X', 'X', 'H')); // 3 gates, par 1
  assert.equal(wasteful.solved, true);
  assert.equal(wasteful.stars, 1);
});

test('check: global phase is ignored (Y gives i|1⟩ and that counts as |1⟩)', () => {
  const game = played(8, 'Y');
  assert.ok(game.current.amplitudes[1].im > 0.99, 'the amplitude really is i, not 1');
  const result = check(game);
  assert.equal(result.solved, true);
  assert.equal(result.stars, 3);
});

test('check: solving after a peek costs one star and the message says so', () => {
  const game = played(11, 'H'); // |−⟩ -> H -> |1⟩, a plain state
  const outcome = peek(game, fixedRng(0.5));
  assert.equal(outcome.bits, '1');
  assert.equal(outcome.wasBlend, false);
  addGate(game, 'X');
  const result = check(game);
  assert.equal(result.solved, true);
  assert.equal(result.peeked, true);
  assert.equal(result.stars, 2);
  assert.match(result.message, /Peeking cost one star/);
});

// ------------------------------------------------- check: friendly failures

test('check: with no gates yet it asks the player to press a gate', () => {
  const result = check(createGame(puzzle(5)));
  assert.equal(result.solved, false);
  assert.equal(result.kind, 'empty');
  assert.equal(result.stars, 0);
  assert.match(result.message, /Press a gate/);
});

test('check: right probabilities, wrong sign suggests Z when Z is allowed', () => {
  const result = check(played(5, 'X')); // |+⟩ -> X -> |+⟩, but the target is |−⟩
  assert.equal(result.solved, false);
  assert.equal(result.kind, 'sign');
  assert.equal(result.difference.probabilitiesMatch, true);
  assert.match(result.message, /Your probabilities match, but the sign of \|1⟩ is wrong\./);
  assert.match(result.message, /Try a Z gate/);
});

test('check: wrong sign without a Z gate in the puzzle never suggests Z', () => {
  const result = check(played(14, 'X')); // |+⟩ -> X -> |+⟩; target |−⟩; only H and X are allowed
  assert.equal(result.kind, 'sign');
  assert.match(result.message, /sign of \|1⟩ is wrong/);
  assert.ok(!/try a z/i.test(result.message), result.message);
  assert.match(result.message, /no Z gate/);
});

test('check: the "hidden sign" advice only appears when H is allowed and Y is not', () => {
  const nine = check(played(9, 'X')); // gates X and Y, no H
  assert.equal(nine.kind, 'sign');
  assert.ok(!/hidden sign into a visible change/.test(nine.message), nine.message);
  assert.match(nine.message, /Try each gate you have/);
  const ten = check(played(10, 'H')); // gates H and Y
  assert.equal(ten.kind, 'sign');
  assert.ok(!/hidden sign into a visible change/.test(ten.message), ten.message);
  assert.match(check(played(14, 'X')).message, /hidden sign into a visible change/);
});

test('check: wrong probabilities say what a measurement would give now versus the target', () => {
  const result = check(played(2, 'X')); // |0⟩ -> X -> |1⟩; the target is |+⟩
  assert.equal(result.kind, 'wrong-probabilities');
  assert.equal(result.difference.probabilitiesMatch, false);
  assert.match(result.message, /If you measured now, you would get 1 every time/);
  assert.match(result.message, /target gives 0 \(50%\) or 1 \(50%\)/);
  assert.match(result.message, /Try|H blends/);
});

test('check: plain-versus-blend advice names H only if H is allowed', () => {
  const withH = check(played(2, 'X'));
  assert.match(withH.message, /H blends/);
  const noH = createGame({ ...puzzle(2), allowedGates: ['X', 'Z'], referenceSolution: [{ gate: 'X', target: 0 }], par: 1 });
  addGate(noH, 'X');
  const result = check(noH);
  assert.equal(result.kind, 'wrong-probabilities');
  assert.ok(!/\bH\b/.test(result.message), result.message);
});

test('check: two different plain states suggest X only when X is allowed', () => {
  const allowedX = createGame({ ...puzzle(1), allowedGates: ['X', 'H'] });
  addGate(allowedX, 'H');
  addGate(allowedX, 'H'); // back to |0⟩, the target is |1⟩
  assert.match(check(allowedX).message, /X swaps 0 and 1/);
  const noX = createGame({ ...puzzle(13), allowedGates: ['H', 'Z'] }); // |0⟩ -> |1⟩
  addGate(noX, 'Z');
  const result = check(noX);
  assert.equal(result.kind, 'wrong-probabilities');
  assert.ok(!/\bX\b/.test(result.message), result.message);
});

test('check: a quarter-turn error suggests S only if S is allowed', () => {
  const quarter = { id: 99, title: 'Quarter', qubits: 1, startState: ['1/√2', '1/√2'], targetState: ['1/√2', 'i/√2'], allowedGates: ['S', 'H'], par: 1, hint: 'h', explanation: 'e', referenceSolution: [{ gate: 'S', target: 0 }] };
  assert.deepEqual(validatePuzzle(quarter), []);
  const game = createGame(quarter);
  addGate(game, 'H');
  addGate(game, 'H'); // back to |+⟩
  const result = check(game);
  assert.equal(result.kind, 'quarter-turn');
  assert.match(result.message, /quarter-turn off/);
  assert.match(result.message, /Try an S gate/);
  const noS = createGame({ ...quarter, allowedGates: ['H', 'X'], referenceSolution: [{ gate: 'X', target: 0 }] });
  addGate(noS, 'X');
  assert.ok(!/\bS gate\b/.test(check(noS).message));
});

// ------------------------------------------------- peek and collapse

test('peek really measures with the engine: the state collapses and the rng is used once', () => {
  const zero = createGame(puzzle(3)); // starts in |+⟩
  const rng0 = fixedRng(0.1);
  const first = peek(zero, rng0);
  assert.equal(first.bits, '0');
  assert.equal(first.wasBlend, true);
  assert.ok(Math.abs(first.probability - 0.5) < 1e-9);
  assert.equal(rng0.calls(), 1);
  assert.ok(isSameState(zero.current, createState(1, '0')), 'collapsed to |0⟩');

  const one = createGame(puzzle(3));
  const rng1 = fixedRng(0.9);
  assert.equal(peek(one, rng1).bits, '1');
  assert.ok(isSameState(one.current, createState(1, '1')), 'collapsed to |1⟩');
  assert.equal(rng1.calls(), 1);
});

test('peek marks the attempt, shows a peek marker in the sequence and does not count as a gate', () => {
  const game = played(3);
  peek(game, fixedRng(0.9));
  assert.equal(game.peeked, true);
  assert.equal(stepLabel(game.steps.at(-1)), 'Peek: got 1');
  assert.equal(gatesUsed(game), 0);
  const result = check(game);
  assert.match(result.message, /You peeked earlier/);
});

test('peeking a plain state changes nothing and is not a blend', () => {
  const game = played(1);
  const outcome = peek(game, fixedRng(0.3));
  assert.equal(outcome.bits, '0');
  assert.equal(outcome.wasBlend, false);
  assert.ok(isSameState(game.current, game.start));
});

test('peeking several times still costs only one star', () => {
  const game = played(11, 'H'); // plain |1⟩
  peek(game, fixedRng(0.5));
  peek(game, fixedRng(0.5));
  peek(game, fixedRng(0.5));
  addGate(game, 'X');
  assert.equal(check(game).stars, 2);
});

test('a peek that collapses straight onto the target by luck does not count as solving', () => {
  const game = createGame(puzzle(3)); // |+⟩ -> |0⟩ ; target is plain 0
  peek(game, fixedRng(0.1)); // collapses to |0⟩ = the target
  assert.ok(isSameState(game.current, game.target));
  assert.equal(game.collapsed, true);
  const result = check(game);
  assert.equal(result.solved, false);
  assert.equal(result.kind, 'lucky-collapse');
  assert.equal(result.stars, 0);
  assert.match(result.message, /press Reset/);
  reset(game);
  addGate(game, 'H');
  const real = check(game);
  assert.equal(real.solved, true);
  assert.equal(real.stars, 3, 'a fresh attempt without a peek earns full stars');
});

test('lucky collapse: peek, then H on puzzle #14 with an rng that forces outcome 1 is not solved', () => {
  const game = createGame(puzzle(14)); // |+⟩ -> |−⟩ with H and X, par 3
  assert.equal(peek(game, fixedRng(0.9)).bits, '1');
  addGate(game, 'H'); // |1⟩ -> |−⟩ = the target, by luck
  assert.ok(isSameState(game.current, game.target));
  const result = check(game);
  assert.equal(result.solved, false);
  assert.equal(result.kind, 'lucky-collapse');
  assert.equal(result.stars, 0);
});

test('lucky collapse: peek, then X, X on puzzle #3 is not solved', () => {
  const game = createGame(puzzle(3)); // |+⟩ -> |0⟩ with H
  peek(game, fixedRng(0.1)); // collapses to |0⟩
  addGate(game, 'X');
  addGate(game, 'X');
  assert.ok(isSameState(game.current, game.target));
  assert.equal(check(game).kind, 'lucky-collapse');
});

test('a peek on a plain state does not collapse a blend, so it does not block a real solve and still costs one star', () => {
  const game = played(11, 'H'); // |−⟩ -> H -> plain |1⟩
  peek(game, fixedRng(0.5));
  assert.equal(game.peeked, true);
  assert.equal(game.collapsed, false);
  addGate(game, 'X');
  const result = check(game);
  assert.equal(result.solved, true);
  assert.equal(result.stars, 2);
  assert.match(result.message, /Peeking cost one star/);
});

test('after a collapse, a wrong answer tells the player to press Reset instead of Undo', () => {
  const game = createGame(puzzle(5)); // |+⟩ -> |−⟩ with H and Z
  peek(game, fixedRng(0.1)); // collapses to |0⟩
  const result = check(game);
  assert.equal(result.solved, false);
  assert.match(result.message, /press Reset/);
  assert.ok(!/blend back/i.test(result.message), result.message);
});

test('the player can keep going after a peek, from the collapsed state', () => {
  const game = createGame(puzzle(6)); // |0⟩ -> |−⟩ with H and Z
  peek(game, fixedRng(0.1)); // |0⟩ is plain, so nothing collapses
  addGate(game, 'H');
  addGate(game, 'Z');
  const result = check(game);
  assert.equal(result.solved, true);
  assert.equal(result.gatesUsed, 2);
  assert.equal(result.stars, 2);
});

// ------------------------------------------------- undo and reset

test('undo steps back over gates, but never over a peek', () => {
  const game = createGame(puzzle(6));
  addGate(game, 'H');
  peek(game, fixedRng(0.9));
  assert.ok(isSameState(game.current, createState(1, '1')));
  assert.equal(canUndo(game), false);
  assert.equal(undo(game), null, 'a measurement cannot be undone');
  assert.equal(game.steps.length, 2, 'the peek stays');
  assert.equal(game.steps.at(-1).kind, 'peek');
  assert.ok(isSameState(game.current, createState(1, '1')), 'still collapsed');
  assert.equal(game.peeked, true);
  assert.equal(game.collapsed, true);
});

test('gates added after a peek can still be undone, one by one, down to the peek', () => {
  const game = createGame(puzzle(6));
  peek(game, fixedRng(0.1)); // |0⟩ stays |0⟩
  addGate(game, 'H');
  addGate(game, 'Z');
  assert.equal(canUndo(game), true);
  assert.equal(undo(game).gate, 'Z');
  assert.equal(undo(game).gate, 'H');
  assert.ok(isSameState(game.current, createState(1, '0')));
  assert.equal(undo(game), null, 'only the peek is left');
  assert.equal(game.steps.length, 1);
  assert.equal(undo(createGame(puzzle(6))), null, 'nothing at all to undo');
});

test('reset starts a fresh attempt: no gates, no peek, no collapse, back at the start', () => {
  const game = played(6, 'H');
  peek(game, fixedRng(0.9));
  assert.equal(game.collapsed, true);
  reset(game);
  assert.equal(game.steps.length, 0);
  assert.equal(game.peeked, false);
  assert.equal(game.collapsed, false);
  assert.ok(isSameState(game.current, game.start));
  assert.equal(undo(game), null);
});

// ------------------------------------------------- helpers

test('describeOdds and stepLabel use plain words', () => {
  assert.equal(describeOdds(createState(1, '1')), '1 every time');
  assert.equal(describeOdds(PLUS), '0 (50%) or 1 (50%)');
  assert.equal(describeOdds(createState(2, ['1/√2', 0, 0, '1/√2'])), '00 (50%) or 11 (50%)');
  assert.equal(stepLabel({ kind: 'gate', gate: 'H', target: 0 }), 'H');
  assert.equal(stepLabel({ kind: 'gate', gate: 'CNOT', control: 0, target: 1 }), 'CNOT 0→1');
});

test('validatePuzzle spots broken puzzles with a clear message', () => {
  const good = puzzle(2);
  assert.deepEqual(validatePuzzle(good), []);
  assert.match(validatePuzzle({ ...good, par: 2 }).join(' '), /par must equal/);
  assert.match(validatePuzzle({ ...good, targetState: [1, 0] }).join(' '), /already equals the target/);
  assert.match(validatePuzzle({ ...good, allowedGates: ['X'] }).join(' '), /not allowed/);
  assert.match(validatePuzzle({ ...good, hint: '' }).join(' '), /hint/);
  assert.match(validatePuzzle({ ...good, startState: [1, 0, 0] }).join(' '), /not valid/);
  assert.match(validatePuzzle({ ...good, referenceSolution: [{ gate: 'X', target: 0 }], allowedGates: ['X', 'H'] }).join(' '), /does not reach/);
});

// ------------------------------------------------- progress store helpers (game stats, stars, today's result)

/** Run progressStore.js against a fake in-memory localStorage (Node has no browser). */
async function freshStorage() {
  const memory = new Map();
  globalThis.window = {
    localStorage: {
      getItem: (key) => (memory.has(key) ? memory.get(key) : null),
      setItem: (key, value) => memory.set(key, String(value)),
      removeItem: (key) => memory.delete(key),
      key: (index) => [...memory.keys()][index] ?? null,
      get length() {
        return memory.size;
      },
    },
  };
  return { storage: await import(`../js/services/progressStore.js?fresh=${Math.random()}`), memory };
}

test('storage: a daily win saves stars, the streak, played-today and the result; practice does not touch the streak', async () => {
  const { storage } = await freshStorage();
  assert.equal(storage.hasPlayedToday('2026-11-14'), false);
  assert.equal(storage.getTodayResult('2026-11-14'), null);
  assert.equal(storage.getTotalStars(), 0);

  storage.recordGameResult({ dayKey: '2026-11-14', score: 3, perfect: true, daily: true, puzzleId: 6, stars: 3, gatesUsed: 2 });
  assert.equal(storage.hasPlayedToday('2026-11-14'), true);
  assert.equal(storage.hasPlayedToday('2026-11-15'), false);
  assert.deepEqual(storage.getTodayResult('2026-11-14'), { dayKey: '2026-11-14', puzzleId: 6, stars: 3, gatesUsed: 2 });
  assert.equal(storage.getTodayResult('2026-11-15'), null);
  assert.equal(storage.getCurrentStreak('2026-11-14'), 1);

  storage.recordGameResult({ dayKey: '2026-11-14', score: 2, daily: false, puzzleId: 2, stars: 2, gatesUsed: 2 });
  storage.recordGameResult({ dayKey: '2026-11-14', score: 3, daily: false, puzzleId: 2, stars: 3, gatesUsed: 1 });
  storage.recordGameResult({ dayKey: '2026-11-14', score: 1, daily: false, puzzleId: 2, stars: 1, gatesUsed: 5 });
  assert.equal(storage.getBestStars(2), 3, 'the best stars are kept');
  assert.equal(storage.getBestStars(7), 0);
  assert.equal(storage.getTotalStars(), 6);
  assert.equal(storage.getCurrentStreak('2026-11-14'), 1, 'practice does not change the streak');
  assert.equal(storage.getGameStats().played, 4);

  storage.recordGameResult({ dayKey: '2026-11-15', score: 2, daily: true, puzzleId: 9, stars: 2, gatesUsed: 1 });
  assert.equal(storage.getCurrentStreak('2026-11-15'), 2);
  assert.equal(storage.getTodayResult('2026-11-15').puzzleId, 9);
});

test('storage: the old fields still work, and damaged saved data is repaired', async () => {
  const { storage, memory } = await freshStorage();
  const summary = storage.getProgressSummary();
  for (const field of ['topicsCompleted', 'totalTopics', 'quizzesPassed', 'gamesPlayed', 'streak', 'bestStreak', 'bestScore', 'confidence']) {
    assert.ok(field in summary, `summary.${field} is still there`);
  }
  assert.equal(summary.totalStars, 0);
  assert.equal(summary.playedToday, false);
  // An old save without the new fields, and a save with nonsense in them.
  memory.set('qss:progress', JSON.stringify({ game: { played: 2, perfect: 1, bestScore: 5, streak: 1, bestStreak: 3, lastDay: '2026-11-13' } }));
  assert.equal(storage.getGameStats().played, 2);
  assert.deepEqual(storage.getGameStats().solved, {});
  assert.equal(storage.getTotalStars(), 0);
  memory.set('qss:progress', JSON.stringify({ game: { solved: { 3: 2, 4: 9, 5: 'x' }, lastDaily: { dayKey: 'nope' } } }));
  assert.deepEqual(storage.getGameStats().solved, { 3: 2 });
  assert.equal(storage.getGameStats().lastDaily, null);
  assert.equal(storage.getTotalStars(), 2);
  storage.resetProgress();
  assert.equal(storage.getTotalStars(), 0);
});
