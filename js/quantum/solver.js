/* ==========================================================================
   solver.js — finds the SHORTEST circuit between two states.

   It is a breadth-first search: try every single gate, then every pair, and so
   on, so the first answer found is as short as possible. Two states count as
   the same when they differ only by a global phase. Used by the puzzle game to
   check that a puzzle can be solved and to show how many gates it needs.

   Example:
     import { findShortestCircuit } from './solver.js';
     findShortestCircuit({ numQubits: 1, start: '0', target: '1', allowedGates: ['H', 'Z'] });
     // [{gate:'H',target:0}, {gate:'Z',target:0}, {gate:'H',target:0}]
   ========================================================================== */

import { SINGLE_QUBIT_GATES, applyGate } from './gates.js';
import { MAX_QUBITS, asState } from './state.js';
import { abs } from './complex.js';

const KEY_DECIMALS = 1e6;
const NEGLIGIBLE = 1e-9;

/** Every single placement allowed: each single-qubit gate on each qubit, and CNOT on each ordered pair of qubits. */
export function enumeratePlacements(numQubits, allowedGates) {
  if (!Number.isInteger(numQubits) || numQubits < 1 || numQubits > MAX_QUBITS) {
    throw new Error(`The number of qubits must be a whole number from 1 to ${MAX_QUBITS}, not ${String(numQubits)}.`);
  }
  const placements = [];
  [...new Set(allowedGates)].forEach((gate) => {
    if (SINGLE_QUBIT_GATES.includes(gate)) {
      for (let target = 0; target < numQubits; target += 1) placements.push({ gate, target });
    } else if (gate === 'CNOT') {
      for (let control = 0; control < numQubits; control += 1) {
        for (let target = 0; target < numQubits; target += 1) {
          if (control !== target) placements.push({ gate, control, target });
        }
      }
    } else {
      throw new Error(`The solver cannot use gate "${String(gate)}". Use ${[...SINGLE_QUBIT_GATES, 'CNOT'].join(', ')}.`);
    }
  });
  return placements;
}

/** A text key that is the same for states that differ only by a global phase. */
function canonicalKey(state) {
  const first = state.amplitudes.find((a) => abs(a) > NEGLIGIBLE);
  const length = abs(first);
  const phase = { re: first.re / length, im: -first.im / length }; // rotating by this makes the first amplitude real and positive
  return state.amplitudes
    .map((a) => {
      const re = (a.re * phase.re - a.im * phase.im) * KEY_DECIMALS;
      const im = (a.re * phase.im + a.im * phase.re) * KEY_DECIMALS;
      return `${Math.round(re) + 0},${Math.round(im) + 0}`;
    })
    .join(';');
}

/** The shortest list of placements that turns start into target (up to global phase): [] if already equal, null if unreachable. */
export function findShortestCircuit({ numQubits, start, target, allowedGates, maxGates = 6, maxNodes = 300000 }) {
  const placements = enumeratePlacements(numQubits, allowedGates);
  const startState = asState(numQubits, start);
  const targetKey = canonicalKey(asState(numQubits, target));
  const startKey = canonicalKey(startState);
  if (startKey === targetKey) return [];

  const seen = new Set([startKey]);
  let frontier = [{ state: startState, path: [] }];
  for (let depth = 1; depth <= maxGates; depth += 1) {
    const next = [];
    for (const { state, path } of frontier) {
      for (const placement of placements) {
        const after = applyGate(state, placement.gate, placement);
        const key = canonicalKey(after);
        if (seen.has(key)) continue;
        if (key === targetKey) return [...path, placement];
        if (seen.size >= maxNodes) return null;
        seen.add(key);
        next.push({ state: after, path: [...path, placement] });
      }
    }
    frontier = next;
  }
  return null;
}
