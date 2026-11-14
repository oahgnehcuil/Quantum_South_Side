/* ==========================================================================
   navbar.js — builds the top menu bar on every page.
   Links come from NAV_LINKS in js/config.js; the current page is highlighted
   (aria-current="page"). On phones the links hide behind a menu button.
   Keyboard friendly: Escape closes the menu and returns focus to the button.
   ========================================================================== */
import { SITE, NAV_LINKS, siteUrl } from '../config.js';
import { h } from '../utils/dom.js';

/**
 * @param {HTMLElement} container   the <header id="site-header"> element
 * @param {string} currentPage      the page id (from <body data-page="...">)
 */
export function renderNavbar(container, currentPage) {
  if (!container) return;
  const menuId = 'site-nav';

  const brand = h(
    'a',
    { class: 'brand', href: siteUrl('index.html') },
    // alt="" because the site name right next to it already says everything
    h('img', { class: 'brand__logo', src: siteUrl('assets/images/logo.svg'), alt: '', width: 40, height: 40 }),
    h('span', { class: 'brand__name' }, SITE.name),
  );

  const toggle = h(
    'button',
    { class: 'nav-toggle', type: 'button', 'aria-label': 'Menu', 'aria-expanded': 'false', 'aria-controls': menuId },
    h('span', { class: 'nav-toggle__bars', 'aria-hidden': 'true' }),
  );

  const links = NAV_LINKS.map((link) =>
    h('li', null, h('a', { class: 'site-nav__link', href: siteUrl(link.href), 'aria-current': link.id === currentPage ? 'page' : null }, link.label)),
  );
  const nav = h('nav', { id: menuId, class: 'site-nav', 'aria-label': 'Main' }, h('ul', { class: 'site-nav__list' }, links));

  container.replaceChildren(h('div', { class: 'container site-header__inner' }, brand, toggle, nav));

  /* ----- open / close the mobile menu ----- */
  const isOpen = () => nav.dataset.open === 'true';
  function setOpen(open) {
    nav.dataset.open = String(open);
    toggle.setAttribute('aria-expanded', String(open));
  }
  setOpen(false);

  toggle.addEventListener('click', () => setOpen(!isOpen()));
  nav.addEventListener('click', (event) => {
    if (event.target.closest('a')) setOpen(false);
  });
  document.addEventListener('click', (event) => {
    if (isOpen() && !container.contains(event.target)) setOpen(false);
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && isOpen()) {
      setOpen(false);
      toggle.focus();
    }
  });
  // If the window grows to desktop size, reset the mobile menu state.
  window.matchMedia('(min-width: 900px)').addEventListener('change', (event) => {
    if (event.matches) setOpen(false);
  });
}
