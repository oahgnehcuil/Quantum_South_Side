/* ==========================================================================
   qubitDemo.js — the one-qubit playground and the small "state view" it is built from.

   createStateView()  shows ONE quantum state: the big ket symbol, a compass dial
                      with an arrow, a bar of measurement chances and (optionally)
                      the amplitudes written out. The Collapse Challenge game uses it
                      for the Start, Target and Your state cards.
   createQubitDemo()  the playground: gate buttons, Reset, a "What just happened?"
                      sentence and the list of gates you pressed.

   All the quantum math comes from js/quantum/ (states are {numQubits, amplitudes}).
   This file keeps the plain-language words and draws things.
   Example:  container.append(createQubitDemo({ gates: ['X', 'H', 'Z'] }));
   ========================================================================== */
import { h, withKets, icon } from '../utils/dom.js';
import { createState, asState, probabilities } from '../quantum/state.js';
import { applyGate } from '../quantum/gates.js';
import { blochVector } from '../quantum/bloch.js';
import { formatKet, formatProbability, nameState } from '../quantum/format.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

/** The gates the playground offers by default, in display order. */
const DEFAULT_GATES = ['X', 'H', 'Z'];

/** Plain-language words for each gate: name, short caption (label) and one friendly sentence (plain). The game page reuses these. */
export const GATE_COPY = {
  X: { id: 'X', name: 'X gate', label: 'flip', plain: 'Flips 0 and 1, like the NOT gate on a regular bit.' },
  H: { id: 'H', name: 'H gate', label: 'blend', plain: 'Blends a plain 0 or 1 into an even mix of both, and turns a mix back into a plain 0 or 1.' },
  Z: { id: 'Z', name: 'Z gate', label: 'flip the sign', plain: 'Flips the hidden plus or minus sign, which changes a blend but not a plain 0.' },
  Y: { id: 'Y', name: 'Y gate', label: 'flip and twist', plain: 'Flips 0 and 1 like X, and adds a hidden twist that you cannot measure.' },
};

/** The named one-qubit states: ket text and a friendly name. The amplitudes are easy to type as text. */
const STATE_COPY = {
  zero: { ket: '|0⟩', plain: 'Plain 0', amplitudes: [1, 0] },
  one: { ket: '|1⟩', plain: 'Plain 1', amplitudes: [0, 1] },
  plus: { ket: '|+⟩', plain: 'Even blend, plus sign', amplitudes: ['1/√2', '1/√2'] },
  minus: { ket: '|−⟩', plain: 'Even blend, minus sign', amplitudes: ['1/√2', '-1/√2'] },
  plusI: { ket: '|+i⟩', plain: 'Even blend, quarter-turn twist', amplitudes: ['1/√2', 'i/√2'] },
  minusI: { ket: '|−i⟩', plain: 'Even blend, backward quarter-turn twist', amplitudes: ['1/√2', '-i/√2'] },
};

/** Turn a name ('zero', 'plus'...), a list of amplitudes, a bit string or a ready state into an engine state. */
function toState(value) {
  return asState(1, STATE_COPY[value]?.amplitudes ?? value);
}

/* Dial geometry (SVG units): a 300 x 250 picture with the circle in the middle (keep in sync with the CSS transform-origin). */
const WIDTH = 300;
const HEIGHT = 250;
const MID_X = WIDTH / 2;
const MID_Y = HEIGHT / 2;
const RADIUS = 78;
const DIAL_MARKS = [
  { id: 'zero', where: 'at the top', x: MID_X, y: 27, point: [MID_X, MID_Y - RADIUS] },
  { id: 'one', where: 'at the bottom', x: MID_X, y: 247, point: [MID_X, MID_Y + RADIUS] },
  { id: 'plus', where: 'on the right', x: 266, y: MID_Y + 10, point: [MID_X + RADIUS, MID_Y] },
  { id: 'minus', where: 'on the left', x: 34, y: MID_Y + 10, point: [MID_X - RADIUS, MID_Y] },
];

