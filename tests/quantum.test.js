/* ==========================================================================
   quantum.test.js — tests for the shared quantum engine in js/quantum/.
   Run with: npm test   (uses node:test, no extra packages needed)

   Example:
     npm test
     node --test tests/quantum.test.js
     // every test name below says what it checks
   ========================================================================== */

import test from 'node:test';
import assert from 'node:assert/strict';

import { complex, ZERO, ONE, I, toComplex, add, sub, mul, scale, conj, abs, abs2, arg, fromPolar, isZero, approxEqual } from '../js/quantum/complex.js';
import {
  MAX_QUBITS, createState, normalize, norm, probabilities, basisLabel, bitsOf, measureQubit, measureAll, sample,
} from '../js/quantum/state.js';
import { GATES, SINGLE_QUBIT_GATES, applyGate, applySingleQubitGate, applyCNOT } from '../js/quantum/gates.js';
import { validateCircuit, runCircuit, simulateShots } from '../js/quantum/simulator.js';
import { innerProduct, fidelity, isSameState, describeDifference } from '../js/quantum/compare.js';
import { exactValue, formatAmplitude, formatKet, basisKet, formatProbability, nameState } from '../js/quantum/format.js';
import { parseAmplitude } from '../js/quantum/parse.js';
import { blochVector, reducedBlochVector } from '../js/quantum/bloch.js';
import { findShortestCircuit, enumeratePlacements } from '../js/quantum/solver.js';

const R = Math.SQRT1_2;
const NEAR = 1e-9;

/** A tiny seeded random number generator (mulberry32): same seed, same sequence. */
function seededRng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A rng that returns the given numbers one after another (and then repeats the last). */
function fixedRng(...values) {
  let k = 0;
  return () => values[Math.min(k++, values.length - 1)];
}

/** Assert two numbers are within tolerance. */
function near(actual, expected, message, tolerance = NEAR) {
  assert.ok(Math.abs(actual - expected) < tolerance, `${message ?? ''} expected ${expected}, got ${actual}`);
}

/** Assert a state has exactly these amplitudes (each a number | [re, im]), within tolerance. */
function assertAmplitudes(state, expected) {
  assert.equal(state.amplitudes.length, expected.length);
  expected.forEach((e, i) => {
    const want = toComplex(e);
    assert.ok(approxEqual(state.amplitudes[i], want), `amplitude ${i}: expected ${want.re}+${want.im}i, got ${state.amplitudes[i].re}+${state.amplitudes[i].im}i`);
  });
}

/** Multiply two 2x2 matrices of {re, im}. */
function matMul(a, b) {
  return [0, 1].map((r) => [0, 1].map((c) => add(mul(a[r][0], b[0][c]), mul(a[r][1], b[1][c]))));
}

/** Compare two 2x2 matrices, optionally after multiplying the first by a phase. */
function matEqual(a, b, phase = ONE) {
  return [0, 1].every((r) => [0, 1].every((c) => approxEqual(mul(phase, a[r][c]), b[r][c])));
}

const M = (id) => GATES[id].matrix;
const one = (gate, target) => ({ gate, target });
const cnot = (control, target) => ({ gate: 'CNOT', control, target });

// ---------------------------------------------------------------- complex.js

test('complex numbers: arithmetic, polar form and conversion', () => {
  assert.deepEqual(add(complex(1, 2), complex(3, -1)), { re: 4, im: 1 });
  assert.deepEqual(sub(complex(1, 2), complex(3, -1)), { re: -2, im: 3 });
  assert.deepEqual(mul(I, I), { re: -1, im: 0 });
  assert.deepEqual(scale(complex(1, -2), 3), { re: 3, im: -6 });
  assert.deepEqual(conj(complex(1, 2)), { re: 1, im: -2 });
  assert.equal(abs(complex(3, 4)), 5);
  assert.equal(abs2(complex(3, 4)), 25);
  near(arg(I), Math.PI / 2);
  assert.ok(approxEqual(fromPolar(2, Math.PI), complex(-2, 0)));
  assert.ok(isZero(complex(1e-13, -1e-13)));
  assert.ok(!isZero(complex(1e-6, 0)));
  assert.deepEqual(toComplex(2), { re: 2, im: 0 });
  assert.deepEqual(toComplex([1, 2]), { re: 1, im: 2 });
  assert.deepEqual(toComplex({ re: 1, im: 2 }), { re: 1, im: 2 });
  assert.throws(() => toComplex('x'), /complex number/);
  assert.equal(Object.is(complex(-0, -0).re, 0), true);
  assert.deepEqual([ZERO, ONE, I], [{ re: 0, im: 0 }, { re: 1, im: 0 }, { re: 0, im: 1 }]);
});

// ---------------------------------------------------------- the required five

test('H|0⟩ gives 50/50', () => {
  const after = applyGate(createState(1), 'H', { target: 0 });
  assertAmplitudes(after, [R, R]);
  const [p0, p1] = probabilities(after);
  near(p0, 0.5);
  near(p1, 0.5);
});

test('X|0⟩ = |1⟩', () => {
  const after = applyGate(createState(1), 'X', { target: 0 });
  assert.deepEqual(after, createState(1, '1'));
});

test('HZH = X (matrix and on states)', () => {
  const hzh = matMul(M('H'), matMul(M('Z'), M('H')));
  assert.ok(matEqual(hzh, M('X')));
  [createState(1, '0'), createState(1, '1'), createState(1, [{ re: 0.6, im: 0 }, { re: 0, im: 0.8 }])].forEach((start) => {
    const viaHzh = ['H', 'Z', 'H'].reduce((s, g) => applyGate(s, g, { target: 0 }), start);
    const viaX = applyGate(start, 'X', { target: 0 });
    assertAmplitudes(viaHzh, viaX.amplitudes);
  });
});

test('H then CNOT makes a Bell state', () => {
  const afterH = applyGate(createState(2), 'H', { target: 0 });
  const bell = applyGate(afterH, 'CNOT', { control: 0, target: 1 });
  assertAmplitudes(bell, [R, 0, 0, R]);
  assert.equal(formatKet(bell), '1/√2|00⟩ + 1/√2|11⟩');
});

