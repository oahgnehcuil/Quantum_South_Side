/* ==========================================================================
   game.js — draws the Collapse Challenge page.

   The rules (gates, peeking, stars, friendly messages) live in
   js/games/collapseChallenge.js and the puzzles in data/game-puzzles.json.
   This file only builds the page, listens to buttons and saves progress.

   Flow: load puzzles -> pick today's -> show Start, Target and "Your state" ->
   the player adds gates -> Check -> stars, explanation and a share text.
   Practice mode lets anyone replay any puzzle without touching the streak.
   ========================================================================== */
import { h, $, icon, withKets, announce } from '../utils/dom.js';
import { loadJSON, showDataError } from '../utils/loadData.js';
import { siteUrl } from '../config.js';
import { getDayKey } from '../utils/dailySeed.js';
import { createStateView, GATE_COPY } from '../components/qubitDemo.js';
import { isSameState } from '../quantum/compare.js';
import { formatProbability } from '../quantum/format.js';
import {
  MAX_STARS, createGame, addGate, canUndo, undo, reset, peek, check, gatesUsed, stepLabel, shareText, pickTodaysPuzzle, validatePuzzle,
} from '../games/collapseChallenge.js';
import {
  getCurrentStreak, hasPlayedToday, getTodayResult, getBestStars, getTotalStars, recordGameResult, getFlag, setFlag, subscribe,
} from '../services/progressStore.js';

const HELP_SEEN_KEY = 'gameHelpSeen';
const TALL_SCREEN = 1000; // window height in pixels that is tall enough to show the help and the puzzle together
const FEEDBACK_TITLES = {
  empty: 'Add a gate first',
  'lucky-collapse': 'That was luck, not a circuit',
  sign: 'So close',
};

/* Everything the page needs to remember while it is open. */
const page = { puzzles: [], today: null, dayKey: '', currentId: null, root: null };

/* ---------- Small helpers ---------- */

/** "★★☆" for the eyes and "2 out of 3 stars" for screen readers. */
function starsText(count, className = 'game-stars') {
  return h(
    'span',
    { class: className },
    h('span', { 'aria-hidden': 'true' }, '★'.repeat(count) + '☆'.repeat(MAX_STARS - count)),
    h('span', { class: 'visually-hidden' }, `${count} out of ${MAX_STARS} stars`),
  );
}

const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;

/** Restart a one-shot CSS animation class on an element. */
function replay(el, className) {
  el.classList.remove(className);
  void el.offsetWidth;
  el.classList.add(className);
}

function scrollToIfNeeded(el) {
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  el.scrollIntoView({ block: 'nearest', behavior: reduce ? 'auto' : 'smooth' });
}

/* ---------- Status strip: streak, stars, played today ---------- */
function renderStatus() {
  const streak = getCurrentStreak(page.dayKey);
  const stars = getTotalStars();
  const best = page.puzzles.length * MAX_STARS;
  const played = hasPlayedToday(page.dayKey);
  const tile = (symbol, value, label, spoken) =>
    h(
      'li',
      { class: 'game-stat' },
      h('span', { class: 'game-stat__top', 'aria-hidden': 'true' }, h('span', { class: 'game-stat__icon' }, symbol), h('span', { class: 'game-stat__value' }, value)),
      h('span', { class: 'game-stat__label', 'aria-hidden': 'true' }, label),
      h('span', { class: 'visually-hidden' }, spoken),
    );
  $('#game-status').replaceChildren(
    tile('🔥', String(streak), 'Day streak', `Day streak: ${plural(streak, 'day')}`),
    tile('⭐', `${stars}`, `of ${best} stars`, `Stars earned: ${stars} of ${best}`),
    tile('✅', played ? 'Yes' : 'Not yet', 'Played today', `Played today: ${played ? 'yes' : 'not yet'}`),
  );
}

/* ---------- Practice mode grid ---------- */
/** What the grid looked like last time, so an unchanged grid is left alone. */
let practiceSignature = '';

