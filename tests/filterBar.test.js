// Tests for the shared word search used by Careers, News and Research.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchesAllWords } from '../js/components/filterBar.js';

const story = 'IBM quantum computer unveiled in Chicago. Northwestern quantum sensing. Error correction.';

test('every word must appear, in any order', () => {
  assert.equal(matchesAllWords(story, 'quantum chicago'), true);
  assert.equal(matchesAllWords(story, 'chicago quantum'), true);
  assert.equal(matchesAllWords(story, 'correction error'), true);
  assert.equal(matchesAllWords(story, 'northwestern sensing'), true);
});

test('one missing word means no match', () => {
  assert.equal(matchesAllWords(story, 'quantum zebra'), false);
});

test('case and extra spaces do not matter', () => {
  assert.equal(matchesAllWords(story, '  CHICAGO   Quantum '), true);
});

test('an empty query matches everything', () => {
  assert.equal(matchesAllWords(story, ''), true);
  assert.equal(matchesAllWords(story, '   '), true);
});
