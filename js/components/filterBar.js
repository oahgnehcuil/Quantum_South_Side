/* ==========================================================================
   filterBar.js — one reusable "filters + search + sort" bar.
   Careers, News and Research all use it, so they look and behave the same.

   Example:
     const bar = createFilterBar({
       label: 'Filter stories',
       search: { label: 'Search stories', placeholder: 'Try "Argonne"' },
       groups: [{ id: 'tag', label: 'Topic', options: [{ value: 'all', label: 'All' }, { value: 'careers', label: 'Careers' }] }],
       sort: { label: 'Sort by', options: [{ value: 'date', label: 'Newest' }, { value: 'importance', label: 'Most important' }] },
       onChange: (state) => render(state),     // state = { groups: { tag: 'all' }, search: '', sort: 'date' }
     });
     container.append(bar.el);
     bar.setCount(shown, total, 'stories');    // updates the "Showing 3 of 12 stories" text

   • A group is a row of pills. Default: pick ONE (radio buttons) — include an "all" option yourself.
     Add  multiple: true  to let people pick several (checkboxes; an empty list means "no filter").
   • Everything is a real form control, so keyboard and screen readers work without extra code.
   ========================================================================== */
import { h } from '../utils/dom.js';

let barCount = 0;

/**
 * Word search used by Careers, News and Research: every word typed must appear somewhere in the text.
 * Word order does not matter, so "quantum chicago" and "chicago quantum" give the same results.
 * @param {string} text   everything a card says, joined together
 * @param {string} query  what the person typed
 */
export function matchesAllWords(text, query) {
  const haystack = String(text).toLowerCase();
  return String(query)
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => haystack.includes(word));
}

/**
 * @param {object} options
 * @param {string} [options.label]   accessible name of the whole bar
 * @param {Array<{id:string,label:string,options:Array<{value:string,label:string}>,multiple?:boolean,value?:string|string[]}>} [options.groups]
 * @param {{label:string,placeholder?:string}} [options.search]
 * @param {{label:string,options:Array<{value:string,label:string}>,value?:string}} [options.sort]
 * @param {(state:object)=>void} options.onChange
 */