function renderPractice() {
  const signature = JSON.stringify([page.puzzles.map((puzzle) => [puzzle.id, getBestStars(puzzle.id)]), page.today.id, page.currentId]);
  if (signature === practiceSignature) return;
  practiceSignature = signature;
  const focusedId = document.activeElement?.closest?.('#game-practice-grid') ? document.activeElement.dataset.puzzleId : null;
  const items = page.puzzles.map((puzzle) => {
    const best = getBestStars(puzzle.id);
    const isToday = puzzle.id === page.today.id;
    const button = h(
      'button',
      { type: 'button', dataset: { puzzleId: String(puzzle.id) }, class: ['game-tile', isToday ? 'is-today' : ''], 'aria-current': puzzle.id === page.currentId ? 'true' : null, onClick: () => chooseFromGrid(puzzle) },
      h('span', { class: 'game-tile__num' }, `#${puzzle.id}`),
      h('span', { class: 'game-tile__body' }, h('span', { class: 'game-tile__title' }, puzzle.title), isToday ? h('span', { class: 'game-tile__badge' }, 'Today') : null),
      best ? h('span', { class: 'game-tile__stars' }, starsText(best, 'game-stars game-stars--small')) : h('span', { class: 'game-tile__new' }, 'Not solved yet'),
    );
    return h('li', null, button);
  });
  $('#game-practice-grid').replaceChildren(...items);
  $('#game-practice').hidden = false;
  if (focusedId !== null) $(`#game-practice-grid [data-puzzle-id="${CSS.escape(focusedId)}"]`)?.focus({ preventScroll: true }); // keep keyboard focus on the same tile
}

/** A tile in the practice grid was chosen. Today's puzzle stays the daily one until it has been solved. */
function chooseFromGrid(puzzle) {
  const isToday = puzzle.id === page.today.id;
  showPuzzle(puzzle, { mode: isToday ? (hasPlayedToday(page.dayKey) ? 'solved-today' : 'daily') : 'practice', focus: true });
}

/* ---------- Share box ---------- */
function buildShare(text) {
  const textEl = h('p', { class: 'game-share__text' }, text);
  const note = h('p', { class: 'game-share__note', role: 'status' });
  const copyButton = h('button', { type: 'button', class: 'btn btn--outline-light game-share__copy' }, 'Copy result');

  /** If the browser blocks the clipboard, show the text in a box that is already selected. */
  function showFallback() {
    const box = h('textarea', { class: 'game-share__box', readonly: true, rows: 3, 'aria-label': 'Your result. Select it and copy it.' }, text);
    textEl.replaceWith(box);
    box.focus();
    box.select();
    note.textContent = 'Your browser would not copy for us. The text is selected: press Ctrl+C (or Command+C) to copy it.';
    announce('Result selected. Press Control C or Command C to copy.');
  }

  copyButton.addEventListener('click', async () => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('No clipboard');
      await navigator.clipboard.writeText(text);
      copyButton.textContent = 'Copied ✓';
      note.textContent = 'Copied';
      announce('Copied');
      window.setTimeout(() => {
        copyButton.textContent = 'Copy result';
        note.textContent = '';
      }, 2500);
    } catch {
      showFallback();
    }
  });

  return h('div', { class: 'game-share' }, h('p', { class: 'game-label' }, 'Share your result'), textEl, h('div', { class: 'game-share__row' }, copyButton), note);
}

/* ---------- Celebration (pure CSS animation; hidden when motion is reduced) ---------- */
function buildConfetti() {
  const colors = ['var(--cyan-300)', 'var(--orange-400)', 'var(--violet-300)', 'var(--amber-300)', 'var(--green-100)'];
  const pieces = Array.from({ length: 16 }, (_, i) =>
    h('span', {
      class: ['game-confetti__piece', i % 3 === 0 ? 'is-round' : ''],
      style: { '--x': `${(i * 37) % 100}%`, '--delay': `${(i % 6) * 0.07}s`, '--drift': `${((i * 53) % 60) - 30}px`, '--color': colors[i % colors.length] },
    }),
  );
  return h('div', { class: 'game-confetti', 'aria-hidden': 'true' }, pieces);
}

