/* ==========================================================================
   home.js — builds the Home page from data/home.json.

   What happens, in order:
     1. Load data/home.json (if that fails, show a friendly error with "Try again").
     2. Fill each "slot" in index.html: hero, timeline, 30-second explainer,
        "why now" facts, call-to-action cards, your progress, and sources.
     3. Keep the progress panel fresh when you come back to the page, when
        another tab changes your saved progress, or when an account finishes syncing.

   To change any wording, edit data/home.json. This file only holds layout code
   and tiny interface labels.
   ========================================================================== */
import { SITE, siteUrl } from '../config.js';
import { h, $, $$, withKets, icon, externalLink, formatDate, announce } from '../utils/dom.js';
import { loadJSON, showDataError } from '../utils/loadData.js';
import { createCard } from '../components/card.js';
import { getProgressSummary, resetProgress, isPersistent, getMode, subscribe } from '../services/progressStore.js';

const slot = (name) => $(`[data-slot="${name}"]`);

/** Eyebrow + heading + optional intro, shared by every section. */
function sectionHeading({ eyebrow, title, intro }, titleId) {
  return h(
    'div',
    { class: 'section-heading' },
    eyebrow ? h('p', { class: 'eyebrow' }, eyebrow) : null,
    h('h2', { id: titleId }, withKets(title)),
    intro ? h('p', { class: 'lead' }, withKets(intro)) : null,
  );
}

/* ---------- 1. Hero ---------- */
function renderHero(root, hero) {
  const cta = (item, className) => h('a', { class: `btn btn--lg ${className}`, href: siteUrl(item.href) }, item.label);
  root.replaceChildren(
    h('p', { class: 'eyebrow' }, hero.eyebrow),
    h(
      'h1',
      { id: 'hero-title', class: 'home-hero__title' },
      h('span', { class: 'home-hero__past' }, hero.headlinePast),
      h('span', { class: 'home-hero__future' }, hero.headlineFuture),
    ),
    h('p', { class: 'lead home-hero__subhead' }, withKets(hero.subhead)),
    h('div', { class: 'cluster home-hero__actions' }, cta(hero.primaryCta, 'btn--light'), cta(hero.secondaryCta, 'btn--outline-light')),
    h('p', { class: 'home-hero__trust' }, icon('🔒'), ' ', hero.trustNote),
  );
}

/* ---------- 2. Timeline of revolutions ---------- */
/** One "who gained / who was left out" line. The symbol AND the label say it, never color alone. */
function timelineNote(kind, symbol, label, text) {
  return h(
    'div',
    { class: `home-note home-note--${kind}` },
    h('p', { class: 'home-note__label' }, icon(symbol, 'home-note__icon'), ' ', label),
    h('p', { class: 'home-note__text' }, withKets(text)),
  );
}

function renderStop(stop, labels) {
  const current = Boolean(stop.current);
  return h(
    'li',
    { class: ['home-stop', current ? 'home-stop--now' : ''], 'aria-current': current ? 'step' : null },
    h('span', { class: 'home-stop__marker', 'aria-hidden': 'true' }, stop.icon),
    h(
      'div',
      { class: ['home-stop__card', current ? 'surface-dark' : ''] },
      current ? h('p', { class: 'home-stop__now' }, labels.now) : null,
      h('p', { class: 'home-stop__era' }, stop.era),
      h('h3', { class: 'home-stop__name' }, stop.name),
      h('p', { class: 'home-stop__plain' }, withKets(stop.plain)),
      timelineNote(current ? 'now' : 'gain', current ? '◆' : '✓', stop.gainedLabel || labels.gained, stop.gained),
      timelineNote(current ? 'change' : 'left', current ? '→' : '✕', stop.leftOutLabel || labels.leftOut, stop.leftOut),
    ),
  );
}

function renderTimeline(root, timeline) {
  root.replaceChildren(
    sectionHeading(timeline, 'timeline-title'),
    h('ol', { class: 'home-timeline' }, timeline.stops.map((stop) => renderStop(stop, timeline.labels))),
  );
}

