// Independent cross-check of the quantum engine against a dense-matrix reference.
// The reference below shares NO code with js/quantum: plain arrays of [re, im] pairs,
// Kronecker products with identities, and permutation-matrix CNOT built from a truth table.
// Example: npm test   (node --test discovers this file)

import test from 'node:test';
import assert from 'node:assert/strict';

import { createState, measureQubit, measureAll, sample, probabilities, norm, MAX_QUBITS } from '../js/quantum/state.js';
import { applyGate, applySingleQubitGate, applyCNOT, SINGLE_QUBIT_GATES } from '../js/quantum/gates.js';
import { validateCircuit, runCircuit, simulateShots } from '../js/quantum/simulator.js';
import { isSameState, describeDifference, fidelity } from '../js/quantum/compare.js';
import { formatAmplitude, formatKet } from '../js/quantum/format.js';
import { parseAmplitude } from '../js/quantum/parse.js';
import { findShortestCircuit } from '../js/quantum/solver.js';

// ---------- reference implementation (dense, independent) ----------

const R = Math.SQRT1_2;
const REF_GATES = {
  H: [[[R, 0], [R, 0]], [[R, 0], [-R, 0]]],
  X: [[[0, 0], [1, 0]], [[1, 0], [0, 0]]],
  Y: [[[0, 0], [0, -1]], [[0, 1], [0, 0]]],
  Z: [[[1, 0], [0, 0]], [[0, 0], [-1, 0]]],
  S: [[[1, 0], [0, 0]], [[0, 0], [0, 1]]],
  T: [[[1, 0], [0, 0]], [[0, 0], [Math.cos(Math.PI / 4), Math.sin(Math.PI / 4)]]],
};

const cmul = ([a, b], [c, d]) => [a * c - b * d, a * d + b * c];
const cadd = ([a, b], [c, d]) => [a + c, b + d];
const IDENT = [[[1, 0], [0, 0]], [[0, 0], [1, 0]]];

function kron(A, B) {
  const n = A.length;
  const m = B.length;
  const out = Array.from({ length: n * m }, () => Array.from({ length: n * m }, () => [0, 0]));
  for (let i = 0; i < n; i += 1) for (let j = 0; j < n; j += 1) for (let k = 0; k < m; k += 1) for (let l = 0; l < m; l += 1) {
    out[i * m + k][j * m + l] = cmul(A[i][j], B[k][l]);
  }
  return out;
}

function matVec(M, v) {
  return M.map((row) => row.reduce((acc, entry, j) => cadd(acc, cmul(entry, v[j])), [0, 0]));
}

// Full-register matrix for a gate on one qubit: qubit 0 is the LEFT factor.
function refSingle(n, gate, target) {
  let M = [[[1, 0]]];
  for (let q = 0; q < n; q += 1) M = kron(M, q === target ? REF_GATES[gate] : IDENT);
  return M;
}

// CNOT as a permutation matrix from the truth table on bit arrays (left bit = qubit 0).
function refCnot(n, control, target) {
  const size = 2 ** n;
  const M = Array.from({ length: size }, () => Array.from({ length: size }, () => [0, 0]));
  for (let input = 0; input < size; input += 1) {
    const bits = [...input.toString(2).padStart(n, '0')].map(Number);
    if (bits[control] === 1) bits[target] ^= 1;
    const output = parseInt(bits.join(''), 2);
    M[output][input] = [1, 0];
  }
  return M;
}

const refStep = (n, v, p) => matVec(p.gate === 'CNOT' ? refCnot(n, p.control, p.target) : refSingle(n, p.gate, p.target), v);

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomVector(n, rng) {
  const raw = Array.from({ length: 2 ** n }, () => [rng() * 2 - 1, rng() * 2 - 1]);
  const len = Math.sqrt(raw.reduce((s, [a, b]) => s + a * a + b * b, 0));
  return raw.map(([a, b]) => [a / len, b / len]);
}

const toState = (n, v) => ({ numQubits: n, amplitudes: v.map(([re, im]) => ({ re, im })) });
const toVector = (state) => state.amplitudes.map((a) => [a.re, a.im]);

function assertVectorsClose(actual, expected, tol, label) {
  assert.equal(actual.length, expected.length, `${label}: length`);
  actual.forEach(([a, b], i) => {
    assert.ok(Math.abs(a - expected[i][0]) < tol && Math.abs(b - expected[i][1]) < tol,
      `${label}: amplitude ${i} is ${a}+${b}i but reference says ${expected[i][0]}+${expected[i][1]}i`);
  });
}

function randomPlacement(n, rng, allowCnot = true) {
  const names = [...SINGLE_QUBIT_GATES, ...(allowCnot && n > 1 ? ['CNOT'] : [])];
  const gate = names[Math.floor(rng() * names.length)];
  const target = Math.floor(rng() * n);
  if (gate !== 'CNOT') return { gate, target };
  let control = Math.floor(rng() * (n - 1));
  if (control >= target) control += 1;
  return { gate, control, target };
}

const key = (state) => JSON.stringify(state);

// ---------- gates vs dense matrices ----------

