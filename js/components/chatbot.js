/* ==========================================================================
   chatbot.js — the floating "learning helper" chat on every page.

   Right now it runs in FAQ mode: it matches the question against the ready-made
   answers in data/chatbot-faq.json (see js/utils/faqMatch.js). Nothing is sent
   anywhere and nothing is saved, so closing the page erases the chat.

   The file is split into sections, top to bottom:
     1. Text and state   labels, and what we remember while the page is open
     2. Getting a reply  ONE small function: getReply(message). A different
                         answerer can be added later by changing only that function.
     3. Messages         drawing chat bubbles, links and "You might also ask"
     4. Panel            building the launcher + panel, opening, closing, clearing
     5. Start-up         mountChatbot(), called once by js/main.js

   To change the answers, starter questions or disclaimer, edit the JSON file.
   This file only holds button labels and short messages.
   ========================================================================== */
import { siteUrl } from '../config.js';
import { h, clear, paragraphs, externalLink, announce } from '../utils/dom.js';
import { loadJSON, showDataError } from '../utils/loadData.js';
import { findAnswer } from '../utils/faqMatch.js';

/* ==========================================================================
   1. Text and state
   ========================================================================== */
const FAQ_PATH = 'data/chatbot-faq.json';
const ROOT_ID = 'qss-chatbot';
const MAX_QUESTION_LENGTH = 300;

/** Below this confidence the answer starts with "I'm not sure". */
const LOW_CONFIDENCE = 0.45;

/** Shown until (or unless) the JSON file loads, so the safety wording is always on screen. */
const DEFAULT_LABELS = {
  disclaimer: "I'm a learning helper and can make mistakes. Don't share personal information.",
  modeLabel: 'FAQ mode',
  privacyNote: 'Your questions stay on this device in FAQ mode.',
};

const LEARN_LINK = { label: 'Browse the Learn page', href: 'pages/learn.html' };

/** faq: the loaded JSON (or null).  ui: the elements we need to update later. */
const state = { mounted: false, opened: false, faq: null, loading: null, loadError: null };
const ui = {};

/* ==========================================================================
   2. Getting a reply
   ========================================================================== */

/** Load (or reload) the FAQ file. Never throws: a failure is remembered in state.loadError. */
function loadFaq() {
  if (state.loading) return state.loading;
  state.loading = loadJSON(FAQ_PATH)
    .then((data) => {
      if (!data || !Array.isArray(data.entries) || data.entries.length === 0) throw new Error(`${FAQ_PATH} has no entries`);
      state.faq = data;
      state.loadError = null;
      showLabels(data);
    })
    .catch((error) => {
      state.faq = null;
      state.loadError = error;
    })
    .finally(() => {
      state.loading = null;
    });
  return state.loading;
}

/**
 * Get a reply for one message. The ONLY place that decides how the helper answers.
 * @param {string} message
 * @returns {Promise<{lead?: string, text: string, links: Array, suggestions: string[]}>}
 */
async function getReply(message) {
  if (!state.faq) await loadFaq();
  if (!state.faq) {
    return {
      text: "Sorry, my answers aren't available right now. You can still learn on the Learn page, and you can try me again in a little while.",
      links: [LEARN_LINK],
      suggestions: [],
    };
  }

  const { match, confidence, related } = findAnswer(message, state.faq.entries);
  if (!match) {
    return { text: state.faq.noMatch.text, links: [LEARN_LINK], suggestions: state.faq.noMatch.suggest };
  }
  return {
    lead: confidence < LOW_CONFIDENCE ? "I'm not completely sure, but this might help:" : '',
    text: match.answer,
    links: match.links,
    suggestions: related.map((entry) => entry.questions[0]),
  };
}

/* ==========================================================================
   3. Messages
   ========================================================================== */

/** Keep the newest message in view (or its top, if it is taller than the window). */
function scrollToNewest(message) {
  const { body } = ui;
  body.scrollTop = message.offsetHeight > body.clientHeight ? message.offsetTop - 8 : body.scrollHeight;
}

/** Add one chat bubble. role is 'bot' or 'user'. */
function addMessage(role, content) {
  const speaker = role === 'user' ? 'You said: ' : 'Helper says: ';
  const message = h(
    'div',
    { class: `chatbot__msg chatbot__msg--${role}` },
    h('span', { class: 'visually-hidden' }, speaker),
    h('div', { class: 'chatbot__bubble' }, content),
  );
  ui.log.append(message);
  scrollToNewest(message);
  return message;
}

