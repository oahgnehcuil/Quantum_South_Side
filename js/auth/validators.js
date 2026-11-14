/* ==========================================================================
   validators.js — checks for the sign-up and log-in forms. Pure functions: no DOM, no network.

   The password rules here MUST match "Minimum password length" in the Supabase dashboard
   (see docs/supabase-setup.md). The nickname rules match the CHECK on profiles.nickname.
   Passwords are only checked here and sent to Supabase Auth. They are never stored or logged.
   ========================================================================== */
import { PASSWORD_MIN_LENGTH, NICKNAME_MIN, NICKNAME_MAX } from '../config.js';

/** Supabase hashes passwords with bcrypt, which accepts at most 72 bytes. */
const PASSWORD_MAX_BYTES = 72;
const EMAIL_MAX_LENGTH = 254;

const LETTER = /\p{L}/u;
const DIGIT = /\p{Nd}/u;
const NICKNAME_CHARS = /^[\p{L}\p{Nd} _]+$/u;
const COMMON_PASSWORDS = new Set(['password12', 'password123', 'password1234', '1234567890', '12345678910', 'qwertyuiop1', 'iloveyou123', 'letmein1234', 'abcdefghij1', 'abc1234567']);

const countChars = (text) => [...text].length;

/** Is this a plausible email address? (Supabase does the final check by sending the email.) */
export function validateEmail(email) {
  if (typeof email !== 'string' || email.trim() === '') return { ok: false, message: 'Please enter your email address.' };
  const value = email.trim();
  const looksRight = value.length <= EMAIL_MAX_LENGTH && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value) && !value.includes('..') && !/^\.|\.@|@\.|\.$/.test(value);
  if (!looksRight) return { ok: false, message: 'That does not look like an email address. It should look like name@example.com.' };
  return { ok: true, value };
}

/**
 * Check a password and say how strong it is.
 * score: 0 = too short, 1 = weak, 2 = okay, 3-4 = strong (for a 4-step meter).
 * ok is true only when every rule is met.
 */
export function validatePassword(password) {
  const text = typeof password === 'string' ? password : '';
  const length = countChars(text);
  const rules = [
    { id: 'length', label: `At least ${PASSWORD_MIN_LENGTH} characters`, met: length >= PASSWORD_MIN_LENGTH },
    { id: 'letter', label: 'At least one letter', met: LETTER.test(text) },
    { id: 'number', label: 'At least one number', met: DIGIT.test(text) },
  ];
  const tooLong = new TextEncoder().encode(text).length > PASSWORD_MAX_BYTES;
  const allMet = rules.every((rule) => rule.met);

  let score = 0;
  if (rules[0].met) {
    score = 1;
    if (allMet && !tooLong) {
      const classes = [/\p{Ll}/u, /\p{Lu}/u, DIGIT, /[^\p{L}\p{Nd}]/u].filter((pattern) => pattern.test(text)).length;
      const easyToGuess = COMMON_PASSWORDS.has(text.toLowerCase()) || new Set(text).size < 4;
      score = easyToGuess ? 1 : 2 + (length >= 14 ? 1 : 0) + (classes >= 3 ? 1 : 0);
    }
  }
  const label = !rules[0].met ? 'Too short' : score <= 1 ? 'Weak' : score === 2 ? 'Okay' : 'Strong';

  const result = { ok: allMet && !tooLong, score, label, rules };
  if (tooLong) result.message = 'That password is too long. Please use 72 bytes or fewer (about 72 letters and numbers).';
  return result;
}

/** Letters-and-numbers key used to compare a nickname with the start of an email address. */
const squash = (text) => text.toLowerCase().replace(/[\s_.\-+]/g, '');

/**
 * Check a nickname: 2-30 characters; letters (any language), numbers, spaces and underscore only.
 * It must not look like an email address, or be the first part of the person's email.
 * Returns the cleaned-up value (trimmed, spaces collapsed) when it is fine.
 */
export function validateNickname(nickname, { email } = {}) {
  if (typeof nickname !== 'string') return { ok: false, message: 'Please choose a nickname.' };
  const value = nickname.normalize('NFC').trim().replace(/\s+/g, ' ');
  if (value === '') return { ok: false, message: 'Please choose a nickname.' };
  if (value.includes('@')) return { ok: false, message: 'A nickname cannot be an email address or contain "@". Pick a fun name instead.' };
  const length = countChars(value);
  if (length < NICKNAME_MIN) return { ok: false, message: `Your nickname needs at least ${NICKNAME_MIN} characters.` };
  if (length > NICKNAME_MAX) return { ok: false, message: `Your nickname can be at most ${NICKNAME_MAX} characters.` };
  if (!NICKNAME_CHARS.test(value)) return { ok: false, message: 'Use only letters, numbers, spaces and underscores in your nickname.' };

  if (typeof email === 'string' && email.includes('@')) {
    const trimmed = email.trim();
    const localPart = trimmed.slice(0, trimmed.lastIndexOf('@'));
    const withoutTag = localPart.split('+')[0]; // "sam+news@..." is still "sam"
    const key = squash(value);
    if (key !== '' && (key === squash(localPart) || key === squash(withoutTag))) {
      return { ok: false, message: 'Your nickname should not match your email address. Pick a different one.' };
    }
  }
  return { ok: true, value };
}

/** True when both passwords are the same text. */
export function passwordsMatch(a, b) {
  return typeof a === 'string' && typeof b === 'string' && a === b;
}
