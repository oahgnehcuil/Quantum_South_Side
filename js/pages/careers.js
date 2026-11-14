/* ==========================================================================
   careers.js — the Careers page.
   It loads data/careers.json, then draws these parts, top to bottom:
     1. Intro      the "not only PhDs" message with sourced facts
     2. Quiz       five preference questions that suggest interest areas
     3. Results    your top 1-2 areas and their career cards (after the quiz)
     4. Explore    filters + search + every career card
     5. Sources    a collapsible list of where the facts come from
     6. Call to action

   The quiz runs only in your browser. Answers are never saved or sent anywhere.
   To change any WORDS, edit data/careers.json. This file only holds layout and labels.
   ========================================================================== */
import { siteUrl } from '../config.js';
import { h, $, clear, withKets, externalLink, formatDate, announce } from '../utils/dom.js';
import { loadJSON, showDataError } from '../utils/loadData.js';
import { createCard } from '../components/card.js';
import { createFilterBar, matchesAllWords } from '../components/filterBar.js';

/* ==========================================================================
   1. State and small helpers
   ========================================================================== */
/** Show a second quiz match when it scores at least this share of the top score. */
const CLOSE_RATIO = 0.8;

/** What we remember while the page is open. */
const state = { data: null, bar: null, cards: new Map(), grid: null, empty: null, quizForm: null, questions: [] };

const prefersReducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const slot = (name) => $(`[data-slot="${name}"]`);
const areaOf = (id) => state.data.interestAreas.find((area) => area.id === id);
const levelOf = (id) => state.data.educationLevels.find((level) => level.id === id);
const sourceOf = (id) => state.data.sources.list.find((source) => source.id === id);
const levelIndex = (id) => state.data.educationLevels.findIndex((level) => level.id === id);

/** A heading you can move keyboard focus to (so screen readers start reading there). */
function focusHeading(heading) {
  heading.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'start' });
  heading.focus({ preventScroll: true });
}

/** A "section title" block: small label, heading and intro paragraph. */
function sectionHeading({ eyebrow, title, intro }, headingId) {
  const heading = h('h2', { id: headingId, tabindex: '-1' }, title);
  return {
    heading,
    el: h('div', { class: 'section-heading' }, eyebrow ? h('p', { class: 'eyebrow' }, eyebrow) : null, heading, intro ? h('p', { class: 'lead' }, intro) : null),
  };
}

/** Let screen readers know a section has finished loading. */
function markLoaded(name) {
  slot(name)?.closest('section')?.removeAttribute('aria-busy');
}

/* ==========================================================================
   2. Intro: the big idea
   ========================================================================== */
function renderIntro(root) {
  const { intro, meta } = state.data;
  const { el } = sectionHeading(intro, 'why-title');

  const notice = h(
    'div',
    { class: 'notice notice--sample careers-notice' },
    h('span', { class: 'notice__icon', 'aria-hidden': 'true' }, '📌'),
    h('div', { class: 'notice__body' }, h('p', { class: 'notice__title' }, meta.cardBadge), h('p', null, meta.disclaimer)),
  );

  const stats = h(
    'div',
    { class: 'careers-stats' },
    intro.stats.map((stat) => {
      const source = sourceOf(stat.sourceId);
      return h(
        'div',
        { class: 'stat careers-stat' },
        h('p', { class: 'stat__value' }, stat.value),
        h('p', { class: 'stat__label' }, stat.label),
        source ? h('p', { class: 'careers-stat__source' }, 'Source: ', externalLink(source.url, source.publisher)) : null,
      );
    }),
  );

  const parkSource = sourceOf(intro.parkSourceId);
  const park = h(
    'div',
    { class: 'careers-park' },
    h('h3', { class: 'careers-park__title' }, intro.parkTitle),
    h('p', null, intro.parkText),
    h('ul', { class: 'careers-park__roles' }, intro.parkRoles.map((role) => h('li', { class: 'tag tag--orange' }, role))),
    parkSource ? h('p', { class: 'careers-stat__source' }, 'Source: ', externalLink(parkSource.url, parkSource.title)) : null,
  );

  const warning = h('div', { class: 'callout callout--jobs' }, h('p', { class: 'callout__title' }, h('span', { 'aria-hidden': 'true' }, '💡'), intro.honestTitle), h('p', null, intro.honestText));

  clear(root).append(notice, el, stats, park, warning);
  markLoaded('intro');
}