test('cross-check: every single-qubit gate on every qubit, n = 1..4, random states', () => {
  const rng = mulberry32(11);
  for (let n = 1; n <= MAX_QUBITS; n += 1) {
    for (const gate of SINGLE_QUBIT_GATES) {
      for (let target = 0; target < n; target += 1) {
        for (let trial = 0; trial < 4; trial += 1) {
          const v = randomVector(n, rng);
          const input = toState(n, v);
          const before = key(input);
          const out = applyGate(input, gate, { target });
          assert.equal(key(input), before, 'input must not be mutated');
          assertVectorsClose(toVector(out), matVec(refSingle(n, gate, target), v), 1e-12, `${gate} on q${target} of ${n}`);
        }
      }
    }
  }
});

test('cross-check: CNOT for every ordered control/target pair, n = 2..4', () => {
  const rng = mulberry32(12);
  for (let n = 2; n <= MAX_QUBITS; n += 1) {
    for (let control = 0; control < n; control += 1) {
      for (let target = 0; target < n; target += 1) {
        if (control === target) continue;
        for (let trial = 0; trial < 4; trial += 1) {
          const v = randomVector(n, rng);
          const input = toState(n, v);
          const before = key(input);
          const out = applyCNOT(input, control, target);
          assert.equal(key(input), before, 'input must not be mutated');
          assertVectorsClose(toVector(out), matVec(refCnot(n, control, target), v), 1e-12, `CNOT ${control}->${target} of ${n}`);
          assert.deepEqual(applyGate(input, 'CNOT', { control, target }), out);
        }
      }
    }
  }
});

test('cross-check: returned states never share references with the input or each other', () => {
  const input = toState(2, randomVector(2, mulberry32(3)));
  for (const out of [applyGate(input, 'H', { target: 0 }), applyCNOT(input, 0, 1), applyGate(input, 'Z', { target: 1 })]) {
    assert.notEqual(out.amplitudes, input.amplitudes);
    out.amplitudes.forEach((a) => assert.ok(!input.amplitudes.includes(a)));
  }
  const m = measureQubit(input, 0, () => 0.3);
  m.state.amplitudes.forEach((a) => assert.ok(!input.amplitudes.includes(a)));
  const created = createState(2, input.amplitudes);
  created.amplitudes.forEach((a) => assert.ok(!input.amplitudes.includes(a)));
});

test('cross-check: random circuits of depth 20 match the dense reference and keep the norm', () => {
  for (let seed = 1; seed <= 12; seed += 1) {
    const rng = mulberry32(seed * 101);
    const n = 1 + (seed % MAX_QUBITS);
    const placements = Array.from({ length: 20 }, () => randomPlacement(n, rng));
    const v0 = randomVector(n, rng);
    let ref = v0;
    let current = toState(n, v0);
    for (const p of placements) {
      ref = refStep(n, ref, p);
      current = applyGate(current, p.gate, p);
      assert.ok(Math.abs(norm(current) - 1) < 1e-12, `norm drifted at seed ${seed}`);
    }
    assertVectorsClose(toVector(current), ref, 1e-11, `seed ${seed} applyGate chain`);

    const columns = placements.map((p) => [p]);
    const run = runCircuit({ numQubits: n, columns, initial: toState(n, v0) });
    assert.equal(run.states.length, 21);
    assertVectorsClose(toVector(run.final), ref, 1e-11, `seed ${seed} runCircuit`);
    assert.ok(Math.abs(probabilities(run.final).reduce((a, b) => a + b, 0) - 1) < 1e-12);
  }
});

test('cross-check: columns with several placements at once match sequential reference', () => {
  const rng = mulberry32(77);
  const n = 4;
  const v0 = randomVector(n, rng);
  const columns = [
    [{ gate: 'H', target: 0 }, { gate: 'T', target: 1 }, { gate: 'Y', target: 3 }],
    [{ gate: 'CNOT', control: 3, target: 0 }, { gate: 'S', target: 2 }],
    [{ gate: 'CNOT', control: 1, target: 2 }, { gate: 'H', target: 3 }],
  ];
  let ref = v0;
  columns.flat().forEach((p) => { ref = refStep(n, ref, p); });
  const { final, states } = runCircuit({ numQubits: n, columns, initial: toState(n, v0) });
  assert.equal(states.length, 4);
  assertVectorsClose(toVector(final), ref, 1e-12, 'multi-placement columns');
});

test('cross-check: a very long random circuit (3000 gates) stays normalized', () => {
  const rng = mulberry32(5);
  let state = createState(4);
  for (let i = 0; i < 3000; i += 1) {
    const p = randomPlacement(4, rng);
    state = applyGate(state, p.gate, p);
  }
  assert.ok(Math.abs(norm(state) - 1) < 1e-9);
  assert.ok(Math.abs(probabilities(state).reduce((a, b) => a + b, 0) - 1) < 1e-9);
});

test('cross-check: hand-built matrices through applySingleQubitGate match the reference', () => {
  const rng = mulberry32(8);
  const v = randomVector(3, rng);
  for (let target = 0; target < 3; target += 1) {
    const out = applySingleQubitGate(toState(3, v), REF_GATES.Y.map((row) => row.map(([re, im]) => ({ re, im }))), target);
    assertVectorsClose(toVector(out), matVec(refSingle(3, 'Y', target), v), 1e-12, 'custom matrix');
  }
});

