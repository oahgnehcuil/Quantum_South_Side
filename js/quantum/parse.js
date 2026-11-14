/* ==========================================================================
   parse.js — turns text like "1/√2" or "e^(iπ/4)/√2" into a complex number.

   It is a small "recursive-descent" parser: one function per grammar rule.
   It never uses eval or new Function, so any text typed by a visitor is safe.
   Understood: numbers, i, π or pi, e, √ or sqrt(...), + - * / ^, brackets,
   and "implicit multiplication" (so "2i" and "iπ" mean 2*i and i*π).

   Example:
     import { parseAmplitude } from './parse.js';
     parseAmplitude('1/√2');   // {re: 0.7071…, im: 0}
     parseAmplitude('-i');     // {re: 0, im: -1}
   ========================================================================== */

import { EPSILON, complex, add, sub, mul, conj, abs2, abs, arg, fromPolar, toComplex } from './complex.js';

const NAMES = ['sqrt', 'pi', 'e', 'i'];
const SYMBOLS = '+-*/^()';
const MAX_EXACT_POWER = 64;

/** Split text into tokens: {type:'num'|'name'|'sym', value}. */
function tokenize(text) {
  const tokens = [];
  const clean = text.replace(/−/g, '-').replace(/[×·]/g, '*').toLowerCase();
  let pos = 0;
  while (pos < clean.length) {
    const ch = clean[pos];
    const rest = clean.slice(pos);
    const number = /^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/.exec(rest);
    const name = NAMES.find((n) => rest.startsWith(n));
    if (/\s/.test(ch)) {
      pos += 1;
    } else if (number) {
      tokens.push({ type: 'num', value: Number(number[0]) });
      pos += number[0].length;
    } else if (name) {
      tokens.push({ type: 'name', value: name });
      pos += name.length;
    } else if (ch === 'π') {
      tokens.push({ type: 'name', value: 'pi' });
      pos += 1;
    } else if (ch === '√') {
      tokens.push({ type: 'name', value: 'sqrt' });
      pos += 1;
    } else if (SYMBOLS.includes(ch)) {
      tokens.push({ type: 'sym', value: ch });
      pos += 1;
    } else {
      throw new Error(`Cannot understand "${text}" as an amplitude: unexpected "${text[pos]}" at position ${pos + 1}.`);
    }
  }
  return tokens;
}

/** Raise a complex number to a complex power (exact repeated multiplication for small whole powers). */
function power(base, exponent) {
  const whole = Number.isInteger(exponent.re) && Math.abs(exponent.re) <= MAX_EXACT_POWER;
  if (whole && Math.abs(exponent.im) < EPSILON) {
    let result = complex(1, 0);
    for (let k = 0; k < Math.abs(exponent.re); k += 1) result = mul(result, base);
    return exponent.re < 0 ? divide(complex(1, 0), result) : result;
  }
  if (abs(base) < EPSILON) throw new Error('Cannot raise 0 to that power.');
  // base^exponent = e^(exponent * ln(base)), where ln(base) = ln|base| + i*angle.
  const logBase = complex(Math.log(abs(base)), arg(base));
  const product = mul(exponent, logBase);
  return fromPolar(Math.exp(product.re), product.im);
}

/** Divide a by b, or throw if b is zero. */
function divide(a, b) {
  const size = abs2(b);
  if (size < EPSILON * EPSILON) throw new Error('Cannot divide by zero.');
  const top = mul(a, conj(b));
  return complex(top.re / size, top.im / size);
}

/** Square root of a complex number (principal value). */
function squareRoot(a) {
  return fromPolar(Math.sqrt(abs(a)), arg(a) / 2);
}

/** Parse a token list into one complex number. */
function parseTokens(tokens, text) {
  let pos = 0;
  const peek = () => tokens[pos];
  const isSym = (value) => peek()?.type === 'sym' && peek().value === value;
  const fail = (message) => {
    throw new Error(`Cannot understand "${text}" as an amplitude: ${message}`);
  };

  // An atom starts a new factor, which is how "2i" or "iπ" multiply without a "*".
  const startsAtom = () => {
    const t = peek();
    return Boolean(t) && t.type !== 'num' && (t.type !== 'sym' || t.value === '(');
  };

  function parseAtom() {
    const t = peek();
    if (!t) return fail('it ends too early.');
    pos += 1;
    if (t.type === 'num') return complex(t.value, 0);
    if (t.type === 'name') {
      if (t.value === 'i') return complex(0, 1);
      if (t.value === 'pi') return complex(Math.PI, 0);
      if (t.value === 'e') return complex(Math.E, 0);
      // sqrt: either sqrt(...) or √ followed directly by one atom.
      return squareRoot(parseAtom());
    }
    if (t.value === '(') {
      const inside = parseExpression();
      if (!isSym(')')) return fail('a closing bracket ")" is missing.');
      pos += 1;
      return inside;
    }
    return fail(`unexpected "${t.value}".`);
  }

  function parseFactor() {
    if (isSym('-')) {
      pos += 1;
      return mul(complex(-1, 0), parseFactor());
    }
    if (isSym('+')) {
      pos += 1;
      return parseFactor();
    }
    const base = parseAtom();
    if (isSym('^')) {
      pos += 1;
      return power(base, parseFactor());
    }
    return base;
  }

  function parseTerm() {
    let value = parseFactor();
    for (;;) {
      if (isSym('*') || isSym('/')) {
        const op = peek().value;
        pos += 1;
        const next = parseFactor();
        value = op === '/' ? divide(value, next) : mul(value, next);
      } else if (startsAtom()) {
        value = mul(value, parseFactor());
      } else {
        return value;
      }
    }
  }

  function parseExpression() {
    let value = parseTerm();
    while (isSym('+') || isSym('-')) {
      const op = peek().value;
      pos += 1;
      const next = parseTerm();
      value = op === '+' ? add(value, next) : sub(value, next);
    }
    return value;
  }

  if (tokens.length === 0) fail('it is empty.');
  const result = parseExpression();
  if (pos < tokens.length) fail(peek().type === 'num' ? `unexpected number "${peek().value}" (put * between numbers).` : `unexpected "${peek().value}".`);
  return result;
}

/** Read an amplitude: numbers, [re, im] pairs and {re, im} pass through; text like "1/√2" or "e^(iπ/4)/√2" is parsed. */
export function parseAmplitude(textOrNumber) {
  if (typeof textOrNumber !== 'string') return toComplex(textOrNumber);
  const value = parseTokens(tokenize(textOrNumber), textOrNumber);
  const clean = (x) => (Math.abs(x) < EPSILON ? 0 : x);
  if (!Number.isFinite(value.re) || !Number.isFinite(value.im)) {
    throw new Error(`Cannot understand "${textOrNumber}" as an amplitude: the result is not a finite number.`);
  }
  return complex(clean(value.re), clean(value.im));
}
