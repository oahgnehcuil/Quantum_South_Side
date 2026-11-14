/* ==========================================================================
   card.js — ONE reusable card renderer for the whole site.
   Careers, News, Research and the Home page call createCard() instead of
   writing their own card HTML, so every card looks and behaves the same.

   Example:
     const card = createCard({
       title: 'Quantum technician',
       eyebrow: 'Hardware',
       body: 'Keeps the equipment running.',
       sections: [{ label: 'What this means for Chicago', content: 'More jobs nearby.' }],
       meta: ['Source name', 'Mar 5, 2026'],
       tags: ['Chicago', 'careers'],
       sample: true,                       // shows a yellow SAMPLE badge
       href: 'https://example.org',        // makes the title a link
       external: true,                     // opens the link in a new tab
       actions: [h('a', {class: 'btn btn--secondary btn--sm', href: '…'}, 'Read more')],
     });
     container.append(card);

   Everything is optional except `title`. Text is always inserted as TEXT, never as HTML.
   ========================================================================== */
import { h, withKets, isSafeUrl } from '../utils/dom.js';

/** Turn a string, Node, or array of those into card content (strings become paragraphs). */
function toContent(value) {
  if (value === null || value === undefined || value === false) return [];
  const list = Array.isArray(value) ? value : [value];
  return list
    .filter((item) => item !== null && item !== undefined && item !== false && item !== '')
    .map((item) => (item instanceof Node ? item : h('p', null, withKets(item))));
}

function renderTag(tag) {
  const { text, variant } = typeof tag === 'string' ? { text: tag, variant: '' } : tag;
  return h('span', { class: ['tag', variant ? `tag--${variant}` : ''] }, text);
}

/**
 * @param {object} options
 * @param {string} options.title
 * @param {number} [options.headingLevel=3]  2–6: keep headings in order on the page
 * @param {string} [options.href]            link target for the title
 * @param {boolean} [options.external]       true = open in a new tab
 * @param {boolean} [options.linkCard]       true = the WHOLE card is clickable (default: true when href is set)
 * @param {string} [options.icon]            a decorative emoji above the title
 * @param {string} [options.eyebrow]         small label above the title
 * @param {Array<{text:string, variant?:string}>} [options.badges]  strong labels, e.g. SAMPLE
 * @param {boolean} [options.sample]         shortcut: adds a SAMPLE badge
 * @param {boolean} [options.verify]         shortcut: adds a "Needs verification" badge
 * @param {string|Node|Array} [options.body]
 * @param {Array<{label:string, content:string|Node|Array}>} [options.sections]
 * @param {string[]} [options.meta]          small gray facts (source, date, ...)
 * @param {Array<string|{text:string, variant?:string}>} [options.tags]
 * @param {Node[]} [options.actions]         buttons / links at the bottom
 * @param {string} [options.className]       extra classes
 * @returns {HTMLElement}
 */
export function createCard({
  title,
  headingLevel = 3,
  href,
  external = false,
  linkCard,
  icon,
  eyebrow,
  badges = [],
  sample = false,
  verify = false,
  body,
  sections = [],
  meta = [],
  tags = [],
  actions = [],
  className = '',
} = {}) {
  const level = Math.min(6, Math.max(2, Number(headingLevel) || 3));
  const hasLink = Boolean(href) && isSafeUrl(href);
  const wholeCardLink = hasLink && (linkCard === undefined ? true : linkCard);

  const allBadges = [...badges];
  if (sample) allBadges.unshift({ text: 'Sample data', variant: 'sample' });
  if (verify) allBadges.push({ text: 'Needs verification', variant: 'sample' });

  const titleContent = hasLink
    ? h(
        'a',
        { class: 'card__link', href, ...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {}) },
        title,
        external ? h('span', { class: 'visually-hidden' }, ' (opens in a new tab)') : null,
      )
    : title;

  const header = h(
    'div',
    { class: 'card__header' },
    icon ? h('span', { class: 'card__icon', 'aria-hidden': 'true' }, icon) : null,
    allBadges.length ? h('div', { class: 'card__badges' }, allBadges.map((b) => h('span', { class: `badge badge--${b.variant || 'sample'}` }, b.text))) : null,
    eyebrow ? h('p', { class: 'card__eyebrow' }, eyebrow) : null,
    h(`h${level}`, { class: 'card__title' }, titleContent),
  );

  const bodyNodes = toContent(body);
  const sectionNodes = sections
    .filter((s) => s && toContent(s.content).length)
    .map((s) => h('div', { class: 'card__section' }, h('p', { class: 'card__section-label' }, s.label), ...toContent(s.content)));

  return h(
    'article',
    { class: ['card', wholeCardLink ? 'card--link' : '', className] },
    header,
    meta.length ? h('p', { class: 'card__meta' }, meta.filter(Boolean).map((m) => h('span', null, m))) : null,
    bodyNodes.length || sectionNodes.length ? h('div', { class: 'card__body' }, bodyNodes, sectionNodes) : null,
    tags.length ? h('div', { class: 'card__tags' }, tags.map(renderTag)) : null,
    actions.length ? h('div', { class: 'card__actions' }, actions) : null,
  );
}
