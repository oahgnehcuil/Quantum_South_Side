/* ==========================================================================
   learn.js — the Learn page.
   It loads the lesson files in data/learn/*.json, shows a topic picker, and draws
   one lesson at a time (summary, analogy, key terms, quiz, sources).

   The file is split into sections, top to bottom:
     1. State        what we remember while the page is open
     2. Progress     the "Your progress" card and the confidence check
     3. Topic picker the sidebar (phones: a swipeable strip)
     4. Lesson       drawing one lesson
     5. Quiz         the "Check yourself" questions
     6. Start-up     loading, URL hash (#gates) and focus handling

   To change lesson WORDS, edit the JSON files. This file only holds labels.
   ========================================================================== */
import { SITE, LEARN_TOPICS, QUIZ_PASS_SCORE } from '../config.js';
import { h, $, $$, clear, withKets, paragraphs, icon, externalLink, formatDate, announce } from '../utils/dom.js';
import { loadAll, loadJSON, showDataError } from '../utils/loadData.js';
import {
  getProgressSummary,
  isTopicComplete,
  setTopicComplete,
  recordQuizResult,
  getQuizBest,
  getConfidence,
  setConfidence,
  isPersistent,
  getMode,
  subscribe,
} from '../services/progressStore.js';

/* ==========================================================================
   1. State
   ========================================================================== */
const lessonPath = (id) => `data/learn/${id}.json`;
const isPhoneLayout = () => window.matchMedia('(max-width: 899.98px)').matches;
const prefersReducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** lessons: topic id -> { id, ok, data, error }.   activeId: the lesson on screen. */
const state = { lessons: new Map(), activeId: LEARN_TOPICS[0], listening: false };

/** The three page areas (filled in by init). */
const areas = { progress: null, nav: null, main: null };

/** Sidebar entries, so we can update a single one later: id -> { link, check, doneText, meta }. */
const navItems = new Map();

/** Small functions of the lesson on screen that redraw saved numbers (for example "Your best: 2/3") when progress changes. */
let lessonRefreshers = [];

/** Buttons for the lesson on screen that toggle "complete" (kept in step with each other). */
let completeButtons = [];

/** Elements of the progress card (filled in by buildProgressCard). */
const card = {};