test('measurement probabilities sum to 1', () => {
  const states = [
    createState(1, '1'),
    applyGate(createState(1), 'H', { target: 0 }),
    createState(3, [1, 2, 3, 4, 5, 6, 7, 8]),
    createState(2, [{ re: 1, im: 1 }, [0, 2], '1/2', '-i']),
  ];
  states.forEach((state) => {
    near(probabilities(state).reduce((a, b) => a + b, 0), 1);
    near(norm(state), 1);
  });
});

// -------------------------------------------------------------------- gates

test('S*S = Z and T*T = S and HYH = −Y (as matrices up to the right phase)', () => {
  assert.ok(matEqual(matMul(M('S'), M('S')), M('Z')));
  assert.ok(matEqual(matMul(M('T'), M('T')), M('S')));
  const hyh = matMul(M('H'), matMul(M('Y'), M('H')));
  assert.ok(matEqual(hyh, M('Y'), complex(-1, 0)));
  assert.ok(!matEqual(hyh, M('Y')));
});

test('Y|0⟩ = i|1⟩', () => {
  const after = applyGate(createState(1), 'Y', { target: 0 });
  assertAmplitudes(after, [0, [0, 1]]);
  assert.equal(formatKet(after), 'i|1⟩');
});

test('each gate matrix is unitary and every gate has complete info', () => {
  SINGLE_QUBIT_GATES.forEach((id) => {
    const gate = GATES[id];
    const dagger = [0, 1].map((r) => [0, 1].map((c) => conj(gate.matrix[c][r])));
    assert.ok(matEqual(matMul(gate.matrix, dagger), [[ONE, ZERO], [ZERO, ONE]]), `${id} is unitary`);
    assert.equal(gate.arity, 1);
    assert.equal(gate.unitary, true);
  });
  Object.entries(GATES).forEach(([id, gate]) => {
    assert.equal(gate.id, id);
    assert.ok(gate.name.length > 0 && gate.description.length > 0);
  });
  assert.equal(GATES.H.name, 'Hadamard');
  assert.equal(GATES.X.name, 'Pauli-X (flip)');
  assert.equal(GATES.CNOT.arity, 2);
  assert.equal(GATES.MEASURE.unitary, false);
  assert.deepEqual(SINGLE_QUBIT_GATES, ['H', 'X', 'Y', 'Z', 'S', 'T']);
  assert.throws(() => { GATES.H.matrix[0][0].re = 5; }, TypeError);
});

test('CNOT truth table on 2 qubits for every control/target pair', () => {
  [[0, 1], [1, 0]].forEach(([control, target]) => {
    for (let index = 0; index < 4; index += 1) {
      const bits = bitsOf(index, 2);
      const expected = [...bits];
      if (bits[control] === 1) expected[target] ^= 1;
      const after = applyCNOT(createState(2, index), control, target);
      assert.deepEqual(after, createState(2, expected.join('')), `control ${control}, target ${target}, input ${bits.join('')}`);
    }
  });
});

test('CNOT truth table on 3 qubits for every control/target pair', () => {
  for (let control = 0; control < 3; control += 1) {
    for (let target = 0; target < 3; target += 1) {
      if (control === target) continue;
      for (let index = 0; index < 8; index += 1) {
        const bits = bitsOf(index, 3);
        const expected = [...bits];
        if (bits[control] === 1) expected[target] ^= 1;
        const after = applyGate(createState(3, index), 'CNOT', { control, target });
        assert.deepEqual(after, createState(3, expected.join('')), `control ${control}, target ${target}, input ${bits.join('')}`);
      }
    }
  }
});

test('CNOT acts on superpositions and rejects bad qubits', () => {
  const plus1 = applyGate(createState(2, '01'), 'H', { target: 0 }); // (|01⟩ + |11⟩)/√2
  assertAmplitudes(applyCNOT(plus1, 0, 1), [0, R, R, 0]); // (|01⟩ + |10⟩)/√2
  assert.throws(() => applyCNOT(createState(2), 0, 0), /two different qubits/);
  assert.throws(() => applyCNOT(createState(2), 0, 2), /Qubit 2 is out of range for a 2-qubit register/);
  assert.throws(() => applyGate(createState(2), 'CNOT', { target: 1 }), /control/);
});

test('gates act on every qubit of 1..4 qubit registers (hand-computed states)', () => {
  for (let n = 1; n <= MAX_QUBITS; n += 1) {
    for (let q = 0; q < n; q += 1) {
      // X on qubit q of |0…0⟩ sets exactly bit q, which is index 2^(n-1-q).
      const flipped = applyGate(createState(n), 'X', { target: q });
      assert.deepEqual(flipped, createState(n, 2 ** (n - 1 - q)), `X on qubit ${q} of ${n}`);
      // H on qubit q gives amplitude 1/√2 at index 0 and at index 2^(n-1-q).
      const plus = applyGate(createState(n), 'H', { target: q });
      const expected = Array(2 ** n).fill(0);
      expected[0] = R;
      expected[2 ** (n - 1 - q)] = R;
      assertAmplitudes(plus, expected);
      // Z leaves |0⟩ alone but flips the sign of a |1⟩ on that qubit.
      assertAmplitudes(applyGate(createState(n), 'Z', { target: q }), createState(n).amplitudes);
      const zOne = applyGate(createState(n, 2 ** (n - 1 - q)), 'Z', { target: q });
      assertAmplitudes(zOne, expected.map((_, i) => (i === 2 ** (n - 1 - q) ? -1 : 0)));
      // S gives i and T gives e^{iπ/4} on a |1⟩ of that qubit.
      assertAmplitudes(applyGate(createState(n, 2 ** (n - 1 - q)), 'S', { target: q }), expected.map((_, i) => (i === 2 ** (n - 1 - q) ? [0, 1] : 0)));
      assertAmplitudes(applyGate(createState(n, 2 ** (n - 1 - q)), 'T', { target: q }), expected.map((_, i) => (i === 2 ** (n - 1 - q) ? [R, R] : 0)));
    }
  }
  // Hand-computed: H on qubit 1 of |01⟩ in 2 qubits = |0⟩(|0⟩−|1⟩)/√2.
  assertAmplitudes(applyGate(createState(2, '01'), 'H', { target: 1 }), [R, -R, 0, 0]);
  // Hand-computed: X on qubit 2 of |110⟩ = |111⟩.
  assert.deepEqual(applyGate(createState(3, '110'), 'X', { target: 2 }), createState(3, '111'));
  assert.throws(() => applyGate(createState(2), 'H', { target: 3 }), /Qubit 3 is out of range for a 2-qubit register/);
  assert.throws(() => applyGate(createState(2), 'H', { target: -1 }), /out of range/);
});

