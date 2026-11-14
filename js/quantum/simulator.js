/* ==========================================================================
   simulator.js — runs a whole circuit, column by column, and counts shots.

   A circuit is an array of COLUMNS. A column is an array of placements that
   touch different qubits, so they happen "at the same time":
     {gate:'H', target:0} | {gate:'CNOT', control:0, target:1} | {gate:'MEASURE', target:2}
   Columns are numbered from 0 in every error message and measurement record.

   Example:
     import { runCircuit, simulateShots } from './simulator.js';
     const columns = [[{ gate: 'H', target: 0 }], [{ gate: 'CNOT', control: 0, target: 1 }]];
     const { final } = runCircuit({ numQubits: 2, columns });  // the Bell state
   ========================================================================== */

import { GATES, applyGate } from './gates.js';
import { MAX_QUBITS, asState, measureQubit, sample, basisLabel } from './state.js';

/** The qubits a placement touches (control first, then target). */
function qubitsOf(placement) {
  return placement.gate === 'CNOT' ? [placement.control, placement.target] : [placement.target];
}

/** Check every column of a circuit: returns {ok, errors: [{column, message}]}. */
export function validateCircuit(numQubits, columns) {
  if (!Number.isInteger(numQubits) || numQubits < 1 || numQubits > MAX_QUBITS) {
    throw new Error(`The number of qubits must be a whole number from 1 to ${MAX_QUBITS}, not ${String(numQubits)}.`);
  }
  if (!Array.isArray(columns)) throw new Error('A circuit must be an array of columns.');
  const errors = [];
  columns.forEach((column, columnIndex) => {
    const report = (message) => errors.push({ column: columnIndex, message });
    if (!Array.isArray(column)) {
      report('A column must be a list of gate placements.');
      return;
    }
    const used = new Set();
    column.forEach((placement) => {
      if (!placement || typeof placement !== 'object' || !Object.hasOwn(GATES, placement.gate)) {
        report(`Unknown gate "${String(placement?.gate)}".`);
        return;
      }
      const qubits = qubitsOf(placement);
      const missing = qubits.some((q) => q === undefined);
      const outOfRange = qubits.filter((q) => q !== undefined && !(Number.isInteger(q) && q >= 0 && q < numQubits));
      if (missing) {
        report(`Gate ${placement.gate} needs ${placement.gate === 'CNOT' ? 'both a control and a target qubit' : 'a target qubit'}.`);
      } else if (outOfRange.length > 0) {
        report(`Qubit ${outOfRange[0]} is out of range for a ${numQubits}-qubit register.`);
      } else if (placement.gate === 'CNOT' && placement.control === placement.target) {
        report(`CNOT needs two different qubits, but control and target are both qubit ${placement.target}.`);
      } else {
        const repeated = qubits.find((q) => used.has(q));
        if (repeated !== undefined) report(`Qubit ${repeated} is used twice in the same column.`);
        qubits.forEach((q) => used.add(q));
      }
    });
  });
  return { ok: errors.length === 0, errors };
}

/** Throw the first problem found in a circuit, naming its column (counting from 1 for people). */
function assertValidCircuit(numQubits, columns) {
  const { ok, errors } = validateCircuit(numQubits, columns);
  if (!ok) throw new Error(`Column ${errors[0].column + 1}: ${errors[0].message}`);
}

/** Run a circuit: returns {numQubits, states (initial + one per column), final, measurements}. */
export function runCircuit({ numQubits, columns, initial, rng = Math.random, measure = 'ignore' }) {
  if (measure !== 'ignore' && measure !== 'collapse') throw new Error(`measure must be 'ignore' or 'collapse', not ${String(measure)}.`);
  assertValidCircuit(numQubits, columns);
  let current = asState(numQubits, initial);
  const states = [current];
  const measurements = [];
  columns.forEach((column, columnIndex) => {
    column.forEach((placement) => {
      if (placement.gate !== 'MEASURE') {
        current = applyGate(current, placement.gate, placement);
      } else if (measure === 'collapse') {
        const result = measureQubit(current, placement.target, rng);
        current = result.state;
        measurements.push({ column: columnIndex, qubit: placement.target, outcome: result.outcome });
      }
    });
    states.push(current);
  });
  return { numQubits, states, final: current, measurements };
}

/** The qubits that have a MEASURE placement, in order and without repeats. */
function measuredQubitsOf(columns) {
  const qubits = columns.flat().filter((p) => p.gate === 'MEASURE').map((p) => p.target);
  return [...new Set(qubits)].sort((a, b) => a - b);
}

/** Run the circuit many times: returns {shots, counts (keyed by bit string, qubit 0 first), measuredQubits}. */
export function simulateShots({ numQubits, columns, initial }, shots = 100, rng = Math.random) {
  if (!Number.isInteger(shots) || shots < 0) throw new Error(`The number of shots must be a whole number of 0 or more, not ${String(shots)}.`);
  assertValidCircuit(numQubits, columns);
  const measured = measuredQubitsOf(columns);
  const allQubits = Array.from({ length: numQubits }, (_, q) => q);
  if (measured.length === 0) {
    const { final } = runCircuit({ numQubits, columns, initial });
    return { shots, counts: sample(final, shots, rng).counts, measuredQubits: allQubits };
  }
  const counts = {};
  for (let i = 0; i < 2 ** numQubits; i += 1) counts[basisLabel(i, numQubits)] = 0;
  for (let shot = 0; shot < shots; shot += 1) {
    const run = runCircuit({ numQubits, columns, initial, rng, measure: 'collapse' });
    const bits = allQubits.map(() => null);
    // A qubit is read where its MEASURE sits (the last one wins if it is measured twice).
    run.measurements.forEach(({ qubit, outcome }) => {
      bits[qubit] = outcome;
    });
    // Any qubit that was never measured is read at the very end.
    let state = run.final;
    allQubits.filter((q) => bits[q] === null).forEach((q) => {
      const result = measureQubit(state, q, rng);
      bits[q] = result.outcome;
      state = result.state;
    });
    counts[bits.join('')] += 1;
  }
  return { shots, counts, measuredQubits: measured };
}
