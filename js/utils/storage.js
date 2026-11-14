/* ==========================================================================
   storage.js — a SAFE wrapper around localStorage. Nothing else.

   Pages never call this directly: progress goes through
   js/services/progressStore.js, which decides WHAT to save and where.

   "Safe" means: if the browser blocks localStorage (private mode, school
   settings...), the site keeps working — it just remembers things until the
   tab is closed. If localStorage is full, the newest values stay in memory.
   ========================================================================== */
import { STORAGE_PREFIX } from '../config.js';

/* ---------- Low-level safe storage ---------- */
// Values kept in memory only: everything when localStorage is blocked, or the keys whose latest save failed (quota full).
const memoryFallback = new Map();
let persistent = null;

function canUseStorage() {
  if (persistent !== null) return persistent;
  try {
    const probe = `${STORAGE_PREFIX}__probe`;
    window.localStorage.setItem(probe, '1');
    window.localStorage.removeItem(probe);
    persistent = true;
  } catch {
    persistent = false;
  }
  return persistent;
}

/** True when progress will survive closing the tab. */
export function isPersistent() {
  return canUseStorage();
}

export function getItem(key, fallback = null) {
  try {
    // A value that only made it to memory is newer than whatever localStorage holds, so it wins.
    const raw = memoryFallback.has(key) || !canUseStorage() ? memoryFallback.get(key) : window.localStorage.getItem(STORAGE_PREFIX + key);
    return raw === null || raw === undefined ? fallback : JSON.parse(raw);
  } catch {
    return fallback; // corrupt value: act as if nothing was saved
  }
}

export function setItem(key, value) {
  const raw = JSON.stringify(value);
  try {
    if (canUseStorage()) {
      window.localStorage.setItem(STORAGE_PREFIX + key, raw);
      memoryFallback.delete(key); // saved for real: the memory copy is no longer needed
    } else memoryFallback.set(key, raw);
    return true;
  } catch {
    memoryFallback.set(key, raw); // storage full or blocked: keep it in memory instead
    return false;
  }
}

export function removeItem(key) {
  try {
    if (canUseStorage()) window.localStorage.removeItem(STORAGE_PREFIX + key);
  } catch {
    /* ignore */
  }
  memoryFallback.delete(key);
}

/** Delete everything this site saved (only keys that start with our prefix). */
export function clearAll() {
  try {
    if (canUseStorage()) {
      const keys = [];
      for (let i = 0; i < window.localStorage.length; i++) {
        const key = window.localStorage.key(i);
        if (key && key.startsWith(STORAGE_PREFIX)) keys.push(key);
      }
      keys.forEach((key) => window.localStorage.removeItem(key));
    }
  } catch {
    /* ignore */
  }
  memoryFallback.clear();
}

/** Every saved key (without the prefix) that starts with `prefix`, for example "cache:". */
export function listKeys(prefix = '') {
  const keys = new Set([...memoryFallback.keys()].filter((key) => key.startsWith(prefix)));
  try {
    if (canUseStorage()) {
      for (let i = 0; i < window.localStorage.length; i++) {
        const full = window.localStorage.key(i);
        if (full && full.startsWith(STORAGE_PREFIX + prefix)) keys.add(full.slice(STORAGE_PREFIX.length));
      }
    }
  } catch {
    /* ignore */
  }
  return [...keys];
}

/** Delete every saved key that starts with `prefix` (our own prefix is added for you). */
export function removeByPrefix(prefix) {
  listKeys(prefix).forEach(removeItem);
}