test('gates return new states and never change their inputs', () => {
  const start = createState(2);
  const copy = JSON.parse(JSON.stringify(start));
  const after = applyGate(start, 'H', { target: 0 });
  applyGate(after, 'CNOT', { control: 0, target: 1 });
  assert.deepEqual(start, copy);
  assert.notEqual(after, start);
  assert.notEqual(applyCNOT(start, 0, 1), start);
});

test('gate errors: unknown gate, MEASURE and a missing target', () => {
  assert.throws(() => applyGate(createState(1), 'Q', { target: 0 }), /Unknown gate "Q"/);
  assert.throws(() => applyGate(createState(1), 'MEASURE', { target: 0 }), /measureQubit/);
  assert.throws(() => applyGate(createState(1), 'H'), /target/);
  assert.throws(() => applySingleQubitGate(createState(1), [[1, 0]], 0), /2x2/);
  assert.throws(() => applyGate({ numQubits: 2, amplitudes: [] }, 'H', { target: 0 }), /needs 4 amplitudes/);
});

test('GHZ state on 3 qubits', () => {
  let state = createState(3);
  state = applyGate(state, 'H', { target: 0 });
  state = applyGate(state, 'CNOT', { control: 0, target: 1 });
  state = applyGate(state, 'CNOT', { control: 1, target: 2 });
  assertAmplitudes(state, [R, 0, 0, 0, 0, 0, 0, R]);
  assert.equal(formatKet(state), '1/√2|000⟩ + 1/√2|111⟩');
  assert.deepEqual(sample(state, 200, seededRng(7)).counts['010'], 0);
});

// ------------------------------------------------------------------- state.js

test('createState variants: default, index, bits, amplitudes and strings', () => {
  assert.deepEqual(createState(2), { numQubits: 2, amplitudes: [{ re: 1, im: 0 }, { re: 0, im: 0 }, { re: 0, im: 0 }, { re: 0, im: 0 }] });
  assert.deepEqual(createState(2, 3), createState(2, '11'));
  assert.deepEqual(createState(2, 1), createState(2, '01'));
  assertAmplitudes(createState(2, '01'), [0, 1, 0, 0]);
  assertAmplitudes(createState(2, '10'), [0, 0, 1, 0]);
  assertAmplitudes(createState(1, [1, 1]), [R, R]);
  assertAmplitudes(createState(1, [[1, 0], [0, 1]]), [R, [0, R]]);
  assertAmplitudes(createState(1, ['1/√2', '-1/√2']), [R, -R]);
  assertAmplitudes(createState(1, ['1', 'i']), [R, [0, R]]);
  assertAmplitudes(createState(2, ['1', 0, 0, { re: 1, im: 0 }]), [R, 0, 0, R]);
  assertAmplitudes(createState(1, [3, 4]), [0.6, 0.8]);
});

test('createState rejects bad input with clear messages', () => {
  assert.throws(() => createState(0), /1 to 4/);
  assert.throws(() => createState(5), /1 to 4/);
  assert.throws(() => createState(1.5), /1 to 4/);
  assert.throws(() => createState(2, 4), /out of range for a 2-qubit register/);
  assert.throws(() => createState(2, -1), /out of range/);
  assert.throws(() => createState(2, 1.5), /out of range/);
  assert.throws(() => createState(2, '1'), /exactly 2 digits/);
  assert.throws(() => createState(2, '012'), /bit string/);
  assert.throws(() => createState(2, 'ab'), /bit string/);
  assert.throws(() => createState(2, [1, 0]), /needs 4 amplitudes/);
  assert.throws(() => createState(1, [0, 0]), /all amplitudes equal to zero/);
  assert.throws(() => createState(1, ['hello', 1]), /Cannot understand/);
  assert.throws(() => createState(1, {}), /basis index/);
  assert.throws(() => createState(1, [NaN, 1]), /complex number/);
});

test('normalize and norm and the basis helpers', () => {
  const raw = { numQubits: 1, amplitudes: [complex(3, 0), complex(0, 4)] };
  near(norm(raw), 5);
  assertAmplitudes(normalize(raw), [0.6, [0, 0.8]]);
  assert.equal(raw.amplitudes[0].re, 3);
  assert.throws(() => normalize({ numQubits: 1, amplitudes: [ZERO, ZERO] }), /zero/);
  assert.equal(basisLabel(1, 2), '01');
  assert.equal(basisLabel(5, 4), '0101');
  assert.deepEqual(bitsOf(1, 2), [0, 1]);
  assert.deepEqual(bitsOf(6, 3), [1, 1, 0]);
  assert.throws(() => basisLabel(4, 2), /out of range/);
});

test('in |01⟩ qubit 0 is 0 and qubit 1 is 1', () => {
  const state = createState(2, '01');
  assert.equal(measureQubit(state, 0, fixedRng(0.5)).outcome, 0);
  assert.equal(measureQubit(state, 1, fixedRng(0.5)).outcome, 1);
  assert.equal(measureAll(state).bits, '01');
  assert.equal(measureAll(state).index, 1);
});