/** A pill-shaped link: site pages stay in the tab, other websites open in a new one. */
function replyLink({ label, href }) {
  const className = 'chatbot__link';
  return /^https?:/i.test(href) ? externalLink(href, label, className) : h('a', { class: className, href: siteUrl(href) }, label);
}

/** A button that asks a question when pressed. */
function questionButton(question) {
  return h(
    'button',
    {
      class: 'chatbot__chip',
      type: 'button',
      onClick: () => {
        ask(question);
        focusStart();
      },
    },
    question,
  );
}

/** Turn a reply into the content of a bot bubble. */
function renderReply({ lead, text, links, suggestions }) {
  const pieces = [];
  if (lead) pieces.push(h('p', { class: 'chatbot__lead' }, lead));
  pieces.push(...paragraphs(text));
  if (links.length > 0) {
    pieces.push(h('ul', { class: 'chatbot__links' }, links.map((link) => h('li', null, replyLink(link)))));
  }
  if (suggestions.length > 0) {
    pieces.push(
      h(
        'div',
        { class: 'chatbot__more', role: 'group', 'aria-label': 'You might also ask' },
        h('p', { class: 'chatbot__more-label' }, 'You might also ask'),
        suggestions.map(questionButton),
      ),
    );
  }
  return pieces;
}

/** The starter questions under the greeting. */
function renderStarters(questions) {
  clear(ui.starters);
  if (questions.length === 0) return;
  ui.starters.append(
    h('p', { class: 'chatbot__more-label', id: 'chatbot-starters-label' }, 'Try asking'),
    h('div', { class: 'chatbot__chips', role: 'group', 'aria-labelledby': 'chatbot-starters-label' }, questions.map(questionButton)),
  );
}

/** Send a question: show it, get the reply, show that. */
async function ask(text) {
  const question = String(text).trim();
  if (!question) {
    announce('Please type a question first.');
    ui.input.focus();
    return;
  }
  clear(ui.starters);
  addMessage('user', question);
  ui.input.value = '';
  const reply = await getReply(question);
  addMessage('bot', renderReply(reply));
}

/* ==========================================================================
   4. Panel: building, opening, closing, clearing
   ========================================================================== */

/** Update the disclaimer, mode label and privacy line from the JSON file. */
function showLabels(data) {
  ui.mode.textContent = data.modeLabel || DEFAULT_LABELS.modeLabel;
  ui.disclaimer.textContent = data.disclaimer || DEFAULT_LABELS.disclaimer;
  ui.privacy.textContent = data.privacyNote || DEFAULT_LABELS.privacyNote;
}

/** Explain kindly that answers can't load, and offer to try again. */
function showLoadFailure() {
  clear(ui.starters);
  const box = h('div', { class: 'chatbot__error' });
  ui.log.append(box);
  showDataError(box, {
    error: state.loadError,
    title: "The helper can't answer right now",
    message: 'The answers did not load. Check your internet connection and try again, or learn the basics on the Learn page.',
    onRetry: async () => {
      await loadFaq();
      startConversation();
    },
  });
  box.append(h('p', { class: 'chatbot__error-link' }, replyLink(LEARN_LINK)));
}

/** Empty the chat and show the greeting and starter questions again. */
function startConversation() {
  clear(ui.log);
  clear(ui.starters);
  if (!state.faq) {
    showLoadFailure();
    return;
  }
  addMessage('bot', paragraphs(state.faq.greeting));
  renderStarters(state.faq.starters);
}

function clearChat() {
  startConversation();
  announce('Chat cleared.');
  focusStart();
}

/**
 * Put the cursor where it is most useful: in the box on computers, on the title on phones (so the
 * keyboard stays down) and on short windows (so the header and Close button never scroll out of view).
 */
function focusStart() {
  const shortWindow = window.matchMedia('(max-height: 32rem)').matches;
  if (!shortWindow && window.matchMedia('(pointer: fine)').matches) ui.input.focus({ preventScroll: true });
  else ui.title.focus();
}

async function openPanel() {
  ui.panel.hidden = false;
  ui.launcher.hidden = true;
  ui.launcher.setAttribute('aria-expanded', 'true');
  focusStart();
  if (!state.opened) {
    state.opened = true;
    ui.log.setAttribute('aria-busy', 'true');
    if (!state.faq) {
      ui.log.append(h('div', { class: 'chatbot__loading' }, h('div', { class: 'skeleton' }), h('div', { class: 'skeleton' })));
      await loadFaq();
    }
    ui.log.removeAttribute('aria-busy');
    startConversation();
  }
}

