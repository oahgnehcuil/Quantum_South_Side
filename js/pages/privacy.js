/* ==========================================================================
   privacy.js — the Privacy page.
   It loads data/privacy.json and draws a short table of contents plus one block of text per
   section. Every word lives in the JSON, so edit data/privacy.json to change the page.

   Each section has "blocks". A block is one of:
     { type: 'p', text }                 a paragraph
     { type: 'h3', text }                a small heading inside the section
     { type: 'list', items: [text] }     a bullet list
     { type: 'terms', items: [{ term, text }] }   a list of names with a short explanation
     { type: 'links', items: [{ label, href }] }  links (site paths stay on the site; https opens a new tab)
   ========================================================================== */
import { siteUrl } from '../config.js';
import { h, $, clear, externalLink, formatDate, isSafeUrl } from '../utils/dom.js';
import { loadJSON, showDataError } from '../utils/loadData.js';

const DATA_PATH = 'data/privacy.json';

/** A site path (index.html) stays on this site; an https address opens in a new tab. */
function buildLink(item) {
  if (/^https:\/\//.test(item.href) && isSafeUrl(item.href)) return externalLink(item.href, item.label, 'privacy-link');
  return h('a', { class: 'privacy-link', href: siteUrl(item.href) }, item.label);
}

/** Turn one block from the JSON into an element. */
function buildBlock(block) {
  switch (block.type) {
    case 'h3':
      return h('h3', { class: 'privacy-subhead' }, block.text);
    case 'list':
      return h('ul', { class: 'privacy-list' }, (block.items || []).map((text) => h('li', null, text)));
    case 'terms':
      return h(
        'dl',
        { class: 'privacy-terms' },
        (block.items || []).map((item) => h('div', { class: 'privacy-terms__row' }, h('dt', null, item.term), h('dd', null, item.text))),
      );
    case 'links':
      return h('ul', { class: 'privacy-links' }, (block.items || []).map((item) => h('li', null, buildLink(item))));
    default:
      return h('p', null, block.text);
  }
}

function buildSection(section) {
  const titleId = `${section.id}-title`;
  return h(
    'section',
    { class: ['privacy-section', section.highlight ? 'privacy-section--highlight' : ''], id: section.id, 'aria-labelledby': titleId },
    h('h2', { class: 'privacy-section__title', id: titleId }, section.title),
    h('div', { class: 'privacy-section__body' }, (section.blocks || []).map(buildBlock)),
  );
}

function buildContents(data) {
  return h(
    'nav',
    { class: 'privacy-toc', 'aria-label': data.tocLabel || 'On this page' },
    h('p', { class: 'privacy-toc__title' }, data.tocLabel || 'On this page'),
    h('ol', { class: 'privacy-toc__list' }, data.sections.map((section) => h('li', null, h('a', { href: `#${section.id}` }, section.title)))),
  );
}

function buildUpdated(data) {
  if (!data.lastUpdated) return null;
  return h('p', { class: 'privacy-updated' }, `${data.lastUpdatedLabel || 'Last updated'}: `, h('time', { datetime: data.lastUpdated }, formatDate(data.lastUpdated)));
}

/** The banner and meta description come from the JSON too (the HTML holds the same words in case the file fails). */
function applyHeader(data) {
  const banner = $('.page-header');
  const { eyebrow, title, lead } = data.header || {};
  if (eyebrow) $('.eyebrow', banner).textContent = eyebrow;
  if (title) $('h1', banner).textContent = title;
  if (lead) $('.lead', banner).textContent = lead;
  const description = $('meta[name="description"]');
  if (description && data.meta?.description) description.content = data.meta.description;
}

function buildPage(data) {
  return h(
    'section',
    { class: 'section section--alt privacy' },
    h('div', { class: 'container container--narrow' }, buildUpdated(data), buildContents(data), data.sections.map(buildSection)),
  );
}

async function init() {
  const root = $('#privacy-root');
  root.setAttribute('aria-busy', 'true');
  try {
    const data = await loadJSON(DATA_PATH);
    if (!Array.isArray(data.sections) || !data.sections.length) throw new Error(`${DATA_PATH} has no sections`);
    applyHeader(data);
    clear(root).append(buildPage(data));
  } catch (error) {
    const holder = h('div', { class: 'container container--narrow' });
    clear(root).append(h('section', { class: 'section section--alt' }, holder));
    showDataError(holder, { error, title: "We couldn't load the privacy page", onRetry: init });
  }
  root.setAttribute('aria-busy', 'false');
  scrollToHash();
}

/** A link like privacy.html#passwords should still land on its section after the text is drawn. */
function scrollToHash() {
  if (location.hash.length < 2) return;
  try {
    document.getElementById(decodeURIComponent(location.hash.slice(1)))?.scrollIntoView();
  } catch {
    // A broken address like "#%" just means we stay at the top.
  }
}

init();
