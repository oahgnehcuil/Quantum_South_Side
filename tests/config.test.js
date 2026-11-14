/* ==========================================================================
   config.test.js — tests for siteUrl() in js/config.js.
   Links that come from JSON must never run code or leave the site.
   Run with: npm test   (or: node --test tests/config.test.js)
   ========================================================================== */

import test from 'node:test';
import assert from 'node:assert/strict';

import { siteUrl, ROOT_URL } from '../js/config.js';

test('siteUrl: normal site paths resolve under the site root', () => {
  assert.equal(siteUrl('pages/learn.html#gates'), `${ROOT_URL.href}pages/learn.html#gates`);
  assert.equal(siteUrl('index.html'), `${ROOT_URL.href}index.html`);
  assert.equal(siteUrl('data/careers.json'), `${ROOT_URL.href}data/careers.json`);
  assert.equal(siteUrl(''), ROOT_URL.href);
  assert.equal(siteUrl(), ROOT_URL.href);
});

test('siteUrl: scripts, data pages and other websites give the site root', () => {
  for (const bad of ['javascript:alert(1)', ' JavaScript:alert(1)', 'data:text/html,x', '//evil.example/x', 'https://evil.example/', 'HTTP://EVIL.EXAMPLE', 'ftp://evil.example/', 'https://']) {
    assert.equal(siteUrl(bad), ROOT_URL.href, `${bad} must not become a link`);
  }
});