/** "error-correction" -> "Error correction" (only used if a lesson file did not load). */
function fallbackTitle(id) {
  const words = id.replace(/-/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function lessonOf(id) {
  const entry = state.lessons.get(id);
  return entry && entry.ok ? entry.data : null;
}

const titleOf = (id) => lessonOf(id)?.title || fallbackTitle(id);
const iconOf = (id) => lessonOf(id)?.icon || '📘';

/** Read the topic from the URL (#gates). Unknown or empty falls back to the first lesson. */
function topicFromHash() {
  let wanted = '';
  try {
    wanted = decodeURIComponent(window.location.hash.slice(1));
  } catch {
    wanted = '';
  }
  return LEARN_TOPICS.includes(wanted) ? wanted : LEARN_TOPICS[0];
}

/** Mark a lesson complete (or not) and refresh everything that shows it. */
function setComplete(id, done) {
  setTopicComplete(id, done);
  syncCompleteButtons();
  refreshNav();
  updateProgressCard();
  const { topicsCompleted, totalTopics } = getProgressSummary();
  announce(`${titleOf(id)} marked as ${done ? 'complete' : 'not complete'}. ${topicsCompleted} of ${totalTopics} lessons complete.`);
}

/* ==========================================================================
   2. Progress card: lesson count + optional, anonymous confidence check
   ========================================================================== */
const RATING_LEGENDS = { before: 'Before you start', after: "After you've learned" };

/** One row of five radio buttons (1 = not at all ... 5 = very confident). */
function buildRatingGroup(which) {
  const endsId = `confidence-${which}-ends`;
  const inputs = [1, 2, 3, 4, 5].map((n) =>
    h('input', {
      class: 'learn-rating__input',
      type: 'radio',
      name: `confidence-${which}`,
      value: n,
      onChange: () => {
        setConfidence(which, n);
        updateProgressCard();
      },
    }),
  );
  const options = inputs.map((input, index) =>
    h('label', { class: 'learn-rating__option' }, input, h('span', { class: 'learn-rating__pill' }, String(index + 1), h('span', { class: 'visually-hidden' }, ' out of 5'))),
  );
  const fieldset = h(
    'fieldset',
    { class: 'learn-rating', 'aria-describedby': endsId },
    h('legend', { class: 'learn-rating__legend' }, RATING_LEGENDS[which]),
    h('div', { class: 'learn-rating__scale' }, options),
    h('p', { class: 'learn-rating__ends', id: endsId }, h('span', null, '1 = Not at all confident'), h('span', null, '5 = Very confident')),
  );
  return { fieldset, inputs };
}

/** Who can see the answers: depends on guest or account mode. */
function privacyText() {
  if (getMode() === 'account') return 'Your answers are saved to your account, so the change shows on any device. We never ask for a real name.';
  return isPersistent()
    ? 'This is anonymous. We never ask your name, and your answers stay on this device.'
    : "This is anonymous. We never ask your name. Your browser won't let us save, so your answers last only until you close this tab.";
}

/** Build the card once. updateProgressCard() fills in the numbers. */
function buildProgressCard() {
  const before = buildRatingGroup('before');
  const after = buildRatingGroup('after');
  Object.assign(card, {
    count: h('p', { class: 'learn-progress__count' }),
    bar: h('div', { class: 'progress__bar' }),
    track: h('div', { class: 'progress', role: 'progressbar', 'aria-label': 'Lessons completed', 'aria-valuemin': '0' }),
    quizzes: h('p', { class: 'text-muted' }),
    message: h('p', { class: 'learn-confidence__message', role: 'status' }),
    before,
    after,
  });
  card.track.append(card.bar);

  card.privacy = h('p', { class: 'text-muted' }, privacyText());

  card.details = h(
    'details',
    { class: 'learn-confidence' },
    h('summary', { class: 'learn-confidence__summary' }, 'How confident do you feel about quantum careers? (1-5, optional)'),
    h(
      'div',
      { class: 'learn-confidence__body' },
      card.privacy,
      h('div', { class: 'learn-confidence__groups' }, before.fieldset, after.fieldset),
      card.message,
    ),
  );

  // On wide screens the card is always open; on phones it starts folded so lessons come first.
  const wide = window.matchMedia('(min-width: 900px)');
  const syncOpen = () => {
    if (wide.matches) card.details.open = true;
  };
  syncOpen();
  wide.addEventListener('change', syncOpen);

  areas.progress.append(
    h('div', { class: 'learn-progress__summary' }, h('h2', { class: 'learn-progress__title' }, 'Your progress'), card.count, card.track, card.quizzes),
    card.details,
  );
}

/** Words that describe how the two ratings compare (honest, never pushy). */
function confidenceChange(before, after) {
  const diff = after - before;
  if (diff > 0) return `You moved from ${before} to ${after}: up ${diff} ${diff === 1 ? 'step' : 'steps'}! That is real growth.`;
  if (diff === 0) return `You picked ${after} both times. Confidence can go up or down as you learn more; that's okay.`;
  return `You moved from ${before} to ${after}. Confidence can go up or down as you learn more; that's okay. Knowing what you still want to learn is progress too.`;
}

/** The one-line note under the ratings: how it works, or the result once both are picked. */
function confidenceMessage({ before, after }) {
  if (before !== null && after !== null) return confidenceChange(before, after);
  if (before !== null) return 'Thanks! After a few lessons, come back and rate yourself again to see how your confidence changes.';
  if (after !== null) return `Thanks! Pick a "Before you start" number too and we'll show how your confidence changed.`;
  return 'Pick a number for "Before you start" now, then rate yourself again after a few lessons. There are no right answers.';
}

/** Change an element's text only when it differs, so screen readers are not told the same thing twice. */
function setText(element, text) {
  if (element.textContent !== text) element.textContent = text;
}

/** Refresh the lesson count, progress bar and confidence check from saved progress. */
function updateProgressCard() {
  const summary = getProgressSummary();
  const { before, after } = getConfidence();
  const total = summary.totalTopics;

  const countText = `${summary.topicsCompleted} of ${total}`;
  if (card.count.firstElementChild?.textContent !== countText) clear(card.count).append(h('strong', null, countText), ' lessons complete');
  card.bar.style.width = `${Math.round((summary.topicsCompleted / total) * 100)}%`;
  card.track.setAttribute('aria-valuemax', String(total));
  card.track.setAttribute('aria-valuenow', String(summary.topicsCompleted));
  setText(card.quizzes, `${summary.quizzesPassed} ${summary.quizzesPassed === 1 ? 'quiz' : 'quizzes'} passed`);

  card.before.inputs.forEach((input) => (input.checked = Number(input.value) === before));
  card.after.inputs.forEach((input) => (input.checked = Number(input.value) === after));
  setText(card.message, confidenceMessage({ before, after }));
  setText(card.privacy, privacyText());
}

/* ==========================================================================
   3. Topic picker (sidebar on wide screens, scrollable strip on phones)
   ========================================================================== */
function buildNavItem(id, index) {
  const entry = state.lessons.get(id);
  const meta = entry.ok
    ? h('span', { class: 'learn-nav__meta' }, `${entry.data.readingTimeMinutes} min read`)
    : h('span', { class: 'learn-nav__meta learn-nav__meta--error' }, icon('⚠️'), " Couldn't load");
  const check = h('span', { class: 'learn-nav__check', 'aria-hidden': 'true' });
  const doneText = h('span', { class: 'visually-hidden' });
  const link = h(
    'a',
    { class: 'learn-nav__link', href: `#${id}` },
    h('span', { class: 'learn-nav__icon', 'aria-hidden': 'true' }, iconOf(id)),
    h('span', { class: 'learn-nav__text' }, h('span', { class: 'learn-nav__title' }, titleOf(id)), meta),
    check,
    doneText,
  );
  navItems.set(id, { link, check, doneText });
  return h('li', null, link);
}

function buildNav() {
  navItems.clear();
  const loaded = LEARN_TOPICS.map((id) => lessonOf(id)).filter(Boolean);
  const minutes = loaded.reduce((sum, lesson) => sum + (lesson.readingTimeMinutes || 0), 0);
  clear(areas.nav).append(
    h('p', { class: 'learn-nav__summary' }, `${loaded.length} lessons, about ${minutes} min in all`),
    h('ol', { class: 'learn-nav__list' }, LEARN_TOPICS.map(buildNavItem)),
  );
  refreshNav();
}

/** Update the completed checks and the "you are here" marker. */
function refreshNav() {
  for (const [id, item] of navItems) {
    const done = isTopicComplete(id);
    item.check.textContent = done ? '✓' : '';
    item.check.classList.toggle('is-done', done);
    item.doneText.textContent = done ? ', completed' : '';
    if (id === state.activeId) item.link.setAttribute('aria-current', 'true');
    else item.link.removeAttribute('aria-current');
  }
}

/** On phones, slide the strip so the active pill is in the middle. */
function centerActiveNavItem() {
  const item = navItems.get(state.activeId);
  const strip = areas.nav;
  if (!item || strip.scrollWidth <= strip.clientWidth) return;
  const left = item.link.offsetLeft - (strip.clientWidth - item.link.offsetWidth) / 2;
  strip.scrollTo({ left: Math.max(0, left), behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
}

/* ==========================================================================
   4. Lesson view
   ========================================================================== */
/** Keep every "Mark as complete" button in step with what is saved. */
function syncCompleteButtons() {
  for (const { button, mark, id } of completeButtons) {
    const done = isTopicComplete(id);
    button.setAttribute('aria-pressed', String(done));
    mark.textContent = done ? '✓' : '';
  }
}

function buildCompleteButton(id, label) {
  const mark = h('span', { class: 'learn-complete__mark', 'aria-hidden': 'true' });
  const button = h(
    'button',
    {
      class: 'btn btn--secondary btn--toggle learn-complete',
      type: 'button',
      'aria-pressed': 'false',
      onClick: () => setComplete(id, button.getAttribute('aria-pressed') !== 'true'),
    },
    mark,
    label,
  );
  completeButtons.push({ button, mark, id });
  syncCompleteButtons();
  return button;
}

/** A titled block of the lesson: small icon + h3, then the content. */
function lessonSection(lessonId, key, symbol, title, ...content) {
  const headingId = `${lessonId}-${key}-title`;
  return h(
    'section',
    { class: `lesson-section lesson-section--${key}`, 'aria-labelledby': headingId },
    h('h3', { class: 'lesson-section__title', id: headingId }, h('span', { class: 'lesson-section__icon', 'aria-hidden': 'true' }, symbol), title),
    ...content,
  );
}

/** A colored callout box whose title is a real heading. */
function calloutSection(lessonId, key, variant, symbol, title, text) {
  const headingId = `${lessonId}-${key}-title`;
  return h(
    'section',
    { class: `lesson-section lesson-section--${key}`, 'aria-labelledby': headingId },
    h('div', { class: `callout callout--${variant}` }, h('h3', { class: 'callout__title', id: headingId }, icon(symbol), title), ...paragraphs(text)),
  );
}

function buildLessonHeader(lesson, index) {
  return h(
    'header',
    { class: 'lesson__header' },
    h('span', { class: 'lesson__icon', 'aria-hidden': 'true' }, lesson.icon),
    h(
      'div',
      { class: 'lesson__heading' },
      h('p', { class: 'eyebrow' }, `Lesson ${index + 1} of ${LEARN_TOPICS.length}`),
      h('h2', { class: 'lesson__title', id: 'lesson-title', tabindex: '-1' }, lesson.title),
      h('p', { class: 'lead' }, lesson.tagline),
      h('p', { class: 'lesson__meta' }, icon('⏱️'), ` ${lesson.readingTimeMinutes} min read`),
    ),
    h('div', { class: 'lesson__actions' }, buildCompleteButton(lesson.id, 'Mark as complete')),
  );
}

function buildKeyTerms(lesson) {
  const rows = lesson.keyTerms.map((item) => h('div', { class: 'learn-terms__row' }, h('dt', null, withKets(item.term)), h('dd', null, withKets(item.definition))));
  return h('dl', { class: 'learn-terms' }, rows);
}

function buildSources(lesson) {
  const items = lesson.sources.map((source) =>
    h('li', { class: 'learn-sources__item' }, externalLink(source.url, source.title), h('span', { class: 'learn-sources__publisher' }, source.publisher)),
  );
  return [h('ul', { class: 'learn-sources' }, items), h('p', { class: 'text-muted learn-sources__checked' }, `Sources last checked: ${formatDate(lesson.lastVerified)}`)];
}

/** "Previous" and "Next" links (the last lesson points on to Careers). */
function buildPager(id) {
  const index = LEARN_TOPICS.indexOf(id);
  const prevId = LEARN_TOPICS[index - 1];
  const nextId = LEARN_TOPICS[index + 1];
  const link = (href, direction, title, variant) =>
    h('a', { class: `btn btn--${variant} lesson-pager__link`, href }, h('span', { class: 'lesson-pager__dir' }, direction), h('span', { class: 'lesson-pager__title' }, title));
  return h(
    'nav',
    { class: 'lesson-pager', 'aria-label': 'Lesson navigation' },
    prevId ? link(`#${prevId}`, '← Previous lesson', titleOf(prevId), 'secondary') : h('span'),
    nextId ? link(`#${nextId}`, 'Next lesson →', titleOf(nextId), 'primary') : link('careers.html', 'You finished the lessons →', 'Explore quantum careers', 'primary'),
  );
}

/** The interactive qubit playground. It loads on demand so the lesson still works without it. */
async function mountDemo(holder) {
  try {
    const { createQubitDemo } = await import('../components/qubitDemo.js');
    clear(holder).append(createQubitDemo());
  } catch {
    clear(holder).append(
      h('div', { class: 'notice' }, h('span', { class: 'notice__icon', 'aria-hidden': 'true' }, '🛠️'), h('div', { class: 'notice__body' }, h('p', { class: 'notice__title' }, "The interactive demo couldn't load"), h('p', null, 'You can still read the lesson and take the quiz. Reloading the page may bring the demo back.'))),
    );
  }
}

function buildDemoSection(lesson) {
  const holder = h('div', { class: 'learn-demo' }, h('div', { class: 'skeleton learn-demo__loading', role: 'status' }, h('span', { class: 'visually-hidden' }, 'Loading the demo…')));
  mountDemo(holder);
  return lessonSection(lesson.id, 'demo', '🎮', 'Try it yourself', h('p', { class: 'text-muted' }, 'Play with one qubit. Nothing you press here can break it.'), holder);
}

/** Put one whole lesson together, in reading order. */
function buildLesson(lesson, index) {
  completeButtons = [];
  lessonRefreshers = [];
  const sections = [
    lessonSection(lesson.id, 'plain', '📖', 'In plain words', h('div', { class: 'lesson-prose' }, paragraphs(lesson.plainSummary))),
    lesson.demo === 'qubit-gates' ? buildDemoSection(lesson) : null,
    lesson.everydayAnalogy
      ? h(
          'div',
          { class: 'lesson-analogy' },
          calloutSection(lesson.id, 'analogy', 'analogy', '💡', 'Think of it like...', lesson.everydayAnalogy),
          lesson.analogyLimits ? h('p', { class: 'lesson-analogy__limits' }, h('strong', null, 'Where the comparison breaks down: '), withKets(lesson.analogyLimits)) : null,
        )
      : null,
    lesson.keyTerms?.length ? lessonSection(lesson.id, 'terms', '🔑', 'Key terms', buildKeyTerms(lesson)) : null,
    lesson.whyItMattersForJobs ? calloutSection(lesson.id, 'jobs', 'jobs', '💼', 'Why this matters for jobs', lesson.whyItMattersForJobs) : null,
    lesson.chicagoConnection ? calloutSection(lesson.id, 'chicago', 'chicago', '📍', 'Chicago connection', lesson.chicagoConnection) : null,
    buildQuiz(lesson),
    lesson.sources?.length ? lessonSection(lesson.id, 'sources', '📚', 'Sources', ...buildSources(lesson)) : null,
  ];
  return h('article', { class: 'lesson', 'aria-labelledby': 'lesson-title' }, buildLessonHeader(lesson, index), h('div', { class: 'lesson__body' }, sections), buildPager(lesson.id));
}

/** Friendly error for a lesson whose file did not load (other lessons keep working). */
function buildLessonError(id) {
  const entry = state.lessons.get(id);
  const holder = h('div');
  showDataError(holder, {
    error: entry.error,
    title: `We couldn't load "${titleOf(id)}"`,
    message: 'The other lessons still work. Check your internet connection and try again.',
    onRetry: () => retryLesson(id),
  });
  return h(
    'article',
    { class: 'lesson lesson--error', 'aria-labelledby': 'lesson-title' },
    h('header', { class: 'lesson__header' }, h('span', { class: 'lesson__icon', 'aria-hidden': 'true' }, '⚠️'), h('div', { class: 'lesson__heading' }, h('h2', { class: 'lesson__title', id: 'lesson-title', tabindex: '-1' }, titleOf(id)))),
    h('div', { class: 'lesson__body' }, holder),
    buildPager(id),
  );
}

async function retryLesson(id) {
  try {
    state.lessons.set(id, { id, ok: true, data: await loadJSON(lessonPath(id)) });
  } catch (error) {
    state.lessons.set(id, { id, ok: false, error });
  }
  buildNav();
  showLesson(id, { moveFocus: true });
}

/* ==========================================================================
   5. Quiz ("Check yourself")
   ========================================================================== */
const ARROW_KEYS = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'];

/** A question is usable only if it has text, 2+ options and a real answer. */
function isValidQuestion(q) {
  return q && q.question && Array.isArray(q.options) && q.options.length >= 2 && Number.isInteger(q.answerIndex) && q.answerIndex >= 0 && q.answerIndex < q.options.length;
}

/** Write the little "✓ Correct" / "✗ Not quite" tag inside an answer. */
function setResultTag(label, kind, text) {
  label.classList.add(`choice--${kind}`);
  $('.choice__box', label).append(h('span', { class: 'quiz__result' }, h('span', { 'aria-hidden': 'true' }, kind === 'correct' ? '✓ ' : '✗ '), text));
}

/** One question. Returns its element plus reset() and focusFirst() for "Try again". */
function buildQuestion(lessonId, q, index, total, onAnswered) {
  const name = `quiz-${lessonId}-q${index + 1}`;
  const feedback = h('div', { class: 'quiz__feedback', 'aria-live': 'polite' });
  let chosen = null;

  const inputs = q.options.map((_, optionIndex) =>
    h('input', {
      class: 'choice__input',
      type: 'radio',
      name,
      value: optionIndex,
      onChange: () => answer(optionIndex),
      onKeydown: keepLockedChoice,
    }),
  );
  const labels = q.options.map((optionText, optionIndex) =>
    h('label', { class: 'choice' }, inputs[optionIndex], h('span', { class: 'choice__box' }, h('span', { class: 'choice__text' }, withKets(optionText)))),
  );

  /** Once answered, arrow keys must not move focus or the selection (Tab still works). */
  function keepLockedChoice(event) {
    if (chosen !== null && ARROW_KEYS.includes(event.key)) event.preventDefault();
  }

  function answer(optionIndex) {
    if (chosen !== null) {
      // Already answered: put the selection back (questions lock after the first choice).
      inputs.forEach((input, i) => (input.checked = i === chosen));
      return;
    }
    chosen = optionIndex;
    const correct = optionIndex === q.answerIndex;
    labels.forEach((label) => label.classList.add('is-locked'));
    // aria-disabled (not "disabled") keeps every option readable; the chosen one stays the focusable one.
    inputs.forEach((input, i) => i !== optionIndex && input.setAttribute('aria-disabled', 'true'));
    setResultTag(labels[optionIndex], correct ? 'correct' : 'incorrect', correct ? 'Correct' : 'Not quite');
    if (!correct) setResultTag(labels[q.answerIndex], 'correct', 'Right answer');
    feedback.append(
      h(
        'div',
        { class: `quiz__explain ${correct ? 'quiz__explain--correct' : 'quiz__explain--incorrect'}` },
        h('p', null, h('strong', null, correct ? '✓ Correct! ' : '✗ Not quite. '), q.explanation ? withKets(q.explanation) : null),
        correct ? null : h('p', null, h('strong', null, 'The right answer: '), withKets(q.options[q.answerIndex])),
        h('p', { class: 'quiz__locked-note' }, 'Your answer is locked. Use Try again after the last question to change it.'),
      ),
    );
    onAnswered(correct);
  }

  const element = h(
    'fieldset',
    { class: 'choice-group quiz__question' },
    h('legend', { class: 'choice-group__legend' }, h('span', { class: 'quiz__number' }, `Question ${index + 1} of ${total}`), h('span', { class: 'quiz__prompt' }, withKets(q.question))),
    labels,
    feedback,
  );

  return {
    element,
    focusFirst: () => inputs[0].focus(),
    reset() {
      chosen = null;
      inputs.forEach((input) => {
        input.checked = false;
        input.removeAttribute('aria-disabled');
      });
      labels.forEach((label) => {
        label.classList.remove('is-locked', 'choice--correct', 'choice--incorrect');
        $$('.quiz__result', label).forEach((tag) => tag.remove());
      });
      clear(feedback);
    },
  };
}

function buildQuiz(lesson) {
  const questions = (lesson.quiz || []).filter(isValidQuestion);
  if (!questions.length) return null;
  const total = questions.length;
  let correctCount = 0;
  let answeredCount = 0;

  const best = h('p', { class: 'quiz__best' });
  const summary = h('div', { class: 'quiz__summary', role: 'status' });

  function showBest() {
    const saved = getQuizBest(lesson.id);
    setText(best, saved === null ? '' : `Your best: ${saved}/${total}`);
    best.hidden = saved === null;
  }
  lessonRefreshers.push(showBest); // so a sync from the account updates the number without touching the quiz itself

  /** Called after every answer. After the last one, show the score (and save it once). */
  function onAnswered(correct) {
    answeredCount += 1;
    if (correct) correctCount += 1;
    if (answeredCount < total) return;
    recordQuizResult(lesson.id, correctCount, total);
    showBest();
    showSummary();
  }

  function showSummary() {
    const passed = correctCount >= QUIZ_PASS_SCORE;
    const headline = passed
      ? `You got ${correctCount} of ${total}. ${correctCount === total ? 'Perfect score, you passed!' : 'Nice work, you passed!'}`
      : `You got ${correctCount} of ${total}. Not yet. Read the lesson again and try once more.`;
    const buttons = [h('button', { class: 'btn btn--secondary btn--sm', type: 'button', onClick: tryAgain }, 'Try again')];
    if (passed) buttons.push(buildCompleteButton(lesson.id, 'Mark this lesson as complete'));
    clear(summary).append(
      h(
        'div',
        { class: `notice ${passed ? 'notice--success' : ''}` },
        h('span', { class: 'notice__icon', 'aria-hidden': 'true' }, passed ? '🎉' : '💪'),
        h('div', { class: 'notice__body' }, h('p', { class: 'notice__title' }, headline), h('div', { class: 'cluster' }, buttons)),
      ),
    );
  }

  function tryAgain() {
    correctCount = 0;
    answeredCount = 0;
    clear(summary);
    completeButtons = completeButtons.filter(({ button }) => button.isConnected);
    built.forEach((question) => question.reset());
    built[0].focusFirst();
  }

  const built = questions.map((q, index) => buildQuestion(lesson.id, q, index, total, onAnswered));
  showBest();

  return lessonSection(
    lesson.id,
    'quiz',
    '✅',
    'Check yourself',
    h('p', { class: 'text-muted' }, `${total} quick questions. Pick an answer and you will see why right away.`),
    best,
    h('form', { class: 'quiz', onSubmit: (event) => event.preventDefault() }, built.map((question) => question.element)),
    summary,
  );
}

/* ==========================================================================
   6. Start-up: showing a lesson, loading files, URL hash
   ========================================================================== */
/** Scroll back up only when the top of the lesson area has scrolled out of view. */
function scrollToLessonIfNeeded() {
  const target = isPhoneLayout() ? areas.nav : areas.main;
  const headerBottom = document.getElementById('site-header').getBoundingClientRect().bottom;
  if (target.getBoundingClientRect().top < headerBottom) target.scrollIntoView({ block: 'start' });
}

/**
 * Show one lesson.
 * moveFocus is true for things the visitor did (clicking, Back button) so keyboard and
 * screen-reader users land on the lesson title. It is false on first load.
 */
function showLesson(id, { moveFocus }) {
  state.activeId = id;
  const entry = state.lessons.get(id);
  const index = LEARN_TOPICS.indexOf(id);
  clear(areas.main).removeAttribute('aria-busy');
  areas.main.append(entry.ok ? buildLesson(entry.data, index) : buildLessonError(id));
  document.title = `${titleOf(id)} · Learn · ${SITE.name}`;
  refreshNav();
  centerActiveNavItem();
  if (moveFocus) {
    $('#lesson-title', areas.main).focus({ preventScroll: true });
    scrollToLessonIfNeeded();
  }
}

function showLoading() {
  const bar = (width) => h('div', { class: 'skeleton', style: { height: '1.1rem', width } });
  areas.nav.hidden = false;
  clear(areas.nav).append(...[1, 2, 3, 4].map(() => h('div', { class: 'skeleton learn-nav__skeleton' })));
  areas.main.setAttribute('aria-busy', 'true');
  clear(areas.main).append(
    h('div', { class: 'lesson lesson--loading', role: 'status' }, h('span', { class: 'visually-hidden' }, 'Loading lessons…'), h('div', { class: 'stack' }, bar('40%'), bar('85%'), bar('100%'), bar('92%'), bar('70%'))),
  );
}

function showAllFailed(firstError) {
  areas.nav.hidden = true;
  areas.main.removeAttribute('aria-busy');
  showDataError(areas.main, {
    error: firstError,
    title: "We couldn't load the lessons",
    message: 'Check your internet connection and try again. Your progress is safe on this device.',
    onRetry: loadLessons,
  });
}

/** Load every lesson in parallel. One broken file never blocks the rest. */
async function loadLessons() {
  showLoading();
  const results = await loadAll(LEARN_TOPICS.map(lessonPath));
  state.lessons.clear();
  results.forEach((result, index) => state.lessons.set(LEARN_TOPICS[index], { id: LEARN_TOPICS[index], ok: result.ok, data: result.data, error: result.error }));

  if (results.every((result) => !result.ok)) {
    showAllFailed(results[0].error);
    return;
  }
  buildNav();
  showLesson(topicFromHash(), { moveFocus: false });
  if (!state.listening) {
    state.listening = true;
    window.addEventListener('hashchange', () => showLesson(topicFromHash(), { moveFocus: true }));
  }
}

function init() {
  areas.progress = $('#learn-progress');
  areas.nav = $('#learn-nav');
  areas.main = $('#learn-main');
  buildProgressCard();
  updateProgressCard();
  // Progress changed somewhere else (another tab, or the account finished syncing). Only counters and checks are
  // redrawn: a quiz that is half answered, and keyboard focus, are never touched.
  subscribe(() => {
    updateProgressCard();
    refreshNav();
    syncCompleteButtons();
    lessonRefreshers.forEach((refresh) => refresh());
  });
  loadLessons();
}

init();
