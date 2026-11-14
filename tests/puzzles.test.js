/* ==========================================================================
   puzzles.test.js — checks EVERY puzzle in data/game-puzzles.json.
   Run with: npm test   (or: node --test tests/puzzles.test.js)

   A puzzle is only good if it can be solved, its "par" is the true fewest
   gates, and the words are filled in. The quantum math comes from js/quantum/.

   Example: add a puzzle to the JSON file, run npm test, and read any failure message.
   ========================================================================== */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { createState } from '../js/quantum/state.js';
import { GATES, SINGLE_QUBIT_GATES, applyGate } from '../js/quantum/gates.js';
import { validateCircuit } from '../js/quantum/simulator.js';
import { isSameState } from '../js/quantum/compare.js';
import { blochVector } from '../js/quantum/bloch.js';
import { findShortestCircuit } from '../js/quantum/solver.js';
import { validatePuzzle, pickTodaysPuzzle } from '../js/games/collapseChallenge.js';

const data = JSON.parse(readFileSync(new URL('../data/game-puzzles.json', import.meta.url), 'utf8'));
const KNOWN_GATES = [...SINGLE_QUBIT_GATES, 'CNOT'];
// The dial can only show states in the x-z plane, so version 0 uses these gates.
const DIAL_GATES = ['X', 'Y', 'Z', 'H'];

test('the puzzle file has a version and at least 14 puzzles', () => {
  assert.equal(data.version, 1);
  assert.ok(Array.isArray(data.puzzles));
  assert.ok(data.puzzles.length >= 14, `expected at least 14 puzzles, found ${data.puzzles.length}`);
});

test('ids are unique and numbered 1..N in order', () => {
  const ids = data.puzzles.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length, 'ids must be unique');
  assert.deepEqual(ids, ids.map((_, i) => i + 1));
});

test('the puzzles ramp up: one-gate warm-ups first, three-gate puzzles at the end', () => {
  const pars = data.puzzles.map((p) => p.par);
  assert.ok(pars.slice(0, 3).every((par) => par === 1), 'the first puzzles should be one-gate warm-ups');
  assert.ok(pars.includes(3), 'there should be some three-gate puzzles');
  assert.ok(pars.lastIndexOf(1) < pars.indexOf(3), 'every one-gate puzzle comes before the first three-gate puzzle');
});

test('the first puzzle is |0⟩ to |1⟩ with X, and a puzzle teaches global phase with Y', () => {
  const first = data.puzzles[0];
  assert.deepEqual(first.allowedGates, ['X']);
  assert.ok(isSameState(createState(1, first.startState), createState(1, '0')));
  assert.ok(isSameState(createState(1, first.targetState), createState(1, '1')));
  const phase = data.puzzles.find((p) => /twist|phase/i.test(p.explanation) && p.referenceSolution.every((s) => s.gate === 'Y'));
  assert.ok(phase, 'expected a Y-only puzzle that explains global phase');
  const reached = applyGate(createState(1, phase.startState), 'Y', { target: 0 });
  assert.notDeepEqual(reached.amplitudes[1], createState(1, phase.targetState).amplitudes[1], 'Y gives i|1⟩, not exactly |1⟩');
  assert.ok(isSameState(reached, createState(1, phase.targetState)));
});

test('the first puzzle that shows i explains it in plain words, and no text says a measurement can be undone', () => {
  const twist = data.puzzles.find((p) => p.referenceSolution.every((step) => step.gate === 'Y'));
  assert.match(twist.explanation, /i is a special number that just means a quarter-turn twist/);
  for (const p of data.puzzles) {
    assert.ok(!/undo (the|a) (peek|measurement)|blend back after/i.test(`${p.hint} ${p.explanation}`), `puzzle #${p.id} suggests a measurement can be undone`);
  }
});

test('some puzzles restrict the gates: H and Z only, and H and X only, in three gates', () => {
  const hz = data.puzzles.find((p) => p.par === 3 && p.allowedGates.length === 2 && p.allowedGates.includes('H') && p.allowedGates.includes('Z'));
  const hx = data.puzzles.find((p) => p.par === 3 && p.allowedGates.length === 2 && p.allowedGates.includes('H') && p.allowedGates.includes('X'));
  assert.ok(hz, 'expected a three-gate puzzle with only H and Z');
  assert.ok(hx, 'expected a three-gate puzzle with only H and X');
});