test('measureQubit collapses and renormalizes (seeded rng)', () => {
  const bell = applyGate(applyGate(createState(2), 'H', { target: 0 }), 'CNOT', { control: 0, target: 1 });
  const low = measureQubit(bell, 0, fixedRng(0.1)); // 0.1 < 0.5 means outcome 0
  assert.equal(low.outcome, 0);
  near(low.probability, 0.5);
  assertAmplitudes(low.state, [1, 0, 0, 0]);
  const high = measureQubit(bell, 1, fixedRng(0.9));
  assert.equal(high.outcome, 1);
  assertAmplitudes(high.state, [0, 0, 0, 1]);
  // Measuring one qubit of a product state keeps the other qubit's blend.
  const product = applyGate(createState(2), 'H', { target: 1 });
  const collapsed = measureQubit(product, 0, fixedRng(0.3));
  assert.equal(collapsed.outcome, 0);
  near(collapsed.probability, 1);
  assertAmplitudes(collapsed.state, [R, R, 0, 0]);
  // Impossible outcomes never happen, whatever the rng says.
  [0, 0.5, 0.999999999].forEach((r) => assert.equal(measureQubit(createState(1, '1'), 0, fixedRng(r)).outcome, 1));
  [0, 0.5, 0.999999999].forEach((r) => assert.equal(measureQubit(createState(1, '0'), 0, fixedRng(r)).outcome, 0));
  assert.throws(() => measureQubit(createState(2), 2), /out of range/);
});

test('measureAll collapses to a basis state (seeded rng)', () => {
  const ghz = applyGate(applyGate(applyGate(createState(3), 'H', { target: 0 }), 'CNOT', { control: 0, target: 1 }), 'CNOT', { control: 1, target: 2 });
  const first = measureAll(ghz, fixedRng(0.2));
  assert.deepEqual([first.index, first.bits], [0, '000']);
  near(first.probability, 0.5);
  assert.deepEqual(first.state, createState(3, '000'));
  const second = measureAll(ghz, fixedRng(0.8));
  assert.deepEqual([second.index, second.bits], [7, '111']);
  const rng = seededRng(42);
  for (let k = 0; k < 50; k += 1) assert.ok(['000', '111'].includes(measureAll(ghz, rng).bits));
});

test('sample() statistics are close to probabilities and counts sum to shots', () => {
  const state = createState(2, [1, 1, 1, 3]); // probabilities 1/12, 1/12, 1/12, 9/12
  const shots = 20000;
  const { counts, shots: reported } = sample(state, shots, seededRng(2026));
  assert.equal(reported, shots);
  // Object.keys() lists number-like keys such as '10' first, so check the labels in index order instead.
  assert.deepEqual([0, 1, 2, 3].map((i) => basisLabel(i, 2) in counts), [true, true, true, true]);
  assert.equal(Object.keys(counts).length, 4);
  assert.equal(Object.values(counts).reduce((a, b) => a + b, 0), shots);
  probabilities(state).forEach((p, i) => {
    near(counts[basisLabel(i, 2)] / shots, p, `label ${basisLabel(i, 2)}`, 0.02);
  });
  // Every label is listed even when it never happens.
  assert.deepEqual(sample(createState(2, '10'), 5, seededRng(1)).counts, { '00': 0, '01': 0, '10': 5, '11': 0 });
  assert.deepEqual(sample(createState(1), 0).counts, { 0: 0, 1: 0 });
  assert.throws(() => sample(createState(1), -1), /shots/);
});

// ----------------------------------------------------------------- simulator

test('validateCircuit catches every error kind', () => {
  assert.deepEqual(validateCircuit(2, [[one('H', 0)], [cnot(0, 1)], [one('MEASURE', 1)]]), { ok: true, errors: [] });
  assert.deepEqual(validateCircuit(2, []), { ok: true, errors: [] });

  const unknown = validateCircuit(2, [[one('H', 0)], [one('FOO', 0)]]);
  assert.equal(unknown.ok, false);
  assert.equal(unknown.errors[0].column, 1);
  assert.match(unknown.errors[0].message, /Unknown gate "FOO"/);

  const range = validateCircuit(2, [[one('X', 2)]]);
  assert.match(range.errors[0].message, /Qubit 2 is out of range for a 2-qubit register/);
  assert.match(validateCircuit(2, [[cnot(0, 5)]]).errors[0].message, /Qubit 5 is out of range/);
  assert.match(validateCircuit(2, [[one('X', -1)]]).errors[0].message, /out of range/);

  const same = validateCircuit(2, [[cnot(1, 1)]]);
  assert.match(same.errors[0].message, /two different qubits/);

  const twice = validateCircuit(3, [[one('H', 0), one('X', 0)], [cnot(0, 1), one('Z', 1)], [cnot(0, 1), cnot(2, 0)]]);
  assert.deepEqual(twice.errors.map((e) => e.column), [0, 1, 2]);
  twice.errors.forEach((e) => assert.match(e.message, /used twice in the same column/));

  assert.match(validateCircuit(2, [[{ gate: 'CNOT', target: 1 }]]).errors[0].message, /control and a target/);
  assert.match(validateCircuit(2, [[{ gate: 'H' }]]).errors[0].message, /target/);
  assert.match(validateCircuit(2, ['nope']).errors[0].message, /list of gate placements/);
  assert.equal(validateCircuit(2, [[one('H', 0), one('X', 1)]]).ok, true);
  assert.throws(() => validateCircuit(9, []), /1 to 4/);
  assert.throws(() => validateCircuit(2, 'x'), /array of columns/);
});

test('runCircuit step states: states.length === columns + 1', () => {
  const columns = [[one('H', 0)], [cnot(0, 1)], [one('MEASURE', 0)]];
  const run = runCircuit({ numQubits: 2, columns });
  assert.equal(run.states.length, columns.length + 1);
  assert.equal(run.numQubits, 2);
  assert.deepEqual(run.states[0], createState(2));
  assertAmplitudes(run.states[1], [R, 0, R, 0]);
  assertAmplitudes(run.states[2], [R, 0, 0, R]);
  assertAmplitudes(run.states[3], [R, 0, 0, R]); // MEASURE ignored by default
  assert.equal(run.final, run.states[3]);
  assert.deepEqual(run.measurements, []);
  assert.equal(runCircuit({ numQubits: 1, columns: [] }).states.length, 1);
});

