/* ==========================================================================
   loadData.js — loads the JSON content files with friendly error handling.

   Every page uses this instead of calling fetch() directly, so a missing or
   broken JSON file shows a helpful message instead of a blank page.

   Typical use inside a page script:
     try {
       const careers = await loadJSON('data/careers.json');   // path from the site root
       ...render...
     } catch (error) {
       showDataError(container, { error, onRetry: init });     // friendly message + "Try again"
     }
   ========================================================================== */
import { siteUrl } from '../config.js';
import { h, clear } from './dom.js';

/** An error that remembers WHICH file failed and WHY (for the "details for the team" box). */
export class DataLoadError extends Error {
  constructor(path, reason, detail = '') {
    super(`Could not load ${path} (${reason}${detail ? `: ${detail}` : ''})`);
    this.name = 'DataLoadError';
    this.path = path;
    this.reason = reason; // 'network' | 'http' | 'parse'
    this.detail = detail;
  }
}

/**
 * Fetch and parse a JSON file.
 * @param {string} path  path from the site root, e.g. 'data/learn/gates.json'
 * @returns {Promise<any>} the parsed JSON — or throws a DataLoadError
 */
export async function loadJSON(path) {
  let response;
  try {
    // "no-cache" = always check for a fresh copy, so edits to JSON show up right away
    response = await fetch(siteUrl(path), { cache: 'no-cache' });
  } catch (error) {
    throw new DataLoadError(path, 'network', error.message);
  }
  if (!response.ok) throw new DataLoadError(path, 'http', `${response.status} ${response.statusText}`.trim());
  try {
    return await response.json();
  } catch (error) {
    throw new DataLoadError(path, 'parse', error.message);
  }
}

/**
 * Load several files at once. One failure never blocks the others.
 * @returns {Promise<Array<{path:string, ok:boolean, data?:any, error?:DataLoadError}>>} same order as `paths`
 */
export async function loadAll(paths) {
  const settled = await Promise.allSettled(paths.map((path) => loadJSON(path)));
  return settled.map((result, index) =>
    result.status === 'fulfilled'
      ? { path: paths[index], ok: true, data: result.value }
      : { path: paths[index], ok: false, error: result.reason },
  );
}

/**
 * Show a friendly error box inside `container` (replacing its contents).
 * @param {HTMLElement} container
 * @param {object} options
 * @param {Error}    [options.error]    the error that happened (details go in a collapsible box)
 * @param {string}   [options.title]    headline
 * @param {string}   [options.message]  a short, friendly explanation
 * @param {Function} [options.onRetry]  if given, a "Try again" button calls it
 */
export function showDataError(container, { error, title = "We couldn't load this part of the page", message, onRetry } = {}) {
  console.error(error || title);
  const text = message || 'This usually fixes itself: check your internet connection and try again. If it keeps happening, tell your teacher or the project team.';
  const retryButton = onRetry
    ? h('button', { class: 'btn btn--secondary btn--sm', type: 'button', onClick: () => onRetry() }, 'Try again')
    : null;
  const details = error
    ? h('details', null, h('summary', null, 'Details for the project team'), h('p', { class: 'text-muted' }, error.message || String(error)))
    : null;
  const box = h(
    'div',
    { class: 'notice notice--error', role: 'alert' },
    h('span', { class: 'notice__icon', 'aria-hidden': 'true' }, '⚠️'),
    h('div', { class: 'notice__body' }, h('p', { class: 'notice__title' }, title), h('p', null, text), details, retryButton),
  );
  clear(container).append(box);
  return box;
}
