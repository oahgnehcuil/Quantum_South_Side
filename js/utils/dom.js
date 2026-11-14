/* ==========================================================================
   dom.js — tiny helpers for building HTML in JavaScript safely.

   Why: building elements with h() instead of innerHTML means text from the JSON
   files can never break the page (a stray "<" or "&" is just text).

   Quick example:
     h('div', { class: 'card' },
       h('h3', { class: 'card__title' }, 'Hello'),
       h('p', null, 'Some text'),
       h('button', { type: 'button', onClick: () => alert('hi') }, 'Click me'))
   ========================================================================== */

function isChild(value) {
  return typeof value === 'string' || typeof value === 'number' || value instanceof Node || Array.isArray(value);
}

function appendChildren(parent, children) {
  for (const child of children) {
    if (child === null || child === undefined || child === false || child === true) continue;
    if (Array.isArray(child)) appendChildren(parent, child);
    else parent.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

/**
 * Create an element.
 * @param {string} tag       e.g. 'div'
 * @param {object|null} props  attributes. Special keys: class, text, dataset {}, style {}, onClick (any on* = event)
 *                             false/null/undefined values are skipped; true becomes an empty attribute.
 * @param {...any} children  strings, numbers, Nodes, or arrays of those
 */
export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  if (props !== null && props !== undefined && isChild(props)) {
    children.unshift(props);
    props = null;
  }
  for (const [key, value] of Object.entries(props || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class' || key === 'className') el.className = Array.isArray(value) ? value.filter(Boolean).join(' ') : value;
    else if (key === 'text') el.textContent = value;
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key === 'style' && typeof value === 'object') Object.assign(el.style, value);
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value);
    else if (value === true) el.setAttribute(key, '');
    else el.setAttribute(key, String(value));
  }
  appendChildren(el, children);
  return el;
}

/** Shortcuts for finding elements. */
export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

/** Remove everything inside an element. */
export function clear(el) {
  el.replaceChildren();
  return el;
}

/**
 * Turn text into a DocumentFragment, wrapping quantum "ket" symbols like |0⟩, |1⟩, |+⟩, |−⟩
 * in <span class="ket"> so they get the math font. Everything else stays plain text.
 */
export function withKets(text) {
  const source = String(text ?? '');
  const fragment = document.createDocumentFragment();
  const pattern = /\|[^|⟩\s]{1,3}⟩/g;
  let last = 0;
  let match;
  while ((match = pattern.exec(source))) {
    if (match.index > last) fragment.append(source.slice(last, match.index));
    fragment.append(h('span', { class: 'ket' }, match[0]));
    last = match.index + match[0].length;
  }
  if (last < source.length) fragment.append(source.slice(last));
  return fragment;
}

/** Turn a string or array of strings into an array of <p> elements (kets styled). */
export function paragraphs(textOrList, className) {
  const list = Array.isArray(textOrList) ? textOrList : [textOrList];
  return list.filter((t) => t !== null && t !== undefined && String(t).trim() !== '').map((t) => h('p', { class: className }, withKets(t)));
}

/** A decorative emoji/icon that screen readers skip. */
export function icon(symbol, className = 'icon-inline') {
  return h('span', { class: className, 'aria-hidden': 'true' }, symbol);
}

/** Only allow http(s) links from JSON content (blocks javascript: URLs). */
export function isSafeUrl(url) {
  try {
    const parsed = new URL(url, window.location.href);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

/** A link to another website: opens in a new tab and tells screen readers so. */
export function externalLink(href, label, className) {
  if (!isSafeUrl(href)) return h('span', { class: className }, label);
  return h(
    'a',
    { href, class: className, target: '_blank', rel: 'noopener noreferrer' },
    label,
    h('span', { class: 'visually-hidden' }, ' (opens in a new tab)'),
  );
}

/** Format an ISO date string (2026-03-05) as "Mar 5, 2026" without time-zone surprises. */
export function formatDate(iso) {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
  if (!match) return String(iso || '');
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return date.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

/**
 * Say something to screen-reader users without moving focus
 * (uses one hidden "polite" live region shared by the whole page).
 */
let announcer = null;
export function announce(message) {
  if (!announcer) {
    announcer = h('div', { class: 'visually-hidden', role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' });
    document.body.append(announcer);
  }
  announcer.textContent = '';
  // Clearing first makes screen readers re-announce identical messages.
  window.setTimeout(() => {
    announcer.textContent = message;
  }, 50);
}
