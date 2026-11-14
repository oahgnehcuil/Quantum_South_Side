/* ==========================================================================
   footer.js — builds the footer on every page (site name, links, privacy note and a link to the Privacy page).
   Text comes from SITE and NAV_LINKS in js/config.js.
   ========================================================================== */
import { SITE, NAV_LINKS, siteUrl } from '../config.js';
import { h, externalLink, isSafeUrl } from '../utils/dom.js';

/** @param {HTMLElement} container the <footer id="site-footer"> element */
export function renderFooter(container) {
  if (!container) return;
  const year = new Date().getFullYear();

  const brand = h(
    'div',
    { class: 'stack', style: { '--stack-gap': 'var(--space-3)' } },
    h(
      'a',
      { class: 'site-footer__brand', href: siteUrl('index.html') },
      h('img', { src: siteUrl('assets/images/logo.svg'), alt: '', width: 36, height: 36 }),
      h('span', null, SITE.name),
    ),
    h('p', null, SITE.tagline),
    h('p', null, `Built for the ${SITE.hackathon}.`),
  );

  const explore = h(
    'div',
    null,
    h('h2', { class: 'site-footer__heading' }, 'Explore'),
    h('ul', { class: 'site-footer__links' }, NAV_LINKS.map((link) => h('li', null, h('a', { href: siteUrl(link.href) }, link.label)))),
  );

  const about = h(
    'div',
    { class: 'stack', style: { '--stack-gap': 'var(--space-3)' } },
    h('h2', { class: 'site-footer__heading' }, 'Your privacy'),
    h('p', null, 'No account needed. As a guest, your progress stays on this device. If this site offers accounts, they are optional and store only your email, a nickname and your progress. No ads, no tracking.'),
    h('p', null, h('a', { href: siteUrl('pages/privacy.html') }, 'Read our privacy page')),
    h('p', null, 'Career cards are examples, marked SAMPLE until our team verifies them. News and research summaries are written with AI and can contain mistakes, so read the original source.'),
    isSafeUrl(SITE.repoUrl) && SITE.repoUrl ? h('p', null, externalLink(SITE.repoUrl, 'View the code on GitHub')) : null,
  );

  container.replaceChildren(
    h(
      'div',
      { class: 'container' },
      h('div', { class: 'site-footer__grid' }, brand, explore, about),
      h('p', { class: 'site-footer__fine' }, `© ${year} ${SITE.name}. Open source under the MIT License.`),
    ),
  );
}
