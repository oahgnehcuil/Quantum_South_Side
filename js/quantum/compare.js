/* ==========================================================================
   compare.js — compares two quantum states, ignoring the global phase.

   "Global phase" is a hidden turn applied to every amplitude at once (like
   multiplying by −1 or i). It cannot be measured, so |1⟩ and −|1⟩ are the
   SAME state. describeDifference() also explains HOW two states differ, which
   the puzzle game turns into friendly hints.

   Example:
     import { isSameState, describeDifference } from './compare.js';
     isSameState(stateA, stateB);                      // true or false
     describeDifference(target, yours).phaseHint;      // 'sign', 'quarter-turn', …
   ========================================================================== */

import { EPSILON, complex, conj, mul, add, abs, abs2, arg, sub } from './complex.js';
import { assertState, probabilities, basisLabel } from './state.js';

const DEGREES = 180 / Math.PI;
const PHASE_TOLERANCE_DEGREES = 1e-4;

/** The inner product ⟨a|b⟩: multiply a's conjugated amplitudes by b's and add them up. */
export function innerProduct(a, b) {
  assertState(a);
  assertState(b);
  if (a.numQubits !== b.numQubits) {
    throw new Error(`Cannot compare a ${a.numQubits}-qubit state with a ${b.numQubits}-qubit state.`);
  }
  return a.amplitudes.reduce((sum, amp, i) => add(sum, mul(conj(amp), b.amplitudes[i])), complex(0, 0));
}

/** How close the current state is to the target: |⟨target|current⟩|^2, from 0 (opposite) to 1 (same). */
export function fidelity(target, current) {
  return Math.min(1, abs2(innerProduct(target, current)));
}

/** True when two states are equal up to a global phase (false if they have different numbers of qubits). */
export function isSameState(a, b, tolerance = 1e-6) {
  assertState(a);
  assertState(b);
  if (a.numQubits !== b.numQubits) return false;
  const overlap = innerProduct(a, b);
  if (abs(overlap) < EPSILON) return false;
  // If b equals a up to a global phase, the overlap IS that phase (times a length of 1).
  const phase = complex(overlap.re / abs(overlap), overlap.im / abs(overlap));
  return a.amplitudes.every((amp, i) => abs(sub(b.amplitudes[i], mul(phase, amp))) < tolerance);
}

/** An angle in degrees brought into the range 0 up to (not including) 360, rounded to remove noise. */
function wrapDegrees(degrees) {
  const rounded = Math.round((((degrees % 360) + 360) % 360) * 1e6) / 1e6;
  return rounded === 360 ? 0 : rounded;
}

/** Name the kind of phase error from the list of differences (in degrees) between actual and expected. */
function hintForPhaseErrors(differences) {
  const allMultiplesOf = (step) => differences.every((d) => {
    const ratio = d / step;
    return Math.abs(ratio - Math.round(ratio)) * step < PHASE_TOLERANCE_DEGREES;
  });
  if (differences.every((d) => Math.abs(d - 180) < PHASE_TOLERANCE_DEGREES)) return 'sign';
  if (allMultiplesOf(90)) return 'quarter-turn';
  if (allMultiplesOf(45)) return 'eighth-turn';
  return 'other';
}

/** Explain how current differs from target: {same, fidelity, probabilitiesMatch, phaseMismatches, phaseHint}. */
export function describeDifference(target, current) {
  assertState(target);
  assertState(current);
  if (target.numQubits !== current.numQubits) {
    return { same: false, fidelity: 0, probabilitiesMatch: false, phaseMismatches: [], phaseHint: 'wrong-probabilities' };
  }
  const same = isSameState(target, current);
  const targetChances = probabilities(target);
  const currentChances = probabilities(current);
  const probabilitiesMatch = targetChances.every((p, i) => Math.abs(p - currentChances[i]) < 1e-6);
  const result = { same, fidelity: fidelity(target, current), probabilitiesMatch, phaseMismatches: [], phaseHint: 'none' };
  if (same) return result;
  if (!probabilitiesMatch) return { ...result, phaseHint: 'wrong-probabilities' };

  // Remove the global phase by measuring every angle from the first non-negligible amplitude of the target.
  const reference = target.amplitudes.findIndex((a) => abs(a) > EPSILON);
  const targetShift = arg(target.amplitudes[reference]);
  const currentShift = arg(current.amplitudes[reference]);
  const differences = [];
  target.amplitudes.forEach((expected, index) => {
    if (abs(expected) <= EPSILON) return;
    const expectedDegrees = wrapDegrees((arg(expected) - targetShift) * DEGREES);
    const actualDegrees = wrapDegrees((arg(current.amplitudes[index]) - currentShift) * DEGREES);
    const difference = wrapDegrees(actualDegrees - expectedDegrees);
    if (Math.min(difference, 360 - difference) < PHASE_TOLERANCE_DEGREES) return;
    differences.push(difference);
    result.phaseMismatches.push({ index, label: basisLabel(index, target.numQubits), expectedDegrees, actualDegrees });
  });
  return { ...result, phaseHint: differences.length === 0 ? 'other' : hintForPhaseErrors(differences) };
}
