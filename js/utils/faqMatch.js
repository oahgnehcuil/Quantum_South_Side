/* ==========================================================================
   faqMatch.js — finds the best answer for a question by scoring keywords.
   This file is "pure": it never touches the page, so it is easy to test
   (see tests/faq.test.js).

   How it works, in plain words:
     1. Clean up the question: lowercase it, drop punctuation and little words
        like "the" and "is", and trim plurals ("gates" becomes "gate").
     2. Give every FAQ entry points:
          • a keyword from the entry's "keywords" list appears in the question
          • a whole phrase from "keywords" appears ("quantum computer"): bonus points
          • the question looks like one of the entry's example "questions"
        Rare words count for more than common ones ("qubit" beats "quantum").
     3. The entry with the most points wins. If even the winner scores too
        low, we say "no match" instead of guessing.

   Use it like this:
     const result = findAnswer('what is a qubit?', faq.entries);
     // result = { match: entry | null, confidence: 0..1, score, related: [entry, entry] }
   ========================================================================== */

/** Answers need at least this many points, and must explain this share of the question's words. */
export const MIN_SCORE = 4;
export const MIN_COVERAGE = 0.5;

/** A word we have never seen counts as this much "unexplained" weight (so "football" hurts a match). */
const UNKNOWN_WORD_WEIGHT = 2.5;

/** How many extra entries to offer under "You might also ask". */
const MAX_RELATED = 2;

/** A score at or above this counts as 100% confident. */
const FULL_CONFIDENCE_SCORE = 14;

const MAX_QUERY_LENGTH = 300;

/** Little words that say nothing about the topic. */
const STOP_WORDS = new Set(
  `a an the is are was were be been being am do does did done can could would should will shall may might must
   i me my mine we our ours you your yours it its this that these those of to in on at for with about as by from
   and or but so if then than too very just please tell explain what whats who whom whose which when where why how
   there their they them he she his her let lets know want like get gives give some any also really yes okay ok
   much many more most`.split(/\s+/),
);