/* ---------- 3. "What is quantum, in 30 seconds?" ---------- */
/** A bit and a qubit side by side, plus a button that "measures" the qubit. */
function createQubitVisual(text) {
  const knob = h('span', { class: 'home-switch__knob', 'data-state': 'blend' });
  const result = h('p', { class: 'home-visual__result', role: 'status' }, text.blendText);
  const button = h('button', { class: 'btn btn--light btn--sm home-visual__button', type: 'button' }, text.measureLabel);
  let measured = null;

  function update() {
    knob.dataset.state = measured === null ? 'blend' : String(measured);
    knob.textContent = measured === null ? '' : String(measured);
    result.textContent = measured === null ? text.blendText : `${text.resultText.replace('{n}', measured)} ${text.resultHint}`;
    button.textContent = measured === null ? text.measureLabel : text.againLabel;
  }

  button.addEventListener('click', () => {
    measured = measured === null ? (Math.random() < 0.5 ? 0 : 1) : null;
    update();
  });

  const ends = () => [h('span', { class: 'home-switch__end' }, '0'), h('span', { class: 'home-switch__end' }, '1')];
  const bitKnob = h('span', { class: 'home-switch__knob home-switch__knob--bit' });

  return h(
    'div',
    { class: 'home-visual' },
    h(
      'div',
      { class: 'home-visual__panels' },
      h(
        'div',
        { class: 'home-visual__panel' },
        h('p', { class: 'home-visual__title' }, text.bitTitle),
        h('span', { class: 'home-switch home-switch--bit', 'aria-hidden': 'true' }, ends(), bitKnob),
        h('p', { class: 'home-visual__caption' }, text.bitCaption),
      ),
      h(
        'div',
        { class: 'home-visual__panel home-visual__panel--qubit' },
        h('p', { class: 'home-visual__title' }, text.qubitTitle),
        h('span', { class: 'home-switch home-switch--qubit', 'aria-hidden': 'true' }, ends(), knob),
        h('p', { class: 'home-visual__caption' }, text.qubitCaption),
      ),
    ),
    h('div', { class: 'home-visual__controls' }, button, result),
  );
}

function renderExplainer(root, explainer) {
  root.replaceChildren(
    h(
      'div',
      { class: 'home-explainer' },
      h(
        'div',
        { class: 'home-explainer__text' },
        sectionHeading(explainer, 'explainer-title'),
        h(
          'ol',
          { class: 'home-steps' },
          explainer.steps.map((step) =>
            h('li', { class: 'home-steps__item' }, h('h3', { class: 'home-steps__title' }, step.title), h('p', null, withKets(step.text))),
          ),
        ),
        h('div', { class: 'callout home-not' }, h('p', { class: 'callout__title' }, icon('✕'), ' ', explainer.notLabel), h('p', null, withKets(explainer.notText))),
      ),
      createQubitVisual(explainer.visual),
    ),
  );
}

/* ---------- 4. Why Chicago, why now ---------- */
function renderWhy(root, why) {
  root.replaceChildren(
    sectionHeading(why, 'why-title'),
    h(
      'ul',
      { class: 'home-facts' },
      why.facts.map((fact) => h('li', { class: 'home-fact' }, h('span', { class: 'home-fact__value' }, fact.value), h('span', { class: 'home-fact__text' }, withKets(fact.text)))),
    ),
    h('p', { class: 'home-why__note' }, withKets(why.jobsNote)),
  );
}

/* ---------- 5. Call-to-action cards ---------- */
function renderCta(root, cta) {
  const cards = cta.cards.map((card) =>
    createCard({
      icon: card.icon,
      eyebrow: card.eyebrow,
      title: card.title,
      body: card.text,
      href: siteUrl(card.href),
      actions: [h('span', { class: 'home-cta__go', 'aria-hidden': 'true' }, `${card.goLabel} →`)],
      className: 'home-cta',
    }),
  );
  root.replaceChildren(sectionHeading(cta, 'cta-title'), h('div', { class: 'grid grid--3' }, cards));
}

/* ---------- 6. Your progress ---------- */
function statTile(label, value, { wide = false, children = [] } = {}) {
  const earned = typeof value === 'number' ? value > 0 : true;
  return h(
    'li',
    { class: ['stat', 'home-stat', earned ? 'home-stat--earned' : '', wide ? 'home-stat--wide' : ''] },
    earned ? h('span', { class: 'home-stat__check', 'aria-hidden': 'true' }, '✓') : null,
    h('p', { class: 'stat__value' }, value),
    h('p', { class: 'stat__label' }, label),
    children,
  );
}

function confidenceMessage(confidence, labels) {
  if (confidence.after > confidence.before) return labels.confidenceMore;
  if (confidence.after === confidence.before) return labels.confidenceSame;
  return labels.confidenceLess;
}

