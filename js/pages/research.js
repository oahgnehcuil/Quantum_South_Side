/* ==========================================================================
   research.js — the Research page.
   It loads data/research.json (new quantum papers from arXiv) and the lesson titles from
   data/learn/*.json, then shows one card per paper: a plain explanation, a difficulty badge,
   a "Learn the basics first" link to the matching lesson, and links to arXiv.
   A search box, difficulty pills, topic pills and a sort menu narrow the list.

   The file is split into sections, top to bottom:
     1. Settings     difficulty levels and page state
     2. Filtering    which papers match, and in what order
     3. Cards        drawing one paper
     4. Page         the toolbar, the card grid and empty messages
     5. Start-up     loading, errors and wiring the filter bar

   To change paper WORDS, edit data/research.json. This file only holds labels.
   ========================================================================== */
import { LEARN_TOPICS, AI_SUMMARY_LABEL, SOURCE_EXCERPT_LABEL } from '../config.js';
import { h, $, clear, externalLink, formatDate } from '../utils/dom.js';
import { loadJSON, loadAll, showDataError } from '../utils/loadData.js';
import { createCard } from '../components/card.js';
import { createFilterBar, matchesAllWords } from '../components/filterBar.js';

/* ==========================================================================
   1. Settings
   ========================================================================== */
const DATA_PATH = 'data/research.json';
const lessonPath = (id) => `data/learn/${id}.json`;

/** Difficulty levels, easiest first. `rank` is used for sorting. */
const LEVELS = [
  { value: 'beginner', label: 'Beginner', rank: 1 },
  { value: 'intermediate', label: 'Intermediate', rank: 2 },
  { value: 'advanced', label: 'Advanced', rank: 3 },
];
const NOT_RATED = 'unrated';

/** What the page remembers while it is open. lessonTitles: topic id -> lesson title. */
const state = { items: [], lessonTitles: new Map(), bar: null, list: null };