/* ==========================================================================
   3. Quiz: five questions, scored right here in the browser
   ========================================================================== */
let quizHeading = null;
let quizStatus = null;

/** One question: a fieldset of big tappable radio choices (reuses the shared .choice styles). */
function buildQuestion(question, index, total) {
  const name = `careers-q-${question.id}`;
  const hint = h('p', { class: 'careers-question__hint', hidden: true }, state.data.results.incompleteHint);
  const choices = question.options.map((option, optionIndex) =>
    h(
      'label',
      { class: 'choice' },
      h('input', { class: 'choice__input', type: 'radio', name, value: String(optionIndex) }),
      h('span', { class: 'choice__box' }, h('span', { class: 'choice__text' }, withKets(option.text))),
    ),
  );
  const fieldset = h(
    'fieldset',
    { class: 'choice-group careers-question' },
    h('legend', { class: 'choice-group__legend careers-question__legend' }, h('span', { class: 'careers-question__number' }, `Question ${index + 1} of ${total}`), h('span', { class: 'careers-question__prompt' }, question.question)),
    choices,
    hint,
  );
  return { fieldset, hint, name, question };
}

/** Read the picked option of each question. Unanswered questions come back as null. */
function readAnswers(questions) {
  return questions.map(({ name, question }) => {
    const picked = $(`input[name="${name}"]:checked`, state.quizForm);
    return picked ? question.options[Number(picked.value)] : null;
  });
}

function updateAnsweredCount(questions) {
  const done = readAnswers(questions).filter(Boolean).length;
  quizStatus.textContent = `${done} of ${questions.length} answered`;
}

/**
 * Add up the weights. Highest score wins; a tie goes to the area picked as a main answer
 * (weight 2 or more) more often, then to the order in the JSON file.
 */
function scoreAnswers(answers, areas) {
  const totals = areas.map((area, order) => ({ area, order, score: 0, strong: 0 }));
  for (const option of answers) {
    for (const [areaId, weight] of Object.entries(option.weights || {})) {
      const total = totals.find((t) => t.area.id === areaId);
      if (!total) continue;
      total.score += weight;
      if (weight >= 2) total.strong += 1;
    }
  }
  return totals.sort((a, b) => b.score - a.score || b.strong - a.strong || a.order - b.order);
}

/** The top area, plus a second one when it is a tie or very close. */
function pickMatches(ranked) {
  const [first, second] = ranked;
  const matches = [first];
  const tied = Boolean(second) && second.score === first.score;
  if (second && second.score > 0 && second.score >= first.score * CLOSE_RATIO) matches.push(second);
  return { matches, tied: tied && matches.length === 2 };
}

function submitQuiz(questions) {
  const answers = readAnswers(questions);
  const missing = questions.filter((_, i) => !answers[i]);
  questions.forEach((q) => {
    const isMissing = missing.includes(q);
    q.hint.hidden = !isMissing;
    q.fieldset.classList.toggle('is-missing', isMissing);
  });
  if (missing.length) {
    quizStatus.textContent = `${state.data.results.emptyStatus} ${missing.length} still to go.`;
    $('input', missing[0].fieldset).focus();
    return;
  }
  const ranked = scoreAnswers(answers, state.data.interestAreas);
  renderResults(pickMatches(ranked), ranked);
}

/** Clear every answer and hide the results. */
function resetQuiz(questions) {
  state.quizForm.reset();
  questions.forEach((q) => {
    q.hint.hidden = true;
    q.fieldset.classList.remove('is-missing');
  });
  slot('results').closest('section').hidden = true;
  clear(slot('results'));
  updateAnsweredCount(questions);
  announce('Quiz cleared. Answer all five questions to see your matches.');
}

