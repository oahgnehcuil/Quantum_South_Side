/* ==========================================================================
   faq.test.js — checks the chatbot's FAQ data and its keyword matching.
   Run it with:  npm test      (it uses Node's built-in test runner, nothing to install)

   What is checked:
     • every FAQ entry has the fields the chatbot needs, and ids are unique
     • every starter question and every entry's first example question finds its own entry
     • nonsense and off-topic questions return "no match" (the bot never invents answers)
     • odd input (empty, huge, emoji, not a string) never crashes
     • every link in the data points to a page that really exists (or is an https link)
     • facts that were fixed after review stay fixed (park acreage, IBM, steel mills, the game)
     • the accounts and privacy copy: the FAQ answers are hedged, data/privacy.json is complete and
       true to the code, and no page still promises "no accounts" (accounts are optional, not absent)
   ========================================================================== */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findAnswer, tokenize, stem, normalize, MIN_SCORE } from '../js/utils/faqMatch.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const faq = JSON.parse(readFileSync(path.join(root, 'data', 'chatbot-faq.json'), 'utf8'));
const { entries } = faq;

/** Old promises that are no longer true now that accounts are optional (see the last tests in this file). */
const STALE_PROMISE = /\bno accounts?\b(?! (is |are )?needed)|name or email|never ask (for )?(your name|personal)|saved only in (your|this) browser/i;

/** Which entry id does this question find? (null when there is no match) */
const idFor = (question) => findAnswer(question, entries).match?.id ?? null;

/** Plain-language list of question -> expected entry id, written the way students might type. */
const REAL_QUESTIONS = {
  'what is quantum computing': 'what-is-quantum',
  'qubit?': 'qubit',
  'whats a qubit': 'qubit',
  'what is a q bit': 'qubit',
  'what is superposition': 'superposition',
  'what happens when I measure a qubit': 'measurement',
  'what is entanglement': 'entanglement',
  'how do quantum gates work': 'gates',
  'what does the Hadamard gate do': 'x-h-gates',
  'what is a CNOT gate': 'cnot',
  'will quantum computers replace my laptop?': 'replace-laptop',
  'do quantum computers try every answer at once': 'myth-every-answer',
  'can quantum computers break encryption': 'shor-encryption',
  'what is quantum error correction': 'error-correction',
  'why are qubits fragile': 'fragile-noise',
  'what is a quantum simulator': 'simulators',
  'what is a quantum compiler': 'compilation',
  'do I need a PhD?': 'phd-jobs',
  'do I need a Ph.D. for quantum jobs': 'phd-jobs',
  'what jobs are there in quantum': 'jobs-list',
  'how much money do quantum jobs pay': 'pay-openings',
  'how can I learn quantum for free': 'free-start',
  'what is Quirk': 'quirk',
  'tell me about Quantum Quickstart': 'quickstart',
  'what is the Chicago Quantum Exchange': 'cqe',
  'what is PsiQuantum': 'park-companies',
  'tell me about Argonne': 'argonne-fermilab',
  'is there a daily puzzle': 'site-game',
  'do you collect my data': 'privacy',
  'does this site track me': 'privacy',
  'do I need an account?': 'account-needed',
  'do I need to sign up': 'account-needed',
  'can I make an account': 'account-needed',
  'what does an account save?': 'account-saves',
  'do you store my password': 'account-saves',
  'do you save my email': 'account-saves',
  'will my progress follow me to another computer': 'progress-reset',
  'who made this website': 'who-made',
  'is this free': 'free-teachers',
  'hello': 'hello',
  'thanks!': 'thanks',
  'what is an entanglment': 'entanglement',
};

test('the FAQ file has the fields the chatbot needs', () => {
  for (const key of ['greeting', 'disclaimer', 'modeLabel', 'privacyNote']) {
    assert.equal(typeof faq[key], 'string', `${key} must be text`);
    assert.ok(faq[key].trim().length > 0, `${key} must not be empty`);
  }
  assert.equal(faq.disclaimer, "I'm a learning helper and can make mistakes. Don't share personal information.");
  assert.equal(faq.privacyNote, 'Your questions stay on this device in FAQ mode.');
  assert.equal(faq.starters.length, 3);
  assert.equal(typeof faq.noMatch.text, 'string');
  assert.ok(faq.noMatch.suggest.length >= 1);
});