/** What the panel looked like last time, so an unchanged panel is left alone (keeps keyboard focus and screen readers calm). */
let lastStatsSignature = '';

function renderStats(container, labels) {
  const summary = getProgressSummary();
  const signature = JSON.stringify(summary);
  if (signature === lastStatsSignature && container.hasChildNodes()) return false;
  lastStatsSignature = signature;
  const hadFocus = container.contains(document.activeElement);
  const { confidence } = summary;
  const hasConfidence = confidence.before !== null && confidence.after !== null;
  const isEmpty = !summary.topicsCompleted && !summary.quizzesPassed && !summary.gamesPlayed && !summary.streak && !hasConfidence;

  if (isEmpty) {
    container.replaceChildren(
      h(
        'div',
        { class: 'home-empty' },
        icon('🌱', 'home-empty__icon'),
        h('p', { class: 'home-empty__title' }, labels.emptyTitle),
        h('p', null, labels.emptyText),
        h('a', { class: 'btn btn--primary', href: siteUrl(labels.emptyCta.href) }, labels.emptyCta.label),
      ),
    );
    if (hadFocus) container.focus({ preventScroll: true });
    return true;
  }

  const { topicsCompleted, totalTopics } = summary;
  const percent = totalTopics ? Math.round((topicsCompleted / totalTopics) * 100) : 0;
  const topicsTile = statTile(
    labels.topicsLabel,
    h('span', null, String(topicsCompleted), h('span', { class: 'home-stat__of' }, ` ${labels.topicsOf} ${totalTopics}`)),
    {
      wide: true,
      children: [
        h(
          'div',
          { class: 'progress home-stat__bar', role: 'progressbar', 'aria-label': labels.topicsLabel, 'aria-valuemin': '0', 'aria-valuemax': String(totalTopics), 'aria-valuenow': String(topicsCompleted) },
          h('div', { class: 'progress__bar', style: { width: `${percent}%` } }),
        ),
        topicsCompleted === totalTopics ? h('p', { class: 'home-stat__praise' }, labels.topicsAllDone) : null,
      ],
    },
  );

  const tiles = [
    topicsTile,
    statTile(labels.quizzesLabel, summary.quizzesPassed, { children: summary.quizzesPassed ? [] : [h('p', { class: 'home-stat__hint' }, labels.notYet)] }),
    statTile(labels.gamesLabel, summary.gamesPlayed, { children: summary.gamesPlayed ? [] : [h('p', { class: 'home-stat__hint' }, labels.notYet)] }),
    statTile(labels.streakLabel, summary.streak, { children: summary.streak ? [] : [h('p', { class: 'home-stat__hint' }, labels.notYet)] }),
  ];

  if (hasConfidence) {
    tiles.push(
      statTile(
        labels.confidenceLabel,
        h('span', null, h('span', { 'aria-hidden': 'true' }, `${confidence.before} → ${confidence.after}`), h('span', { class: 'visually-hidden' }, `from ${confidence.before} to ${confidence.after}`)),
        { wide: true, children: [h('p', { class: 'home-stat__hint' }, `${labels.confidenceScale}. ${confidenceMessage(confidence, labels)}`)] },
      ),
    );
  }
  container.replaceChildren(h('ul', { class: 'home-stats' }, tiles));
  if (hadFocus) container.focus({ preventScroll: true }); // the focused link was replaced: keep focus on this panel
  return true;
}

/** Wording that depends on the mode. Account wording comes from data/home.json (…Account keys); guest wording is the fallback. */
function noteFor(labels, guestKey, accountKey) {
  return getMode() === 'account' && labels[accountKey] ? labels[accountKey] : labels[guestKey];
}