// ---------- measurement statistics ----------

const fiveSigma = (p, shots) => 5 * Math.sqrt((p * (1 - p)) / shots) + 1e-9;

test('cross-check: sample() frequencies match probabilities for 2- and 3-qubit states', () => {
  for (const n of [2, 3]) {
    const rng = mulberry32(900 + n);
    const v = randomVector(n, rng);
    const state = toState(n, v);
    const shots = 20000;
    const { counts } = sample(state, shots, mulberry32(4242 + n));
    const probs = v.map(([a, b]) => a * a + b * b);
    assert.equal(Object.values(counts).reduce((a, b) => a + b, 0), shots);
    probs.forEach((p, i) => {
      const label = i.toString(2).padStart(n, '0');
      assert.ok(Math.abs(counts[label] / shots - p) < fiveSigma(p, shots), `${label}: ${counts[label] / shots} vs ${p}`);
    });
  }
});

test('cross-check: measureQubit marginals and collapse match the projection reference', () => {
  for (const n of [2, 3]) {
    const v = randomVector(n, mulberry32(31 + n));
    const state = toState(n, v);
    for (let qubit = 0; qubit < n; qubit += 1) {
      const bitOf = (i) => (i >> (n - 1 - qubit)) & 1;
      const pOne = v.reduce((s, [a, b], i) => s + (bitOf(i) === 1 ? a * a + b * b : 0), 0);
      const rng = mulberry32(555 + qubit);
      const shots = 6000;
      let ones = 0;
      for (let k = 0; k < shots; k += 1) {
        const { outcome, probability, state: after } = measureQubit(state, qubit, rng);
        if (outcome === 1) ones += 1;
        assert.ok(Math.abs(probability - (outcome === 1 ? pOne : 1 - pOne)) < 1e-12);
        const kept = v.map((amp, i) => (bitOf(i) === outcome ? amp : [0, 0]));
        const len = Math.sqrt(kept.reduce((s, [a, b]) => s + a * a + b * b, 0));
        assertVectorsClose(toVector(after), kept.map(([a, b]) => [a / len, b / len]), 1e-12, 'collapse');
        assert.ok(Math.abs(norm(after) - 1) < 1e-12);
      }
      assert.ok(Math.abs(ones / shots - pOne) < fiveSigma(pOne, shots), `q${qubit}: ${ones / shots} vs ${pOne}`);
    }
  }
});

test('cross-check: rng edge values 0 and 0.999999 give sensible, deterministic outcomes', () => {
  const plus = createState(1, [1, 1]);
  assert.equal(measureQubit(plus, 0, () => 0).outcome, 0);
  assert.equal(measureQubit(plus, 0, () => 0.999999).outcome, 1);
  assert.equal(measureQubit(createState(1, 0), 0, () => 0.999999).outcome, 0);
  assert.equal(measureQubit(createState(1, 1), 0, () => 0).outcome, 1);
  const bell = createState(2, [1, 0, 0, 1]);
  assert.equal(measureAll(bell, () => 0).bits, '00');
  assert.equal(measureAll(bell, () => 0.999999).bits, '11');
  assert.equal(measureAll(createState(2, '10'), () => 0).bits, '10');
  assert.equal(measureAll(createState(2, '10'), () => 0.999999).bits, '10');
  assert.equal(sample(createState(2, '01'), 5, () => 0.999999).counts['01'], 5);
});

test('cross-check: measuring one half of a Bell pair fixes the other qubit', () => {
  const bell = createState(2, [1, 0, 0, 1]);
  const rng = mulberry32(1);
  for (let k = 0; k < 200; k += 1) {
    const { outcome, state } = measureQubit(bell, 1, rng);
    const second = measureQubit(state, 0, rng);
    assert.equal(second.outcome, outcome);
    assert.equal(second.probability, 1);
  }
});

// ---------- simulateShots ----------

const ghz = [
  [{ gate: 'H', target: 0 }],
  [{ gate: 'CNOT', control: 0, target: 1 }],
  [{ gate: 'CNOT', control: 1, target: 2 }],
];

test('cross-check: simulateShots on GHZ with no MEASURE', () => {
  const shots = 4000;
  const { counts, measuredQubits } = simulateShots({ numQubits: 3, columns: ghz }, shots, mulberry32(9));
  assert.deepEqual(measuredQubits, [0, 1, 2]);
  assert.equal(Object.keys(counts).length, 8);
  assert.equal(counts['000'] + counts['111'], shots);
  assert.ok(Math.abs(counts['000'] / shots - 0.5) < fiveSigma(0.5, shots));
});

test('cross-check: simulateShots on GHZ with MEASURE on one, several and all qubits', () => {
  const shots = 3000;
  for (const measured of [[1], [0, 2], [0, 1, 2]]) {
    const columns = [...ghz, measured.map((target) => ({ gate: 'MEASURE', target }))];
    const out = simulateShots({ numQubits: 3, columns }, shots, mulberry32(21));
    assert.deepEqual(out.measuredQubits, measured);
    assert.equal(Object.keys(out.counts).length, 8);
    assert.equal(out.counts['000'] + out.counts['111'], shots, `measured ${measured}`);
    assert.ok(Math.abs(out.counts['000'] / shots - 0.5) < fiveSigma(0.5, shots));
  }
});

