/* ==========================================================================
   collapseChallenge.js — the rules of the Collapse Challenge, with NO web page code.

   A puzzle gives a STARTING state and a TARGET state. The player builds a list of
   gates that turns one into the other. They may "peek" (measure), which collapses
   the qubit into a plain 0 or 1, so the state must be matched BEFORE measuring.
   Like in real life, a measurement can never be undone: only Reset starts over.

   A game session is a plain object: {puzzle, start, target, steps, states, current,
   peeked, collapsed}. Every function below works on that object and the quantum engine in
   js/quantum/ does all the math. This file also runs in Node, so it is unit-tested.

   Example:
     const game = createGame(puzzle);
     addGate(game, 'H');
     const result = check(game);   // {solved, stars, gatesUsed, message, ...}
   ========================================================================== */
import { createState, measureAll, probabilities, basisLabel } from '../quantum/state.js';
import { applyGate, SINGLE_QUBIT_GATES } from '../quantum/gates.js';
import { isSameState, describeDifference } from '../quantum/compare.js';
import { formatProbability, basisKet } from '../quantum/format.js';
import { validateCircuit } from '../quantum/simulator.js';
import { pickDaily, getDayKey } from '../utils/dailySeed.js';

/** Stars: the best you can win and the most a peek can take away. */
export const MAX_STARS = 3;
const PEEK_COST = 1;
const NEGLIGIBLE = 1e-9;

/** One friendly sentence per gate, used when we suggest a gate (and only when the puzzle allows it). */
const GATE_TIPS = {
  X: 'X swaps 0 and 1.',
  H: 'H blends a plain 0 or 1 into an even mix, and turns a mix back into a plain state.',
  Z: 'Z flips the sign of the |1⟩ part.',
  S: 'S turns the |1⟩ part by a quarter-turn.',
  T: 'T turns the |1⟩ part by an eighth-turn.',
};

/* ---------- Puzzles ---------- */

/** The starting state and the target state of a puzzle, as engine states. */
export function buildPuzzleStates(puzzle) {
  return {
    start: createState(puzzle.qubits, puzzle.startState),
    target: createState(puzzle.qubits, puzzle.targetState),
  };
}

/** Today's puzzle from the list: the same one for everybody (the day rolls over at midnight Chicago time). */
export function pickTodaysPuzzle(puzzles, dayKey = getDayKey()) {
  return pickDaily(puzzles, dayKey);
}

/** Check one puzzle from the data file. Returns a list of problems (empty when the puzzle is fine). */
export function validatePuzzle(puzzle) {
  const problems = [];
  if (!puzzle || typeof puzzle !== 'object') return ['The puzzle is not an object.'];
  const text = (value) => typeof value === 'string' && value.trim() !== '';
  if (!Number.isInteger(puzzle.id) || puzzle.id < 1) problems.push('id must be a whole number from 1.');
  if (!text(puzzle.title)) problems.push('title is missing.');
  if (!text(puzzle.hint)) problems.push('hint is missing.');
  if (!text(puzzle.explanation)) problems.push('explanation is missing.');
  if (puzzle.qubits !== 1 && puzzle.qubits !== 2) problems.push('qubits must be 1 or 2.');
  const known = [...SINGLE_QUBIT_GATES, 'CNOT'];
  if (!Array.isArray(puzzle.allowedGates) || puzzle.allowedGates.length === 0 || !puzzle.allowedGates.every((g) => known.includes(g))) {
    problems.push(`allowedGates must be a list of gates from ${known.join(', ')}.`);
  }
  if (!Number.isInteger(puzzle.par) || puzzle.par < 1) problems.push('par must be a whole number from 1.');
  if (problems.length > 0) return problems;
  let states;
  try {
    states = buildPuzzleStates(puzzle);
  } catch (error) {
    return [`startState or targetState is not valid: ${error.message}`];
  }
  if (isSameState(states.start, states.target)) problems.push('the start already equals the target.');
  const solution = puzzle.referenceSolution;
  if (!Array.isArray(solution) || solution.length === 0) return [...problems, 'referenceSolution must be a list of gates.'];
  const circuit = validateCircuit(puzzle.qubits, solution.map((placement) => [placement]));
  if (!circuit.ok) return [...problems, `referenceSolution is not a valid circuit: ${circuit.errors[0].message}`];
  if (solution.some((placement) => !puzzle.allowedGates.includes(placement.gate))) problems.push('referenceSolution uses a gate that is not allowed.');
  else if (!isSameState(solution.reduce((state, placement) => applyGate(state, placement.gate, placement), states.start), states.target)) {
    problems.push('referenceSolution does not reach the target.');
  }
  if (solution.length !== puzzle.par) problems.push('par must equal the length of referenceSolution.');
  return problems;
}

/* ---------- A game session ---------- */

/** Start a new session for a puzzle: no gates yet, the current state is the starting state. */
export function createGame(puzzle) {
  const { start, target } = buildPuzzleStates(puzzle);
  return { puzzle, start, target, steps: [], states: [start], current: start, peeked: false, collapsed: false };
}