function renderQuiz(root) {
  const { quiz } = state.data;
  const { heading, el } = sectionHeading(quiz, 'quiz-title');
  quizHeading = heading;

  const questions = quiz.questions.map((q, i) => buildQuestion(q, i, quiz.questions.length));
  state.questions = questions;
  quizStatus = h('p', { class: 'careers-quiz__status text-muted', role: 'status' });

  const form = h(
    'form',
    { class: 'careers-quiz', 'aria-labelledby': 'quiz-title', novalidate: true },
    questions.map((q) => q.fieldset),
    h(
      'div',
      { class: 'careers-quiz__footer' },
      h('div', { class: 'cluster' }, h('button', { class: 'btn btn--primary btn--lg', type: 'submit' }, 'See my matches'), h('button', { class: 'btn btn--ghost', type: 'button', onClick: () => resetQuiz(questions) }, 'Reset answers')),
      quizStatus,
    ),
  );
  state.quizForm = form;
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    submitQuiz(questions);
  });
  form.addEventListener('change', (event) => {
    const question = questions.find((q) => q.name === event.target.name);
    if (question) {
      question.hint.hidden = true;
      question.fieldset.classList.remove('is-missing');
    }
    updateAnsweredCount(questions);
  });
  updateAnsweredCount(questions);

  clear(root).append(el, h('div', { class: 'careers-quiz-card' }, form));
  markLoaded('quiz');
}

/* ==========================================================================
   4. Results: your top matches
   ========================================================================== */
const scoreWord = (n) => `${n} ${n === 1 ? 'point' : 'points'}`;

/** A small bar chart (plain list + CSS bars) of how each area scored. */
function buildChart(ranked) {
  const top = Math.max(1, ranked[0].score);
  return h(
    'div',
    { class: 'careers-chart' },
    h('h3', { class: 'careers-chart__title' }, state.data.results.chartTitle),
    h(
      'ul',
      { class: 'careers-chart__list' },
      ranked.map((item) =>
        h(
          'li',
          { class: ['careers-chart__row', `careers-tone-${item.area.tone}`] },
          h('span', { class: 'careers-chart__label' }, h('span', { 'aria-hidden': 'true' }, `${item.area.icon} `), item.area.label),
          h('span', { class: 'careers-chart__track', 'aria-hidden': 'true' }, h('span', { class: 'careers-chart__bar', style: { width: `${Math.round((item.score / top) * 100)}%` } })),
          h('span', { class: 'careers-chart__score' }, scoreWord(item.score)),
        ),
      ),
    ),
  );
}

function renderMatchBlock(area) {
  const careers = state.data.careers.filter((c) => c.interestArea === area.id);
  return h(
    'div',
    { class: ['careers-match', `careers-tone-${area.tone}`] },
    h('h3', { class: 'careers-match__title' }, h('span', { 'aria-hidden': 'true' }, `${area.icon} `), area.label),
    h('p', { class: 'careers-match__text' }, area.matchText),
    h('p', { class: 'careers-match__roles-title' }, state.data.results.rolesTitle),
    h('div', { class: 'grid careers-grid' }, careers.map((career) => renderCard(career, 4))),
  );
}

function renderResults({ matches, tied }, ranked) {
  const { results } = state.data;
  const names = matches.map((m) => m.area.label).join(' and ');
  const title = matches.length === 1 ? `${results.titleOne}: ${names}` : `${results.titleMany}: ${names}`;
  const heading = h('h2', { id: 'results-title', tabindex: '-1' }, title);

  const actions = h(
    'div',
    { class: 'cluster careers-results__actions' },
    h('button', { class: 'btn btn--secondary', type: 'button', onClick: retakeQuiz }, results.retakeLabel),
    h('button', { class: 'btn btn--primary', type: 'button', onClick: showAllCareers }, results.showAllLabel),
  );

  const root = clear(slot('results'));
  root.append(
    h('div', { class: 'section-heading' }, h('p', { class: 'eyebrow' }, 'Your results'), heading, h('p', { class: 'lead' }, results.intro), tied ? h('p', { class: 'careers-tie' }, results.tieNote) : null),
    h('div', { class: 'careers-matches' }, matches.map((m) => renderMatchBlock(m.area))),
    buildChart(ranked),
    actions,
  );
  root.closest('section').hidden = false;
  focusHeading(heading);

  const careerCount = matches.reduce((sum, m) => sum + state.data.careers.filter((c) => c.interestArea === m.area.id).length, 0);
  announce(`${title}. ${careerCount} matching careers are shown below.`);
}

function retakeQuiz() {
  resetQuiz(state.questions);
  focusHeading(quizHeading);
}

function showAllCareers() {
  state.bar.reset();
  focusHeading($('#explore-title'));
  announce('Showing all careers.');
}

/* ==========================================================================
   5. Career cards
   ========================================================================== */
/** A <details> expander: keyboard and screen-reader friendly with no extra code. */
function buildDetail(label, ...content) {
  return h('details', { class: 'careers-detail' }, h('summary', { class: 'careers-detail__summary' }, label), h('div', { class: 'careers-detail__body' }, content));
}