/* What just happened? One hand-written sentence for each of the 12 moves. */
const TRANSITIONS = {
  'zero:X': 'X flipped |0⟩ into |1⟩, just like a NOT gate. Measuring now always gives 1.',
  'zero:H': 'H turned |0⟩ into |+⟩, an even blend. Measuring now gives 0 or 1 with equal chance.',
  'zero:Z': 'Z left |0⟩ as it was. A plain 0 has no hidden sign to flip, so nothing seems to change. Measuring still always gives 0.',
  'one:X': 'X flipped |1⟩ back into |0⟩. Measuring now always gives 0.',
  'one:H': 'H turned |1⟩ into |−⟩, an even blend with a hidden minus sign. Measuring now gives 0 or 1 with equal chance.',
  'one:Z': 'Z flipped a sign on |1⟩, but a sign on the whole qubit cannot be seen or measured. You still have |1⟩, and measuring always gives 1.',
  'plus:X': 'X swapped the 0 part and the 1 part of |+⟩. They are equal, so you still have |+⟩. Measuring gives 0 or 1 with equal chance.',
  'plus:H': 'H turned |+⟩ back into |0⟩. Measuring now always gives 0.',
  'plus:Z': 'Z flipped the hidden sign, so |+⟩ became |−⟩. Measuring still gives 0 or 1 with equal chance, but look: the arrow swung to the other side.',
  'minus:X': 'X swapped the 0 part and the 1 part of |−⟩. That only flips a sign on the whole qubit, so you still have |−⟩. Measuring gives 0 or 1 with equal chance.',
  'minus:H': 'H turned |−⟩ into |1⟩. Measuring now always gives 1.',
  'minus:Z': 'Z flipped the hidden sign again, so |−⟩ became |+⟩. Measuring still gives 0 or 1 with equal chance.',
};

const PHASE_NOTE =
  'Good to know: |+⟩ and |−⟩ give identical measurement odds, but they are different states. The hidden sign does not show up when you measure, yet it changes what later gates do.';
const MAX_CHIPS = 10;

let idCounter = 0;
const nextId = (prefix) => {
  idCounter += 1;
  return `${prefix}-${idCounter}`;
};

/** Make an SVG element (h() only makes HTML elements). */
function svg(tag, attributes = {}, ...children) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attributes)) el.setAttribute(key, String(value));
  el.append(...children.flat());
  return el;
}

/** Rewrite ket symbols as words so screen readers say "ket plus" instead of reading symbols. */
function spoken(text) {
  const words = { '+': 'plus', '−': 'minus' };
  return text.replace(/\|([^|⟩\s]{1,3})⟩/g, (_, inside) => `ket ${words[inside] ?? inside}`);
}