/* ---------- The result card ---------- */
function buildResult({ puzzle, stars, used, message, mode, sequence, onAgain, onNext, onToday }) {
  const titleId = `game-result-title-${puzzle.id}`;
  const title = h('h3', { class: 'game-result__title', id: titleId, tabindex: '-1' }, mode === 'solved-today' ? 'You solved today’s puzzle' : 'You solved it!');
  const pieces = [
    mode === 'solved-today' ? null : buildConfetti(),
    title,
    h('p', { class: 'game-result__stars' }, starsText(stars, 'game-stars game-stars--big')),
    h('p', { class: 'game-result__message' }, message),
    sequence ? h('p', { class: 'game-result__sequence' }, h('span', { class: 'game-label' }, 'Your gates '), sequence) : null,
    h('div', { class: 'game-result__why' }, h('p', { class: 'game-label' }, 'What the gates did'), h('p', null, withKets(puzzle.explanation))),
    buildShare(shareText({ puzzleId: puzzle.id, stars, gatesUsed: used, url: siteUrl('pages/game.html') })),
  ];

  const actions = [];
  if (mode === 'daily' || mode === 'solved-today') {
    pieces.push(h('p', { class: 'game-result__tomorrow' }, icon('🌙'), ' Come back tomorrow for a new puzzle. It changes at midnight Chicago time.'));
    actions.push(h('button', { type: 'button', class: 'btn btn--light', onClick: () => goToPractice() }, 'Keep playing in Practice mode'));
    actions.push(h('button', { type: 'button', class: 'btn btn--outline-light', onClick: onAgain }, mode === 'daily' ? 'Replay this puzzle' : 'Replay this puzzle (practice)'));
  } else {
    actions.push(h('button', { type: 'button', class: 'btn btn--light', onClick: onNext }, 'Next puzzle'));
    actions.push(h('button', { type: 'button', class: 'btn btn--outline-light', onClick: onAgain }, stars < MAX_STARS ? 'Try again for more stars' : 'Play it again'));
    actions.push(h('button', { type: 'button', class: 'btn btn--outline-light', onClick: onToday }, 'Back to today’s challenge'));
  }
  pieces.push(h('div', { class: 'game-result__actions' }, actions));
  return { el: h('section', { class: 'game-result', 'aria-labelledby': titleId }, pieces), title };
}

/** The puzzle after this one in the list (the first one after the last). */
function nextPuzzle(puzzle) {
  const index = page.puzzles.findIndex((p) => p.id === puzzle.id);
  return page.puzzles[(index + 1) % page.puzzles.length];
}

/** Put the player on the practice grid with focus on its heading. */
function goToPractice() {
  const heading = $('#game-practice-title');
  heading.focus();
  heading.scrollIntoView({ block: 'start' });
}

/* ---------- One puzzle on screen ---------- */

/**
 * Show a puzzle. mode is 'daily' (counts for the streak), 'practice', or 'solved-today' (today's puzzle is done:
 * show the saved result instead of the builder).
 */