test('runCircuit with an initial state and with parallel gates in one column', () => {
  const run = runCircuit({ numQubits: 3, initial: '101', columns: [[one('X', 0), one('H', 1), one('Z', 2)]] });
  assertAmplitudes(run.states[0], createState(3, '101').amplitudes);
  // X turns |101⟩ into |001⟩, H blends qubit 1, and Z flips the sign because qubit 2 is 1.
  assertAmplitudes(run.final, [0, -R, 0, -R, 0, 0, 0, 0]);
  const fromState = runCircuit({ numQubits: 1, initial: createState(1, '1'), columns: [[one('X', 0)]] });
  assert.deepEqual(fromState.final, createState(1, '0'));
  assert.throws(() => runCircuit({ numQubits: 2, columns: [[one('H', 0)], [one('H', 7)]] }), /Column 2: Qubit 7 is out of range/);
  assert.throws(() => runCircuit({ numQubits: 2, columns: [], measure: 'sometimes' }), /measure must be/);
  assert.throws(() => runCircuit({ numQubits: 2, columns: [], initial: createState(1) }), /2-qubit state/);
});

test('runCircuit with measure collapse records measurements', () => {
  const columns = [[one('H', 0)], [cnot(0, 1)], [one('MEASURE', 0)], [one('MEASURE', 1)]];
  const run = runCircuit({ numQubits: 2, columns, measure: 'collapse', rng: fixedRng(0.9) });
  assert.deepEqual(run.measurements, [{ column: 2, qubit: 0, outcome: 1 }, { column: 3, qubit: 1, outcome: 1 }]);
  assertAmplitudes(run.states[3], [0, 0, 0, 1]);
  assertAmplitudes(run.final, [0, 0, 0, 1]);
  const zero = runCircuit({ numQubits: 2, columns, measure: 'collapse', rng: fixedRng(0.1) });
  assert.deepEqual(zero.measurements.map((m) => m.outcome), [0, 0]);
});

test('simulateShots without MEASURE samples every qubit at the end', () => {
  const columns = [[one('H', 0)], [cnot(0, 1)]];
  const result = simulateShots({ numQubits: 2, columns }, 4000, seededRng(11));
  assert.equal(result.shots, 4000);
  assert.deepEqual(Object.keys(result.counts).sort(), ['00', '01', '10', '11']);
  assert.equal(result.counts['01'], 0);
  assert.equal(result.counts['10'], 0);
  assert.equal(result.counts['00'] + result.counts['11'], 4000);
  near(result.counts['00'] / 4000, 0.5, 'bell split', 0.05);
  assert.deepEqual(result.measuredQubits, [0, 1]);
  assert.equal(simulateShots({ numQubits: 1, columns: [[one('X', 0)]] }, undefined, seededRng(1)).shots, 100);
});

test('simulateShots with MEASURE reads a qubit where its MEASURE sits', () => {
  // Qubit 0 is measured in the middle of the circuit, then flipped by X: the recorded bit is the value BEFORE the flip.
  const columns = [[one('H', 0)], [one('MEASURE', 0)], [one('X', 0)]];
  const result = simulateShots({ numQubits: 2, columns }, 2000, seededRng(5));
  assert.deepEqual(result.measuredQubits, [0]);
  assert.equal(result.counts['01'], 0); // qubit 1 is never measured and stays 0
  assert.equal(result.counts['11'], 0);
  near(result.counts['00'] / 2000, 0.5, 'measured half', 0.06);
  assert.equal(result.counts['00'] + result.counts['10'], 2000);
  // Measuring one half of a Bell pair leaves the other half correlated, and the unmeasured qubit is read at the end.
  const bell = [[one('H', 0)], [cnot(0, 1)], [one('MEASURE', 0)]];
  const correlated = simulateShots({ numQubits: 2, columns: bell }, 1000, seededRng(9));
  assert.equal(correlated.counts['01'] + correlated.counts['10'], 0);
  assert.equal(correlated.counts['00'] + correlated.counts['11'], 1000);
  assert.throws(() => simulateShots({ numQubits: 1, columns: [[one('H', 3)]] }), /out of range/);
});

// ------------------------------------------------------------------ compare.js

test('innerProduct and fidelity', () => {
  const zero = createState(1, '0');
  const plus = applyGate(zero, 'H', { target: 0 });
  assert.ok(approxEqual(innerProduct(zero, zero), ONE));
  assert.ok(approxEqual(innerProduct(zero, plus), complex(R, 0)));
  near(fidelity(zero, plus), 0.5);
  near(fidelity(zero, createState(1, '1')), 0);
  near(fidelity(plus, plus), 1);
  assert.throws(() => innerProduct(createState(1), createState(2)), /Cannot compare/);
});

test('isSameState ignores global phase (−1, i, e^{iπ/4}) but rejects different states', () => {
  const bell = applyGate(applyGate(createState(2), 'H', { target: 0 }), 'CNOT', { control: 0, target: 1 });
  const times = (state, phase) => ({ numQubits: state.numQubits, amplitudes: state.amplitudes.map((a) => mul(a, phase)) });
  [complex(-1, 0), I, fromPolar(1, Math.PI / 4), complex(0, -1)].forEach((phase) => {
    assert.ok(isSameState(bell, times(bell, phase)), `phase ${phase.re}+${phase.im}i`);
  });
  assert.ok(isSameState(bell, bell));
  assert.ok(!isSameState(createState(1, '0'), createState(1, '1')));
  const plus = createState(1, [1, 1]);
  const minus = createState(1, [1, -1]);
  assert.ok(!isSameState(plus, minus)); // a RELATIVE sign is not a global phase
  assert.ok(!isSameState(plus, createState(1, [1, [0, 1]])));
  assert.ok(!isSameState(createState(1, '0'), createState(2, '00')));
  assert.ok(!isSameState(bell, createState(2, [1, 0, 0, 1.01])));
  assert.ok(isSameState(bell, createState(2, [1, 0, 0, 1.01]), 0.1));
});