/** Turn "Qubits!" or "Ph.D." into clean lowercase words. */
export function normalize(text) {
  return String(text ?? '')
    .slice(0, MAX_QUERY_LENGTH)
    .toLowerCase()
    .replace(/[’']s\b/g, '')
    .replace(/(\p{L})\.(?=\p{L})/gu, '$1')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** Very light stemming: "gates" becomes "gate", "entangled" becomes "entangl". Same rules for questions and keywords. */
export function stem(word) {
  let w = word;
  if (w.length <= 3) return w;
  if (w.endsWith('ies') && w.length > 4) w = `${w.slice(0, -3)}y`;
  else if (/(ss|us|is)$/.test(w)) return w;
  else if (/(ches|shes|xes|zes|sses)$/.test(w)) w = w.slice(0, -2);
  else if (w.endsWith('s')) w = w.slice(0, -1);
  if (w.endsWith('ing') && w.length >= 7) w = w.slice(0, -3);
  else if (w.endsWith('ed') && w.length >= 6) w = w.slice(0, -2);
  return w;
}

/** Text to a list of stemmed words with the little words removed. */
export function tokenize(text) {
  const words = normalize(text).split(' ').filter(Boolean);
  return words.filter((word) => !STOP_WORDS.has(word)).map(stem);
}

/** True when `phrase` appears as a run of neighbors inside `words`. */
function containsRun(words, phrase) {
  for (let start = 0; start + phrase.length <= words.length; start += 1) {
    if (phrase.every((word, offset) => words[start + offset] === word)) return true;
  }
  return false;
}

/** True when two words differ by at most one letter (a typo). */
function withinOneEdit(a, b) {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
  const restA = a.slice(i + (a.length >= b.length ? 1 : 0));
  const restB = b.slice(i + (b.length >= a.length ? 1 : 0));
  return restA === restB;
}

/** Prepare every entry once: its keyword words, keyword phrases and example-question words. */
export function buildIndex(entries) {
  const frequency = new Map();
  const prepared = entries.map((entry) => {
    const words = new Set();
    const phraseWords = new Set();
    const phrases = [];
    for (const keyword of entry.keywords || []) {
      const tokens = tokenize(keyword);
      if (tokens.length === 1) words.add(tokens[0]);
      else if (tokens.length > 1) {
        phrases.push(tokens);
        tokens.forEach((token) => phraseWords.add(token));
      }
    }
    const questionSets = (entry.questions || []).map((question) => new Set(tokenize(question)));
    const everyWord = new Set([...words, ...phraseWords, ...questionSets.flatMap((set) => [...set])]);
    everyWord.forEach((word) => frequency.set(word, (frequency.get(word) || 0) + 1));
    return { entry, words, phraseWords, phrases, questionSets };
  });
  // Rare words are worth more than words that appear in many entries.
  const weight = new Map([...frequency].map(([word, count]) => [word, Math.log(1 + entries.length / count)]));
  return { prepared, weight, vocabulary: [...weight.keys()] };
}

const indexCache = new WeakMap();
function indexFor(entries) {
  if (!indexCache.has(entries)) indexCache.set(entries, buildIndex(entries));
  return indexCache.get(entries);
}

/** Fix a one-letter typo ("entanglment") by finding a known word that is one edit away. */
function fixTypo(token, index) {
  if (index.weight.has(token) || token.length < 6) return token;
  return index.vocabulary.find((known) => withinOneEdit(token, known)) || token;
}

/** Score one prepared entry against the question's words. */
function scoreEntry(item, queryWords, index) {
  const queryList = [...new Set(queryWords)];
  const querySet = new Set(queryList);
  let score = 0;
  let matchedWeight = 0;
  let totalWeight = 0;

  for (const word of queryList) {
    const weight = index.weight.get(word) || 0;
    totalWeight += weight || UNKNOWN_WORD_WEIGHT;
    const inQuestions = item.questionSets.some((set) => set.has(word));
    if (item.words.has(word)) score += 2 * weight;
    else if (item.phraseWords.has(word)) score += 0.8 * weight;
    else if (inQuestions) score += weight;
    else continue;
    matchedWeight += weight;
  }

  for (const phrase of item.phrases) {
    if (containsRun(queryWords, phrase)) score += 2 * phrase.length;
  }

  let bestOverlap = 0;
  for (const set of item.questionSets) {
    if (set.size === 0) continue;
    const shared = [...set].filter((word) => querySet.has(word)).length;
    bestOverlap = Math.max(bestOverlap, (2 * shared) / (set.size + querySet.size));
  }
  score += 8 * bestOverlap;

  return { entry: item.entry, score, coverage: matchedWeight / totalWeight };
}

/**
 * Find the best FAQ entry for a question.
 * @param {string} query    what the user typed
 * @param {Array}  entries  the "entries" array from data/chatbot-faq.json
 * @returns {{match: object|null, confidence: number, score: number, related: object[]}}
 *   match is null when nothing scores high enough (never guess).
 */
export function findAnswer(query, entries) {
  const empty = { match: null, confidence: 0, score: 0, related: [] };
  if (!Array.isArray(entries) || entries.length === 0) return empty;

  const index = indexFor(entries);
  const queryWords = tokenize(query).map((token) => fixTypo(token, index));
  if (queryWords.length === 0) return empty;

  const ranked = index.prepared
    .map((item) => scoreEntry(item, queryWords, index))
    .sort((a, b) => b.score - a.score);

  const best = ranked[0];
  if (best.score < MIN_SCORE || best.coverage < MIN_COVERAGE) return { ...empty, score: best.score };

  const related = ranked
    .slice(1)
    .filter((item) => item.score >= Math.max(MIN_SCORE, best.score * 0.4))
    .slice(0, MAX_RELATED)
    .map((item) => item.entry);

  return {
    match: best.entry,
    confidence: Math.min(1, best.score / FULL_CONFIDENCE_SCORE),
    score: best.score,
    related,
  };
}
