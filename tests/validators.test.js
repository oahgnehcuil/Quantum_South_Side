/* ==========================================================================
   validators.test.js — the sign-up and log-in form checks in js/auth/validators.js.
   Run with: npm test   (or: node --test tests/validators.test.js)
   ========================================================================== */

import test from 'node:test';
import assert from 'node:assert/strict';

import { validateEmail, validatePassword, validateNickname, passwordsMatch } from '../js/auth/validators.js';
import { PASSWORD_MIN_LENGTH, NICKNAME_MIN, NICKNAME_MAX } from '../js/config.js';

test('config: the account limits match the owner spec', () => {
  assert.equal(PASSWORD_MIN_LENGTH, 10);
  assert.equal(NICKNAME_MIN, 2);
  assert.equal(NICKNAME_MAX, 30);
});

/* ---------- email ---------- */

test('validateEmail: normal addresses pass (and come back trimmed)', () => {
  for (const email of ['a@b.co', 'student@example.com', 'first.last+tag@sub.example.org', ' padded@example.com ', 'x_y-z@my-school.k12.il.us', 'JOSÉ@example.com']) {
    const result = validateEmail(email);
    assert.equal(result.ok, true, email);
    assert.equal(result.value, email.trim());
  }
});

test('validateEmail: bad input is refused with a friendly message', () => {
  const bad = ['', '   ', 'plain', 'a@b', '@example.com', 'a@', 'a b@example.com', 'a@exa mple.com', 'a@@example.com', 'a@b@example.com', 'a..b@example.com', '.a@example.com', 'a.@example.com', 'a@.example.com', 'a@example.', 'a@example.c', 'x'.repeat(250) + '@example.com', null, undefined, 42, {}, ['a@b.co']];
  for (const email of bad) {
    const result = validateEmail(email);
    assert.equal(result.ok, false, String(email).slice(0, 30));
    assert.equal(typeof result.message, 'string');
    assert.ok(result.message.length > 10);
  }
});

/* ---------- password ---------- */

const ruleMap = (result) => Object.fromEntries(result.rules.map((rule) => [rule.id, rule.met]));

test('validatePassword: always returns the three rules in order, with labels', () => {
  for (const input of ['', 'abc', 'abcdefghij1', undefined, null, 12345, {}]) {
    const result = validatePassword(input);
    assert.deepEqual(result.rules.map((rule) => rule.id), ['length', 'letter', 'number']);
    for (const rule of result.rules) assert.ok(typeof rule.label === 'string' && rule.label.length > 5 && typeof rule.met === 'boolean');
    assert.ok(Number.isInteger(result.score) && result.score >= 0 && result.score <= 4);
    assert.ok(['Too short', 'Weak', 'Okay', 'Strong'].includes(result.label));
  }
  assert.match(validatePassword('').rules[0].label, /10 characters/);
});

test('validatePassword: length boundary 9 / 10 characters', () => {
  const nine = validatePassword('abcdefgh1');
  assert.equal(nine.ok, false);
  assert.equal(ruleMap(nine).length, false);
  assert.equal(nine.label, 'Too short');
  assert.equal(nine.score, 0);

  const ten = validatePassword('abcdefghi1');
  assert.equal(ten.ok, true);
  assert.equal(ruleMap(ten).length, true);
  assert.equal(ten.label, 'Okay');
});

test('validatePassword: needs a letter and a number', () => {
  const noNumber = validatePassword('abcdefghijkl');
  assert.deepEqual(ruleMap(noNumber), { length: true, letter: true, number: false });
  assert.equal(noNumber.ok, false);
  assert.equal(noNumber.label, 'Weak');
  assert.equal(noNumber.score, 1);

  const noLetter = validatePassword('1234567890123');
  assert.deepEqual(ruleMap(noLetter), { length: true, letter: false, number: true });
  assert.equal(noLetter.ok, false);
  assert.equal(noLetter.label, 'Weak');

  const symbolsOnly = validatePassword('!!!!!!!!!!!!');
  assert.deepEqual(ruleMap(symbolsOnly), { length: true, letter: false, number: false });
  assert.equal(symbolsOnly.ok, false);
});

test('validatePassword: unicode letters count as letters, spaces count as characters', () => {
  assert.equal(validatePassword('contraseña9ñ').ok, true);
  assert.equal(validatePassword('пароль12345').ok, true);
  assert.equal(validatePassword('a 1 b 2 c 3').ok, true);
  assert.equal(validatePassword('😀😀😀😀😀😀😀😀😀😀').ok, false, 'emoji only: no letter, no number');
});