for (const puzzle of data.puzzles) {
  test(`puzzle #${puzzle.id} "${puzzle.title}" is complete and solvable with the true fewest gates`, () => {
    // Required fields.
    for (const field of ['id', 'title', 'qubits', 'startState', 'targetState', 'allowedGates', 'par', 'hint', 'explanation', 'referenceSolution']) {
      assert.ok(field in puzzle, `missing field ${field}`);
    }
    assert.ok(Number.isInteger(puzzle.id) && puzzle.id >= 1);
    assert.ok(typeof puzzle.title === 'string' && puzzle.title.trim().length > 0, 'title');
    assert.ok([1, 2].includes(puzzle.qubits), 'qubits must be 1 or 2');
    assert.ok(typeof puzzle.hint === 'string' && puzzle.hint.trim().length > 0, 'hint');
    assert.ok(typeof puzzle.explanation === 'string' && puzzle.explanation.trim().length > 0, 'explanation');
    assert.ok(!/todo|placeholder|coming soon/i.test(`${puzzle.title} ${puzzle.hint} ${puzzle.explanation}`), 'no placeholder words');

    // Gates.
    assert.ok(Array.isArray(puzzle.allowedGates) && puzzle.allowedGates.length > 0, 'allowedGates');
    assert.equal(new Set(puzzle.allowedGates).size, puzzle.allowedGates.length, 'allowedGates has repeats');
    puzzle.allowedGates.forEach((gate) => assert.ok(KNOWN_GATES.includes(gate) && GATES[gate], `unknown gate ${gate}`));
    puzzle.allowedGates.forEach((gate) => assert.ok(DIAL_GATES.includes(gate), `gate ${gate} cannot be drawn on the dial yet`));

    // States.
    const size = 2 ** puzzle.qubits;
    assert.equal(puzzle.startState.length, size, 'startState needs 2^qubits amplitudes');
    assert.equal(puzzle.targetState.length, size, 'targetState needs 2^qubits amplitudes');
    const start = createState(puzzle.qubits, puzzle.startState);
    const target = createState(puzzle.qubits, puzzle.targetState);
    assert.ok(!isSameState(start, target), 'the start must not already be the target');
    if (puzzle.qubits === 1) {
      assert.ok(Math.abs(blochVector(start).y) < 1e-9 && Math.abs(blochVector(target).y) < 1e-9, 'one-qubit states must sit on the dial (x-z plane)');
    }

    // The reference solution.
    const solution = puzzle.referenceSolution;
    assert.ok(Array.isArray(solution) && solution.length > 0, 'referenceSolution');
    const circuit = validateCircuit(puzzle.qubits, solution.map((placement) => [placement]));
    assert.ok(circuit.ok, circuit.errors.map((e) => e.message).join('; '));
    solution.forEach((placement) => assert.ok(puzzle.allowedGates.includes(placement.gate), `reference uses ${placement.gate}, which is not allowed`));
    const final = solution.reduce((state, placement) => applyGate(state, placement.gate, placement), start);
    assert.ok(isSameState(final, target), 'the reference solution must reach the target');

    // Par is the true minimum.
    assert.equal(puzzle.par, solution.length, 'par must equal the reference solution length');
    const shortest = findShortestCircuit({ numQubits: puzzle.qubits, start: puzzle.startState, target: puzzle.targetState, allowedGates: puzzle.allowedGates, maxGates: puzzle.par + 2 });
    assert.ok(shortest, 'the solver found no solution');
    assert.equal(shortest.length, puzzle.par, `par is ${puzzle.par} but the solver found ${shortest.length}`);

    // The game logic agrees.
    assert.deepEqual(validatePuzzle(puzzle), []);
  });
}

test('the daily pick is the same for everyone, always a real puzzle, and every puzzle comes up', () => {
  const seen = new Set();
  for (let offset = 0; offset < data.puzzles.length; offset += 1) {
    const key = new Date(Date.UTC(2026, 10, 14 + offset)).toISOString().slice(0, 10);
    const first = pickTodaysPuzzle(data.puzzles, key);
    assert.equal(pickTodaysPuzzle(data.puzzles, key).id, first.id);
    assert.ok(data.puzzles.includes(first));
    seen.add(first.id);
  }
  assert.equal(seen.size, data.puzzles.length, 'no puzzle repeats until all have been used');
});