/** The "Reset my progress" control with its two-step, in-page confirmation (no pop-up). Returns { el, refreshText }. */
function createResetControl(labels, onReset) {
  const done = h('p', { class: 'home-reset__done', hidden: true }, labels.resetDone);
  const resetButton = h('button', { class: 'btn btn--ghost btn--sm', type: 'button', 'aria-expanded': 'false', 'aria-controls': 'home-reset-confirm' }, labels.resetLabel);
  const keepButton = h('button', { class: 'btn btn--secondary btn--sm', type: 'button' }, labels.resetCancel);
  const eraseButton = h('button', { class: 'btn btn--sm home-reset__erase', type: 'button' }, labels.resetConfirm);
  const warning = h('p', null, noteFor(labels, 'resetWarning', 'resetWarningAccount'));
  const confirmBox = h(
    'div',
    { class: 'home-reset__confirm', id: 'home-reset-confirm', role: 'group', 'aria-label': labels.resetLabel, hidden: true },
    warning,
    h('div', { class: 'cluster' }, eraseButton, keepButton),
  );

  function setConfirming(open) {
    confirmBox.hidden = !open;
    resetButton.hidden = open;
    resetButton.setAttribute('aria-expanded', String(open));
    done.hidden = true;
    (open ? keepButton : resetButton).focus();
  }

  resetButton.addEventListener('click', () => setConfirming(true));
  keepButton.addEventListener('click', () => setConfirming(false));
  confirmBox.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') setConfirming(false);
  });
  eraseButton.addEventListener('click', () => {
    resetProgress();
    onReset();
    setConfirming(false);
    done.hidden = false;
    announce(labels.resetDone);
  });

  return {
    el: h('div', { class: 'home-reset' }, resetButton, confirmBox, done),
    refreshText: () => {
      warning.textContent = noteFor(labels, 'resetWarning', 'resetWarningAccount');
    },
  };
}

let stopListening = null;

function renderProgress(root, labels) {
  const statsBox = h('div', { class: 'home-progress__stats', tabindex: '-1' });
  const savedText = () => (isPersistent() ? noteFor(labels, 'savedNote', 'savedNoteAccount') : labels.notSavedNote);
  const savedNote = h('p', { class: 'home-progress__saved' }, icon('💾'), ' ', savedText());
  const reset = createResetControl(labels, () => renderStats(statsBox, labels));
  renderStats(statsBox, labels);

  root.replaceChildren(
    sectionHeading(labels, 'progress-title'),
    h('div', { class: 'home-progress' }, statsBox, h('div', { class: 'home-progress__footer' }, savedNote, reset.el)),
  );

  /** Redraw after a change. Panels that look the same are left alone, so keyboard focus stays put. */
  function refresh(kind) {
    savedNote.replaceChildren(icon('💾'), ' ', savedText());
    reset.refreshText();
    if (renderStats(statsBox, labels) && kind === 'remote') announce('Your saved progress was updated from your account.');
  }

  // The store tells us about changes made by another tab, by an account finishing its sync, or by signing in or out.
  stopListening?.();
  stopListening = subscribe(refresh);
  // The back/forward cache brings back an old copy of the page, and the day may have changed.
  window.addEventListener('pageshow', () => refresh());
}

/* ---------- 7. Sources ---------- */
function renderSources(root, sources) {
  const groups = sources.groups.map((group) =>
    h(
      'div',
      { class: 'home-sources__group' },
      h('p', { class: 'home-sources__topic' }, group.topic),
      h('ul', null, group.items.map((item) => h('li', null, externalLink(item.url, item.title), h('span', { class: 'text-muted' }, ` · ${item.publisher}`)))),
    ),
  );
  root.replaceChildren(
    h(
      'details',
      { class: 'home-sources' },
      h('summary', { id: 'sources-summary' }, sources.summary),
      h('div', { class: 'home-sources__body' }, h('p', { class: 'text-muted' }, `${sources.intro} ${formatDate(sources.lastVerified)}.`), groups),
    ),
  );
}

/* ---------- Start-up ---------- */
const SECTIONS = $$('main > section');

function showFailure(error) {
  const heroSlot = slot('hero');
  heroSlot.removeAttribute('aria-busy');
  showDataError(heroSlot, { error, onRetry: init });
  heroSlot.prepend(h('h1', { id: 'hero-title', class: 'home-hero__title' }, SITE.name));
  SECTIONS.slice(1).forEach((section) => {
    section.hidden = true;
  });
}

function render(data) {
  const meta = $('meta[name="description"]');
  if (meta) meta.content = data.meta.description;
  SECTIONS.forEach((section) => {
    section.hidden = false;
  });
  renderHero(slot('hero'), data.hero);
  renderTimeline(slot('timeline'), data.timeline);
  renderExplainer(slot('explainer'), data.explainer);
  renderWhy(slot('why'), data.whyNow);
  renderCta(slot('cta'), data.cta);
  renderProgress(slot('progress'), data.progress);
  renderSources(slot('sources'), data.sources);
  $$('[data-slot]').forEach((el) => el.removeAttribute('aria-busy'));
}

async function init() {
  try {
    render(await loadJSON('data/home.json'));
  } catch (error) {
    showFailure(error);
  }
}

init();
