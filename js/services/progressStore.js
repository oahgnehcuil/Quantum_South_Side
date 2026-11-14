/* ==========================================================================
   progressStore.js — the ONE place pages read and save progress.

   PRIVACY: nothing here is personal. We only keep:
     • which Learn topics are marked complete
     • best quiz score per topic
     • an optional 1–5 "confidence" rating before / after learning
     • game stats: games played, streak, best score, the best stars per puzzle
       and the result of today's daily puzzle

   Two modes:
     GUEST    progress lives on this device only (localStorage). Nothing is sent anywhere.
     ACCOUNT  a signed-in learner. Progress is also saved to their own rows in the
              Supabase "progress" table. This device keeps a copy ("cache:<userId>")
              so the page shows it instantly. Signing out deletes that copy.

   Reading is always instant and synchronous (guest: one small localStorage read; account: an
   in-memory copy of this user's cache). Saving to the server happens in
   the background about 1 second after a change; if it fails we simply try again
   later. This file never throws into page code and never logs.
   ========================================================================== */
import { STORAGE_PREFIX, LEARN_TOPICS, QUIZ_PASS_SCORE } from '../config.js';
import { getDayKey, daysBetween } from '../utils/dailySeed.js';
import * as storage from '../utils/storage.js';
import { emptyProgress, normalizeProgress, mergeProgress, changedKeys, isProgressEmpty, cleanLastDaily } from './progressMerge.js';
import { pullProgress, pushProgress, deleteProgress } from './progressRemote.js';

export { isPersistent } from '../utils/storage.js';

const GUEST_KEY = 'progress'; // guest progress: one small JSON object
const MARKER_KEY = 'account'; // { userId } while someone is signed in on this device
const CACHE_PREFIX = 'cache:'; // cache:<userId> = { progress, pendingReset }
const DECISION_PREFIX = 'merge:'; // merge:<userId> = 'merged' | 'declined'
const SYNC_DELAY_MS = 1000;

/** Everything the store remembers while the page is open. */
const store = {
  mode: 'guest',
  userId: null,
  client: null, // the Supabase client (set by connectAccount)
  progress: emptyProgress(), // what pages see
  remote: null, // what the server held the last time we looked (null = not pulled yet)
  pendingReset: false, // "Reset my progress" was pressed but the server rows are not deleted yet
  sync: { state: 'idle', lastSyncedAt: null },
  generation: 0, // goes up on sign-out/user switch so slow replies for the old user are ignored
  timer: null,
  running: null,
  rerun: false,
};

const listeners = new Set();

function emit(kind) {
  for (const listener of [...listeners]) {
    try {
      listener(kind);
    } catch {
      /* one broken listener must not stop the others */
    }
  }
}

