/* ==========================================================================
   news.js — the News page.
   It loads data/news.json and shows the stories in two sections:
     • "Big Quantum News"          stories from around the world
     • "Chicago Schools & Quantum" stories from Chicago-area schools, labs and companies
   A search box and topic pills (from the shared filter bar) narrow both sections at once.

   The file is split into sections, top to bottom:
     1. Settings     topic names and the two sections
     2. Filtering    which stories match, and in what order
     3. Cards        drawing one story
     4. Sections     headings, empty messages and the card grids
     5. Start-up     loading, errors, and wiring the filter bar

   To change story WORDS, edit data/news.json. This file only holds labels.
   ========================================================================== */
import { AI_SUMMARY_LABEL, SOURCE_EXCERPT_LABEL } from '../config.js';
import { h, $, clear, externalLink, formatDate } from '../utils/dom.js';
import { loadJSON, showDataError } from '../utils/loadData.js';
import { createCard } from '../components/card.js';
import { createFilterBar, matchesAllWords } from '../components/filterBar.js';

/* ==========================================================================
   1. Settings
   ========================================================================== */
const DATA_PATH = 'data/news.json';

/** Topics we know, in the order the pills appear. `variant` picks the tag color on each card. */
const TOPICS = [
  { value: 'careers', label: 'Careers', variant: 'green' },
  { value: 'education', label: 'Education', variant: 'blue' },
  { value: 'industry', label: 'Industry', variant: 'orange' },
  { value: 'research', label: 'Research', variant: 'violet' },
  { value: 'policy', label: 'Policy', variant: 'cyan' },
  { value: 'cybersecurity', label: 'Cybersecurity', variant: 'blue' },
];

/** Shown on stories that have no Chicago line of their own, so the label is never missing. */
const NO_CHICAGO_LINK = 'No direct Chicago link in this story. It shows where the field is heading.';

const isChicagoStory = (item) => item.isChicagoRelated === true || item.category === 'chicago-schools';

/** The two page sections, in order. `belongs` decides which stories go where. */
const SECTIONS = [
  {
    id: 'big',
    eyebrow: 'Around the world',
    title: 'Big Quantum News',
    intro: 'The biggest quantum technology stories of the moment, with the most important first.',
    belongs: (item) => !isChicagoStory(item),
  },
  {
    id: 'chicago',
    eyebrow: 'Close to home',
    title: 'Chicago Schools & Quantum',
    intro: 'What is happening at Chicago-area schools, labs and companies, and what it could mean for students here.',
    belongs: isChicagoStory,
  },
];

/** What the page remembers while it is open. */
const state = { items: [], topics: TOPICS, bar: null, results: null };

/* ==========================================================================
   2. Filtering and sorting
   ========================================================================== */
/** Most important first; stories with the same importance: newest first. */
function byImportanceThenDate(a, b) {
  return (Number(b.importance) || 0) - (Number(a.importance) || 0) || String(b.date || '').localeCompare(String(a.date || ''));
}

/** Does a story match the chosen topics (any of them) and the search words? */
function matchesFilters(item, filters) {
  const chosen = filters.groups.topic;
  if (chosen.length && !(item.tags || []).some((tag) => chosen.includes(tag))) return false;
  if (!filters.search) return true;
  const text = [item.title, item.source, item.summary, ...(item.tags || []), item.whyItMattersForChicago].join(' ');
  return matchesAllWords(text, filters.search);
}

/* ==========================================================================
   3. Cards
   ========================================================================== */
const topicOf = (tag) => TOPICS.find((topic) => topic.value === tag);