test('validatePassword: length counts characters, not UTF-16 units', () => {
  assert.equal(ruleMap(validatePassword('😀😀😀😀😀a1')).length, false); // 7 characters
  assert.equal(ruleMap(validatePassword('😀😀😀😀😀😀😀a1x')).length, true); // 10 characters
});

test('validatePassword: score and label thresholds', () => {
  assert.deepEqual([validatePassword('').score, validatePassword('').label], [0, 'Too short']);
  assert.deepEqual([validatePassword('short1').score, validatePassword('short1').label], [0, 'Too short']);
  assert.deepEqual([validatePassword('abcdefghijkl').score, validatePassword('abcdefghijkl').label], [1, 'Weak']);

  const okay = validatePassword('apples123x'); // 10 chars, lowercase + digit only
  assert.deepEqual([okay.score, okay.label, okay.ok], [2, 'Okay', true]);

  const longer = validatePassword('applesandpears123'); // 17 chars, 2 classes: +1 for length
  assert.deepEqual([longer.score, longer.label], [3, 'Strong']);

  const mixed = validatePassword('Apples123x'); // 10 chars, 3 classes: +1 for variety
  assert.deepEqual([mixed.score, mixed.label], [3, 'Strong']);

  const best = validatePassword('Apples and Pears 123!'); // long and many classes
  assert.deepEqual([best.score, best.label], [4, 'Strong']);
});

test('validatePassword: very guessable passwords never rate better than Weak, but the rules still decide ok', () => {
  for (const easy of ['password123', 'Password123', 'aaaaaaaaa1', 'a1a1a1a1a1a1']) {
    const result = validatePassword(easy);
    assert.equal(result.ok, true, `${easy}: the rules from the owner spec decide ok`);
    assert.equal(result.score, 1, easy);
    assert.equal(result.label, 'Weak');
  }
});

test('validatePassword: more than 72 bytes is refused (bcrypt limit) with a message', () => {
  assert.equal(validatePassword('a1'.repeat(36)).ok, true); // exactly 72 bytes
  const tooLong = validatePassword('a1'.repeat(36) + 'b');
  assert.equal(tooLong.ok, false);
  assert.match(tooLong.message, /too long/);
  assert.equal(validatePassword('é1'.repeat(25)).ok, false, '50 characters, 75 bytes');
  assert.equal(validatePassword('é1'.repeat(24)).ok, true, '48 characters, 72 bytes');
});

test('validatePassword: empty and non-string input is just "too short"', () => {
  for (const input of [undefined, null, 5, {}, [], true]) {
    const result = validatePassword(input);
    assert.equal(result.ok, false);
    assert.equal(result.label, 'Too short');
    assert.equal(result.score, 0);
  }
});

test('validatePassword: the result never contains the password itself', () => {
  const secret = 'Zx9-unique-secret-value';
  assert.ok(!JSON.stringify(validatePassword(secret)).includes(secret));
  assert.ok(!JSON.stringify(validatePassword(secret + 'x'.repeat(80))).includes(secret));
});

/* ---------- nickname ---------- */

test('validateNickname: length boundaries 1 / 2 / 30 / 31', () => {
  assert.equal(validateNickname('a').ok, false);
  assert.match(validateNickname('a').message, /at least 2/);
  assert.deepEqual(validateNickname('ab'), { ok: true, value: 'ab' });
  assert.equal(validateNickname('a'.repeat(30)).ok, true);
  const tooLong = validateNickname('a'.repeat(31));
  assert.equal(tooLong.ok, false);
  assert.match(tooLong.message, /at most 30/);
});

test('validateNickname: letters in any language, numbers, spaces and underscores are fine', () => {
  for (const name of ['José', 'Zoë', 'Renée Dubois', 'Åsa', '李小龍', 'Дима', 'Quantum_Fan_7', 'player 1', '12', '__', 'مرحبا']) {
    const result = validateNickname(name);
    assert.equal(result.ok, true, name);
    assert.equal(result.value, name.normalize('NFC'));
  }
});