test('cross-check: a mid-circuit MEASURE reads the qubit where it sits', () => {
  // H on q0, measure q0, then X on q0: the reading must be the value BEFORE the X.
  const columns = [[{ gate: 'H', target: 0 }], [{ gate: 'MEASURE', target: 0 }], [{ gate: 'X', target: 0 }]];
  const shots = 2000;
  const { counts } = simulateShots({ numQubits: 2, columns }, shots, mulberry32(2));
  assert.equal(counts['00'] + counts['10'], shots, 'qubit 1 is always 0');
  assert.ok(Math.abs(counts['00'] / shots - 0.5) < fiveSigma(0.5, shots));
  // Measure before CNOT: results are still perfectly correlated.
  const columns2 = [[{ gate: 'H', target: 0 }], [{ gate: 'MEASURE', target: 0 }], [{ gate: 'CNOT', control: 0, target: 1 }]];
  const two = simulateShots({ numQubits: 2, columns: columns2 }, shots, mulberry32(3));
  assert.equal(two.counts['01'] + two.counts['10'], 0);
  assert.equal(two.counts['00'] + two.counts['11'], shots);
});

test('cross-check: runCircuit collapse records measurements and ignore skips them', () => {
  const columns = [[{ gate: 'H', target: 0 }], [{ gate: 'MEASURE', target: 0 }, { gate: 'X', target: 1 }]];
  const ignored = runCircuit({ numQubits: 2, columns });
  assert.equal(ignored.measurements.length, 0);
  assert.equal(ignored.states.length, 3);
  assertVectorsClose(toVector(ignored.final), matVec(refSingle(2, 'X', 1), matVec(refSingle(2, 'H', 0), [[1, 0], [0, 0], [0, 0], [0, 0]])), 1e-12, 'ignore');
  const collapsed = runCircuit({ numQubits: 2, columns, rng: () => 0.999999, measure: 'collapse' });
  assert.deepEqual(collapsed.measurements, [{ column: 1, qubit: 0, outcome: 1 }]);
  assert.equal(key(collapsed.final), key(createState(2, '11')));
});

// ---------- solver vs brute force ----------

function bruteForceDistance(n, startVec, targetVec, gates, maxDepth) {
  const placements = [];
  for (const g of gates) {
    if (g === 'CNOT') {
      for (let c = 0; c < n; c += 1) for (let t = 0; t < n; t += 1) if (c !== t) placements.push({ gate: g, control: c, target: t });
    } else {
      for (let t = 0; t < n; t += 1) placements.push({ gate: g, target: t });
    }
  }
  const overlap = (a, b) => {
    let re = 0;
    let im = 0;
    a.forEach(([ar, ai], i) => { re += ar * b[i][0] + ai * b[i][1]; im += ar * b[i][1] - ai * b[i][0]; });
    return re * re + im * im;
  };
  const same = (a, b) => overlap(a, b) > 1 - 1e-9;
  if (same(startVec, targetVec)) return 0;
  const seen = [startVec];
  let frontier = [startVec];
  for (let depth = 1; depth <= maxDepth; depth += 1) {
    const next = [];
    for (const v of frontier) {
      for (const p of placements) {
        const after = refStep(n, v, p);
        if (seen.some((s) => same(s, after))) continue;
        if (same(after, targetVec)) return depth;
        seen.push(after);
        next.push(after);
      }
    }
    frontier = next;
  }
  return null;
}

const basisVec = (n, i) => Array.from({ length: 2 ** n }, (_, k) => (k === i ? [1, 0] : [0, 0]));

test('cross-check: findShortestCircuit matches an independent brute-force BFS (minimal length, valid circuit)', () => {
  const cases = [];
  const rng = mulberry32(2024);
  const gateSets = [
    [1, ['H', 'T']], [1, ['H', 'S']], [1, ['H', 'Z']], [1, ['X', 'Z', 'S']], [1, ['H', 'X', 'Y', 'Z', 'S', 'T']],
    [2, ['H', 'CNOT']], [2, ['H', 'X', 'CNOT']], [2, ['H', 'T', 'CNOT']], [2, ['H', 'S', 'Z']],
  ];
  for (const [n, gates] of gateSets) {
    for (let trial = 0; trial < 5; trial += 1) {
      const startIndex = Math.floor(rng() * 2 ** n);
      let v = basisVec(n, startIndex);
      const length = 1 + Math.floor(rng() * 4);
      const placements = [];
      for (let k = 0; k < length; k += 1) {
        let p;
        do { p = randomPlacement(n, rng, gates.includes('CNOT')); } while (!gates.includes(p.gate));
        placements.push(p);
        v = placements.reduce((acc, q, idx) => (idx === placements.length - 1 ? refStep(n, acc, q) : acc), v);
      }
      cases.push({ n, gates, startIndex, targetVec: v });
    }
    // an unreachable-ish case: 1-qubit |+i> from |0> with only X/Z gates, 2-qubit with no entangler
    cases.push({ n, gates, startIndex: 0, targetVec: n === 1 ? [[R, 0], [0, R]] : [[R, 0], [0, 0], [0, 0], [R, 0]] });
  }
  for (const { n, gates, startIndex, targetVec } of cases) {
    const expected = bruteForceDistance(n, basisVec(n, startIndex), targetVec, gates, 5);
    const got = findShortestCircuit({
      numQubits: n, start: startIndex, target: toState(n, targetVec), allowedGates: gates, maxGates: 5,
    });
    const label = `${n}q ${gates} start ${startIndex}`;
    if (expected === null) {
      assert.equal(got, null, label);
      continue;
    }
    assert.equal(got.length, expected, `${label}: engine length vs brute force`);
    const ref = got.reduce((acc, p) => refStep(n, acc, p), basisVec(n, startIndex));
    const ov = ref.reduce((s, [a, b], i) => [s[0] + a * targetVec[i][0] + b * targetVec[i][1], s[1] + a * targetVec[i][1] - b * targetVec[i][0]], [0, 0]);
    assert.ok(ov[0] ** 2 + ov[1] ** 2 > 1 - 1e-9, `${label}: returned circuit does not reach the target`);
    got.forEach((p) => assert.ok(gates.includes(p.gate)));
  }
});

