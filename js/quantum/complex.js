/* ==========================================================================
   complex.js — complex numbers for the quantum engine, with no web page code.

   A complex number is a plain object {re, im}: "re" is the real part and "im"
   the imaginary part (a quantum amplitude is one of these). Every function
   returns a NEW object and never changes its inputs.

   Example:
     import { complex, mul, I } from './complex.js';
     const a = mul(complex(1, 1), I);   // (1 + i) * i
     // a is {re: -1, im: 1}
   ========================================================================== */

/** Numbers smaller than this (in size) count as zero everywhere in the engine. */
export const EPSILON = 1e-12;

/** Make a complex number {re, im}; "+ 0" turns a stray -0 into plain 0. */
export function complex(re = 0, im = 0) {
  return { re: re + 0, im: im + 0 };
}

/** The complex number 0. */
export const ZERO = Object.freeze(complex(0, 0));

/** The complex number 1. */
export const ONE = Object.freeze(complex(1, 0));

/** The imaginary unit i (i times i is -1). */
export const I = Object.freeze(complex(0, 1));

/** Turn a number, a [re, im] pair or a {re, im} object into a fresh {re, im}, or throw. */
export function toComplex(x) {
  if (typeof x === 'number' && Number.isFinite(x)) return complex(x, 0);
  if (Array.isArray(x) && x.length === 2 && x.every(Number.isFinite)) return complex(x[0], x[1]);
  if (x && typeof x === 'object' && Number.isFinite(x.re) && Number.isFinite(x.im ?? 0)) {
    return complex(x.re, x.im ?? 0);
  }
  throw new Error('A complex number must be a number, a [re, im] pair or an object like {re, im}.');
}

/** a + b. */
export function add(a, b) {
  return complex(a.re + b.re, a.im + b.im);
}

/** a - b. */
export function sub(a, b) {
  return complex(a.re - b.re, a.im - b.im);
}

/** a * b. */
export function mul(a, b) {
  return complex(a.re * b.re - a.im * b.im, a.re * b.im + a.im * b.re);
}

/** Multiply a complex number by an ordinary number k. */
export function scale(a, k) {
  return complex(a.re * k, a.im * k);
}

/** The complex conjugate (flip the sign of the imaginary part). */
export function conj(a) {
  return complex(a.re, -a.im);
}

/** The magnitude (size) of a, written |a|. */
export function abs(a) {
  return Math.hypot(a.re, a.im);
}

/** The squared magnitude |a|^2, which is the probability when a is an amplitude. */
export function abs2(a) {
  return a.re * a.re + a.im * a.im;
}

/** The angle of a in radians, from -π to π (0 for the number 0). */
export function arg(a) {
  return Math.atan2(a.im, a.re);
}

/** Build a complex number from a length r and an angle theta (in radians). */
export function fromPolar(r, theta) {
  return complex(r * Math.cos(theta), r * Math.sin(theta));
}

/** True when a is smaller than tol in size (default EPSILON). */
export function isZero(a, tol = EPSILON) {
  return abs(a) < tol;
}

/** True when a and b are closer together than tol (default 1e-9). */
export function approxEqual(a, b, tol = 1e-9) {
  return abs(sub(a, b)) < tol;
}
