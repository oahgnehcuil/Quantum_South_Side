/* ==========================================================================
   progressRemote.js — talks to the Supabase "progress" table.

   One row per saved part: (user_id, key, value jsonb, updated_at).
   Keys: topicsCompleted, quizBest, confidence, game.

   This file only uses client.from('progress') with select, upsert and delete.
   Row Level Security on the server means a signed-in user can only ever touch
   their own rows. Nothing here throws: every function answers with a plain
   object, and a failure says whether the device looks offline or something else broke.
   ========================================================================== */
import { PROGRESS_KEYS, emptyProgress, normalizeProgress } from './progressMerge.js';

const TABLE = 'progress';

const deviceOffline = () => typeof navigator !== 'undefined' && navigator.onLine === false;

/** A failed answer. When the network call itself fails, supabase-js answers with status 0 (no HTTP answer at all). */
const failure = (result) => ({ ok: false, offline: result?.status === 0 || deviceOffline() });

/** Run one request and never let an exception escape. */
async function attempt(request) {
  try {
    const result = await request();
    return result && !result.error ? { ok: true } : failure(result);
  } catch {
    return failure(null);
  }
}

/**
 * Read this user's saved progress.
 * Returns { ok:true, progress } (parts missing on the server stay at their starting value) or { ok:false, offline }.
 */
export async function pullProgress(client, userId) {
  try {
    const result = await client.from(TABLE).select('key, value').eq('user_id', userId);
    if (!result || result.error || !Array.isArray(result.data)) return failure(result);
    const parts = {};
    for (const row of result.data) {
      if (row && PROGRESS_KEYS.includes(row.key)) parts[row.key] = row.value;
    }
    return { ok: true, progress: normalizeProgress({ ...emptyProgress(), ...parts }) };
  } catch {
    return failure(null);
  }
}

/** Save the listed parts of `state` (an upsert: a new row, or replace the old one). */
export async function pushProgress(client, userId, changedKeys, state) {
  const progress = normalizeProgress(state);
  const keys = [...new Set(changedKeys)].filter((key) => PROGRESS_KEYS.includes(key));
  if (keys.length === 0) return { ok: true };
  const now = new Date().toISOString();
  const rows = keys.map((key) => ({ user_id: userId, key, value: progress[key], updated_at: now }));
  return attempt(() => client.from(TABLE).upsert(rows, { onConflict: 'user_id,key' }));
}

/** Delete every saved row of this user ("Reset my progress"). */
export async function deleteProgress(client, userId) {
  return attempt(() => client.from(TABLE).delete().eq('user_id', userId));
}
