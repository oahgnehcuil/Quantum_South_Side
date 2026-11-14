/* ==========================================================================
   format.js — turns amplitudes, states and probabilities into readable text.

   Exact mode writes familiar values ("1/√2", "√3/2") when it recognises them;
   otherwise numbers are rounded decimals. Ket text uses "|0⟩" (U+27E9) and the
   true minus sign "−" (U+2212). Numbers smaller than 1e-12 print as 0, so you
   never see "-0" or 1e-17.

   Example:
     import { formatKet } from './format.js';
     formatKet(plusState);                      // '1/√2|0⟩ + 1/√2|1⟩'
     formatKet(plusState, { exact: false });    // '0.707|0⟩ + 0.707|1⟩'
   ========================================================================== */

import { EPSILON } from './complex.js';
import { assertState, basisLabel, createState } from './state.js';
import { isSameState } from './compare.js';

const MINUS = '−';
const EXACT_TOLERANCE = 1e-9;

// Magnitudes we can write exactly, as [value, text].
const EXACT_VALUES = [
  [0, '0'],
  [1, '1'],
  [0.5, '1/2'],
  [Math.SQRT1_2, '1/√2'],
  [Math.SQRT1_2 / 2, '1/(2√2)'],
  [Math.sqrt(3) / 2, '√3/2'],
  [1 / Math.sqrt(3), '1/√3'],
  [0.25, '1/4'],
];

/** Write a magnitude exactly ('1/√2', '1/2', …) or return null if it is not a recognised value; the sign is up to the caller. */
export function exactValue(x) {
  const size = Math.abs(x);
  const match = EXACT_VALUES.find(([value]) => Math.abs(size - value) < EXACT_TOLERANCE);
  return match ? match[1] : null;
}

/** Round to a number of decimals and drop trailing zeros ('0.707', '0.5', '1'). */
function decimal(x, precision) {
  return String(Number(Math.abs(x).toFixed(precision)));
}

/** Write a non-negative magnitude, exactly if allowed and possible, otherwise as a decimal. */
function magnitudeText(x, exact, precision) {
  return (exact ? exactValue(x) : null) ?? decimal(x, precision);
}

/** Attach "i" to a magnitude text: '1' -> 'i', '1/√2' -> 'i/√2', '√3/2' -> 'i√3/2', '0.5' -> '0.5i'. */
function imaginaryText(magnitude, exact) {
  if (magnitude === '1') return 'i';
  if (exact && magnitude.startsWith('1/')) return `i${magnitude.slice(1)}`;
  return exact && /[√/]/.test(magnitude) ? `i${magnitude}` : `${magnitude}i`;
}

/** Split a complex number into {re, im}; noise below EPSILON, or a part that rounds to 0 at this precision, becomes 0. */
function cleanParts(c, precision) {
  const clean = (x) => (Math.abs(x) < EPSILON || Number(Math.abs(x).toFixed(precision)) === 0 ? 0 : x);
  return { re: clean(c.re), im: clean(c.im) };
}

/** Write one amplitude as text: '1/√2', '−1/2', '0.707', 'i/√2', '−i', '(1+i)/2' or '0.854+0.354i'. */
export function formatAmplitude(c, { exact = true, precision = 3 } = {}) {
  const { re, im } = cleanParts(c, precision);
  const sign = (x) => (x < 0 ? MINUS : '');
  if (re === 0 && im === 0) return '0';
  if (im === 0) {
    const text = magnitudeText(re, exact, precision);
    return text === '0' ? '0' : sign(re) + text;
  }
  if (re === 0) {
    const text = magnitudeText(im, exact, precision);
    return text === '0' ? '0' : sign(im) + imaginaryText(text, exact);
  }
  const common = exact && Math.abs(Math.abs(re) - Math.abs(im)) < EXACT_TOLERANCE ? exactValue(re) : null;
  if (common === '1' || common?.startsWith('1/')) {
    // Equal real and imaginary parts: (1+i)/2 style, with the size written after the bracket.
    const rest = common === '1' ? '' : common.slice(1);
    return `(${sign(re)}1${im < 0 ? MINUS : '+'}i)${rest}`;
  }
  const reText = sign(re) + magnitudeText(re, false, precision);
  const imMagnitude = decimal(im, precision);
  return `${reText}${im < 0 ? MINUS : '+'}${imMagnitude === '1' ? '' : imMagnitude}i`;
}

/** Write a bit string as a ket: '01' -> '|01⟩'. */
export function basisKet(bits) {
  if (typeof bits !== 'string' || !/^[01]+$/.test(bits)) throw new Error(`Expected a bit string like "01", not ${String(bits)}.`);
  return `|${bits}⟩`;
}

/** Write a state as a sum of kets, like '1/√2|0⟩ + 1/√2|1⟩' (includeZeros also lists the impossible outcomes). */
export function formatKet(state, { exact = true, precision = 3, includeZeros = false } = {}) {
  assertState(state);
  const terms = [];
  state.amplitudes.forEach((amplitude, index) => {
    const { re, im } = cleanParts(amplitude, precision);
    const ket = basisKet(basisLabel(index, state.numQubits));
    const single = re === 0 || im === 0; // only one non-zero part, so the sign can sit outside
    const part = single ? { re: Math.abs(re), im: Math.abs(im) } : amplitude;
    let text = formatAmplitude(part, { exact, precision });
    if (text === '0' && !includeZeros) return;
    const negative = single && (re < 0 || im < 0) && text !== '0';
    if (!single && !text.startsWith('(')) text = `(${text})`;
    terms.push({ negative, text: text === '1' ? ket : `${text}${ket}` });
  });
  if (terms.length === 0) return '0';
  return terms
    .map(({ negative, text }, k) => (k === 0 ? (negative ? MINUS : '') + text : ` ${negative ? MINUS : '+'} ${text}`))
    .join('');
}

/** Write a probability from 0 to 1 as a whole-number percent: '50%', '<1%' for tiny values and '>99%' for just under 1. */
export function formatProbability(p) {
  if (!Number.isFinite(p)) throw new Error(`A probability must be a number, not ${String(p)}.`);
  const clamped = Math.min(1, Math.max(0, p));
  if (clamped < EPSILON) return '0%';
  if (clamped > 1 - EPSILON) return '100%';
  const percent = Math.round(clamped * 100);
  if (percent === 0) return '<1%';
  if (percent === 100) return '>99%';
  return `${percent}%`;
}

// The single-qubit states that have a name, as [id, ket text, amplitudes].
const NAMED_STATES = [
  ['zero', '|0⟩', [1, 0]],
  ['one', '|1⟩', [0, 1]],
  ['plus', '|+⟩', [Math.SQRT1_2, Math.SQRT1_2]],
  ['minus', '|−⟩', [Math.SQRT1_2, -Math.SQRT1_2]],
  ['plusI', '|+i⟩', [Math.SQRT1_2, { re: 0, im: Math.SQRT1_2 }]],
  ['minusI', '|−i⟩', [Math.SQRT1_2, { re: 0, im: -Math.SQRT1_2 }]],
];

/** The name of a one-qubit state ({id, ket}) such as |+⟩, up to global phase, or null if it has no name. */
export function nameState(state) {
  assertState(state);
  if (state.numQubits !== 1) return null;
  const match = NAMED_STATES.find(([, , amplitudes]) => isSameState(createState(1, amplitudes), state));
  return match ? { id: match[0], ket: match[1] } : null;
}