test('describeDifference hints: sign, quarter-turn, eighth-turn, other, wrong-probabilities, none', () => {
  const plus = createState(1, [1, 1]);
  const minus = createState(1, [1, -1]);
  const plusI = createState(1, [1, 'i']);
  const withT = applyGate(plus, 'T', { target: 0 });

  const sign = describeDifference(plus, minus);
  assert.equal(sign.phaseHint, 'sign');
  assert.equal(sign.same, false);
  assert.equal(sign.probabilitiesMatch, true);
  near(sign.fidelity, 0);
  assert.deepEqual(sign.phaseMismatches, [{ index: 1, label: '1', expectedDegrees: 0, actualDegrees: 180 }]);

  const quarter = describeDifference(plus, plusI);
  assert.equal(quarter.phaseHint, 'quarter-turn');
  assert.equal(quarter.phaseMismatches[0].actualDegrees, 90);
  near(quarter.fidelity, 0.5);
  assert.equal(describeDifference(plus, createState(1, [1, '-i'])).phaseHint, 'quarter-turn');

  const eighth = describeDifference(plus, withT);
  assert.equal(eighth.phaseHint, 'eighth-turn');
  assert.equal(eighth.phaseMismatches[0].actualDegrees, 45);

  assert.equal(describeDifference(plus, createState(1, [1, 'e^(i*pi/8)'])).phaseHint, 'other');

  const wrong = describeDifference(createState(1, '0'), createState(1, '1'));
  assert.equal(wrong.phaseHint, 'wrong-probabilities');
  assert.equal(wrong.probabilitiesMatch, false);
  assert.deepEqual(wrong.phaseMismatches, []);
  assert.equal(describeDifference(createState(1, '0'), plus).phaseHint, 'wrong-probabilities');

  const same = describeDifference(plus, { numQubits: 1, amplitudes: plus.amplitudes.map((a) => mul(a, complex(-1, 0))) });
  assert.deepEqual([same.same, same.phaseHint, same.phaseMismatches], [true, 'none', []]);
  near(same.fidelity, 1);
  assert.equal(describeDifference(createState(1), createState(2)).phaseHint, 'wrong-probabilities');
});

test('describeDifference removes global phase and handles a zero first amplitude', () => {
  // Target |1⟩ + |0⟩ style with a global phase on the current state must still report only the RELATIVE phase.
  const target = createState(2, [0, 1, 1, 0]);
  const current = { numQubits: 2, amplitudes: [ZERO, mul(complex(0, 1), complex(R, 0)), mul(complex(0, 1), complex(-R, 0)), ZERO] };
  const result = describeDifference(target, current);
  assert.equal(result.phaseHint, 'sign');
  assert.deepEqual(result.phaseMismatches.map((m) => m.label), ['10']);
  assert.equal(result.phaseMismatches[0].expectedDegrees, 0);
  assert.equal(result.phaseMismatches[0].actualDegrees, 180);
});

// -------------------------------------------------------------------- format.js

test('formatKet exact strings', () => {
  assert.equal(formatKet(createState(1, '0')), '|0⟩');
  assert.equal(formatKet(createState(1, '1')), '|1⟩');
  const plus = createState(1, [1, 1]);
  const minus = createState(1, [1, -1]);
  assert.equal(formatKet(plus), '1/√2|0⟩ + 1/√2|1⟩');
  assert.equal(formatKet(plus, { exact: false }), '0.707|0⟩ + 0.707|1⟩');
  assert.equal(formatKet(minus), '1/√2|0⟩ − 1/√2|1⟩');
  assert.equal(formatKet(minus, { exact: false }), '0.707|0⟩ − 0.707|1⟩');
  const bell = createState(2, [1, 0, 0, 1]);
  assert.equal(formatKet(bell), '1/√2|00⟩ + 1/√2|11⟩');
  assert.equal(formatKet(createState(1, [1, 'i'])), '1/√2|0⟩ + i/√2|1⟩');
  assert.equal(formatKet(applyGate(plus, 'T', { target: 0 })), '1/√2|0⟩ + (1+i)/2|1⟩');
});

test('formatKet extra cases: signs, zeros, noise and complex amplitudes', () => {
  assert.equal(formatKet(createState(1, [-1, 0])), '−|0⟩');
  assert.equal(formatKet(createState(1, [0, '-i'])), '−i|1⟩');
  assert.equal(formatKet(createState(1, [1, '-i'])), '1/√2|0⟩ − i/√2|1⟩');
  assert.equal(formatKet(createState(1, [1, 0]), { includeZeros: true }), '|0⟩ + 0|1⟩');
  assert.equal(formatKet(createState(2, [1, 1, 1, 1])), '1/2|00⟩ + 1/2|01⟩ + 1/2|10⟩ + 1/2|11⟩');
  assert.equal(formatKet({ numQubits: 1, amplitudes: [complex(1, 1e-17), complex(-1e-17, 0)] }), '|0⟩');
  assert.equal(formatKet(applyGate(applyGate(createState(1), 'H', { target: 0 }), 'H', { target: 0 })), '|0⟩');
  assert.equal(formatKet({ numQubits: 1, amplitudes: [complex(0.6, 0), complex(0, 0.8)] }, { exact: false }), '0.6|0⟩ + 0.8i|1⟩');
  const mixed = createState(1, [[1, 0], [0.5, 0.5]]);
  assert.match(formatKet(mixed, { exact: false }), /^0\.\d+\|0⟩ \+ \(0\.\d+\+0\.\d+i\)\|1⟩$/);
  assert.equal(formatKet(createState(1, ['1/√2', '(-1-i)/2'])).includes('(−1−i)/2|1⟩'), true);
  assert.ok(!formatKet(createState(2, [1, 0, 0, -1])).includes('-'));
});