test('cross-check: findShortestCircuit handles global phase, maxGates and maxNodes', () => {
  assert.deepEqual(findShortestCircuit({ numQubits: 1, start: '0', target: [-1, 0], allowedGates: ['X'] }), []);
  assert.deepEqual(findShortestCircuit({ numQubits: 1, start: '0', target: [{ re: 0, im: 1 }, 0], allowedGates: ['X'] }), []);
  assert.equal(findShortestCircuit({ numQubits: 1, start: '0', target: '1', allowedGates: ['H', 'Z'], maxGates: 2 }), null);
  assert.equal(findShortestCircuit({ numQubits: 1, start: '0', target: '1', allowedGates: ['H', 'Z'], maxGates: 3 }).length, 3);
  assert.equal(findShortestCircuit({ numQubits: 1, start: '0', target: '1', allowedGates: ['H', 'Z'], maxNodes: 2 }), null);
  // Y|0> = i|1> is |1> up to global phase
  assert.equal(findShortestCircuit({ numQubits: 1, start: '0', target: '1', allowedGates: ['Y'] }).length, 1);
  // CNOT in both directions on 3 qubits
  const out = findShortestCircuit({ numQubits: 3, start: '100', target: '111', allowedGates: ['CNOT'] });
  assert.equal(out.length, 2);
});

// ---------- parse / format ----------

test('cross-check: parseAmplitude and formatAmplitude round trip for the recognised exact values', () => {
  const texts = ['1/√2', '−1/√2', '1/2', '−1/2', '1/(2√2)', '√3/2', '1/√3', '1/4', '−1/4', 'i', '−i', 'i/√2', '−i/√2', 'i/2',
    '(1+i)/2', '(1−i)/2', '(−1+i)/√2', '(1−i)/√2', '(1+i)/(2√2)', '1', '−1'];
  for (const text of texts) {
    const c = parseAmplitude(text);
    assert.equal(formatAmplitude(c), text, `round trip of ${text}`);
  }
  assert.equal(formatAmplitude({ re: 1e-13, im: -1e-14 }), '0');
  assert.equal(formatAmplitude({ re: -1e-13, im: -1e-14 }, { exact: false }), '0');
  const near = parseAmplitude('1/√2');
  assert.ok(Math.abs(near.re - Math.SQRT1_2) < 1e-15);
});

test('cross-check: parseAmplitude precedence and variants', () => {
  const eq = (text, re, im) => {
    const c = parseAmplitude(text);
    assert.ok(Math.abs(c.re - re) < 1e-12 && Math.abs(c.im - im) < 1e-12, `${text} -> ${c.re}+${c.im}i`);
  };
  eq('1/√2 i', 0, R);
  eq('i/√2', 0, R);
  eq('-1/2', -0.5, 0);
  eq('-i', 0, -1);
  eq('(1+i)/2', 0.5, 0.5);
  eq('(1-i)/sqrt(2)', R, -R);
  eq('e^(iπ/4)/√2', 0.5, 0.5);
  eq('e^(i*pi/4)/sqrt(2)', 0.5, 0.5);
  eq('e^(-iπ/2)', 0, -1);
  eq('√3/2', Math.sqrt(3) / 2, 0);
  eq('1/sqrt(2)', R, 0);
  eq('0.5', 0.5, 0);
  eq('2i', 0, 2);
  eq('1/2^2', 0.25, 0);
  eq('−1/√2', -R, 0);
  assert.deepEqual(parseAmplitude(0.25), { re: 0.25, im: 0 });
  assert.deepEqual(parseAmplitude([0.5, -0.5]), { re: 0.5, im: -0.5 });
  assert.equal(Object.is(parseAmplitude('-0').re, -0), false);
  for (const bad of ['', '   ', 'abc', '1/0', '(1+i', '1+', '*2', '1//2', 'alert(1)', 'process.exit()', '2**3', '((', ')', '√', 'e^', '1/(1-1)']) {
    assert.throws(() => parseAmplitude(bad), /amplitude|zero|Cannot/i, `"${bad}" should throw`);
  }
  assert.throws(() => parseAmplitude(NaN));
  assert.throws(() => parseAmplitude(Infinity));
  assert.throws(() => parseAmplitude(null));
  assert.throws(() => parseAmplitude(undefined));
  assert.throws(() => parseAmplitude('9^9^9'));
});