function buildTagRow(items, variant) {
  return h('div', { class: 'card__tags' }, items.map((text) => h('span', { class: ['tag', variant ? `tag--${variant}` : ''] }, text)));
}

function buildPaths(career) {
  const labels = state.data.cardLabels;
  const items = career.educationPaths.map((path) => h('li', null, h('strong', null, levelOf(path.level)?.label || path.level), ' ', path.note));
  const sources = career.sourceIds.map(sourceOf).filter(Boolean);
  return buildDetail(
    labels.waysIn,
    h('ul', { class: 'careers-list careers-paths' }, items),
    career.caution ? h('p', { class: 'careers-caution' }, h('strong', null, `${labels.caution}: `), career.caution) : null,
    sources.length ? h('p', { class: 'careers-based' }, `${labels.basedOn}: `, sources.map((source, i) => [i ? ', ' : '', externalLink(source.url, source.title)])) : null,
  );
}

function buildResources(career) {
  const items = career.localResources.map((resource) => h('li', null, externalLink(resource.url, resource.name, 'careers-resource__link'), h('span', { class: 'careers-resource__note' }, resource.note)));
  return buildDetail(state.data.cardLabels.learnLocal, h('ul', { class: 'careers-list careers-resources' }, items), h('p', { class: 'careers-detail__foot text-muted' }, state.data.meta.resourceNote));
}

/** Build one career card (headingLevel keeps headings in order: 3 in the grid, 4 in the results). */
function renderCard(career, headingLevel = 3) {
  const labels = state.data.cardLabels;
  const area = areaOf(career.interestArea);
  const levels = career.educationPaths.map((path) => levelOf(path.level)?.label || path.level);

  const card = createCard({
    title: career.role,
    headingLevel,
    eyebrow: area.label,
    badges: [{ text: state.data.meta.cardBadge, variant: 'sample' }],
    body: career.summary,
    sections: [
      { label: labels.educationPaths, content: buildTagRow(levels, 'blue') },
      { label: labels.skills, content: buildTagRow(career.skills) },
    ],
    className: `careers-card careers-tone-${area.tone}`,
  });

  card.append(
    h(
      'div',
      { class: 'careers-details' },
      buildDetail(labels.dayToDay, h('ul', { class: 'careers-list' }, career.dayToDay.map((line) => h('li', null, line)))),
      buildPaths(career),
      buildDetail(labels.relatedJobs, h('p', null, labels.relatedJobsIntro), h('ul', { class: 'careers-list' }, career.relatedJobs.map((job) => h('li', null, job)))),
      buildResources(career),
    ),
  );
  return card;
}

/* ==========================================================================
   6. Explore: filters, search, sort and the card grid
   ========================================================================== */
function matchesFilters(career, filters) {
  const { education, area } = filters.groups;
  if (education !== 'all' && !career.educationPaths.some((path) => path.level === education)) return false;
  if (area !== 'all' && career.interestArea !== area) return false;
  if (!filters.search) return true;
  const text = [
    career.role,
    career.summary,
    areaOf(career.interestArea).label,
    ...career.skills,
    ...career.relatedJobs,
    ...career.dayToDay,
    ...career.educationPaths.map((path) => path.note),
    ...career.localResources.map((resource) => `${resource.name} ${resource.note}`),
  ].join(' ');
  return matchesAllWords(text, filters.search);
}

/** Order the careers the way the "Sort by" menu says. */
function sortCareers(list, sort) {
  const sorted = [...list];
  if (sort === 'name') sorted.sort((a, b) => a.role.localeCompare(b.role));
  if (sort === 'least-school') {
    const lowest = (career) => Math.min(...career.educationPaths.map((path) => levelIndex(path.level)));
    sorted.sort((a, b) => lowest(a) - lowest(b));
  }
  return sorted;
}

function drawGrid(filters) {
  const { careers } = state.data;
  const shown = sortCareers(careers.filter((career) => matchesFilters(career, filters)), filters.sort);
  state.grid.replaceChildren(...shown.map((career) => state.cards.get(career.id)));
  state.empty.hidden = shown.length > 0;
  state.grid.hidden = shown.length === 0;
  state.bar.setCount(shown.length, careers.length, 'careers');
}