/** Call listener(kind) when progress changes. kind: 'local' | 'remote' | 'mode'. Returns a function that stops listening. */
export function subscribe(listener) {
  if (typeof listener !== 'function') return () => {};
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getMode() {
  return store.mode;
}

export function getSyncStatus() {
  return { mode: store.mode, state: store.mode === 'account' ? store.sync.state : 'idle', lastSyncedAt: store.mode === 'account' ? store.sync.lastSyncedAt : null };
}

/* ---------- Local copy (guest key, or this user's cache) ---------- */
function saveLocal() {
  if (store.mode === 'account') storage.setItem(CACHE_PREFIX + store.userId, { progress: store.progress, pendingReset: store.pendingReset });
  else storage.setItem(GUEST_KEY, store.progress);
}

function loadLocal() {
  if (store.mode === 'account') {
    const cache = storage.getItem(CACHE_PREFIX + store.userId, null);
    store.progress = normalizeProgress(cache?.progress);
    store.pendingReset = cache?.pendingReset === true;
  } else {
    store.progress = normalizeProgress(storage.getItem(GUEST_KEY, {}));
    store.pendingReset = false;
  }
}

/** The progress to show. A guest's copy is re-read each time (a few bytes), so another tab's change is never missed. */
function current() {
  if (store.mode === 'guest') store.progress = normalizeProgress(storage.getItem(GUEST_KEY, {}));
  return store.progress;
}

function readGuest() {
  return normalizeProgress(storage.getItem(GUEST_KEY, {}));
}

function markedUserId() {
  const marker = storage.getItem(MARKER_KEY, null);
  return typeof marker?.userId === 'string' && marker.userId ? marker.userId : null;
}

/** Forget the server connection (sign-out or another user). Replies still on their way are ignored. */
function dropConnection() {
  store.generation += 1;
  clearTimeout(store.timer);
  store.timer = null;
  store.client = null;
  store.remote = null;
  store.sync = { state: 'idle', lastSyncedAt: null };
}

/** Read everything again from localStorage. Returns what changed: 'mode', 'local' or null. */
function rehydrate() {
  const before = store.progress;
  const id = markedUserId();
  const switched = id !== store.userId;
  if (switched) {
    dropConnection();
    store.mode = id ? 'account' : 'guest';
    store.userId = id;
  }
  loadLocal();
  if (switched) return 'mode';
  return changedKeys(before, store.progress).length ? 'local' : null;
}

/** Replace the progress, save it on this device and tell the pages. Nothing happens if nothing changed. */
function commit(progress) {
  if (changedKeys(current(), progress).length === 0) return;
  store.progress = progress;
  saveLocal();
  emit('local');
  scheduleSync();
}

/* ---------- Talking to the server (always in the background) ---------- */
function scheduleSync() {
  if (store.mode !== 'account' || !store.client) return;
  clearTimeout(store.timer);
  store.timer = setTimeout(() => {
    store.timer = null;
    runSync();
  }, SYNC_DELAY_MS);
  store.timer?.unref?.();
}

function failSync(result) {
  store.sync = { state: result.offline ? 'offline' : 'error', lastSyncedAt: store.sync.lastSyncedAt };
}

/** One round: finish a pending reset, pull + merge (first time only), then push what differs. */
async function syncOnce() {
  const { client, userId, generation } = store;
  const stale = () => generation !== store.generation;
  store.sync = { state: 'syncing', lastSyncedAt: store.sync.lastSyncedAt };

  if (store.pendingReset) {
    const deleted = await deleteProgress(client, userId);
    if (stale()) return;
    if (!deleted.ok) return failSync(deleted);
    store.pendingReset = false;
    store.remote = emptyProgress();
    saveLocal();
  }

  if (!store.remote) {
    const pulled = await pullProgress(client, userId);
    if (stale()) return;
    if (!pulled.ok) return failSync(pulled);
    if (store.pendingReset) return; // Reset was pressed while we were reading: the next round deletes the server rows first
    store.remote = pulled.progress;
    const merged = mergeProgress(store.progress, pulled.progress);
    if (changedKeys(store.progress, merged).length) {
      store.progress = merged;
      saveLocal();
      emit('remote');
    }
  }

  const keys = changedKeys(store.progress, store.remote);
  if (keys.length) {
    const sent = normalizeProgress(store.progress);
    const pushed = await pushProgress(client, userId, keys, sent);
    if (stale()) return;
    if (!pushed.ok) return failSync(pushed);
    store.remote = { ...store.remote, ...Object.fromEntries(keys.map((key) => [key, sent[key]])) };
  }
  store.sync = { state: 'idle', lastSyncedAt: Date.now() };
}

/** Start a round now. If one is already running, it goes around once more. Never rejects. */
function runSync() {
  if (store.mode !== 'account' || !store.client) return Promise.resolve();
  if (store.running) {
    store.rerun = true;
    return store.running;
  }
  store.running = (async () => {
    try {
      do {
        store.rerun = false;
        await syncOnce();
      } while (store.rerun && store.client);
    } catch {
      store.sync = { state: 'error', lastSyncedAt: store.sync.lastSyncedAt };
    } finally {
      store.running = null;
    }
  })();
  return store.running;
}

/** Send any waiting changes right now (for example just before signing out). Never rejects. */
export function flushPending() {
  clearTimeout(store.timer);
  store.timer = null;
  return runSync();
}

/* ---------- Switching modes ---------- */
/**
 * A learner signed in. Show their saved copy at once, then pull from the server, merge and push what differs.
 * Safe to call again and again.
 */
export async function connectAccount(user, client) {
  const id = user?.id;
  if (typeof id !== 'string' || !id || !client) return;
  try {
    if (store.mode !== 'account' || store.userId !== id) {
      dropConnection();
      // Shared school computers: never keep anybody else's saved copy.
      storage.listKeys(CACHE_PREFIX).filter((key) => key !== CACHE_PREFIX + id).forEach(storage.removeItem);
      store.mode = 'account';
      store.userId = id;
      storage.setItem(MARKER_KEY, { userId: id });
      loadLocal();
      saveLocal();
      emit('mode');
    }
    store.client = client;
    await runSync();
  } catch {
    store.sync = { state: 'error', lastSyncedAt: store.sync.lastSyncedAt };
  }
}

/** The learner signed out: delete the saved copy of their progress from this device and go back to guest mode. */
export function disconnectAccount() {
  const wasAccount = store.mode === 'account';
  dropConnection();
  storage.removeByPrefix(CACHE_PREFIX);
  storage.removeItem(MARKER_KEY);
  store.mode = 'guest';
  store.userId = null;
  loadLocal();
  if (wasAccount) emit('mode');
}

/* ---------- Guest progress waiting to join an account ---------- */
/** A short description of the guest progress on this device, or null when there is none. */
export function getGuestProgressSummary() {
  const guest = readGuest();
  if (isProgressEmpty(guest)) return null;
  return {
    topicsCompleted: guest.topicsCompleted.filter((id) => LEARN_TOPICS.includes(id)).length,
    quizzesPassed: Object.values(guest.quizBest).filter((score) => score >= QUIZ_PASS_SCORE).length,
    gamesPlayed: guest.game.played,
    bestStreak: guest.game.bestStreak,
    totalStars: Object.values(guest.game.solved).reduce((sum, stars) => sum + stars, 0),
    confidenceSet: [guest.confidence.before, guest.confidence.after].filter((rating) => rating !== null).length,
  };
}

/** Ask once per learner: guest data exists and this learner has not said yes or no yet. */
export function shouldOfferGuestMerge(userId) {
  if (typeof userId !== 'string' || !userId) return false;
  return getGuestProgressSummary() !== null && storage.getItem(DECISION_PREFIX + userId, null) === null;
}

/** "No thanks": keep the guest data on this device and never ask this learner again. */
export function dismissGuestMergeOffer() {
  if (store.mode === 'account' && store.userId) storage.setItem(DECISION_PREFIX + store.userId, 'declined');
}

/**
 * "Yes, add it": combine guest progress into the account and save it. The guest copy is deleted only once the
 * server has it. Resolves to true when that happened; false means it will finish later (the account copy is kept).
 */
export async function mergeGuestIntoAccount() {
  if (store.mode !== 'account' || !store.userId) return false;
  const id = store.userId;
  commit(mergeProgress(readGuest(), store.progress)); // the account side is "b", so its confidence ratings win
  await flushPending();
  const saved = store.userId === id && store.sync.state === 'idle' && store.remote !== null && changedKeys(store.progress, store.remote).length === 0;
  if (!saved) return false;
  storage.removeItem(GUEST_KEY);
  storage.setItem(DECISION_PREFIX + id, 'merged');
  return true;
}

/* ---------- Progress: the shape pages rely on ---------- */
/** Read progress. You get a fresh copy, so changing it never changes what is saved. */
export function getProgress() {
  return normalizeProgress(current());
}

/* ---------- Learn: topics, quizzes, confidence ---------- */
export function getCompletedTopics() {
  return getProgress().topicsCompleted;
}

export function isTopicComplete(topicId) {
  return getProgress().topicsCompleted.includes(topicId);
}

/** Mark a topic complete (done = true) or not complete (done = false). Returns the new list. */
export function setTopicComplete(topicId, done = true) {
  const progress = getProgress();
  const without = progress.topicsCompleted.filter((id) => id !== topicId);
  progress.topicsCompleted = done ? [...without, topicId] : without;
  commit(progress);
  return getProgress().topicsCompleted;
}

/**
 * Remember a finished quiz. Keeps only the BEST score per topic.
 * Returns { best, passed, newlyPassed } so the page can celebrate the first pass.
 */
export function recordQuizResult(topicId, score, total = 3) {
  const progress = getProgress();
  const before = progress.quizBest[topicId] ?? -1;
  const wasPassed = before >= QUIZ_PASS_SCORE;
  const best = Math.max(before, Math.min(Math.max(0, score), total));
  progress.quizBest[topicId] = best;
  commit(progress);
  const passed = best >= QUIZ_PASS_SCORE;
  return { best, passed, newlyPassed: passed && !wasPassed };
}

export function getQuizBest(topicId) {
  const best = getProgress().quizBest[topicId];
  return Number.isInteger(best) ? best : null;
}

/** How many topics have a passing quiz score. */
export function getQuizzesPassed() {
  return Object.values(getProgress().quizBest).filter((score) => score >= QUIZ_PASS_SCORE).length;
}

export function getConfidence() {
  return getProgress().confidence;
}

/** which = 'before' | 'after', value = 1…5 (or null to clear). */
export function setConfidence(which, value) {
  if (which !== 'before' && which !== 'after') return getConfidence();
  const progress = getProgress();
  progress.confidence[which] = value === null || (Number.isInteger(value) && value >= 1 && value <= 5) ? value : progress.confidence[which];
  commit(progress);
  return getConfidence();
}

/* ---------- Game: games played, streak, stars ---------- */
export function getGameStats() {
  return getProgress().game;
}

/**
 * The streak to SHOW: a streak only counts while you played today or yesterday.
 * (The saved number stays until your next win, so a missed day shows 0 but never crashes.)
 */
export function getCurrentStreak(today = getDayKey()) {
  const { streak, lastDay } = getProgress().game;
  if (!lastDay) return 0;
  const gap = daysBetween(lastDay, today);
  return gap === 0 || gap === 1 ? streak : 0;
}

/** True once today's daily puzzle has been solved. */
export function hasPlayedToday(today = getDayKey()) {
  return getProgress().game.lastDay === today;
}

/** The result of today's daily puzzle ({ dayKey, puzzleId, stars, gatesUsed }), or null if it has not been solved today. */
export function getTodayResult(today = getDayKey()) {
  const { lastDaily } = getProgress().game;
  return lastDaily && lastDaily.dayKey === today ? lastDaily : null;
}

/** The best stars (1 to 3) won on a puzzle, or 0 if it has not been solved yet. */
export function getBestStars(puzzleId) {
  return getProgress().game.solved[String(puzzleId)] ?? 0;
}

/** The sum of the best stars over all solved puzzles. */
export function getTotalStars() {
  return Object.values(getProgress().game.solved).reduce((sum, stars) => sum + stars, 0);
}

/**
 * Record a finished puzzle.
 *   dayKey    – the day of the puzzle ("2026-11-14"); needed for streaks
 *   score     – higher is better (we keep the best)
 *   perfect   – true if the player matched the fewest possible gates
 *   daily     – true for today's puzzle (counts toward the streak), false for practice
 *   puzzleId  – optional: which puzzle was solved (keeps the best stars per puzzle)
 *   stars     – optional: stars won, 1 to 3
 *   gatesUsed – optional: how many gates the player used (saved with the daily result)
 * Returns the updated game stats.
 */
export function recordGameResult({ dayKey = getDayKey(), score = 0, perfect = false, daily = true, puzzleId = null, stars = 0, gatesUsed = 0 } = {}) {
  const progress = getProgress();
  const game = progress.game;
  game.played += 1;
  if (perfect) game.perfect += 1;
  if (score > game.bestScore) game.bestScore = score;
  if (puzzleId !== null && Number.isInteger(stars) && stars >= 1 && stars <= 3) {
    const key = String(puzzleId);
    game.solved[key] = Math.max(game.solved[key] ?? 0, stars);
  }
  if (daily && game.lastDay !== dayKey) {
    const continues = game.lastDay !== null && daysBetween(game.lastDay, dayKey) === 1;
    game.streak = continues ? game.streak + 1 : 1;
    game.lastDay = dayKey;
    game.lastDaily = puzzleId === null ? null : cleanLastDaily({ dayKey, puzzleId, stars, gatesUsed });
  }
  if (game.streak > game.bestStreak) game.bestStreak = game.streak;
  commit(progress);
  return getGameStats();
}

/* ---------- One-stop summary for the "Your progress" panel ---------- */
export function getProgressSummary() {
  const progress = getProgress();
  const validTopics = progress.topicsCompleted.filter((id) => LEARN_TOPICS.includes(id));
  return {
    topicsCompleted: validTopics.length,
    totalTopics: LEARN_TOPICS.length,
    quizzesPassed: getQuizzesPassed(),
    gamesPlayed: progress.game.played,
    streak: getCurrentStreak(),
    bestStreak: progress.game.bestStreak,
    bestScore: progress.game.bestScore,
    totalStars: getTotalStars(),
    playedToday: progress.game.lastDay === getDayKey(),
    confidence: progress.confidence,
  };
}

/**
 * Wipe all saved progress ("Reset my progress" button).
 * Guest: clears everything this site saved on the device.
 * Account: clears the account progress here AND deletes the learner's rows on the server (retried until it works).
 */
export function resetProgress() {
  if (store.mode === 'account') {
    store.progress = emptyProgress();
    store.pendingReset = true;
    saveLocal();
    emit('local');
    clearTimeout(store.timer);
    store.timer = null;
    runSync();
    return;
  }
  storage.clearAll();
  store.progress = emptyProgress();
  emit('local');
}

/* ---------- Small interface flags (not progress), for example "the help was closed" ---------- */
const FLAG_NAME = /^[A-Za-z][A-Za-z0-9]*$/;
const RESERVED = [GUEST_KEY, MARKER_KEY];

export function getFlag(name, fallback = null) {
  return FLAG_NAME.test(name) && !RESERVED.includes(name) ? storage.getItem(name, fallback) : fallback;
}

export function setFlag(name, value) {
  if (FLAG_NAME.test(name) && !RESERVED.includes(name)) storage.setItem(name, value);
}

/* ---------- Start up ---------- */
rehydrate();

// Other tabs, the back/forward cache, coming back online and leaving the page.
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  const refreshFromStorage = () => {
    const kind = rehydrate();
    if (kind) emit(kind);
  };
  window.addEventListener('storage', (event) => {
    if (event.key === null || event.key.startsWith(STORAGE_PREFIX)) refreshFromStorage();
  });
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) refreshFromStorage();
  });
  window.addEventListener('online', () => {
    if (store.mode === 'account' && store.sync.state !== 'idle') runSync();
  });
  window.addEventListener('pagehide', () => {
    if (store.timer) flushPending();
  });
}