function closePanel() {
  ui.panel.hidden = true;
  ui.launcher.hidden = false;
  ui.launcher.setAttribute('aria-expanded', 'false');
  ui.launcher.focus();
}

/** A small speech-bubble drawing (decorative; the button has its own label). */
function chatIcon() {
  const svgNamespace = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNamespace, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.setAttribute('class', 'chatbot__launcher-icon');
  const shape = document.createElementNS(svgNamespace, 'path');
  shape.setAttribute('fill', 'currentColor');
  shape.setAttribute('d', 'M5 3h14a3 3 0 0 1 3 3v8a3 3 0 0 1-3 3h-7.2L6 21.5V17H5a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3z');
  svg.append(shape);
  return svg;
}

function buildHeader() {
  ui.title = h('h2', { class: 'chatbot__title', id: 'chatbot-title', tabindex: '-1' }, 'Learning helper');
  ui.mode = h('p', { class: 'chatbot__mode' }, DEFAULT_LABELS.modeLabel);
  return h(
    'div',
    { class: 'chatbot__header' },
    h('div', { class: 'chatbot__titles' }, ui.title, ui.mode),
    h(
      'div',
      { class: 'chatbot__actions' },
      h('button', { class: 'chatbot__action', type: 'button', onClick: clearChat }, 'Clear chat'),
      h('button', { class: 'chatbot__action', type: 'button', onClick: closePanel }, 'Close'),
    ),
  );
}

function buildForm() {
  ui.input = h('input', {
    class: 'chatbot__input',
    id: 'chatbot-input',
    type: 'text',
    name: 'question',
    maxlength: MAX_QUESTION_LENGTH,
    autocomplete: 'off',
    enterkeyhint: 'send',
  });
  return h(
    'form',
    {
      class: 'chatbot__form',
      onSubmit: (event) => {
        event.preventDefault();
        ask(ui.input.value);
      },
    },
    h('label', { class: 'chatbot__label', for: 'chatbot-input' }, 'Your question'),
    h('div', { class: 'chatbot__row' }, ui.input, h('button', { class: 'btn btn--primary chatbot__send', type: 'submit' }, 'Send')),
  );
}

function buildPanel() {
  ui.log = h('div', { class: 'chatbot__log', role: 'log', 'aria-live': 'polite', 'aria-label': 'Chat messages' });
  ui.starters = h('div', { class: 'chatbot__starters' });
  ui.body = h('div', { class: 'chatbot__body', role: 'region', 'aria-label': 'Conversation', tabindex: '0' }, ui.log, ui.starters);
  ui.disclaimer = h('p', { class: 'chatbot__disclaimer' }, DEFAULT_LABELS.disclaimer);
  ui.privacy = h('p', { class: 'chatbot__privacy' }, DEFAULT_LABELS.privacyNote);

  ui.panel = h(
    'section',
    { class: 'chatbot__panel', id: 'chatbot-panel', role: 'dialog', 'aria-modal': 'false', 'aria-labelledby': 'chatbot-title', hidden: true },
    buildHeader(),
    ui.disclaimer,
    ui.body,
    buildForm(),
    ui.privacy,
  );
  // Escape closes the chat when the cursor is inside it. Tab is never trapped.
  ui.panel.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closePanel();
  });
  return ui.panel;
}

function buildLauncher() {
  ui.launcher = h(
    'button',
    {
      class: 'chatbot__launcher',
      type: 'button',
      'aria-label': 'Open the learning helper chat',
      'aria-haspopup': 'dialog',
      'aria-expanded': 'false',
      'aria-controls': 'chatbot-panel',
      onClick: openPanel,
    },
    chatIcon(),
  );
  return ui.launcher;
}

/* ==========================================================================
   5. Start-up
   ========================================================================== */

/** Add the chat to the page. Safe to call more than once: it only mounts the first time. */
export function mountChatbot() {
  if (state.mounted || document.getElementById(ROOT_ID)) return;
  state.mounted = true;
  ui.root = h('div', { class: 'chatbot', id: ROOT_ID }, buildPanel(), buildLauncher());
  document.body.append(ui.root);
  document.body.classList.add('has-chatbot');
  loadFaq();
}
