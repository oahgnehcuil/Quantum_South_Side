/* ==========================================================================
   state.js — quantum states of 1 to 4 qubits, and measuring them.

   CONVENTIONS (used by every file in this folder and repeated in the UI help):
   - Qubit 0 is the TOP wire and the LEFT-most digit of a ket: |q0 q1 q2⟩.
   - The index of basis state |b0 b1 … b(n-1)⟩ is b0*2^(n-1) + … + b(n-1)*2^0.
     For two qubits the amplitudes are ordered |00⟩, |01⟩, |10⟩, |11⟩, and in
     |01⟩ qubit 0 is 0 and qubit 1 is 1.
   - A complex number is a plain object {re, im}.
   - A state is a plain object {numQubits, amplitudes: [{re, im}, …]} with
     2^numQubits amplitudes whose squared sizes add up to 1.
   - A gate placement is {gate:'H', target:0} | {gate:'CNOT', control:0,
     target:1} | {gate:'MEASURE', target:2}. A circuit is an array of COLUMNS;
     a column is an array of placements that touch different qubits.
   - Ket text uses "|0⟩" (closing bracket U+27E9) and the minus sign "−" (U+2212).

   States are never changed in place: every function returns a NEW state.
   Random choices take an "rng" (a function returning a number in [0, 1)),
   which defaults to Math.random; pass a seeded one to get repeatable results.

   Example:
     import { createState, measureQubit } from './state.js';
     const state = createState(2, '01');        // |01⟩
     const { outcome } = measureQubit(state, 1); // outcome is 1
   ========================================================================== */

import { EPSILON, complex, abs2, scale } from './complex.js';
import { parseAmplitude } from './parse.js';

/** The biggest register the engine supports (4 qubits = 16 amplitudes). */
export const MAX_QUBITS = 4;

/** Throw a clear error unless numQubits is a whole number from 1 to MAX_QUBITS. */
function checkNumQubits(numQubits) {
  if (!Number.isInteger(numQubits) || numQubits < 1 || numQubits > MAX_QUBITS) {
    throw new Error(`The number of qubits must be a whole number from 1 to ${MAX_QUBITS}, not ${String(numQubits)}.`);
  }
}

/** Throw a clear error unless qubit is a valid qubit number for this register. */
export function checkQubit(qubit, numQubits) {
  if (!Number.isInteger(qubit) || qubit < 0 || qubit >= numQubits) {
    throw new Error(`Qubit ${String(qubit)} is out of range for a ${numQubits}-qubit register.`);
  }
}

/** Throw a clear error unless value looks like a state {numQubits, amplitudes} with the right length. */
export function assertState(value) {
  if (!value || typeof value !== 'object' || !Array.isArray(value.amplitudes)) {
    throw new Error('Expected a state like {numQubits, amplitudes}.');
  }
  checkNumQubits(value.numQubits);
  if (value.amplitudes.length !== 2 ** value.numQubits) {
    throw new Error(`A ${value.numQubits}-qubit state needs ${2 ** value.numQubits} amplitudes, not ${value.amplitudes.length}.`);
  }
  value.amplitudes.forEach((a, index) => {
    if (!a || typeof a !== 'object' || !Number.isFinite(a.re) || !Number.isFinite(a.im)) {
      throw new Error(`State amplitude ${index} is not a finite complex number.`);
    }
  });
}

/** Divide every amplitude by the total length so the probabilities add up to 1. */
function normalizeAmplitudes(amplitudes) {
  if (amplitudes.some((a) => !Number.isFinite(a.re) || !Number.isFinite(a.im))) {
    throw new Error('State amplitudes must be finite numbers.');
  }
  // Divide by the biggest part first so very large amplitudes cannot overflow.
  const biggest = Math.max(...amplitudes.map((a) => Math.max(Math.abs(a.re), Math.abs(a.im))));
  if (biggest < EPSILON) throw new Error('A state cannot have all amplitudes equal to zero.');
  const shrunk = amplitudes.map((a) => scale(a, 1 / biggest));
  const length = Math.sqrt(shrunk.reduce((sum, a) => sum + abs2(a), 0));
  return shrunk.map((a) => scale(a, 1 / length));
}

/** The basis state with a 1 at the given index and 0 everywhere else. */
function basisAmplitudes(numQubits, index) {
  const size = 2 ** numQubits;
  if (!Number.isInteger(index) || index < 0 || index >= size) {
    throw new Error(`Basis index ${String(index)} is out of range for a ${numQubits}-qubit register (use 0 to ${size - 1}).`);
  }
  return Array.from({ length: size }, (_, i) => complex(i === index ? 1 : 0, 0));
}

