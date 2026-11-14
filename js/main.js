/* ==========================================================================
   main.js — runs on EVERY page. It loads the shared pieces:
     • the navbar and footer
     • the page title (from <body data-page-title="...">)
     • the floating chatbot (when FEATURES.chatbot is true in config.js)

   Each HTML page includes this file with:  <script type="module" src="…/js/main.js"></script>
   and has these three things in its <body>:
     <body data-page="learn" data-page-title="Learn">
       <header id="site-header" class="site-header"></header>
       <main id="main"> … </main>
       <footer id="site-footer" class="site-footer"></footer>
   ========================================================================== */
import { SITE, FEATURES } from './config.js';
import { renderNavbar } from './components/navbar.js';
import { renderFooter } from './components/footer.js';

function init() {
  const { page = '', pageTitle = '' } = document.body.dataset;

  // "Learn · Quantum South Side"  (the home page uses the tagline instead)
  document.title = pageTitle ? `${pageTitle} · ${SITE.name}` : `${SITE.name} — ${SITE.tagline}`;
  document.documentElement.classList.add('js');

  renderNavbar(document.getElementById('site-header'), page);
  renderFooter(document.getElementById('site-footer'));

  // The chatbot is optional and loaded on demand, so the site still works if it's missing or fails.
  if (FEATURES.chatbot) {
    import('./components/chatbot.js')
      .then((module) => module.mountChatbot())
      .catch((error) => console.warn('Chatbot could not start:', error));
  }
}

// Module scripts run after the page is parsed, but stay safe either way.
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
