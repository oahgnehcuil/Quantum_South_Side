/* ==========================================================================
   gates.js — the quantum gates and how to apply them to an n-qubit state.

   A single-qubit gate is a 2x2 table (matrix) of complex numbers. Applying it
   to qubit k mixes each pair of amplitudes that differ only in qubit k.
   CNOT flips the target qubit when the control qubit is 1. MEASURE is listed
   here so the UI can show it, but it is not a matrix: use measureQubit().
   Qubit 0 is the top wire and the left-most digit of a ket (see state.js).

   Example:
     import { createState } from './state.js';
     import { applyGate } from './gates.js';
     const bell = applyGate(applyGate(createState(2), 'H', { target: 0 }), 'CNOT', { control: 0, target: 1 });
   ========================================================================== */

import { EPSILON, complex, add, mul, toComplex } from './complex.js';
import { assertState, checkQubit } from './state.js';

const SQRT_HALF = Math.SQRT1_2;

/** Build a 2x2 matrix of {re, im} from four [re, im] pairs. */
function matrix2(a, b, c, d) {
  return [
    [complex(...a), complex(...b)],
    [complex(...c), complex(...d)],
  ];
}

/** Freeze an object and everything inside it so nobody changes a gate by accident. */
function deepFreeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

/** Every gate: id, name, description, arity (qubits used), unitary (true unless MEASURE) and matrix (single-qubit gates only). */
export const GATES = deepFreeze({
  H: {
    id: 'H',
    name: 'Hadamard',
    description: 'Turns a plain 0 or 1 into an even blend of both, and turns that blend back again.',
    arity: 1,
    unitary: true,
    matrix: matrix2([SQRT_HALF, 0], [SQRT_HALF, 0], [SQRT_HALF, 0], [-SQRT_HALF, 0]),
  },
  X: {
    id: 'X',
    name: 'Pauli-X (flip)',
    description: 'Swaps 0 and 1, like the NOT gate on a regular bit.',
    arity: 1,
    unitary: true,
    matrix: matrix2([0, 0], [1, 0], [1, 0], [0, 0]),
  },
  Y: {
    id: 'Y',
    name: 'Pauli-Y',
    description: 'Swaps 0 and 1 and also adds a quarter-turn of phase (a factor of i or −i).',
    arity: 1,
    unitary: true,
    matrix: matrix2([0, 0], [0, -1], [0, 1], [0, 0]),
  },
  Z: {
    id: 'Z',
    name: 'Pauli-Z (sign flip)',
    description: 'Flips the sign of the |1⟩ part and leaves the |0⟩ part alone.',
    arity: 1,
    unitary: true,
    matrix: matrix2([1, 0], [0, 0], [0, 0], [-1, 0]),
  },
  S: {
    id: 'S',
    name: 'S (quarter-turn)',
    description: 'Turns the phase of the |1⟩ part by a quarter-turn (90 degrees).',
    arity: 1,
    unitary: true,
    matrix: matrix2([1, 0], [0, 0], [0, 0], [0, 1]),
  },
  T: {
    id: 'T',
    name: 'T (eighth-turn)',
    description: 'Turns the phase of the |1⟩ part by an eighth-turn (45 degrees).',
    arity: 1,
    unitary: true,
    matrix: matrix2([1, 0], [0, 0], [0, 0], [SQRT_HALF, SQRT_HALF]),
  },
  CNOT: {
    id: 'CNOT',
    name: 'Controlled-NOT',
    description: 'Flips the target qubit only when the control qubit is 1.',
    arity: 2,
    unitary: true,
    matrix: null,
  },
  MEASURE: {
    id: 'MEASURE',
    name: 'Measure',
    description: 'Reads the qubit as a plain 0 or 1, which ends its blend of both.',
    arity: 1,
    unitary: false,
    matrix: null,
  },
});

/** The ids of the gates that act on one qubit with a 2x2 matrix, in display order. */
export const SINGLE_QUBIT_GATES = ['H', 'X', 'Y', 'Z', 'S', 'T'];

/** Round away numbers smaller than EPSILON so results never show 1e-17 noise. */
function tidy(a) {
  return complex(Math.abs(a.re) < EPSILON ? 0 : a.re, Math.abs(a.im) < EPSILON ? 0 : a.im);
}

/** Apply a 2x2 matrix to one qubit of the state and return the new state. */
export function applySingleQubitGate(state, matrix, target) {
  assertState(state);
  checkQubit(target, state.numQubits);
  if (!Array.isArray(matrix) || matrix.length !== 2 || matrix.some((row) => !Array.isArray(row) || row.length !== 2)) {
    throw new Error('A single-qubit gate matrix must be a 2x2 table of complex numbers.');
  }
  const [[m00, m01], [m10, m11]] = matrix.map((row) => row.map(toComplex));
  const mask = 1 << (state.numQubits - 1 - target); // the bit of the index that belongs to the target qubit
  const old = state.amplitudes;
  const amplitudes = old.map((_, i) => {
    const zeroIndex = i & ~mask; // same index but with the target bit set to 0
    const oneIndex = i | mask; // same index but with the target bit set to 1
    const [row0, row1] = i & mask ? [m10, m11] : [m00, m01];
    return tidy(add(mul(row0, old[zeroIndex]), mul(row1, old[oneIndex])));
  });
  return { numQubits: state.numQubits, amplitudes };
}

/** Apply a CNOT (flip the target when the control is 1) and return the new state. */
export function applyCNOT(state, control, target) {
  assertState(state);
  checkQubit(control, state.numQubits);
  checkQubit(target, state.numQubits);
  if (control === target) throw new Error(`CNOT needs two different qubits, but control and target are both qubit ${control}.`);
  const controlMask = 1 << (state.numQubits - 1 - control);
  const targetMask = 1 << (state.numQubits - 1 - target);
  const amplitudes = state.amplitudes.map((_, i) => {
    const source = i & controlMask ? i ^ targetMask : i; // when the control is 1, take the amplitude from the flipped partner
    const a = state.amplitudes[source];
    return complex(a.re, a.im);
  });
  return { numQubits: state.numQubits, amplitudes };
}

/** Apply a gate by id ('H', 'X', 'Y', 'Z', 'S', 'T' or 'CNOT') with {target, control}; returns a new state. */
export function applyGate(state, gate, { target, control } = {}) {
  if (!Object.hasOwn(GATES, gate)) throw new Error(`Unknown gate "${String(gate)}". Use one of: ${Object.keys(GATES).join(', ')}.`);
  if (gate === 'MEASURE') throw new Error('MEASURE is not a matrix gate. Use measureQubit() to measure a qubit.');
  if (gate === 'CNOT') {
    if (control === undefined || target === undefined) throw new Error('CNOT needs both a control qubit and a target qubit.');
    return applyCNOT(state, control, target);
  }
  if (target === undefined) throw new Error(`Gate ${gate} needs a target qubit.`);
  return applySingleQubitGate(state, GATES[gate].matrix, target);
}