test('there are at least 30 entries, each complete, with unique ids', () => {
  assert.ok(entries.length >= 30, `only ${entries.length} entries`);
  const ids = new Set();
  for (const entry of entries) {
    assert.match(entry.id, /^[a-z0-9-]+$/, 'id must be lowercase letters, numbers and dashes');
    assert.ok(!ids.has(entry.id), `duplicate id: ${entry.id}`);
    ids.add(entry.id);
    assert.ok(Array.isArray(entry.questions) && entry.questions.length >= 1, `${entry.id}: needs example questions`);
    assert.ok(Array.isArray(entry.keywords) && entry.keywords.length >= 3, `${entry.id}: needs keywords`);
    assert.equal(typeof entry.answer, 'string', `${entry.id}: answer must be text`);
    assert.ok(Array.isArray(entry.links), `${entry.id}: links must be a list`);
    for (const link of entry.links) {
      assert.ok(link.label && link.href, `${entry.id}: each link needs a label and an href`);
    }
  }
});

test('answers stay short (about 60 words or fewer)', () => {
  for (const entry of entries) {
    const words = entry.answer.trim().split(/\s+/).length;
    assert.ok(words <= 65, `${entry.id}: ${words} words is too long`);
  }
});

test('every internal link points to a file that exists, and lesson hashes are real lessons', () => {
  const lessonIds = new Set(
    readFileSync(path.join(root, 'js', 'config.js'), 'utf8')
      .match(/LEARN_TOPICS = \[([^\]]*)\]/)[1]
      .split(',')
      .map((id) => id.trim().replace(/'/g, '')),
  );
  for (const link of entries.flatMap((entry) => entry.links)) {
    if (/^https:\/\//.test(link.href)) continue;
    assert.ok(!/^[a-z]+:/i.test(link.href), `${link.href}: only https links or site paths are allowed`);
    const [file, hash] = link.href.split('#');
    assert.ok(existsSync(path.join(root, file)), `${link.href}: ${file} does not exist`);
    if (file === 'pages/learn.html' && hash) assert.ok(lessonIds.has(hash), `${link.href}: no lesson called ${hash}`);
  }
});

test('every starter question finds its intended entry', () => {
  const expected = ['qubit', 'phd-jobs', 'chicago-park'];
  faq.starters.forEach((starter, index) => assert.equal(idFor(starter), expected[index], starter));
});

test('the no-match suggestions are questions the bot can answer', () => {
  for (const question of faq.noMatch.suggest) assert.notEqual(idFor(question), null, question);
});

test("the first example question of every entry finds that entry", () => {
  for (const entry of entries) assert.equal(idFor(entry.questions[0]), entry.id, entry.questions[0]);
});

test('every example question finds its own entry', () => {
  for (const entry of entries) {
    for (const question of entry.questions) assert.equal(idFor(question), entry.id, `${entry.id}: "${question}"`);
  }
});

test('real-world phrasings find the right entry', () => {
  for (const [question, expected] of Object.entries(REAL_QUESTIONS)) assert.equal(idFor(question), expected, question);
});

test('nonsense and off-topic questions return no match', () => {
  for (const question of ['asdf qwerty', 'who won the football game', 'what is the best pizza in town', 'zzzz', 'lorem ipsum dolor']) {
    const result = findAnswer(question, entries);
    assert.equal(result.match, null, `"${question}" matched ${result.match?.id}`);
    assert.equal(result.confidence, 0);
    assert.deepEqual(result.related, []);
  }
});

test('short, empty and odd input never throws', () => {
  const odd = ['', ' ', '?', '??!!', 'a', 'I', '🙂', '<script>alert(1)</script>', 'x'.repeat(5000), '\n\t', null, undefined, 42, {}, []];
  for (const input of odd) {
    assert.doesNotThrow(() => findAnswer(input, entries));
    const result = findAnswer(input, entries);
    assert.ok(result.confidence >= 0 && result.confidence <= 1);
    assert.ok(Array.isArray(result.related));
  }
  assert.equal(findAnswer('qubit', []).match, null);
  assert.equal(findAnswer('qubit', undefined).match, null);
});

test('a match comes with a confidence and up to 2 different related entries', () => {
  const result = findAnswer('what is a qubit', entries);
  assert.equal(result.match.id, 'qubit');
  assert.ok(result.confidence > 0.4 && result.confidence <= 1);
  assert.ok(result.score >= MIN_SCORE);
  assert.ok(result.related.length <= 2);
  assert.ok(result.related.every((entry) => entry.id !== 'qubit'));
});

test('typing the exact example question gives higher confidence than one loose keyword', () => {
  const exact = findAnswer('What is a qubit?', entries);
  const loose = findAnswer('qubit', entries);
  assert.equal(loose.match.id, 'qubit');
  assert.ok(exact.confidence >= loose.confidence);
});

test('a longer keyword phrase beats a single word', () => {
  assert.equal(idFor('error correction'), 'error-correction');
  assert.equal(idFor('quantum network'), 'quantum-network');
});

test('tokenize cleans text: lowercase, no punctuation, no little words, plurals trimmed', () => {
  assert.deepEqual(tokenize('What are the Qubits?!'), ['qubit']);
  assert.deepEqual(tokenize('Quantum GATES, gates & gate'), ['quantum', 'gate', 'gate', 'gate']);
  assert.deepEqual(tokenize('Ph.D.'), ['phd']);
  assert.deepEqual(tokenize(''), []);
  assert.equal(normalize("Chicago's"), 'chicago');
});

test('stem trims endings lightly and leaves short words alone', () => {
  assert.equal(stem('qubits'), 'qubit');
  assert.equal(stem('batteries'), 'battery');
  assert.equal(stem('entangled'), stem('entangling'));
  assert.equal(stem('class'), 'class');
  assert.equal(stem('gas'), 'gas');
});

/** The entry with this id (fails the test if it is missing). */
const entryById = (id) => {
  const entry = entries.find((item) => item.id === id);
  assert.ok(entry, `no entry called ${id}`);
  return entry;
};

test('every link is a site path to an existing file or an https URL', () => {
  for (const entry of entries) {
    for (const { href } of entry.links) {
      if (href.startsWith('https://')) continue;
      assert.ok(!/^[a-z][a-z0-9+.-]*:|^\/\//i.test(href), `${entry.id}: ${href} must be https or a site path`);
      assert.ok(existsSync(path.join(root, href.split('#')[0])), `${entry.id}: ${href} does not exist`);
    }
  }
});

test('the 440 acres are never given to the park alone (the park is 128 of them)', () => {
  for (const entry of entries) {
    if (entry.answer.includes('440')) assert.match(entry.answer, /Quantum Shore|128/, `${entry.id}: 440 acres needs Quantum Shore or 128`);
  }
  assert.match(entryById('chicago-park').answer, /128 acres/);
});

test('the IBM question says the computer is already running and links to the News page', () => {
  assert.equal(idFor('Is IBM coming to Chicago?'), 'park-companies');
  const entry = entryById('park-companies');
  assert.match(entry.answer, /already running at UChicago's Hyde Park Labs/);
  assert.match(entry.answer, /once the campus is complete/);
  assert.ok(entry.links.some((link) => link.href === 'pages/news.html'));
});

test('the steel mill answers are hedged, sourced, and mention the apprenticeship path', () => {
  assert.equal(idFor('Why did the steel mills close?'), 'south-works');
  const mills = entryById('south-works');
  assert.match(mills.answer, /different reasons/);
  assert.ok(mills.links.some((link) => link.href === 'https://www.sechicagohistory.org/stories/cotm.html'));
  assert.match(entryById('phd-jobs').answer, /electricians.*apprenticeship/);
});

test('every name and phrasing for the Collapse Challenge finds the game, not the measurement entry', () => {
  const game = {
    'Collapse Challenge': 'site-game',
    'What is the Collapse Challenge?': 'site-game',
    'how do I play the Collapse Challenge': 'site-game',
    'what is the daily puzzle': 'site-game',
    'can I practice the game': 'site-game',
    'how do I share my result': 'site-game',
    'how do I get stars?': 'site-game-stars',
    'how do I get stars in the collapse challenge': 'site-game',
    'how do I get 3 stars': 'site-game-stars',
    'What does Peek do?': 'site-game-stars',
    'what is par': 'site-game-stars',
  };
  for (const [question, expected] of Object.entries(game)) assert.equal(idFor(question), expected, question);
  assert.equal(idFor('what happens when I measure a qubit'), 'measurement');
});

test('the game answers explain Start and Target, stars, par, Peek and practice mode', () => {
  const text = `${entryById('site-game').answer} ${entryById('site-game-stars').answer}`;
  for (const part of [/Collapse Challenge/, /daily puzzle/, /Start state/, /Target state/, /fewer gates earn more stars/i, /Par is the fewest gates/, /Peek measures the qubit once/, /plain 0 or 1/, /costs one star/, /Practice mode never changes your streak/]) {
    assert.match(text, part);
  }
});

/* ==========================================================================
   Accounts and privacy copy
   ========================================================================== */
const read = (relative) => readFileSync(path.join(root, relative), 'utf8');
const privacy = JSON.parse(read('data/privacy.json'));
const privacyText = JSON.stringify(privacy);

test('the two account entries answer in plain, hedged words and link to the Privacy page', () => {
  for (const id of ['account-needed', 'account-saves']) {
    const entry = entryById(id);
    assert.ok(entry.links.some((link) => link.href === 'pages/privacy.html'), `${id}: needs a link to pages/privacy.html`);
    assert.match(entry.answer, /If this site offers accounts|they are optional/, `${id}: accounts may not be switched on, so say so`);
  }
  assert.match(entryById('account-needed').answer, /^No\. Every feature works as a guest/);
  assert.match(entryById('account-needed').answer, /13 or older/);
  assert.match(entryById('account-saves').answer, /email.*nickname.*progress/);
  assert.match(entryById('account-saves').answer, /never collects your real name, birthdate, school, address, phone, race or location/);
  assert.match(entryById('account-saves').answer, /never by us/);
});

test('the privacy answers keep the chatbot honest about guests, accounts and tracking', () => {
  const answer = entryById('privacy').answer;
  assert.match(answer, /As a guest, nothing leaves your device/);
  assert.match(answer, /no ads, no analytics and no tracking cookies/);
  assert.match(answer, /If this site offers accounts/);
  assert.ok(entryById('privacy').links.some((link) => link.href === 'pages/privacy.html'));
  assert.match(entryById('progress-reset').answer, /Reset my progress/);
  assert.match(entryById('progress-reset').answer, /If this site offers accounts/);
  assert.doesNotMatch(entryById('free-teachers').answer, /no account to make/);
});

test('no FAQ answer still says there are no accounts or that progress lives "only" in the browser', () => {
  for (const entry of entries) assert.doesNotMatch(entry.answer, STALE_PROMISE, `${entry.id}: ${entry.answer}`);
});

test('the Privacy page file exists and the data file is complete', () => {
  assert.ok(existsSync(path.join(root, 'pages', 'privacy.html')));
  assert.match(read('pages/privacy.html'), /data-page="privacy" data-page-title="Privacy"/);
  assert.equal(privacy.lastUpdated, '2026-11-14');
  assert.ok(privacy.sections.length >= 9);
  const ids = new Set();
  for (const section of privacy.sections) {
    assert.match(section.id, /^[a-z0-9-]+$/);
    assert.ok(!ids.has(section.id), `duplicate section id ${section.id}`);
    ids.add(section.id);
    assert.ok(section.title.trim() && section.blocks.length, `${section.id}: needs a title and blocks`);
    for (const block of section.blocks) {
      assert.ok(['p', 'h3', 'list', 'terms', 'links'].includes(block.type), `${section.id}: unknown block ${block.type}`);
      if (block.type === 'p' || block.type === 'h3') assert.ok(block.text.trim());
      else assert.ok(block.items.length >= 1, `${section.id}: empty ${block.type}`);
    }
  }
  for (const id of ['short-version', 'guest-mode', 'accounts', 'passwords', 'who-handles-data', 'protection', 'your-choices', 'teens', 'changes']) {
    assert.ok(ids.has(id), `missing section ${id}`);
  }
});

test('every link on the Privacy page is a real site file or an https address', () => {
  const links = privacy.sections.flatMap((section) => section.blocks.filter((block) => block.type === 'links').flatMap((block) => block.items));
  assert.ok(links.length >= 3);
  for (const { label, href } of links) {
    assert.ok(label.trim(), href);
    if (href.startsWith('https://')) continue;
    assert.ok(!/^[a-z][a-z0-9+.-]*:|^\/\//i.test(href), `${href} must be https or a site path`);
    assert.ok(existsSync(path.join(root, href.split('#')[0])), `${href} does not exist`);
  }
});

test('the Privacy page says the true things about data, passwords and third parties', () => {
  const claims = [
    /do not store your age/i,
    /13 or older/,
    /real name, your birthdate, your school, your address, your phone number, your race or your location/,
    /bcrypt/,
    /never see it and we never save it/,
    /esm\.sh/,
    /only when you open the log-in or sign-up form, or when you are signed in/,
    /never contacts Supabase or esm\.sh/,
    /Vercel/,
    /no analytics/,
    /row-level security/,
    /download your data and delete your account/,
    /Deleting your account removes everything/,
    /ask your teacher or the project team/,
    /Reset my progress/,
    /The chatbot saves nothing/,
  ];
  for (const claim of claims) assert.match(privacyText, claim);
  assert.doesNotMatch(privacyText, STALE_PROMISE);
  assert.doesNotMatch(privacyText, /@[a-z0-9-]+\.[a-z]{2,}/i, 'no invented contact email addresses');
});

/** The old "no accounts" promises. Accounts are optional now: say "no account needed" instead. */
const SITE_FILES_TO_SCAN = () => {
  const found = [];
  const walk = (directory) => {
    for (const name of readdirSync(path.join(root, directory))) {
      const relative = path.posix.join(directory, name);
      if (name === 'node_modules' || name.startsWith('.')) continue;
      if (statSync(path.join(root, relative)).isDirectory()) walk(relative);
      else if (/\.(html|js|json|md)$/.test(name)) found.push(relative);
    }
  };
  for (const directory of ['pages', 'js', 'data', 'docs']) if (existsSync(path.join(root, directory))) walk(directory);
  return ['index.html', 'README.md', ...found];
};

/** Pages owned by other parts of the accounts work (Home and Learn pick their wording by mode). */
const OTHER_OWNERS = new Set(['js/pages/home.js', 'js/pages/learn.js']);

test('no page, script or data file still promises "no accounts"', () => {
  for (const file of SITE_FILES_TO_SCAN()) {
    if (OTHER_OWNERS.has(file)) continue;
    assert.doesNotMatch(read(file), STALE_PROMISE, `${file} still has an old no-account promise`);
  }
});

test('Home keeps its guest wording and adds account wording', () => {
  const home = JSON.parse(read('data/home.json'));
  assert.match(home.hero.trustNote, /No account needed/);
  assert.doesNotMatch(home.hero.trustNote, /name or email/);
  assert.match(home.progress.savedNote, /only on this device/);
  assert.match(home.progress.resetWarning, /on this device/);
  assert.match(home.progress.savedNoteAccount, /your account/);
  assert.match(home.progress.resetWarningAccount, /from your account/);
});

test('the footer and the game page mention accounts only as optional and link to Privacy', () => {
  const footer = read('js/components/footer.js');
  assert.match(footer, /pages\/privacy\.html/);
  assert.match(footer, /If this site offers accounts, they are optional/);
  assert.match(read('pages/game.html'), /saved on this device, or in your account if you are signed in/);
});