test('cross-check: formatKet strings from the spec', () => {
  const plus = createState(1, [1, 1]);
  const minus = createState(1, [1, -1]);
  assert.equal(formatKet(createState(1)), '|0⟩');
  assert.equal(formatKet(createState(1, 1)), '|1⟩');
  assert.equal(formatKet(plus), '1/√2|0⟩ + 1/√2|1⟩');
  assert.equal(formatKet(plus, { exact: false }), '0.707|0⟩ + 0.707|1⟩');
  assert.equal(formatKet(minus), '1/√2|0⟩ − 1/√2|1⟩');
  assert.equal(formatKet(minus, { exact: false }), '0.707|0⟩ − 0.707|1⟩');
  assert.equal(formatKet(createState(2, [1, 0, 0, 1])), '1/√2|00⟩ + 1/√2|11⟩');
  assert.equal(formatKet(createState(1, [1, 'i'])), '1/√2|0⟩ + i/√2|1⟩');
  assert.equal(formatKet(applyGate(plus, 'T', { target: 0 })), '1/√2|0⟩ + (1+i)/2|1⟩');
  assert.equal(formatKet(createState(1, [-1, 0])), '−|0⟩');
  assert.equal(formatKet(createState(2, '01'), { includeZeros: true }), '0|00⟩ + |01⟩ + 0|10⟩ + 0|11⟩');
  const dump = formatKet(applyGate(applyGate(createState(3), 'H', { target: 1 }), 'T', { target: 1 }), { exact: false });
  assert.ok(!/-0|−0(?![.\d])|e-/.test(dump), dump);
});

test('cross-check: formatted output never contains "-0", "−0" or exponent noise after many gates', () => {
  const rng = mulberry32(64);
  for (let seed = 0; seed < 30; seed += 1) {
    let s = createState(1 + (seed % 4));
    for (let k = 0; k < 15; k += 1) {
      const p = randomPlacement(s.numQubits, rng);
      s = applyGate(s, p.gate, p);
    }
    for (const exact of [true, false]) {
      const text = formatKet(s, { exact }) + s.amplitudes.map((a) => formatAmplitude(a, { exact })).join(' ');
      assert.ok(!/-0(?![.\d])|−0(?![.\d])|e-\d/.test(text), `bad text: ${text}`);
      assert.ok(!/[+−]0i/.test(text), `pointless +0i / −0i in: ${text}`);
    }
  }
});

// ---------- compare ----------

const phaseFactors = [[-1, 0], [0, 1], [0, -1], [Math.cos(Math.PI / 4), Math.sin(Math.PI / 4)], [Math.cos(1.234), Math.sin(1.234)]];

test('cross-check: isSameState ignores any global phase on random states and gate outputs', () => {
  const rng = mulberry32(606);
  for (let n = 1; n <= 4; n += 1) {
    const v = randomVector(n, rng);
    for (const f of phaseFactors) {
      const rotated = toState(n, v.map((a) => cmul(f, a)));
      assert.ok(isSameState(toState(n, v), rotated), `n=${n} phase ${f}`);
      assert.ok(Math.abs(fidelity(toState(n, v), rotated) - 1) < 1e-12);
    }
  }
  // HZH = X on states, Y|+> vs -i...: gate identities up to phase
  const zero = createState(1);
  assert.ok(isSameState(applyGate(zero, 'Y', { target: 0 }), createState(1, 1)));
  assert.ok(isSameState(applyGate(applyGate(applyGate(zero, 'H', { target: 0 }), 'Z', { target: 0 }), 'H', { target: 0 }), createState(1, 1)));
});

test('cross-check: isSameState tolerance edge: 1e-5 rejected, 1e-8 accepted, in every register size', () => {
  for (let n = 1; n <= 4; n += 1) {
    const base = toState(n, randomVector(n, mulberry32(n * 13)));
    for (const [delta, expected] of [[1e-5, false], [1e-8, true]]) {
      // rotate a single amplitude's phase so the vectors differ by about delta in that component
      const nudged = toState(n, toVector(base).map((a, i) => (i === 0 ? cmul([Math.cos(delta / Math.hypot(...a)), Math.sin(delta / Math.hypot(...a))], a) : a)));
      assert.equal(isSameState(base, nudged), expected, `n=${n} delta=${delta}`);
      // and with a global phase on top
      const rotated = toState(n, toVector(nudged).map((a) => cmul([0, 1], a)));
      assert.equal(isSameState(base, rotated), expected, `n=${n} delta=${delta} with extra phase`);
    }
  }
  assert.equal(isSameState(createState(1, [1, 0]), createState(1, [1, 1e-5])), false);
  assert.equal(isSameState(createState(1, [1, 0]), createState(1, [1, 1e-8])), true);
  assert.equal(isSameState(createState(1), createState(2)), false);
  assert.equal(isSameState(createState(1, 0), createState(1, 1)), false);
});