function renderExplore(root) {
  const { explore, interestAreas, educationLevels, careers } = state.data;
  const { el } = sectionHeading(explore, 'explore-title');

  state.cards = new Map(careers.map((career) => [career.id, renderCard(career, 3)]));
  state.grid = h('div', { class: 'grid careers-grid' });
  state.empty = h(
    'div',
    { class: 'careers-empty', hidden: true },
    h('p', { class: 'careers-empty__icon', 'aria-hidden': 'true' }, '🔎'),
    h('p', { class: 'careers-empty__title' }, 'No careers match those filters'),
    h('p', { class: 'text-muted' }, 'Try a different school path or interest area, or search for a shorter word.'),
    h(
      'button',
      {
        class: 'btn btn--secondary',
        type: 'button',
        onClick: () => {
          state.bar.reset();
          state.bar.focus();
        },
      },
      'Clear filters',
    ),
  );

  state.bar = createFilterBar({
    label: 'Filter careers',
    search: { label: 'Search careers', placeholder: 'Try "software" or "apprenticeship"' },
    groups: [
      { id: 'education', label: 'Education path', options: [{ value: 'all', label: 'Any' }, ...educationLevels.map((level) => ({ value: level.id, label: level.label }))] },
      { id: 'area', label: 'Interest area', options: [{ value: 'all', label: 'All areas' }, ...interestAreas.map((area) => ({ value: area.id, label: area.label }))] },
    ],
    sort: {
      label: 'Sort by',
      options: [
        { value: 'suggested', label: 'Suggested order' },
        { value: 'name', label: 'Job title (A to Z)' },
        { value: 'least-school', label: 'Least school needed to start' },
      ],
    },
    onChange: drawGrid,
  });

  const levelNotes = h(
    'dl',
    { class: 'careers-levels' },
    educationLevels.map((level) => h('div', { class: 'careers-levels__item' }, h('dt', null, level.label), h('dd', null, level.blurb))),
  );

  clear(root).append(el, h('details', { class: 'careers-detail careers-levels-box' }, h('summary', { class: 'careers-detail__summary' }, 'What do these education words mean?'), h('div', { class: 'careers-detail__body' }, levelNotes)), state.bar.el, state.grid, state.empty);
  drawGrid(state.bar.getState());
  markLoaded('explore');
}

/* ==========================================================================
   7. Sources and call to action
   ========================================================================== */
function renderSources(root) {
  const { sources, meta } = state.data;
  const items = sources.list.map((source) => h('li', null, externalLink(source.url, source.title), h('span', { class: 'text-muted' }, ` · ${source.publisher}`)));
  clear(root).append(
    h(
      'div',
      { class: 'container' },
      h('details', { class: 'careers-sources' }, h('summary', null, sources.title), h('div', { class: 'careers-sources__body' }, h('p', { class: 'text-muted' }, `${sources.intro} ${formatDate(meta.lastReviewed)}.`), h('ol', { class: 'careers-sources__list' }, items))),
    ),
  );
}

function renderCta(root) {
  const { cta } = state.data;
  const buttons = cta.links.map((link) => {
    const className = `btn btn--${link.style} btn--lg`;
    return link.external ? externalLink(link.href, link.label, className) : h('a', { class: className, href: siteUrl(link.href) }, link.label);
  });
  clear(root).append(h('div', { class: 'container container--narrow careers-cta__inner' }, h('h2', null, cta.title), h('p', { class: 'lead' }, cta.text), h('div', { class: 'cluster careers-cta__buttons' }, buttons)));
}

/* ==========================================================================
   8. Start-up
   ========================================================================== */
async function init() {
  try {
    state.data = await loadJSON('data/careers.json');
  } catch (error) {
    // Hide the empty sections so the error message is the only thing under the page header.
    ['quiz', 'explore', 'sources', 'cta'].forEach((name) => {
      clear(slot(name));
      slot(name).closest('section').hidden = true;
    });
    showDataError(slot('intro'), { error, title: "We couldn't load the careers", onRetry: init });
    markLoaded('intro');
    return;
  }
  ['quiz', 'explore', 'sources', 'cta'].forEach((name) => {
    slot(name).closest('section').hidden = false;
  });
  renderIntro(slot('intro'));
  renderQuiz(slot('quiz'));
  renderExplore(slot('explore'));
  renderSources(slot('sources'));
  renderCta(slot('cta'));
}

init();
