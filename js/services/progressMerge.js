/* ==========================================================================
   progressMerge.js — PURE helpers (no browser, no storage, no network).

   • normalizeProgress(x)   repairs anything missing or damaged so the shape can be trusted
   • mergeProgress(a, b)    combines two progress objects without ever losing the better result
   • changedKeys(a, b)      which of the four saved parts differ

   mergeProgress rules (merging the same data twice changes nothing):
     topicsCompleted  every topic that either side completed
     quizBest         the best score for each topic
     confidence       per field: b's value when both are set (b = the account side), else whichever is set
     game             counters (played, perfect, bestScore, bestStreak) take the larger number,
                      solved = the best stars per puzzle,
                      streak + lastDay come from the side that played later (a tie takes the higher streak),
                      lastDaily comes from the later day (a tie takes more stars)
   ========================================================================== */

/** The four saved parts. Each one is a single row in the Supabase "progress" table. */
export const PROGRESS_KEYS = ['topicsCompleted', 'quizBest', 'confidence', 'game'];

const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;
const MAX_ENTRIES = 500; // a safety limit for lists and objects that come from outside
const MAX_ID_LENGTH = 100;

export function emptyProgress() {
  return {
    topicsCompleted: [], // ["intro", "gates", ...]
    quizBest: {}, // { gates: 3 }  best score per topic
    confidence: { before: null, after: null }, // 1–5 or null
    game: { played: 0, perfect: 0, bestScore: 0, streak: 0, bestStreak: 0, lastDay: null, solved: {}, lastDaily: null },
  };
}

const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const isRating = (n) => Number.isInteger(n) && n >= 1 && n <= 5;
const isId = (id) => typeof id === 'string' && id.length > 0 && id.length <= MAX_ID_LENGTH && id !== '__proto__';
const count = (n) => (Number.isFinite(n) && n >= 0 ? n : 0);

/** Own entries of a plain object, minus anything unsafe or too many. */
function safeEntries(value) {
  return isObject(value) ? Object.entries(value).filter(([id]) => isId(id)).slice(0, MAX_ENTRIES) : [];
}

/** Keep only { puzzleId: bestStars } entries with a whole number of stars from 1 to 3. */
function cleanSolved(value) {
  const solved = {};
  for (const [id, stars] of safeEntries(value)) if (Number.isInteger(stars) && stars >= 1 && stars <= 3) solved[id] = stars;
  return solved;
}

/** The saved result of a daily puzzle ({ dayKey, puzzleId, stars, gatesUsed }), or null if it is missing or damaged. */
export function cleanLastDaily(value) {
  if (!isObject(value)) return null;
  const { dayKey, puzzleId, stars, gatesUsed } = value;
  const valid = typeof dayKey === 'string' && DAY_KEY.test(dayKey) && Number.isInteger(stars) && stars >= 1 && stars <= 3;
  if (!valid || !Number.isInteger(gatesUsed) || gatesUsed < 0 || !(typeof puzzleId === 'string' || Number.isInteger(puzzleId))) return null;
  return { dayKey, puzzleId, stars, gatesUsed };
}

function cleanGame(value) {
  const base = emptyProgress().game;
  const saved = isObject(value) ? value : {};
  const game = { ...base };
  for (const key of ['played', 'perfect', 'bestScore', 'streak', 'bestStreak']) game[key] = count(saved[key]);
  game.lastDay = typeof saved.lastDay === 'string' && DAY_KEY.test(saved.lastDay) ? saved.lastDay : null;
  game.solved = cleanSolved(saved.solved);
  game.lastDaily = cleanLastDaily(saved.lastDaily);
  return game;
}

/** Repair progress read from anywhere (storage, the server, another tab). The result always has the full, valid shape. */
export function normalizeProgress(value) {
  const saved = isObject(value) ? value : {};
  const quizBest = {};
  for (const [id, score] of safeEntries(saved.quizBest)) if (Number.isInteger(score) && score >= 0) quizBest[id] = score;
  const conf = isObject(saved.confidence) ? saved.confidence : {};
  const topics = Array.isArray(saved.topicsCompleted) ? saved.topicsCompleted.filter(isId) : [];
  return {
    topicsCompleted: [...new Set(topics)].slice(0, MAX_ENTRIES),
    quizBest,
    confidence: { before: isRating(conf.before) ? conf.before : null, after: isRating(conf.after) ? conf.after : null },
    game: cleanGame(saved.game),
  };
}

/** A copy of the value with object keys in sorted order, so two equal values always print the same. */
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (isObject(value)) return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  return value;
}

const same = (a, b) => JSON.stringify(stable(a)) === JSON.stringify(stable(b));

/** The parts of progress that differ between two progress objects (compared after repairing them). */
export function changedKeys(a, b) {
  const left = normalizeProgress(a);
  const right = normalizeProgress(b);
  return PROGRESS_KEYS.filter((key) => !same(left[key], right[key]));
}

/** True when nothing has been saved yet (everything is still at its starting value). */
export function isProgressEmpty(value) {
  return changedKeys(value, emptyProgress()).length === 0;
}

/* ---------- The merge ---------- */
const maxOf = (x, y) => Math.max(x, y);

/** Which of two daily results is "later"? The later day wins; on the same day the one with more stars; then fewer gates. */
function pickDaily(a, b) {
  if (!a || !b) return a || b || null;
  if (a.dayKey !== b.dayKey) return a.dayKey > b.dayKey ? a : b;
  if (a.stars !== b.stars) return a.stars > b.stars ? a : b;
  if (a.gatesUsed !== b.gatesUsed) return a.gatesUsed < b.gatesUsed ? a : b;
  return JSON.stringify(stable(a)) <= JSON.stringify(stable(b)) ? a : b; // identical in every way that matters: pick one the same way each time
}

function mergeGame(a, b) {
  const solved = { ...a.solved };
  for (const [id, stars] of Object.entries(b.solved)) solved[id] = Math.max(solved[id] ?? 0, stars);

  // The side that played the daily puzzle later owns the streak. ("YYYY-MM-DD" text sorts like dates; null is earliest.)
  const later = (a.lastDay ?? '') === (b.lastDay ?? '') ? (a.streak >= b.streak ? a : b) : (a.lastDay ?? '') > (b.lastDay ?? '') ? a : b;
  const streak = later.streak;
  return {
    played: maxOf(a.played, b.played),
    perfect: maxOf(a.perfect, b.perfect),
    bestScore: maxOf(a.bestScore, b.bestScore),
    streak,
    bestStreak: Math.max(a.bestStreak, b.bestStreak, streak),
    lastDay: later.lastDay,
    solved,
    lastDaily: pickDaily(a.lastDaily, b.lastDaily),
  };
}

/** Combine two progress objects. `b` is the account (server) side. Neither input is changed. */
export function mergeProgress(a, b) {
  const left = normalizeProgress(a);
  const right = normalizeProgress(b);

  const quizBest = { ...left.quizBest };
  for (const [id, score] of Object.entries(right.quizBest)) quizBest[id] = Math.max(quizBest[id] ?? 0, score);

  return {
    topicsCompleted: [...new Set([...left.topicsCompleted, ...right.topicsCompleted])],
    quizBest,
    confidence: {
      before: right.confidence.before ?? left.confidence.before,
      after: right.confidence.after ?? left.confidence.after,
    },
    game: mergeGame(left.game, right.game),
  };
}