test('cross-check: describeDifference hints on tricky cases', () => {
  const plus = createState(1, [1, 1]);
  assert.equal(describeDifference(plus, createState(1, [1, -1])).phaseHint, 'sign');
  assert.equal(describeDifference(plus, createState(1, [1, 'i'])).phaseHint, 'quarter-turn');
  assert.equal(describeDifference(plus, createState(1, [1, '-i'])).phaseHint, 'quarter-turn');
  assert.equal(describeDifference(plus, createState(1, [1, 'e^(iπ/4)'])).phaseHint, 'eighth-turn');
  assert.equal(describeDifference(plus, createState(1, [1, 'e^(i*3π/4)'])).phaseHint, 'eighth-turn');
  assert.equal(describeDifference(plus, createState(1, [1, 'e^(i*1)'])).phaseHint, 'other');
  assert.equal(describeDifference(createState(1, 0), createState(1, 1)).phaseHint, 'wrong-probabilities');
  assert.equal(describeDifference(plus, createState(1, [1, 2])).phaseHint, 'wrong-probabilities');
  const same = describeDifference(plus, createState(1, [-1, -1]));
  assert.deepEqual([same.same, same.phaseHint, same.phaseMismatches.length], [true, 'none', 0]);
  // Global phase is removed before comparing: the SAME relative sign error behind a global phase is still 'sign'.
  const rotatedMinus = toState(1, [[0, R], [0, -R]]).amplitudes;
  const d = describeDifference(plus, { numQubits: 1, amplitudes: rotatedMinus.map((a) => ({ re: a.re, im: a.im })) });
  assert.equal(d.phaseHint, 'sign');
  assert.deepEqual(d.phaseMismatches.map((m) => [m.index, m.label, m.expectedDegrees, m.actualDegrees]), [[1, '1', 0, 180]]);
  // Reference amplitude is the first non-negligible one of the target (here index 1).
  const t = createState(2, [0, 1, 0, 1]);
  const c = createState(2, [0, 1, 0, -1]);
  const dd = describeDifference(t, c);
  assert.equal(dd.phaseHint, 'sign');
  assert.equal(dd.phaseMismatches[0].label, '11');
  // Bell with sign error
  assert.equal(describeDifference(createState(2, [1, 0, 0, 1]), createState(2, [1, 0, 0, -1])).phaseHint, 'sign');
  // Mixed errors: S and Z together are still a quarter-turn family
  assert.equal(describeDifference(createState(2, [1, 1, 1, 1]), createState(2, [1, 'i', -1, 'i'])).phaseHint, 'quarter-turn');
  assert.equal(describeDifference(plus, createState(2, 0)).phaseHint, 'wrong-probabilities');
});

// ---------- misuse ----------