test('validateNickname: decomposed accents are joined (NFC) so Zoë typed two ways is accepted', () => {
  const result = validateNickname('Zoë');
  assert.equal(result.ok, true);
  assert.equal(result.value, 'Zoë');
  assert.equal(result.value.length, 3);
});

test('validateNickname: emoji, symbols and punctuation are rejected', () => {
  for (const name of ['cool😀', '😀😀', 'star★', 'a-b', 'a.b', "o'neil", 'hi!', 'a/b', '<b>x</b>', 'name;drop', 'a​b', '👩🏾‍🚀 astro']) {
    const result = validateNickname(name);
    assert.equal(result.ok, false, name);
    assert.match(result.message, /letters, numbers, spaces and underscores/);
  }
});

test('validateNickname: "@" and email-like nicknames are rejected', () => {
  for (const name of ['me@example.com', '@me', 'a@b', 'me@', 'user @ site']) {
    const result = validateNickname(name);
    assert.equal(result.ok, false, name);
    assert.match(result.message, /email|@/);
  }
});

test('validateNickname: must not match the email name part (ignoring case, dots, spaces and underscores)', () => {
  const email = 'jose.garcia@example.com';
  for (const name of ['Jose Garcia', 'JOSE_GARCIA', 'josegarcia', ' jose  garcia ']) {
    const result = validateNickname(name, { email });
    assert.equal(result.ok, false, name);
    assert.match(result.message, /email/);
  }
  assert.equal(validateNickname('jose.garcia', { email }).ok, false, 'a dot is not an allowed character anyway');
  assert.equal(validateNickname('Jose G', { email }).ok, true);
  assert.equal(validateNickname('josegarcia2', { email }).ok, true);
  assert.equal(validateNickname('Jose Garcia').ok, true, 'without an email it is fine');
  assert.equal(validateNickname('Jose Garcia', { email: 'not an email' }).ok, true);
  assert.equal(validateNickname('Jose Garcia', { email: undefined }).ok, true);
  assert.equal(validateNickname('Sam', { email: 'sam@example.com' }).ok, false);
  assert.equal(validateNickname('Sam', { email: ' SAM@example.com ' }).ok, false);
  assert.equal(validateNickname('Sam', { email: 'sam+news@example.com' }).ok, false, 'a +tag is ignored when comparing');
});

test('validateNickname: trims and collapses whitespace to single spaces', () => {
  assert.deepEqual(validateNickname('  Ada   Lovelace  '), { ok: true, value: 'Ada Lovelace' });
  assert.deepEqual(validateNickname('a\t\tb'), { ok: true, value: 'a b' });
  assert.deepEqual(validateNickname('a\n b'), { ok: true, value: 'a b' });
  assert.deepEqual(validateNickname('a b'), { ok: true, value: 'a b' }, 'a non-breaking space becomes a normal space');
  assert.equal(validateNickname('a' + ' '.repeat(40) + 'b').ok, true, 'length is measured after cleaning');
  assert.equal(validateNickname('  a  ').ok, false);
});

test('validateNickname: empty, blank and non-string input', () => {
  for (const input of ['', '   ', '\n\t', undefined, null, 7, {}, [], ['ab'], true]) {
    const result = validateNickname(input);
    assert.equal(result.ok, false, String(input));
    assert.equal(typeof result.message, 'string');
    assert.equal(result.value, undefined);
  }
});

test('validateNickname: length counts characters, not UTF-16 units', () => {
  const astral = '𠀀'.repeat(30); // 2 UTF-16 units each, 1 letter each
  assert.equal(validateNickname(astral).ok, true);
  assert.equal(validateNickname(astral + '𠀀').ok, false);
});

/* ---------- passwordsMatch ---------- */

test('passwordsMatch: exact text only', () => {
  assert.equal(passwordsMatch('abc12345678', 'abc12345678'), true);
  assert.equal(passwordsMatch('abc12345678', 'abc12345679'), false);
  assert.equal(passwordsMatch('Abc12345678', 'abc12345678'), false, 'case matters');
  assert.equal(passwordsMatch('abc12345678', 'abc12345678 '), false, 'spaces matter');
  assert.equal(passwordsMatch('', ''), true);
  assert.equal(passwordsMatch('', 'x'), false);
  assert.equal(passwordsMatch(undefined, undefined), false);
  assert.equal(passwordsMatch(null, null), false);
  assert.equal(passwordsMatch(1, 1), false);
  assert.equal(passwordsMatch('1', 1), false);
});