/** How many gates the player has used. Peeks are not gates. */
export function gatesUsed(game) {
  return game.steps.filter((step) => step.kind === 'gate').length;
}

/** Put a gate on the circuit. Pass 'H' (for qubit 0) or a placement like {gate:'CNOT', control:0, target:1}. Returns the new state. */
export function addGate(game, gateOrPlacement) {
  const placement = typeof gateOrPlacement === 'string' ? { gate: gateOrPlacement, target: 0 } : gateOrPlacement;
  if (!game.puzzle.allowedGates.includes(placement.gate)) {
    throw new Error(`The ${String(placement.gate)} gate is not part of this puzzle.`);
  }
  const circuit = validateCircuit(game.puzzle.qubits, [[placement]]);
  if (!circuit.ok) throw new Error(circuit.errors[0].message);
  const next = applyGate(game.current, placement.gate, placement);
  game.steps.push({ kind: 'gate', ...placement });
  game.states.push(next);
  game.current = next;
  return next;
}

/** True when Undo has something to take back: the last step is a gate. A peek can never be undone. */
export function canUndo(game) {
  return game.steps.at(-1)?.kind === 'gate';
}

/** Take back the last gate. Returns that step, or null when there is nothing to undo or the last step is a peek (a measurement can't be undone). */
export function undo(game) {
  if (!canUndo(game)) return null;
  const step = game.steps.pop();
  game.states.pop();
  game.current = game.states[game.states.length - 1];
  return step;
}

/** Start a fresh attempt: no gates, no peek, no collapse, back at the starting state. */
export function reset(game) {
  game.steps = [];
  game.states = [game.start];
  game.current = game.start;
  game.peeked = false;
  game.collapsed = false;
  return game;
}

/**
 * Peek: measure the current state for real. The qubit collapses to the outcome, the game keeps playing
 * from that collapsed state, and the attempt is marked as peeked (one star, no matter how many peeks).
 * A peek that really collapsed a blend also marks the attempt as collapsed. It stays that way until reset().
 * rng is a function that returns a number from 0 up to (not including) 1, like Math.random.
 * Returns {bits, probability, wasBlend, state}.
 */
export function peek(game, rng = Math.random) {
  const result = measureAll(game.current, rng);
  const wasBlend = result.probability < 1 - NEGLIGIBLE;
  game.steps.push({ kind: 'peek', bits: result.bits, probability: result.probability, collapsed: wasBlend });
  game.states.push(result.state);
  game.current = result.state;
  game.peeked = true;
  if (wasBlend) game.collapsed = true;
  return { bits: result.bits, probability: result.probability, wasBlend, state: result.state };
}

/** The words for one step in the sequence: 'H', 'CNOT 0→1' or 'Peek: got 1'. */
export function stepLabel(step) {
  if (step.kind === 'peek') return `Peek: got ${step.bits}`;
  if (step.gate === 'CNOT') return `CNOT ${step.control}→${step.target}`;
  return step.gate;
}

/* ---------- Stars and sharing ---------- */

/** 3 stars at or under par, 2 for par + 1, 1 otherwise. A peek costs one star, but never below 1. */
export function starsFor({ gatesUsed: used, par, peeked = false }) {
  const base = used <= par ? MAX_STARS : used === par + 1 ? MAX_STARS - 1 : 1;
  return Math.max(1, base - (peeked ? PEEK_COST : 0));
}

/** "Collapse Challenge #12 ⭐⭐⭐ in 3 gates", plus a second line with the page link when url is given. Never shows the solution. */
export function shareText({ puzzleId, stars, gatesUsed: used, url = '' }) {
  const count = `${used} ${used === 1 ? 'gate' : 'gates'}`;
  const first = `Collapse Challenge #${puzzleId} ${'⭐'.repeat(stars)} in ${count}`;
  return url ? `${first}\n${url}` : first;
}

/* ---------- Friendly feedback ---------- */

/** Say how a state would measure: "0 every time" or "0 (50%) or 1 (50%)". */
export function describeOdds(state) {
  const outcomes = probabilities(state)
    .map((p, index) => ({ p, label: basisLabel(index, state.numQubits) }))
    .filter(({ p }) => p > NEGLIGIBLE);
  if (outcomes.length === 1) return `${outcomes[0].label} every time`;
  return outcomes.map(({ p, label }) => `${label} (${formatProbability(p)})`).join(' or ');
}

/** True when one outcome is certain (a plain 0 or 1, not a blend). */
function isPlain(state) {
  return Math.max(...probabilities(state)) > 1 - NEGLIGIBLE;
}

/** Join kets for a sentence: "|1⟩" or "|01⟩ and |10⟩". */
function listKets(mismatches) {
  return mismatches.map((m) => basisKet(m.label)).join(' and ');
}