/** "error-correction" -> "Error correction" (used only if a lesson file did not load). */
function fallbackTitle(id) {
  const words = id.replace(/-/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const lessonTitle = (id) => state.lessonTitles.get(id) || fallbackTitle(id);
const levelOf = (item) => LEVELS.find((level) => level.value === item.difficulty);
const hasLesson = (item) => LEARN_TOPICS.includes(item.relatedTopic);

/* ==========================================================================
   2. Filtering and sorting
   ========================================================================== */
/** Search looks in the title, authors, explanation and key idea. Chicago papers also match the word "Chicago". */
function searchText(item) {
  const chicago = item.chicagoAffiliation === true ? 'Chicago' : '';
  return [item.title, (item.authors || []).join(' '), item.summary, item.keyIdea, chicago].join(' ');
}

function matchesFilters(item, filters) {
  const { difficulty, topic } = filters.groups;
  const level = levelOf(item)?.value || NOT_RATED;
  if (difficulty !== 'all' && level !== difficulty) return false;
  if (topic !== 'all' && item.relatedTopic !== topic) return false;
  return !filters.search || matchesAllWords(searchText(item), filters.search);
}

/** Newest first, or easiest first (papers without a rating go last). */
function sortItems(items, how) {
  const newest = (a, b) => String(b.published || '').localeCompare(String(a.published || ''));
  const rank = (item) => levelOf(item)?.rank || 99;
  return [...items].sort(how === 'easiest' ? (a, b) => rank(a) - rank(b) || newest(a, b) : newest);
}

/* ==========================================================================
   3. Cards
   ========================================================================== */
/** Arxiv titles can contain LaTeX math like $\mathbb{F}_2$. Show the plain version. */
function plainTitle(title) {
  return String(title || '')
    .replace(/\\mathbb\{(\w+)\}/g, '$1')
    .replace(/\\times/g, '×')
    .replace(/\$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** "A, B, C et al." (the first three authors). */
function authorLine(authors) {
  if (!Array.isArray(authors) || !authors.length) return '';
  const names = authors.slice(0, 3).join(', ');
  return authors.length > 3 ? `${names} et al.` : names;
}

function buildBadges(item) {
  const badges = [];
  const level = levelOf(item);
  if (level) badges.push({ text: level.label, variant: level.value });
  if (item.chicagoAffiliation === true) badges.push({ text: 'Chicago connection', variant: 'chicago' });
  return badges;
}

/** The one-sentence "Key idea" (only drawn when the paper has one). */
function buildKeyIdea(text) {
  if (!text) return null;
  return h('div', { class: 'card__section research-key' }, h('p', { class: 'card__section-label' }, 'Key idea'), h('p', null, text));
}

/** The note under the explanation. AI-written text and plain excerpts get different labels. */
function buildSummaryLabel(item) {
  if (item.aiSummary === false) return h('p', { class: 'ai-label ai-label--source' }, SOURCE_EXCERPT_LABEL);
  return h('p', { class: 'ai-label' }, AI_SUMMARY_LABEL);
}

/** Buttons at the bottom: the lesson link (when there is one), then arXiv page and PDF. */
function buildActions(item, title) {
  const hidden = (text) => h('span', { class: 'visually-hidden' }, text);
  const actions = [];
  if (hasLesson(item)) {
    actions.push(
      h('a', { class: 'btn btn--secondary btn--sm research-learn', href: `learn.html#${item.relatedTopic}` }, `Learn the basics first: ${lessonTitle(item.relatedTopic)}`),
    );
  }
  if (item.absUrl) actions.push(externalLink(item.absUrl, ['arXiv page', hidden(` for ${title}`)], 'btn btn--primary btn--sm'));
  if (item.pdfUrl) actions.push(externalLink(item.pdfUrl, ['PDF', hidden(` of ${title}`)], 'btn btn--ghost btn--sm'));
  return actions;
}

function buildPaperCard(item) {
  const title = plainTitle(item.title);
  return createCard({
    title,
    headingLevel: 3,
    className: 'research-card',
    badges: buildBadges(item),
    meta: [authorLine(item.authors), item.published ? `Posted ${formatDate(item.published)}` : ''],
    body: [item.summary, buildKeyIdea(item.keyIdea), buildSummaryLabel(item)],
    actions: buildActions(item, title),
  });
}

/* ==========================================================================
   4. Page: toolbar, card grid and empty messages
   ========================================================================== */
function buildEmptyState(message, withClearButton) {
  const clearButton = withClearButton
    ? h(
        'button',
        {
          class: 'btn btn--secondary btn--sm',
          type: 'button',
          onClick: () => {
            state.bar.reset();
            state.bar.focus();
          },
        },
        'Clear filters',
      )
    : null;
  return h('div', { class: 'research-empty' }, h('p', { class: 'research-empty__text' }, message), clearButton);
}

/** Draw the cards for the current filters and update the "Showing x of y" line. */
function renderPapers() {
  const filters = state.bar.getState();
  const shown = sortItems(state.items.filter((item) => matchesFilters(item, filters)), filters.sort);
  clear(state.list);
  if (shown.length) state.list.append(h('div', { class: 'grid grid--2' }, shown.map(buildPaperCard)));
  else state.list.append(buildEmptyState('No papers match. Try clearing the filters.', true));
  state.bar.setCount(shown.length, state.items.length, 'papers');
}

/** "Last updated: Nov 14, 2026" (left out when the date is missing or unreadable). */
function buildUpdatedLine(lastUpdated) {
  const date = new Date(lastUpdated);
  if (!lastUpdated || Number.isNaN(date.getTime())) return null;
  const text = date.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
  return h('p', { class: 'research-updated' }, 'Last updated: ', h('time', { datetime: lastUpdated }, text));
}

function buildFilterBar() {
  const all = (label) => ({ value: 'all', label });
  return createFilterBar({
    label: 'Filter research papers',
    search: { label: 'Search papers', placeholder: 'Try "qubit" or "Fermilab"' },
    sort: {
      label: 'Sort by',
      options: [
        { value: 'newest', label: 'Newest first' },
        { value: 'easiest', label: 'Easiest first' },
      ],
    },
    groups: [
      {
        id: 'difficulty',
        label: 'Difficulty',
        options: [all('Any level'), ...LEVELS.map(({ value, label }) => ({ value, label })), { value: NOT_RATED, label: 'Not rated' }],
      },
      {
        id: 'topic',
        label: 'Topic (matches a Learn lesson)',
        options: [all('All topics'), ...LEARN_TOPICS.map((id) => ({ value: id, label: lessonTitle(id) }))],
      },
    ],
    onChange: renderPapers,
  });
}

function buildToolbar(lastUpdated) {
  state.bar = buildFilterBar();
  const guide = h(
    'p',
    { class: 'research-guide' },
    'Difficulty is our rough guess at how much background a paper assumes. ',
    h('strong', null, 'Beginner:'),
    ' the big idea makes sense after our lessons. ',
    h('strong', null, 'Intermediate:'),
    ' expect some new words. ',
    h('strong', null, 'Advanced:'),
    ' written for working physicists.',
  );
  return h(
    'section',
    { class: 'section section--alt research-toolbar', 'aria-label': 'Find papers' },
    h('div', { class: 'container' }, h('div', { class: 'research-toolbar__inner' }, buildUpdatedLine(lastUpdated), state.bar.el, guide)),
  );
}

/* ==========================================================================
   5. Start-up
   ========================================================================== */
function buildPage(data) {
  state.list = h('div');
  return [
    buildToolbar(data.lastUpdated),
    h(
      'section',
      { class: 'section research-results', 'aria-labelledby': 'research-results-title' },
      h('div', { class: 'container' }, h('h2', { class: 'visually-hidden', id: 'research-results-title' }, 'Papers'), state.list),
    ),
  ];
}

async function init() {
  const root = $('#research-root');
  root.setAttribute('aria-busy', 'true');
  try {
    const [data] = await Promise.all([loadJSON(DATA_PATH), loadLessonTitles()]);
    state.items = Array.isArray(data.items) ? data.items : [];
    if (!state.items.length) {
      clear(root).append(
        h('section', { class: 'section section--alt' }, h('div', { class: 'container container--narrow' }, buildEmptyState('There are no papers to show right now. Please check back later.', false))),
      );
    } else {
      clear(root).append(...buildPage(data));
      renderPapers();
    }
  } catch (error) {
    const holder = h('div', { class: 'container container--narrow' });
    clear(root).append(h('section', { class: 'section section--alt' }, holder));
    showDataError(holder, { error, title: "We couldn't load the research papers", onRetry: init });
  }
  root.setAttribute('aria-busy', 'false');
}

/** Read each lesson's title so labels say "Quantum Gates", not "gates". One missing lesson never blocks the page. */
async function loadLessonTitles() {
  const results = await loadAll(LEARN_TOPICS.map(lessonPath));
  results.forEach((result, index) => {
    if (result.ok && result.data?.title) state.lessonTitles.set(LEARN_TOPICS[index], result.data.title);
  });
}

init();