/** Say amplitudes in words: "1/√2|0⟩ − 1/√2|1⟩" becomes "1 over root 2 ket 0 minus 1 over root 2 ket 1". */
function spokenAmplitudes(text) {
  return text
    .replace(/\|([01]+)⟩/g, ' ket $1 ')
    .replace(/√/g, 'root ')
    .replace(/\//g, ' over ')
    .replace(/−/g, ' minus ')
    .replace(/\+/g, ' plus ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Everything a view needs to know about a state: its name (when it has one), ket text, friendly
 * name, whole-number percents for one qubit, and the "If you measure" sentence.
 */
function describeState(state) {
  const numQubits = state.numQubits;
  const chances = probabilities(state);
  const named = numQubits === 1 ? nameState(state) : null;
  const copy = named ? STATE_COPY[named.id] : null;
  const amplitudes = formatKet(state);
  const info = {
    id: named?.id ?? null,
    key: named?.id ?? amplitudes,
    ket: copy?.ket ?? '|ψ⟩',
    plain: copy?.plain ?? (numQubits === 1 ? 'A custom blend of 0 and 1' : `A blend of ${2 ** numQubits} outcomes`),
    amplitudes,
    percent0: Math.round(chances[0] * 100),
    percent1: 0,
    odds: '',
  };
  info.percent1 = 100 - info.percent0;
  if (numQubits === 1) {
    info.odds = `If you measure: ${info.percent0}% chance of 0, ${info.percent1}% chance of 1`;
  } else {
    const parts = chances
      .map((p, index) => ({ p, label: index.toString(2).padStart(numQubits, '0') }))
      .filter(({ p }) => p > 1e-9)
      .map(({ p, label }) => `${formatProbability(p)} chance of ${label}`);
    info.odds = `If you measure: ${parts.join(', ')}`;
  }
  return info;
}

/** Restart a one-shot CSS animation class on an element. */
function replay(el, className) {
  el.classList.remove(className);
  void el.offsetWidth;
  el.classList.add(className);
}

/* ---------- The compass dial ---------- */
function createDial() {
  const marks = DIAL_MARKS.map((mark) => {
    const [cx, cy] = mark.point;
    return {
      ...mark,
      dot: svg('circle', { class: 'qubit-dial__dot', cx, cy, r: 6 }),
      label: svg('text', { class: 'qubit-dial__label ket', x: mark.x, y: mark.y, 'text-anchor': 'middle' }, STATE_COPY[mark.id].ket),
    };
  });
  const arrow = svg(
    'g',
    { class: 'qubit-dial__arrow' },
    svg('line', { x1: MID_X, y1: MID_Y, x2: MID_X, y2: MID_Y - RADIUS + 18 }),
    svg('polygon', { points: `${MID_X},${MID_Y - RADIUS - 2} ${MID_X - 9},${MID_Y - RADIUS + 22} ${MID_X + 9},${MID_Y - RADIUS + 22}` }),
    svg('circle', { class: 'qubit-dial__hub', cx: MID_X, cy: MID_Y, r: 7 }),
  );
  const picture = svg(
    'svg',
    { class: 'qubit-dial__svg', viewBox: `0 0 ${WIDTH} ${HEIGHT}`, role: 'img', focusable: 'false' },
    svg('circle', { class: 'qubit-dial__ring', cx: MID_X, cy: MID_Y, r: RADIUS }),
    svg('line', { class: 'qubit-dial__axis', x1: MID_X, y1: MID_Y - RADIUS, x2: MID_X, y2: MID_Y + RADIUS }),
    svg('line', { class: 'qubit-dial__axis', x1: MID_X - RADIUS, y1: MID_Y, x2: MID_X + RADIUS, y2: MID_Y }),
    marks.map((mark) => mark.dot),
    arrow,
    marks.map((mark) => mark.label),
  );
  const el = h('div', { class: 'qubit-dial' }, picture);

  let angle = 0;
  /** Point the arrow at a Bloch vector, turning the short way round. */
  function point(bloch, instant) {
    const target = Math.round((Math.atan2(bloch.x, bloch.z) * 180 * 1e6) / Math.PI) / 1e6;
    let turn = ((((target - angle) % 360) + 540) % 360) - 180;
    if (Math.abs(turn) > 179.999) turn = 180;
    angle += turn;
    el.classList.toggle('is-instant', instant);
    arrow.style.transform = `rotate(${angle}deg)`;
    if (instant) {
      void arrow.getBoundingClientRect();
      el.classList.remove('is-instant');
    }
  }

  /** Light up the matching mark and describe the arrow for screen readers. */
  function describe(id, instant, bloch) {
    point(bloch, instant);
    marks.forEach((mark) => {
      mark.dot.classList.toggle('is-active', mark.id === id);
      mark.label.classList.toggle('is-active', mark.id === id);
    });
    const mark = marks.find((m) => m.id === id);
    picture.setAttribute(
      'aria-label',
      mark ? `Dial. The arrow points to ${spoken(STATE_COPY[id].ket)}, ${mark.where}.` : 'Dial. The arrow points between the marks.',
    );
  }

  return { el, describe };
}

/* ---------- The measurement bar ---------- */
function createBar() {
  const label0 = h('span', { class: 'qubit-bar__label' });
  const label1 = h('span', { class: 'qubit-bar__label' });
  const seg0 = h('span', { class: 'qubit-bar__seg qubit-bar__seg--zero' }, label0);
  const seg1 = h('span', { class: 'qubit-bar__seg qubit-bar__seg--one' }, label1);
  const el = h('div', { class: 'qubit-bar', 'aria-hidden': 'true' }, seg0, seg1);

  /** Set both parts from whole-number percents. */
  function set(info, instant) {
    el.classList.toggle('is-instant', instant);
    seg0.style.width = `${info.percent0}%`;
    seg1.style.width = `${info.percent1}%`;
    label0.textContent = `0 · ${info.percent0}%`;
    label1.textContent = `1 · ${info.percent1}%`;
    if (instant) {
      void el.getBoundingClientRect();
      el.classList.remove('is-instant');
    }
  }
  return { el, set };
}

/**
 * A card that shows ONE quantum state: big ket, plain name, compass dial and measurement bar.
 * showAmplitudes:true adds a line under the ket with the amplitudes, like 1/√2|0⟩ − 1/√2|1⟩.
 * live:false switches off the screen-reader announcement (for parents that announce things themselves).
 * Dial and bar are for one qubit: a bigger state shows its ket, amplitudes and odds as text only.
 */
export function createStateView({ title = '', showBar = true, showDial = true, showAmplitudes = false, size = 'md', live = true } = {}) {
  const titleId = nextId('qubit-view-title');
  const titleEl = h('p', { class: 'qubit-view__title', id: titleId });
  const ketEl = h('p', { class: 'qubit-view__ket ket' });
  const ampsText = h('span', { class: 'qubit-view__amps-text ket', 'aria-hidden': 'true' });
  const ampsSpoken = h('span', { class: 'visually-hidden' });
  const ampsEl = showAmplitudes
    ? h('p', { class: 'qubit-view__amps' }, h('span', { class: 'qubit-view__amps-label' }, 'Amplitudes'), ampsText, ampsSpoken)
    : null;
  const nameEl = h('p', { class: 'qubit-view__name' });
  const dial = showDial ? createDial() : null;
  const bar = showBar ? createBar() : null;
  const oddsEl = showBar ? h('p', { class: 'qubit-view__odds' }) : null;
  const liveEl = live ? h('p', { class: 'visually-hidden', 'aria-live': 'polite', 'aria-atomic': 'true' }) : null;

  const el = h(
    'div',
    { class: ['qubit-view', `qubit-view--${size === 'sm' ? 'sm' : 'md'}`, showDial ? '' : 'qubit-view--no-dial'] },
    titleEl,
    h('div', { class: 'qubit-view__main' }, dial?.el, h('div', { class: 'qubit-view__readout' }, ketEl, ampsEl, nameEl)),
    showBar ? h('div', { class: 'qubit-view__measure' }, bar.el, oddsEl) : null,
    liveEl,
  );

  /** Change the small heading above the state; an empty title hides it. */
  function setTitle(text) {
    titleEl.textContent = text;
    titleEl.hidden = !text;
    if (text) {
      el.setAttribute('role', 'group');
      el.setAttribute('aria-labelledby', titleId);
    } else {
      el.removeAttribute('role');
      el.removeAttribute('aria-labelledby');
    }
  }

  let shownKey = null;
  let shownPercent = null;
  let hasUpdated = false;

  function render(state, animate, speak) {
    const info = describeState(state);
    const instant = !animate;
    const oneQubit = state.numQubits === 1;
    ketEl.textContent = info.ket;
    nameEl.textContent = info.plain;
    if (ampsEl) {
      ampsText.textContent = info.amplitudes;
      ampsSpoken.textContent = ` ${spokenAmplitudes(info.amplitudes)}`;
    }
    if (dial) {
      dial.el.hidden = !oneQubit;
      if (oneQubit) dial.describe(info.id, instant, blochVector(state));
    }
    if (bar) {
      bar.el.hidden = !oneQubit;
      if (oneQubit) bar.set(info, instant);
      oddsEl.textContent = info.odds;
    }
    if (animate && info.key !== shownKey) replay(ketEl, 'is-changed');
    if (speak && liveEl && (info.key !== shownKey || info.percent0 !== shownPercent)) {
      const heading = titleEl.textContent ? `${titleEl.textContent}: ` : '';
      const parts = [`${heading}${spoken(info.ket)}, ${info.plain.toLowerCase()}.`];
      if (showAmplitudes) parts.push(`Amplitudes: ${spokenAmplitudes(info.amplitudes)}.`);
      if (showBar) parts.push(`${info.odds}.`);
      liveEl.textContent = parts.join(' ');
    }
    shownKey = info.key;
    shownPercent = info.percent0;
  }

  /** Show a new state (an engine state, or a name like 'plus'). animate:false jumps straight there quietly (no turning, no announcement). */
  function update(state, { animate = true } = {}) {
    render(typeof state === 'string' ? toState(state) : state, animate, animate && hasUpdated);
    hasUpdated = true;
  }

  setTitle(title);
  render(createState(1), false, false);
  return { el, update, setTitle };
}

/* ---------- The playground ---------- */

/** The aria-label for a gate button. It starts with the visible text ("X flip") so voice control works, e.g. "X flip. Apply the X gate: flips 0 and 1, like ...". */
function gateAriaLabel(gate) {
  const plain = gate.plain.replace(/\.$/, '');
  return `${gate.id} ${gate.label}. Apply the ${gate.name}: ${plain.charAt(0).toLowerCase()}${plain.slice(1)}`;
}

/** The sentence under the gate buttons after a gate is pressed. */
function explainMove(beforeId, gate, after) {
  const known = TRANSITIONS[`${beforeId}:${gate.id}`];
  if (known) return known;
  const info = describeState(after);
  return `${gate.name} changed your qubit to ${info.ket}. ${info.odds}.`;
}

/** The sentence shown at the start and after Reset. */
function explainStart(state, afterReset) {
  const info = describeState(state);
  const lead = afterReset ? `Back to the start: ${info.ket}.` : `Your qubit starts in ${info.ket}.`;
  return `${lead} ${info.odds}. Press a gate to see what it does.`;
}

/**
 * The playground: one qubit, a button for each gate, Reset, a "What just happened?" sentence and a gate history.
 * start can be 'zero', 'one', 'plus', 'minus' or any one-qubit state.
 * onChange(state, history) runs after every gate press and every Reset (state is an engine state).
 */
export function createQubitDemo({ gates = DEFAULT_GATES, start = 'zero', showHistory = true, onChange } = {}) {
  const gatesLabelId = nextId('qubit-gates-label');
  const gateList = gates.map((id) => GATE_COPY[id]).filter(Boolean);
  const startState = toState(start);
  let state = startState;
  let history = [];

  const view = createStateView({ title: 'Your qubit', live: false });
  const whatText = h('p', { class: 'qubit-demo__what-text' });
  const whatBox = h('div', { class: 'qubit-demo__what' }, h('p', { class: 'qubit-demo__label' }, 'What just happened?'), whatText);
  const liveEl = h('p', { class: 'visually-hidden', 'aria-live': 'polite', 'aria-atomic': 'true' });
  const historyList = showHistory ? h('ol', { class: 'qubit-history', 'aria-label': 'Your steps, in order' }) : null;
  const note = h('p', { class: 'qubit-demo__note' }, icon('💡', 'qubit-demo__note-icon'), h('span', null, withKets(PHASE_NOTE)));

  function renderHistory() {
    if (!historyList) return;
    const hidden = Math.max(0, history.length - MAX_CHIPS);
    const shown = history.slice(hidden);
    const chip = (content, extra = '') => h('li', { class: 'qubit-history__item' }, h('span', { class: ['qubit-chip', extra] }, content));
    const items = [chip(['Start ', withKets(describeState(startState).ket)])];
    if (hidden) items.push(chip(`… ${hidden} earlier`, 'qubit-chip--more'));
    shown.forEach((id, index) => items.push(chip(id, index === shown.length - 1 ? 'qubit-chip--latest' : '')));
    historyList.replaceChildren(...items);
  }

  function show(sentence) {
    view.update(state);
    whatText.replaceChildren(withKets(sentence));
    replay(whatBox, 'is-fresh');
    liveEl.textContent = spoken(sentence);
    note.classList.toggle('is-highlighted', ['plus', 'minus'].includes(describeState(state).id));
    renderHistory();
  }

  function press(gate) {
    const before = describeState(state).id;
    state = applyGate(state, gate.id, { target: 0 });
    history = [...history, gate.id];
    show(explainMove(before, gate, state));
    onChange?.(state, [...history]);
  }

  function reset() {
    state = startState;
    history = [];
    show(explainStart(state, true));
    onChange?.(state, []);
  }

  const gateButtons = gateList.map((gate) =>
    h(
      'button',
      { type: 'button', class: 'qubit-gate', 'aria-label': gateAriaLabel(gate), dataset: { gate: gate.id }, onClick: () => press(gate) },
      h('span', { class: 'qubit-gate__letter' }, gate.id),
      ' ',
      h('span', { class: 'qubit-gate__caption' }, gate.label),
    ),
  );

  const el = h(
    'div',
    { class: 'qubit-demo', role: 'group', 'aria-label': 'Qubit playground' },
    h(
      'div',
      { class: 'qubit-demo__layout' },
      view.el,
      h(
        'div',
        { class: 'qubit-demo__panel' },
        h(
          'div',
          { class: 'qubit-demo__controls' },
          h(
            'div',
            { class: 'qubit-demo__controls-head' },
            h('p', { class: 'qubit-demo__label', id: gatesLabelId }, 'Press a gate'),
            h('button', { type: 'button', class: 'btn btn--outline-light qubit-demo__reset', onClick: reset }, 'Reset'),
          ),
          h('div', { class: 'qubit-demo__gates', role: 'group', 'aria-labelledby': gatesLabelId }, gateButtons),
        ),
        whatBox,
        showHistory ? h('div', { class: 'qubit-demo__history' }, h('p', { class: 'qubit-demo__label' }, 'Your steps'), historyList) : null,
        note,
      ),
    ),
    liveEl,
  );

  whatText.replaceChildren(withKets(explainStart(state, false)));
  view.update(state, { animate: false });
  renderHistory();
  return el;
}