function showPuzzle(puzzle, { mode, focus = false }) {
  page.currentId = puzzle.id;
  const game = createGame(puzzle);
  const solvedSaved = mode === 'solved-today' ? getTodayResult(page.dayKey) : null;
  let finished = mode === 'solved-today';

  /* Cards: Start, Target, Your state */
  const startView = createStateView({ title: 'Start', showAmplitudes: true, size: 'sm', live: false });
  const targetView = createStateView({ title: 'Target', showAmplitudes: true, size: 'sm', live: false });
  const yourView = createStateView({ title: 'Your state', showAmplitudes: true, size: 'sm', live: true });
  startView.el.classList.add('game-view', 'game-view--start');
  targetView.el.classList.add('game-view', 'game-view--target');
  yourView.el.classList.add('game-view', 'game-view--yours');
  startView.update(game.start, { animate: false });
  targetView.update(game.target, { animate: false });
  yourView.update(game.current, { animate: false });

  /* Heading */
  const label = mode === 'daily' || mode === 'solved-today' ? 'Today’s challenge' : 'Practice';
  const heading = h('h2', { class: 'game-puzzle__title', tabindex: '-1' }, puzzle.title);
  const counter = h('p', { class: 'game-counter' });
  const head = h(
    'div',
    { class: 'game-puzzle__head' },
    h('div', { class: 'game-puzzle__titles' }, h('p', { class: 'game-puzzle__eyebrow' }, `Puzzle #${puzzle.id} · ${label}`), heading, h('p', { class: 'game-puzzle__task' }, 'Turn the Start into the Target. Fewer gates earn more stars.')),
    mode === 'practice' ? h('button', { type: 'button', class: 'btn btn--outline-light btn--sm game-puzzle__back', onClick: () => chooseFromGrid(page.today) }, 'Back to today’s challenge') : null,
    mode === 'solved-today' ? null : counter,
  );

  /* Where results and messages appear */
  const feedback = h('div', { class: 'game-feedback-live', role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' });
  const hintBox = h('div', { class: 'game-hint', role: 'status', 'aria-live': 'polite' });
  const resultHolder = h('div', { class: 'game-result-holder' });

  /* Builder */
  const gateButtons = puzzle.allowedGates.map((id) => {
    const gate = GATE_COPY[id];
    const plain = gate.plain.replace(/\.$/, '');
    return h(
      'button',
      {
        type: 'button',
        class: 'qubit-gate',
        'aria-label': `${gate.id} ${gate.label}. Add the ${gate.name} to your list: ${plain.charAt(0).toLowerCase()}${plain.slice(1)}`,
        dataset: { gate: id },
        onClick: () => pressGate(id),
      },
      h('span', { class: 'qubit-gate__letter' }, gate.id),
      ' ',
      h('span', { class: 'qubit-gate__caption' }, gate.label),
    );
  });
  const gatesLabelId = `game-gates-label-${puzzle.id}`;
  const sequenceList = h('ol', { class: 'game-sequence', 'aria-label': 'Your gates, in order' });
  const sequenceEmpty = h('p', { class: 'game-sequence__empty' }, 'No gates yet. Press a gate above to add it.');
  const undoButton = h('button', { type: 'button', class: 'btn btn--outline-light btn--sm', onClick: doUndo }, 'Undo');
  const resetButton = h('button', { type: 'button', class: 'btn btn--outline-light btn--sm', onClick: doReset }, 'Reset');
  const peekNote = h('span', { class: 'game-btn__note' });
  const peekButton = h('button', { type: 'button', class: 'btn btn--outline-light game-peek', onClick: doPeek }, h('span', null, 'Peek (measure)'), peekNote);
  const hintButton = h('button', { type: 'button', class: 'btn btn--outline-light', 'aria-expanded': 'false', onClick: toggleHint }, 'Hint (free)');
  const checkButton = h('button', { type: 'button', class: 'btn game-check', onClick: doCheck }, 'Check');

  const build = h(
    'div',
    { class: 'game-build' },
    h(
      'div',
      { class: 'game-build__gates' },
      h('p', { class: 'game-label', id: gatesLabelId }, 'Press a gate to add it'),
      h('div', { class: 'game-gates', role: 'group', 'aria-labelledby': gatesLabelId }, gateButtons),
    ),
    h(
      'div',
      { class: 'game-build__sequence' },
      h('div', { class: 'game-build__sequence-head' }, h('p', { class: 'game-label' }, 'Your gates'), h('div', { class: 'game-build__small' }, undoButton, resetButton)),
      sequenceList,
      sequenceEmpty,
    ),
    h('div', { class: 'game-actions' }, hintButton, peekButton, checkButton),
    hintBox,
  );

  function refreshSequence() {
    const items = game.steps.map((step, index) => {
      const isPeek = step.kind === 'peek';
      return h(
        'li',
        { class: ['game-step', isPeek ? 'game-step--peek' : 'game-step--gate', index === game.steps.length - 1 ? 'is-latest' : ''] },
        h('span', { class: 'game-step__num', 'aria-hidden': 'true' }, String(index + 1)),
        h('span', { class: 'visually-hidden' }, `Step ${index + 1}: ${isPeek ? '' : 'gate '}`),
        isPeek ? icon('👀', 'game-step__icon') : null,
        h('span', { class: 'game-step__label' }, stepLabel(step)),
      );
    });
    sequenceList.replaceChildren(...items);
    sequenceList.hidden = items.length === 0;
    sequenceEmpty.hidden = items.length > 0;
  }

  function refresh() {
    yourView.update(game.current);
    refreshSequence();
    counter.replaceChildren('Gates used: ', h('strong', null, String(gatesUsed(game))), ' · Par: ', h('strong', null, String(puzzle.par)));
    undoButton.setAttribute('aria-disabled', String(!canUndo(game)));
    resetButton.setAttribute('aria-disabled', String(game.steps.length === 0));
    peekNote.textContent = game.peeked ? 'already peeked, no extra cost' : 'costs 1 star';
  }

  function showFeedback(kind, titleText, text, symbol) {
    feedback.replaceChildren(
      h('div', { class: ['game-feedback', `game-feedback--${kind}`] }, icon(symbol, 'game-feedback__icon'), h('div', null, h('p', { class: 'game-feedback__title' }, titleText), h('p', null, withKets(text)))),
    );
    scrollToIfNeeded(feedback);
  }

  function clearFeedback() {
    feedback.replaceChildren();
  }

  function pressGate(id) {
    if (finished) return;
    const before = game.current;
    addGate(game, id);
    clearFeedback();
    refresh();
    const same = isSameState(before, game.current);
    announce(`Added ${id}. ${plural(gatesUsed(game), 'gate')} used.${same ? ' Your state looks the same.' : ''}`);
  }

  function doUndo() {
    if (finished) return;
    const step = undo(game);
    if (step) {
      clearFeedback();
      refresh();
      announce(`Undid ${step.gate}.`);
    } else if (game.steps.length > 0) {
      // The last step is a peek, and a real measurement cannot be taken back.
      showFeedback('peek', 'Peeks can’t be undone', "A measurement can't be undone. Press Reset to start a new attempt.", '👀');
    } else {
      announce('Nothing to undo.');
    }
  }

  function doReset() {
    if (finished) return;
    if (game.steps.length === 0) {
      announce('Already at the start.');
      return;
    }
    const hadPeeked = game.peeked;
    reset(game);
    clearFeedback();
    refresh();
    announce(`Back to the start.${hadPeeked ? ' This is a fresh try, so the peek cost is cleared.' : ''}`);
    gateButtons[0].focus();
  }

  function doPeek() {
    if (finished) return;
    const alreadyPeeked = game.peeked;
    const outcome = peek(game);
    refresh();
    replay(yourView.el, 'is-collapsed');
    const chance = formatProbability(outcome.probability);
    const what = outcome.wasBlend
      ? `You peeked and got ${outcome.bits} (a ${chance} chance). Measuring collapsed your qubit: the blend is gone and you now hold a plain ${outcome.bits}. Match the Target before you measure! In real life you cannot undo a measurement, so only Reset starts a new attempt.`
      : `You peeked and got ${outcome.bits}. Your qubit was already a plain ${outcome.bits}, so nothing changed. A blend would have collapsed to a random 0 or 1 here, and in real life you cannot undo that.`;
    showFeedback('peek', 'Peek: you measured', `${what} ${alreadyPeeked ? 'You already peeked on this try, so there is no extra cost.' : 'Peeking costs one star on this try.'}`, '👀');
  }

  function toggleHint() {
    const open = hintButton.getAttribute('aria-expanded') === 'true';
    hintButton.setAttribute('aria-expanded', String(!open));
    hintButton.textContent = open ? 'Hint (free)' : 'Hide hint';
    hintBox.replaceChildren(...(open ? [] : [icon('💡'), ' ', h('strong', null, 'Hint: '), withKets(puzzle.hint)]));
  }

  function doCheck() {
    if (finished) return;
    const result = check(game);
    if (!result.solved) {
      showFeedback('try', FEEDBACK_TITLES[result.kind] ?? 'Not there yet', result.message, '🤔');
      return;
    }
    finished = true;
    recordGameResult({
      dayKey: page.dayKey,
      score: result.stars,
      perfect: result.gatesUsed <= puzzle.par,
      daily: mode === 'daily',
      puzzleId: puzzle.id,
      stars: result.stars,
      gatesUsed: result.gatesUsed,
    });
    renderStatus();
    renderPractice();
    clearFeedback();
    hintBox.replaceChildren();
    build.hidden = true;
    const sequence = h('span', { class: 'game-result__chips' }, game.steps.map((step) => h('span', { class: ['qubit-chip', step.kind === 'peek' ? 'qubit-chip--more' : ''] }, stepLabel(step))));
    const card = buildResult({
      puzzle,
      stars: result.stars,
      used: result.gatesUsed,
      message: result.message,
      mode,
      sequence,
      onAgain: () => showPuzzle(puzzle, { mode: mode === 'daily' ? 'practice' : mode, focus: true }),
      onNext: () => chooseFromGrid(nextPuzzle(puzzle)),
      onToday: () => chooseFromGrid(page.today),
    });
    resultHolder.replaceChildren(card.el);
    card.title.focus();
  }

  /* A solved daily puzzle on a later visit: show the saved result, not the builder. */
  if (mode === 'solved-today') {
    build.hidden = true;
    const stars = solvedSaved?.stars ?? Math.max(1, getBestStars(puzzle.id));
    const used = solvedSaved?.gatesUsed ?? puzzle.par;
    const card = buildResult({
      puzzle,
      stars,
      used,
      message: solvedSaved
        ? `You matched the target in ${plural(used, 'gate')} and earned ${plural(stars, 'star')}. Nice work!`
        : `You already solved today’s puzzle and earned ${plural(stars, 'star')}. Nice work!`,
      mode,
      sequence: null,
      onAgain: () => showPuzzle(puzzle, { mode: 'practice', focus: true }),
    });
    resultHolder.replaceChildren(card.el);
  }

  const views = h('div', { class: ['game-views', mode === 'solved-today' ? 'game-views--two' : ''] }, startView.el, targetView.el, mode === 'solved-today' ? null : yourView.el);
  const lab = h('div', { class: 'game-lab surface-dark' }, head, views, build, feedback, resultHolder);
  page.root.replaceChildren(lab);
  page.root.removeAttribute('aria-busy');
  if (mode !== 'solved-today') refresh();
  renderPractice();

  if (focus) heading.focus();
}

/* ---------- Start up ---------- */
async function init() {
  page.root = $('#game-root');
  page.root.setAttribute('aria-busy', 'true');
  try {
    const data = await loadJSON('data/game-puzzles.json');
    const puzzles = (Array.isArray(data?.puzzles) ? data.puzzles : []).filter((puzzle) => validatePuzzle(puzzle).length === 0);
    if (puzzles.length === 0) throw new Error('data/game-puzzles.json has no playable puzzles.');
    page.puzzles = puzzles;
  } catch (error) {
    page.root.removeAttribute('aria-busy');
    showDataError(page.root, { error, title: 'We couldn’t load today’s puzzle', onRetry: init });
    return;
  }
  page.dayKey = getDayKey();
  page.today = pickTodaysPuzzle(page.puzzles, page.dayKey);
  renderStatus();
  showPuzzle(page.today, { mode: hasPlayedToday(page.dayKey) ? 'solved-today' : 'daily' });
}

/**
 * "How to play" is for first-time visitors. It only opens by itself on a tall screen, so it never pushes the puzzle out of sight;
 * on a shorter screen it stays closed with a clear "read this first" label. It remembers when it has been closed.
 */
function setUpHelp() {
  const help = $('#game-help');
  if (!help) return;
  const firstVisit = getFlag(HELP_SEEN_KEY, false) !== true && !getTotalStars();
  help.open = firstVisit && window.innerHeight >= TALL_SCREEN;
  if (firstVisit) help.querySelector('summary').textContent = 'How to play (read this first)';
  help.addEventListener('toggle', () => {
    if (!help.open) setFlag(HELP_SEEN_KEY, true);
  });
}

setUpHelp();
init();

// Progress changed elsewhere (another tab, or the account finished syncing): refresh the numbers. The puzzle being played is never rebuilt.
subscribe(() => {
  if (!page.today) return;
  renderStatus();
  renderPractice();
});