test('formatAmplitude, exactValue, basisKet, formatProbability and nameState', () => {
  assert.equal(formatAmplitude(complex(R, 0)), '1/√2');
  assert.equal(formatAmplitude(complex(-0.5, 0)), '−1/2');
  assert.equal(formatAmplitude(complex(R, 0), { exact: false }), '0.707');
  assert.equal(formatAmplitude(complex(0, R)), 'i/√2');
  assert.equal(formatAmplitude(complex(0, -1)), '−i');
  assert.equal(formatAmplitude(complex(0, 1), { exact: false }), 'i');
  assert.equal(formatAmplitude(complex(0.5, 0.5)), '(1+i)/2');
  assert.equal(formatAmplitude(complex(R, -R)), '(1−i)/√2');
  assert.equal(formatAmplitude(complex(0.853553, 0.353553)), '0.854+0.354i');
  assert.equal(formatAmplitude(complex(0.5, -0.25), { precision: 2 }), '0.5−0.25i');
  assert.equal(formatAmplitude(complex(-1e-17, 1e-17)), '0');
  assert.equal(formatAmplitude(complex(1, 0)), '1');
  assert.equal(formatAmplitude(complex(Math.sqrt(3) / 2, 0)), '√3/2');
  assert.equal(formatAmplitude(complex(0, Math.sqrt(3) / 2)), 'i√3/2');
  assert.equal(formatAmplitude(complex(0.123456, 0), { precision: 2 }), '0.12');

  assert.deepEqual([0, 1, 0.5, R, R / 2, Math.sqrt(3) / 2, 1 / Math.sqrt(3), 0.25].map(exactValue), ['0', '1', '1/2', '1/√2', '1/(2√2)', '√3/2', '1/√3', '1/4']);
  assert.equal(exactValue(0.3), null);
  assert.equal(exactValue(-0.5), '1/2');

  assert.equal(basisKet('01'), '|01⟩');
  assert.throws(() => basisKet('2'), /bit string/);

  assert.deepEqual([0, 0.5, 1, 0.004, 0.996, 0.999999, 0.254, 0.255, 1e-15].map(formatProbability), ['0%', '50%', '100%', '<1%', '>99%', '>99%', '25%', '26%', '0%']);
  assert.equal(formatProbability(0.007), '1%');
  assert.equal(formatProbability(1.2), '100%');
  assert.throws(() => formatProbability(NaN), /probability/);

  const named = (amplitudes) => nameState(createState(1, amplitudes));
  assert.deepEqual(named('0'), { id: 'zero', ket: '|0⟩' });
  assert.deepEqual(named('1'), { id: 'one', ket: '|1⟩' });
  assert.deepEqual(named([1, 1]), { id: 'plus', ket: '|+⟩' });
  assert.deepEqual(named([1, -1]), { id: 'minus', ket: '|−⟩' });
  assert.deepEqual(named([1, 'i']), { id: 'plusI', ket: '|+i⟩' });
  assert.deepEqual(named([1, '-i']), { id: 'minusI', ket: '|−i⟩' });
  assert.deepEqual(named([-1, 1]), { id: 'minus', ket: '|−⟩' }); // up to global phase
  assert.equal(named([3, 4]), null);
  assert.equal(nameState(createState(2)), null);
});

// --------------------------------------------------------------------- parse.js

test('parseAmplitude cases', () => {
  const is = (text, re, im = 0) => {
    const value = parseAmplitude(text);
    assert.ok(Math.abs(value.re - re) < NEAR && Math.abs(value.im - im) < NEAR, `"${text}" gave ${value.re}+${value.im}i`);
  };
  is('1/√2', R);
  is('-1/√2', -R);
  is('−1/√2', -R);
  is('i/√2', 0, R);
  is('-i', 0, -1);
  is('(1+i)/2', 0.5, 0.5);
  is('0.5', 0.5);
  is('1/sqrt(2)', R);
  is('e^(iπ/4)/√2', 0.5, 0.5);
  is('e^(i*pi/2)', 0, 1);
  is('√3/2', Math.sqrt(3) / 2);
  is('  1 / 2  ', 0.5);
  is('2i', 0, 2);
  is('1+2i', 1, 2);
  is('3-4i', 3, -4);
  is('2^3', 8);
  is('2^-1', 0.5);
  is('(1-i)*(1+i)', 2);
  is('i*i', -1);
  is('√(1/2)', R);
  is('sqrt2/2', R);
  is('.5', 0.5);
  is('π', Math.PI);
  assert.deepEqual(parseAmplitude('i*i'), { re: -1, im: 0 });
  assert.equal(Object.is(parseAmplitude('0*-1').re, 0), true);
  assert.deepEqual(parseAmplitude(0.25), { re: 0.25, im: 0 });
  assert.deepEqual(parseAmplitude([1, 2]), { re: 1, im: 2 });
  assert.deepEqual(parseAmplitude({ re: 1, im: 2 }), { re: 1, im: 2 });
  ['', '   ', 'hello', '1/', '(1+i', '1+', '1/0', '1 $ 2', '1)', '*2', 'sqrt', '0^-1', '2 ^'].forEach((bad) => {
    assert.throws(() => parseAmplitude(bad), /Cannot|Unexpected/, `"${bad}" should be rejected`);
  });
  assert.throws(() => parseAmplitude('eval(1)'), Error);
  assert.throws(() => parseAmplitude(null), /complex number/);
  assert.throws(() => parseAmplitude('9^9^9'), /not a finite|Cannot/);
});

// --------------------------------------------------------------------- bloch.js

test('blochVector of the six named states', () => {
  const expected = {
    zero: [[1, 0], [0, 0, 1]],
    one: [[0, 1], [0, 0, -1]],
    plus: [[1, 1], [1, 0, 0]],
    minus: [[1, -1], [-1, 0, 0]],
    plusI: [[1, 'i'], [0, 1, 0]],
    minusI: [[1, '-i'], [0, -1, 0]],
  };
  Object.entries(expected).forEach(([name, [amplitudes, [x, y, z]]]) => {
    const v = blochVector(createState(1, amplitudes));
    near(v.x, x, `${name} x`);
    near(v.y, y, `${name} y`);
    near(v.z, z, `${name} z`);
    assert.deepEqual(Object.keys(v), ['x', 'y', 'z']);
  });
  assert.equal(Object.is(blochVector(createState(1, '0')).x, 0), true);
  assert.throws(() => blochVector(createState(2)), /one-qubit/);
});

test('reducedBlochVector of a Bell qubit has purity 0.5', () => {
  const bell = createState(2, [1, 0, 0, 1]);
  [0, 1].forEach((qubit) => {
    const v = reducedBlochVector(bell, qubit);
    near(v.x, 0);
    near(v.y, 0);
    near(v.z, 0);
    near(v.purity, 0.5);
  });
  const ghz = createState(3, [1, 0, 0, 0, 0, 0, 0, 1]);
  near(reducedBlochVector(ghz, 2).purity, 0.5);
  // A product state: qubit 0 is |+⟩ and qubit 1 is |1⟩, both pure.
  const product = applyGate(createState(2, '01'), 'H', { target: 0 });
  const q0 = reducedBlochVector(product, 0);
  const q1 = reducedBlochVector(product, 1);
  [q0.x, q0.purity, q1.z, q1.purity].forEach((value, k) => near(value, [1, 1, -1, 1][k]));
  // Qubit numbering: in |01⟩ qubit 0 points up (z = 1) and qubit 1 points down (z = -1).
  near(reducedBlochVector(createState(2, '01'), 0).z, 1);
  near(reducedBlochVector(createState(2, '01'), 1).z, -1);
  assert.throws(() => reducedBlochVector(bell, 2), /out of range/);
  const single = blochVector(createState(1, [1, 'i']));
  const viaReduced = reducedBlochVector(createState(1, [1, 'i']), 0);
  assert.deepEqual([single.x, single.y, single.z], [viaReduced.x, viaReduced.y, viaReduced.z]);
});