/** "quantum-networks" -> "Quantum Networks" (for tags we have no label for). */
function titleCase(tag) {
  return tag.replace(/-/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function tagLabel(tag) {
  return topicOf(tag)?.label || titleCase(tag);
}

/** One pill for every tag the stories use: known topics first (in our order), then any new tags A to Z. */
function topicsFromItems(items) {
  const used = new Set(items.flatMap((item) => item.tags || []));
  const known = TOPICS.filter((topic) => used.has(topic.value));
  const extra = [...used].filter((tag) => !topicOf(tag)).sort();
  return [...known, ...extra.map((tag) => ({ value: tag, label: titleCase(tag) }))];
}

/** The small note under the summary. AI-written text and plain feed excerpts get different labels. */
function buildSummaryLabel(item) {
  if (item.aiSummary === false) return h('p', { class: 'ai-label ai-label--source' }, SOURCE_EXCERPT_LABEL);
  return h('p', { class: 'ai-label' }, AI_SUMMARY_LABEL);
}

/** "Why it matters for Chicago". Stories without their own line get a muted, honest fallback. */
function buildWhyItMatters(text) {
  const hasText = Boolean(text);
  return h(
    'div',
    { class: ['card__section news-why', hasText ? '' : 'news-why--fallback'] },
    h('p', { class: 'card__section-label' }, 'Why it matters for Chicago'),
    h('p', null, hasText ? text : NO_CHICAGO_LINK),
  );
}

function buildReadLink(item) {
  const label = ['Read the original', h('span', { class: 'visually-hidden' }, `: ${item.title}`)];
  return externalLink(item.url, label, 'btn btn--secondary btn--sm');
}

function buildStoryCard(item) {
  const topStory = Number(item.importance) >= 5;
  return createCard({
    title: item.title,
    headingLevel: 3,
    className: 'news-card',
    badges: topStory ? [{ text: 'Top story', variant: 'top' }] : [],
    meta: [item.source, formatDate(item.date)],
    body: [item.summary, buildWhyItMatters(item.whyItMattersForChicago), buildSummaryLabel(item)],
    tags: (item.tags || []).map((tag) => ({ text: tagLabel(tag), variant: topicOf(tag)?.variant })),
    actions: [buildReadLink(item)],
  });
}

/* ==========================================================================
   4. Sections
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
  return h('div', { class: 'news-empty' }, h('p', { class: 'news-empty__text' }, message), clearButton);
}

/** One section: heading, then the cards (or a friendly empty message). */
function buildSection(config, index, stories, totalInSection) {
  const headingId = `news-${config.id}-title`;
  let content;
  if (stories.length) content = h('div', { class: 'grid grid--2' }, stories.map(buildStoryCard));
  else if (totalInSection) content = buildEmptyState('No stories match. Try clearing the filters.', true);
  else content = buildEmptyState('There are no stories in this section right now.', false);

  return h(
    'section',
    { class: ['section', index % 2 === 0 ? '' : 'section--alt'], 'aria-labelledby': headingId },
    h(
      'div',
      { class: 'container' },
      h('div', { class: 'section-heading' }, h('p', { class: 'eyebrow' }, config.eyebrow), h('h2', { id: headingId }, config.title), h('p', { class: 'lead' }, config.intro)),
      content,
    ),
  );
}

/** Draw both sections for the current filters and update the "Showing x of y" line. */
function renderResults() {
  const filters = state.bar.getState();
  let shown = 0;
  const sections = SECTIONS.map((config, index) => {
    const inSection = state.items.filter(config.belongs);
    const stories = inSection.filter((item) => matchesFilters(item, filters)).sort(byImportanceThenDate);
    shown += stories.length;
    return buildSection(config, index, stories, inSection.length);
  });
  clear(state.results).append(...sections);
  state.bar.setCount(shown, state.items.length, 'stories');
}

/** "Last updated: Nov 14, 2026" (left out when the date is missing or unreadable). */
function buildUpdatedLine(lastUpdated) {
  const date = new Date(lastUpdated);
  if (!lastUpdated || Number.isNaN(date.getTime())) return null;
  const text = date.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
  return h('p', { class: 'news-updated' }, 'Last updated: ', h('time', { datetime: lastUpdated }, text));
}

function buildToolbar(lastUpdated) {
  state.bar = createFilterBar({
    label: 'Filter news stories',
    search: { label: 'Search stories', placeholder: 'Try "Argonne" or "IBM"' },
    groups: [{ id: 'topic', label: 'Topics (pick any)', multiple: true, options: state.topics.map(({ value, label }) => ({ value, label })) }],
    onChange: renderResults,
  });
  return h(
    'section',
    { class: 'section section--alt news-toolbar', 'aria-label': 'Find stories' },
    h('div', { class: 'container' }, h('div', { class: 'news-toolbar__inner' }, buildUpdatedLine(lastUpdated), state.bar.el)),
  );
}

/* ==========================================================================
   5. Start-up
   ========================================================================== */
function buildPageEmptyState() {
  return h(
    'section',
    { class: 'section section--alt' },
    h('div', { class: 'container container--narrow' }, buildEmptyState('There are no stories to show right now. Please check back later.', false)),
  );
}

async function init() {
  const root = $('#news-root');
  root.setAttribute('aria-busy', 'true');
  try {
    const data = await loadJSON(DATA_PATH);
    state.items = Array.isArray(data.items) ? data.items : [];
    state.topics = topicsFromItems(state.items);
    if (!state.items.length) {
      clear(root).append(buildPageEmptyState());
    } else {
      state.results = h('div', { class: 'news-results' });
      clear(root).append(buildToolbar(data.lastUpdated), state.results);
      renderResults();
    }
  } catch (error) {
    const holder = h('div', { class: 'container container--narrow' });
    clear(root).append(h('section', { class: 'section section--alt' }, holder));
    showDataError(holder, { error, title: "We couldn't load the news stories", onRetry: init });
  }
  root.setAttribute('aria-busy', 'false');
}

init();
