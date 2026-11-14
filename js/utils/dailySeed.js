/* ==========================================================================
   dailySeed.js — picks "today's" item from the date, so EVERYONE gets the same
   daily puzzle on the same day (no server needed).

   The day rolls over at midnight Chicago time, on purpose: this is a Chicago project.
   Puzzles are visited in a fixed shuffled order, so none repeats until all have been used.
   ========================================================================== */

const PUZZLE_TIME_ZONE = 'America/Chicago';
const EPOCH_KEY = '2025-01-01'; // day #0 of the puzzle calendar
const SHUFFLE_SEED = 'quantum-south-side'; // change this text to reshuffle the puzzle order

/** Today's date as "YYYY-MM-DD" in Chicago time (or any Date you pass in). */
export function getDayKey(date = new Date()) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: PUZZLE_TIME_ZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(date);
    const get = (type) => parts.find((p) => p.type === type).value;
    return `${get('year')}-${get('month')}-${get('day')}`;
  } catch {
    // Very old browsers without time-zone support: fall back to the device's own date.
    const pad = (n) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  }
}

function keyToUtcMs(key) {
  const [y, m, d] = key.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

/** Whole days from one day key to another ("2026-03-01" → "2026-03-02" is 1). */
export function daysBetween(fromKey, toKey) {
  return Math.round((keyToUtcMs(toKey) - keyToUtcMs(fromKey)) / 86400000);
}

/** Small, fast text → number hash (FNV-1a). Same text always gives the same number. */
export function hashString(text) {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** Tiny seeded random number generator (mulberry32): same seed → same sequence. */
function seededRandom(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A fixed shuffled order of the numbers 0…length-1 (same every time for the same length). */
export function shuffledOrder(length) {
  const order = Array.from({ length }, (_, i) => i);
  const random = seededRandom(hashString(`${SHUFFLE_SEED}:${length}`));
  for (let i = length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order;
}

/** Which item (0…length-1) is "today's"? Pass any day key to look at other days. */
export function getDailyIndex(length, dayKey = getDayKey()) {
  if (!length || length < 1) return 0;
  const dayNumber = daysBetween(EPOCH_KEY, dayKey);
  const position = ((dayNumber % length) + length) % length; // works for dates before the epoch too
  return shuffledOrder(length)[position];
}

/** Pick today's item out of a list. Returns undefined for an empty list. */
export function pickDaily(list, dayKey = getDayKey()) {
  if (!Array.isArray(list) || list.length === 0) return undefined;
  return list[getDailyIndex(list.length, dayKey)];
}