/** What to try next when the measurement odds are wrong. Only gates the puzzle allows are ever mentioned. */
function oddsNudge(game) {
  const allowed = game.puzzle.allowedGates;
  const { current, target } = game;
  if (isPlain(target) && isPlain(current)) {
    return allowed.includes('X') ? `Both are plain states, just different ones. ${GATE_TIPS.X}` : 'Both are plain states, just different ones.';
  }
  if (!isPlain(target) && isPlain(current)) {
    return allowed.includes('H') ? `The target is a mix of outcomes. ${GATE_TIPS.H}` : 'The target is a mix of outcomes, but yours is a plain state.';
  }
  if (isPlain(target) && !isPlain(current)) {
    return allowed.includes('H') ? `The target is a plain state, but yours is still a mix. ${GATE_TIPS.H}` : 'The target is a plain state, but yours is still a mix.';
  }
  return 'Compare the bars and try a different gate.';
}

/** The sentence for "probabilities match but the hidden phase is off". */
function phaseMessage(game, difference) {
  const allowed = game.puzzle.allowedGates;
  const kets = listKets(difference.phaseMismatches);
  const where = kets ? ` on ${kets}` : '';
  switch (difference.phaseHint) {
    case 'sign': {
      const lead = `Your probabilities match, but the sign of ${kets} is wrong.`;
      if (!allowed.includes('Z')) {
        // Only H can turn a hidden sign into a visible change (and back) when Y is not there to flip it directly.
        return allowed.includes('H') && !allowed.includes('Y')
          ? `${lead} This puzzle has no Z gate, so look for a way to turn the hidden sign into a visible change and back again.`
          : `${lead} Your sign is still different. Try each gate you have and watch the dial arrow.`;
      }
      return game.puzzle.qubits === 1 ? `${lead} Try a Z gate. ${GATE_TIPS.Z}` : `${lead} Try a Z gate on one of the qubits.`;
    }
    case 'quarter-turn': {
      const lead = `Your probabilities match, but the hidden twist (phase)${where} is a quarter-turn off.`;
      return allowed.includes('S') ? `${lead} Try an S gate. ${GATE_TIPS.S}` : lead;
    }
    case 'eighth-turn': {
      const lead = `Your probabilities match, but the hidden twist (phase)${where} is an eighth-turn off.`;
      return allowed.includes('T') ? `${lead} Try a T gate. ${GATE_TIPS.T}` : lead;
    }
    default:
      return `Your probabilities match, but the hidden twist (phase)${where} is different from the target.`;
  }
}

/** The sentence after a correct answer. */
function successMessage(used, par, peeked) {
  const count = `${used} ${used === 1 ? 'gate' : 'gates'}`;
  let text;
  if (used < par) text = `You matched the target in ${count}, fewer than par. Great work!`;
  else if (used === par) text = `You matched the target in ${count}, which is par. Perfect!`;
  else if (used === par + 1) text = `You matched the target in ${count}, one more than the shortest way. See if you can find the ${par}-gate path.`;
  else text = `You matched the target in ${count}. The shortest way uses ${par}, so try again whenever you like and see if you can get closer.`;
  return peeked ? `${text} Peeking cost one star.` : text;
}

/**
 * Check the player's answer. Returns {solved, stars, gatesUsed, par, peeked, kind, difference, message}.
 * The states are compared ignoring global phase. After a peek really collapsed the qubit, no gates can reach the target for sure
 * (the two possible outcomes end up in different states), so a match is luck and does not count.
 * kind is 'solved', 'lucky-collapse', 'empty', 'wrong-probabilities', 'sign', 'quarter-turn', 'eighth-turn' or 'other'.
 */
export function check(game) {
  const { puzzle, target, current } = game;
  const used = gatesUsed(game);
  const difference = describeDifference(target, current);
  const base = { solved: false, stars: 0, gatesUsed: used, par: puzzle.par, peeked: game.peeked, difference };

  if (difference.same && game.collapsed) {
    return {
      ...base,
      kind: 'lucky-collapse',
      message: 'That matches only because the measurement collapsed your qubit into it by luck. A measurement can’t be undone, so press Reset to start a new attempt, then build the state with gates before measuring.',
    };
  }
  if (difference.same) {
    const stars = starsFor({ gatesUsed: used, par: puzzle.par, peeked: game.peeked });
    return { ...base, solved: true, stars, kind: 'solved', message: successMessage(used, puzzle.par, game.peeked) };
  }
  if (game.steps.length === 0) {
    return { ...base, kind: 'empty', message: 'You have not added any gates yet. Press a gate button to change your state, then press Check.' };
  }

  const collapsedNote = game.collapsed ? ' You peeked earlier, so your qubit collapsed into a plain state. A measurement can’t be undone: press Reset to start a new attempt.' : '';
  if (!difference.probabilitiesMatch) {
    const message = `If you measured now, you would get ${describeOdds(current)}. The target gives ${describeOdds(target)}. ${oddsNudge(game)}`;
    return { ...base, kind: 'wrong-probabilities', message: message + collapsedNote };
  }
  const kind = ['sign', 'quarter-turn', 'eighth-turn'].includes(difference.phaseHint) ? difference.phaseHint : 'other';
  return { ...base, kind, message: phaseMessage(game, difference) + collapsedNote };
}