test('cross-check: misuse throws readable errors instead of returning garbage', () => {
  assert.throws(() => createState(0), /1 to 4/);
  assert.throws(() => createState(5), /1 to 4/);
  assert.throws(() => createState(1.5), /whole number/);
  assert.throws(() => createState(2, 4), /out of range/);
  assert.throws(() => createState(2, -1), /out of range/);
  assert.throws(() => createState(2, '1'), /bit string/);
  assert.throws(() => createState(2, '012'), /bit string/);
  assert.throws(() => createState(2, [1, 0, 0]), /needs 4 amplitudes/);
  assert.throws(() => createState(1, [0, 0]), /zero/);
  assert.throws(() => createState(1, [NaN, 1]));
  assert.throws(() => createState(1, [Infinity, 1]));
  assert.throws(() => createState(1, ['garbage', 1]), /amplitude/);
  assert.throws(() => createState(1, NaN));
  assert.throws(() => createState(1, null));
  assert.throws(() => createState(1, {}));
  assert.equal(MAX_QUBITS, 4);

  const two = createState(2);
  assert.throws(() => applyGate(two, 'H', { target: 2 }), /Qubit 2 is out of range for a 2-qubit register/);
  assert.throws(() => applyGate(two, 'H', { target: -1 }), /out of range/);
  assert.throws(() => applyGate(two, 'H', { target: 0.5 }), /out of range/);
  assert.throws(() => applyGate(two, 'H', { target: '0' }), /out of range/);
  assert.throws(() => applyGate(two, 'H', {}), /target/);
  assert.throws(() => applyGate(two, 'CNOT', { control: 0, target: 0 }), /different/);
  assert.throws(() => applyGate(two, 'CNOT', { control: 0 }), /control.*target/);
  assert.throws(() => applyGate(two, 'CNOT', { control: 0, target: 5 }), /out of range/);
  assert.throws(() => applyGate(two, 'CNOT', { control: 3, target: 0 }), /out of range/);
  assert.throws(() => applyGate(two, 'MEASURE', { target: 0 }), /measureQubit/);
  assert.throws(() => applyGate(two, 'Q', { target: 0 }), /Unknown gate/);
  assert.throws(() => applyGate({ numQubits: 2, amplitudes: [{ re: 1, im: 0 }] }, 'H', { target: 0 }), /needs 4 amplitudes/);
  assert.throws(() => applyGate({ numQubits: 5, amplitudes: new Array(32).fill({ re: 0, im: 0 }) }, 'H', { target: 0 }), /1 to 4/);
  assert.throws(() => measureQubit(two, 2), /out of range/);
  assert.throws(() => sample(two, -1), /shots/);
  assert.throws(() => sample(two, 1.5), /shots/);
  assert.throws(() => sample(two, NaN), /shots/);
  assert.throws(() => runCircuit({ numQubits: 5, columns: [] }), /1 to 4/);
  assert.throws(() => runCircuit({ numQubits: 2, columns: [[{ gate: 'H', target: 2 }]] }), /out of range/);
  assert.throws(() => runCircuit({ numQubits: 2, columns: [[{ gate: 'CNOT', control: 1, target: 1 }]] }), /different/);
  assert.throws(() => runCircuit({ numQubits: 2, columns: [[{ gate: 'H', target: 0 }, { gate: 'X', target: 0 }]] }), /twice/);
  assert.throws(() => runCircuit({ numQubits: 2, columns: [], measure: 'bogus' }), /measure/);
  assert.throws(() => runCircuit({ numQubits: 2, columns: [], initial: '1' }), /bit string/);
  assert.throws(() => runCircuit({ numQubits: 2, columns: [], initial: createState(3) }), /2-qubit/);
  assert.throws(() => runCircuit({ numQubits: 2, columns: 'nope' }), /array/);
  assert.throws(() => simulateShots({ numQubits: 2, columns: [[{ gate: 'Q', target: 0 }]] }), /Unknown gate/);
  assert.throws(() => findShortestCircuit({ numQubits: 2, start: '00', target: '11', allowedGates: ['MEASURE'] }), /cannot use/);
  assert.throws(() => findShortestCircuit({ numQubits: 5, start: 0, target: 1, allowedGates: ['X'] }), /1 to 4/);
  assert.throws(() => findShortestCircuit({ numQubits: 2, start: '0', target: '11', allowedGates: ['X'] }), /bit string/);
  assert.equal(findShortestCircuit({ numQubits: 1, start: '0', target: '1', allowedGates: ['CNOT'] }), null);

  const v = validateCircuit(2, [
    [{ gate: 'Q', target: 0 }],
    [{ gate: 'H', target: 7 }],
    [{ gate: 'CNOT', control: 1, target: 1 }],
    [{ gate: 'H', target: 0 }, { gate: 'CNOT', control: 1, target: 0 }],
    [{ gate: 'CNOT', target: 0 }],
    [{ gate: 'H' }],
    [null],
    'not a column',
  ]);
  assert.equal(v.ok, false);
  assert.deepEqual(v.errors.map((e) => e.column), [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.ok(v.errors.every((e) => typeof e.message === 'string' && e.message.length > 5));
  assert.deepEqual(validateCircuit(2, []), { ok: true, errors: [] });
});

// ---------- real bugs found by adversarial review (these fail against the current engine) ----------

test('BUG: validateCircuit rejects inherited property names like "constructor" as unknown gates', () => {
  for (const gate of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
    const { ok, errors } = validateCircuit(1, [[{ gate, target: 0 }]]);
    assert.equal(ok, false, `gate "${gate}" must be reported as unknown`);
    assert.match(errors[0].message, /Unknown gate/);
  }
  assert.throws(() => applyGate(createState(1), 'constructor', { target: 0 }), /Unknown gate/);
});

test('BUG: formatAmplitude never prints "−0", "+0i" or "−0i" from decimal rounding', () => {
  assert.equal(formatAmplitude({ re: -0.0004, im: 0.5 }, { exact: false }), '0.5i');
  assert.equal(formatAmplitude({ re: 0.5, im: -0.0004 }, { exact: false }), '0.5');
  assert.equal(formatAmplitude({ re: 0.7071, im: 0.0001 }, { exact: false }), '0.707');
  assert.equal(formatAmplitude({ re: -0.0004, im: 0.5 }), 'i/2'); // exact mode writes a pure imaginary 0.5 as i/2
  assert.ok(!formatKet({ numQubits: 1, amplitudes: [{ re: -0.0004, im: 0.5 }, { re: Math.sqrt(0.75), im: 0 }] }, { exact: false }).includes('−0'));
});

test('BUG: parseAmplitude rejects scientific notation and juxtaposed numbers instead of silently misreading them', () => {
  assert.equal(parseAmplitude('1e-3').re, 0.001);
  assert.equal(parseAmplitude('2.5e-1').re, 0.25);
  assert.throws(() => parseAmplitude('1 2'), /amplitude/);
  assert.throws(() => parseAmplitude('0.5.5'), /amplitude/);
});

test('BUG: simulateShots with MEASURE validates shots exactly like sample()', () => {
  const columns = [[{ gate: 'MEASURE', target: 0 }]];
  assert.throws(() => simulateShots({ numQubits: 1, columns }, -1), /shots/);
  assert.throws(() => simulateShots({ numQubits: 1, columns }, 2.5), /shots/);
  assert.throws(() => simulateShots({ numQubits: 1, columns }, NaN), /shots/);
});

test('BUG: createState normalizes huge amplitudes instead of silently returning the zero vector', () => {
  const s = createState(1, [1e200, 1e200]);
  assert.ok(Math.abs(norm(s) - 1) < 1e-12);
});

test('BUG: states with NaN amplitudes are rejected instead of producing NaN results', () => {
  const bad = { numQubits: 1, amplitudes: [{ re: NaN, im: 0 }, { re: 0, im: 0 }] };
  assert.throws(() => applyGate(bad, 'H', { target: 0 }));
  assert.throws(() => measureAll(bad));
});