/** Make a state: no init = |0…0⟩, a number = basis index, '01' = that basis state, or an array of amplitudes (normalized). */
export function createState(numQubits, init) {
  checkNumQubits(numQubits);
  if (init === undefined) return { numQubits, amplitudes: basisAmplitudes(numQubits, 0) };
  if (typeof init === 'number') return { numQubits, amplitudes: basisAmplitudes(numQubits, init) };
  if (typeof init === 'string') {
    if (!/^[01]+$/.test(init) || init.length !== numQubits) {
      throw new Error(`"${init}" is not a bit string for a ${numQubits}-qubit register (use exactly ${numQubits} digits, each 0 or 1).`);
    }
    return { numQubits, amplitudes: basisAmplitudes(numQubits, parseInt(init, 2)) };
  }
  if (Array.isArray(init)) {
    if (init.length !== 2 ** numQubits) {
      throw new Error(`A ${numQubits}-qubit state needs ${2 ** numQubits} amplitudes, not ${init.length}.`);
    }
    return { numQubits, amplitudes: normalizeAmplitudes(init.map(parseAmplitude)) };
  }
  throw new Error('The starting state must be a basis index, a bit string like "01" or a list of amplitudes.');
}

/** Accept either a ready-made state (checked, copied and normalized) or any init value for createState. */
export function asState(numQubits, value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    assertState(value);
    if (value.numQubits !== numQubits) {
      throw new Error(`Expected a ${numQubits}-qubit state but got a ${value.numQubits}-qubit state.`);
    }
    return normalize(value);
  }
  return createState(numQubits, value);
}

/** The length of the state (1 for a properly normalized state). */
export function norm(state) {
  assertState(state);
  return Math.sqrt(state.amplitudes.reduce((sum, a) => sum + abs2(a), 0));
}

/** A copy of the state scaled to length 1 (throws if every amplitude is zero). */
export function normalize(state) {
  assertState(state);
  const amplitudes = normalizeAmplitudes(state.amplitudes.map((a) => complex(a.re, a.im)));
  return { numQubits: state.numQubits, amplitudes };
}

/** The chance of each basis state, in index order (|amplitude|^2). */
export function probabilities(state) {
  assertState(state);
  return state.amplitudes.map(abs2);
}

/** The bit string of a basis index, like basisLabel(1, 2) = '01'. */
export function basisLabel(index, numQubits) {
  checkNumQubits(numQubits);
  if (!Number.isInteger(index) || index < 0 || index >= 2 ** numQubits) {
    throw new Error(`Basis index ${String(index)} is out of range for a ${numQubits}-qubit register.`);
  }
  return index.toString(2).padStart(numQubits, '0');
}

/** The bits of a basis index as numbers, like bitsOf(1, 2) = [0, 1]. */
export function bitsOf(index, numQubits) {
  return [...basisLabel(index, numQubits)].map(Number);
}

/** Pick a basis index at random, weighted by the probabilities (skips impossible outcomes). */
function pickIndex(probs, rng) {
  const r = rng();
  let total = 0;
  let lastPossible = 0;
  for (let i = 0; i < probs.length; i += 1) {
    if (probs[i] < EPSILON) continue;
    total += probs[i];
    lastPossible = i;
    if (r < total) return i;
  }
  return lastPossible;
}

/** Measure one qubit: returns {outcome, probability (of that outcome), state (collapsed and renormalized)}. */
export function measureQubit(state, qubit, rng = Math.random) {
  assertState(state);
  checkQubit(qubit, state.numQubits);
  const probs = probabilities(state);
  const bitOf = (i) => bitsOf(i, state.numQubits)[qubit];
  const chanceOfOne = probs.reduce((sum, p, i) => sum + (bitOf(i) === 1 ? p : 0), 0);
  const total = probs.reduce((sum, p) => sum + p, 0);
  const chanceOfZero = total - chanceOfOne;
  let outcome;
  if (chanceOfOne < EPSILON) outcome = 0;
  else if (chanceOfZero < EPSILON) outcome = 1;
  else outcome = rng() * total < chanceOfZero ? 0 : 1;
  const kept = state.amplitudes.map((a, i) => (bitOf(i) === outcome ? complex(a.re, a.im) : complex(0, 0)));
  return {
    outcome,
    probability: (outcome === 1 ? chanceOfOne : chanceOfZero) / total,
    state: { numQubits: state.numQubits, amplitudes: normalizeAmplitudes(kept) },
  };
}

/** Measure every qubit: returns {index, bits ('01'), probability, state (the collapsed basis state)}. */
export function measureAll(state, rng = Math.random) {
  assertState(state);
  const probs = probabilities(state);
  const total = probs.reduce((sum, p) => sum + p, 0);
  const index = pickIndex(probs.map((p) => p / total), rng);
  return {
    index,
    bits: basisLabel(index, state.numQubits),
    probability: probs[index] / total,
    state: createState(state.numQubits, index),
  };
}

/** Measure the state many times: returns {shots, counts} where counts has EVERY basis label (zeros too) in index order. */
export function sample(state, shots, rng = Math.random) {
  assertState(state);
  if (!Number.isInteger(shots) || shots < 0) throw new Error(`The number of shots must be a whole number of 0 or more, not ${String(shots)}.`);
  const probs = probabilities(state);
  const total = probs.reduce((sum, p) => sum + p, 0);
  const chances = probs.map((p) => p / total);
  const counts = {};
  chances.forEach((_, i) => {
    counts[basisLabel(i, state.numQubits)] = 0;
  });
  for (let shot = 0; shot < shots; shot += 1) {
    counts[basisLabel(pickIndex(chances, rng), state.numQubits)] += 1;
  }
  return { shots, counts };
}