export function createFilterBar({ label = 'Filter results', groups = [], search = null, sort = null, onChange = () => {} } = {}) {
  const uid = `fb${++barCount}`;
  const defaults = {};
  groups.forEach((g) => {
    defaults[g.id] = g.multiple ? [...(g.value || [])] : g.value ?? g.options[0]?.value ?? '';
  });
  const state = { groups: { ...defaults }, search: '', sort: sort ? sort.value ?? sort.options[0]?.value ?? '' : '' };

  const countText = h('p', { class: 'filter-bar__count', role: 'status', 'aria-live': 'polite' });
  const clearButton = h('button', { class: 'btn btn--ghost btn--sm', type: 'button', hidden: true }, 'Clear filters');

  /* ----- search box ----- */
  let searchInput = null;
  let searchBlock = null;
  if (search) {
    searchInput = h('input', {
      class: 'filter-bar__input',
      id: `${uid}-search`,
      type: 'search',
      autocomplete: 'off',
      placeholder: search.placeholder || '',
    });
    searchBlock = h('div', { class: 'filter-bar__field' }, h('label', { class: 'filter-bar__label', for: `${uid}-search` }, search.label), searchInput);
    let timer;
    searchInput.addEventListener('input', () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        state.search = searchInput.value.trim();
        changed();
      }, 150);
    });
  }

  /* ----- pill groups ----- */
  const groupBlocks = groups.map((group) => {
    const inputs = group.options.map((option, index) => {
      const input = h('input', {
        class: 'chip__input',
        type: group.multiple ? 'checkbox' : 'radio',
        name: `${uid}-${group.id}`,
        value: option.value,
        checked: group.multiple ? defaults[group.id].includes(option.value) : defaults[group.id] === option.value,
      });
      input.addEventListener('change', () => {
        if (group.multiple) state.groups[group.id] = inputs.filter((i) => i.checked).map((i) => i.value);
        else state.groups[group.id] = input.value;
        changed();
      });
      input.dataset.index = String(index);
      return input;
    });
    const chips = group.options.map((option, index) => h('label', { class: 'chip' }, inputs[index], h('span', { class: 'chip__text' }, option.label)));
    const block = h('fieldset', { class: 'filter-group' }, h('legend', { class: 'filter-bar__label' }, group.label), h('div', { class: 'filter-group__chips' }, chips));
    block.groupInputs = inputs;
    return block;
  });

  /* ----- sort menu ----- */
  let sortSelect = null;
  let sortBlock = null;
  if (sort) {
    sortSelect = h('select', { class: 'filter-bar__select', id: `${uid}-sort` }, sort.options.map((o) => h('option', { value: o.value, selected: o.value === state.sort }, o.label)));
    sortBlock = h('div', { class: 'filter-bar__field' }, h('label', { class: 'filter-bar__label', for: `${uid}-sort` }, sort.label), sortSelect);
    sortSelect.addEventListener('change', () => {
      state.sort = sortSelect.value;
      changed();
    });
  }

  /* ----- the pill groups sit in a "Filters" disclosure: collapsed on phones, always open on wide screens ----- */
  const activeBadge = h('span', { class: 'filter-bar__active', hidden: true });
  const groupsPanel = groupBlocks.length
    ? h(
        'details',
        { class: 'filter-bar__groups' },
        h('summary', { class: 'filter-bar__summary' }, h('span', null, 'Filters'), activeBadge),
        h('div', { class: 'filter-bar__groups-body' }, groupBlocks),
      )
    : null;

  const form = h(
    'form',
    { class: 'filter-bar', 'aria-label': label, novalidate: true },
    h('div', { class: 'filter-bar__top' }, searchBlock, sortBlock),
    groupsPanel,
    h('div', { class: 'filter-bar__footer' }, countText, clearButton),
  );
  form.addEventListener('submit', (event) => event.preventDefault());

  // From 900px up there is plenty of room: keep the groups open and hide the "Filters" button.
  const wide = window.matchMedia('(min-width: 900px)');
  function syncPanel() {
    if (!groupsPanel) return;
    groupsPanel.classList.toggle('is-static', wide.matches);
    if (wide.matches) groupsPanel.open = true;
  }
  syncPanel();
  wide.addEventListener('change', syncPanel);

  function isFiltered() {
    if (state.search) return true;
    return groups.some((g) => (g.multiple ? state.groups[g.id].length > 0 : state.groups[g.id] !== defaults[g.id]));
  }

  /** How many pills are switched on (shown next to "Filters" when the panel is collapsed). */
  function activeCount() {
    return groups.reduce((total, g) => {
      const value = state.groups[g.id];
      if (g.multiple) return total + value.length;
      return total + (value !== defaults[g.id] ? 1 : 0);
    }, 0);
  }

  function changed() {
    const active = activeCount();
    activeBadge.hidden = active === 0;
    activeBadge.textContent = `${active} selected`;
    clearButton.hidden = !isFiltered();
    onChange(getState());
  }

  function getState() {
    const copy = { groups: {}, search: state.search, sort: state.sort };
    for (const [id, value] of Object.entries(state.groups)) copy.groups[id] = Array.isArray(value) ? [...value] : value;
    return copy;
  }

  /** Put every control back to its starting value. */
  function reset() {
    state.groups = {};
    groups.forEach((g, i) => {
      state.groups[g.id] = g.multiple ? [...defaults[g.id]] : defaults[g.id];
      groupBlocks[i].groupInputs.forEach((input) => {
        input.checked = g.multiple ? defaults[g.id].includes(input.value) : input.value === defaults[g.id];
      });
    });
    state.search = '';
    if (searchInput) searchInput.value = '';
    changed();
  }

  /** Set one group's value from code (a string, or an array for multiple groups). */
  function setValue(groupId, value) {
    const i = groups.findIndex((g) => g.id === groupId);
    if (i < 0) return;
    const values = Array.isArray(value) ? value : [value];
    state.groups[groupId] = groups[i].multiple ? values : value;
    groupBlocks[i].groupInputs.forEach((input) => {
      input.checked = values.includes(input.value);
    });
    changed();
  }

  /** Update the "Showing 3 of 12 stories" line (read out politely to screen readers). */
  function setCount(shown, total, noun = 'results') {
    countText.textContent = shown === total ? `Showing all ${total} ${noun}` : `Showing ${shown} of ${total} ${noun}`;
  }

  /** Move keyboard focus to the search box (or, with no search box, the first control you can see). */
  function focus() {
    const target = searchInput || [...form.querySelectorAll('select, summary, input')].find((control) => control.offsetParent);
    target?.focus();
  }

  // The button hides itself when it runs, so hand focus to the search box first (keeps keyboard users in place).
  clearButton.addEventListener('click', () => {
    reset();
    focus();
  });

  return { el: form, getState, setCount, reset, setValue, focus };
}