// --------------------------------------------------------------------- solver.js

/** Apply a list of placements to a state (used to check the solver's answers). */
function applyPlacements(state, placements) {
  return placements.reduce((s, p) => applyGate(s, p.gate, p), state);
}

test('findShortestCircuit results', () => {
  const x = findShortestCircuit({ numQubits: 1, start: '0', target: '1', allowedGates: ['X'] });
  assert.deepEqual(x, [{ gate: 'X', target: 0 }]);

  const minus = findShortestCircuit({ numQubits: 1, start: '0', target: [1, -1], allowedGates: ['H', 'Z'] });
  assert.equal(minus.length, 2);
  assert.ok(isSameState(applyPlacements(createState(1), minus), createState(1, [1, -1])));

  const three = findShortestCircuit({ numQubits: 1, start: '0', target: '1', allowedGates: ['H', 'Z'] });
  assert.equal(three.length, 3);
  assert.deepEqual(three.map((p) => p.gate), ['H', 'Z', 'H']);

  const bell = findShortestCircuit({ numQubits: 2, start: '00', target: [1, 0, 0, 1], allowedGates: ['H', 'CNOT'] });
  assert.equal(bell.length, 2);
  assert.ok(isSameState(applyPlacements(createState(2), bell), createState(2, [1, 0, 0, 1])));

  assert.equal(findShortestCircuit({ numQubits: 1, start: '0', target: '1', allowedGates: ['Z'] }), null);
  assert.equal(findShortestCircuit({ numQubits: 2, start: '00', target: [1, 0, 0, 1], allowedGates: ['H'] }), null);
});

test('findShortestCircuit edge cases: already equal, global phase, limits, 3 qubits and errors', () => {
  assert.deepEqual(findShortestCircuit({ numQubits: 1, start: '0', target: '0', allowedGates: ['H'] }), []);
  // -|1⟩ is the same state as |1⟩, so Z on |1⟩ needs no gates.
  assert.deepEqual(findShortestCircuit({ numQubits: 1, start: createState(1, '1'), target: [0, -1], allowedGates: ['Z'] }), []);
  // Too short a limit: 3 gates are needed but only 2 allowed.
  assert.equal(findShortestCircuit({ numQubits: 1, start: '0', target: '1', allowedGates: ['H', 'Z'], maxGates: 2 }), null);
  assert.equal(findShortestCircuit({ numQubits: 1, start: '0', target: '1', allowedGates: ['H', 'Z'], maxNodes: 2 }), null);
  // S then S is Z, which turns |+⟩ into |−⟩ using only the phase gates.
  const phase = findShortestCircuit({ numQubits: 1, start: [1, 1], target: [1, -1], allowedGates: ['S', 'T'] });
  assert.equal(phase.length, 2);
  const ghz = findShortestCircuit({ numQubits: 3, start: '000', target: [1, 0, 0, 0, 0, 0, 0, 1], allowedGates: ['H', 'CNOT'] });
  assert.equal(ghz.length, 3);
  assert.ok(isSameState(applyPlacements(createState(3), ghz), createState(3, [1, 0, 0, 0, 0, 0, 0, 1])));
  // Works from any starting state, and with a pair CNOT that needs the control on a lower qubit.
  const swapLike = findShortestCircuit({ numQubits: 2, start: '01', target: '11', allowedGates: ['CNOT', 'X'] });
  assert.equal(swapLike.length, 1);
  assert.throws(() => findShortestCircuit({ numQubits: 1, start: '0', target: '1', allowedGates: ['MEASURE'] }), /cannot use gate/);
  assert.throws(() => findShortestCircuit({ numQubits: 1, start: '00', target: '1', allowedGates: ['X'] }), /bit string/);
});

test('enumeratePlacements lists every single-qubit gate on every qubit and CNOT on every ordered pair', () => {
  assert.deepEqual(enumeratePlacements(1, ['H', 'X']), [one('H', 0), one('X', 0)]);
  assert.deepEqual(enumeratePlacements(2, ['H', 'CNOT']), [one('H', 0), one('H', 1), cnot(0, 1), cnot(1, 0)]);
  assert.equal(enumeratePlacements(3, SINGLE_QUBIT_GATES.concat('CNOT')).length, 6 * 3 + 6);
  assert.equal(enumeratePlacements(4, ['CNOT']).length, 12);
  assert.deepEqual(enumeratePlacements(1, ['CNOT']), []);
  assert.deepEqual(enumeratePlacements(2, ['H', 'H']), [one('H', 0), one('H', 1)]);
  assert.throws(() => enumeratePlacements(5, ['H']), /1 to 4/);
});

// ------------------------------------------------- the one-qubit teaching helpers the Learn playground needs

test('one-qubit helpers: named states, shortest path, percentages and ket text', () => {
  const states = { zero: [1, 0], one: [0, 1], plus: [1, 1], minus: [1, -1] };
  Object.entries(states).forEach(([id, amplitudes]) => {
    assert.equal(nameState(createState(1, amplitudes)).id, id);
  });
  // Shortest way from |0⟩ to |−⟩ with X, H, Z takes two gates.
  const path = findShortestCircuit({ numQubits: 1, start: '0', target: [1, -1], allowedGates: ['X', 'H', 'Z'] });
  assert.equal(path.length, 2);
  assert.ok(isSameState(applyPlacements(createState(1), path), createState(1, [1, -1])));
  // Percent chances for the probability bar.
  const plus = createState(1, [1, 1]);
  assert.equal(formatProbability(probabilities(plus)[0]), '50%');
  assert.equal(formatKet(createState(1, '0')), '|0⟩');
});
