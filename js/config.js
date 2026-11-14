/* ==========================================================================
   config.js — site-wide settings. If you only edit ONE code file, edit this one.

   • Change the project name       → SITE.name
   • Add/remove a page in the menu → NAV_LINKS (one line per page)
   • Add a Learn topic             → add its id to LEARN_TOPICS (and a JSON file in data/learn/)
   • Turn chatbot / AI mode on/off → FEATURES
   ========================================================================== */

/** The project name and text that appear in the navbar, footer and page titles. */
export const SITE = {
  name: 'Quantum South Side', // ← the project name: change it here and it updates everywhere
  tagline: "Chicago's quantum future should include every neighborhood.",
  hackathon: 'Black CS Success Summit Hackathon 2026',
  repoUrl: '', // optional: paste your GitHub repository link to show it in the footer
};

/**
 * Menu links, in the order they appear.
 *   id    → must match <body data-page="..."> on that page (used to highlight the current page)
 *   label → the text people see
 *   href  → path from the site root (the folder that contains index.html)
 */
export const NAV_LINKS = [
  { id: 'home', label: 'Home', href: 'index.html' },
  { id: 'learn', label: 'Learn', href: 'pages/learn.html' },
  { id: 'careers', label: 'Careers', href: 'pages/careers.html' },
  { id: 'news', label: 'News', href: 'pages/news.html' },
  { id: 'research', label: 'Research', href: 'pages/research.html' },
  { id: 'game', label: 'Daily Puzzle', href: 'pages/game.html' },
];

/** Feature flags: switch parts of the site on or off. */
export const FEATURES = {
  chatbot: true, // floating helper on every page (js/components/chatbot.js; FAQ mode, no key needed)
  aiChat: false, // OPTIONAL "AI mode" for the chatbot (needs a server-side function and an API key; keep false until that is set up)
  accounts: true, // optional accounts (email + password). Master switch: the log-in buttons still stay hidden until the server says Supabase is set up
  googleSignIn: false, // OPTIONAL "Continue with Google" button (also needs the Google provider switched on in Supabase)
};

/* ---- Optional accounts (Supabase Auth) ---- */

/** supabase-js is loaded from here, and ONLY when someone uses accounts (opens a log-in form, has a saved session, or follows an email link). */
export const SUPABASE_JS_URL = 'https://esm.sh/@supabase/supabase-js@2';

/** Where the browser asks which Supabase project to use. The URL and the public key are never written in the code. */
export const PUBLIC_CONFIG_PATH = 'api/public-config';

/** localStorage key for the sign-in session. It does NOT start with "qss:" on purpose, so "Reset my progress" can never sign anybody out. */
export const AUTH_STORAGE_KEY = 'qss-auth';

/** Account rules. Keep PASSWORD_MIN_LENGTH the same as "Minimum password length" in the Supabase dashboard. */
export const PASSWORD_MIN_LENGTH = 10;
export const NICKNAME_MIN = 2;
export const NICKNAME_MAX = 30;

/** Where the chatbot sends questions when FEATURES.aiChat is true. */
export const AI_CHAT_ENDPOINT = '/api/chat';

/**
 * Learn topics in teaching order. Each id needs a matching file: data/learn/<id>.json
 * (To add a topic: create the JSON file, then add its id here.)
 */
export const LEARN_TOPICS = ['intro', 'gates', 'computing', 'compilation', 'simulators', 'error-correction', 'algorithms'];

/** A quiz counts as "passed" when the learner gets at least this many questions right. */
export const QUIZ_PASS_SCORE = 2;

/** Wording for the labels that sit under every summary (News, Research). One place, so it stays consistent. */
export const AI_SUMMARY_LABEL = 'AI-generated summary — may contain mistakes. Read the original.';
export const SOURCE_EXCERPT_LABEL = "Short excerpt from the publisher's feed (not AI-written). Read the original.";

/** Prefix for everything we save in the browser (localStorage). Only non-personal progress is stored. */
export const STORAGE_PREFIX = 'qss:';

/* --------------------------------------------------------------------------
   Path helper — you normally don't need to touch this.
   Pages live in different folders (index.html vs pages/learn.html), so we work
   out the site root from where THIS file lives. That makes links and data paths
   work on localhost, GitHub Pages sub-folders and Netlify alike.
   -------------------------------------------------------------------------- */
export const ROOT_URL = new URL('../', import.meta.url);

/**
 * Turn a site-root-relative path ("data/careers.json") into a full URL string.
 * Safety: paths often come from JSON files. A path like "javascript:..." or
 * "https://other-site/" must never become a link, so anything that does not
 * stay on this site gives the site root instead. (Other websites: use externalLink().)
 */
export function siteUrl(path = '') {
  try {
    const url = new URL(path, ROOT_URL);
    const staysOnSite = url.protocol === ROOT_URL.protocol && url.host === ROOT_URL.host && url.origin === ROOT_URL.origin;
    return staysOnSite ? url.href : ROOT_URL.href;
  } catch {
    return ROOT_URL.href; // not a valid address at all
  }
}
