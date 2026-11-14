# Quantum South Side

Black CS Success Summit Hackathon 2026, Group 5 project.

A free, friendly website that helps Chicago high school students, especially on the South and West Sides, understand quantum technology and see the many quantum careers that **don't require a PhD**.

Hackathon theme: *Past Revolutions, Future Power: Shaping Chicago's Quantum Future.*

---

## What is in the site

| Page | What you can do there |
| --- | --- |
| **Home** | See the steel-to-quantum story of Chicago, read "What is quantum in 30 seconds", and check your progress. |
| **Learn** | Seven short lessons (with quizzes) and a one-qubit playground. |
| **Careers** | Take a 5-question interest quiz and browse 14 example quantum careers with education paths and Chicago learning links. |
| **News** | Read plain-language quantum news, including stories from Chicago-area schools and labs. |
| **Research** | See recent quantum papers explained like you're 15, with links to the original arXiv pages. |
| **Daily Puzzle** | Play the Collapse Challenge: build a short gate sequence to turn a starting qubit state into the target. |
| **Chatbot** | A floating learning helper on every page. It answers from the site's own FAQ (you need neither an account nor a key). |
| **Privacy** | Read, in plain words, what stays on your device as a guest, what an optional account stores, and who handles your data. |

Under the hood there is a small, tested quantum engine in `js/quantum/` (pure JavaScript, no web page code) that the playground and the puzzle both use.

---

## Run it on your computer

The site is plain HTML, CSS and JavaScript. **There is no build step.**

There is one catch: browsers block `fetch()` and JavaScript modules when you double-click `index.html` (an address that starts with `file://`). So you need to serve the folder with a tiny local web server. Pick **one** of these:

### Option 1: Node.js (recommended)

Open a terminal **in the folder that contains `index.html`** and run:

```bash
npm run dev
```

Then open **<http://localhost:8000>**. To use another port: `PORT=3000 npm run dev`.

This server refuses to hand out private files (anything starting with a dot, like `.env`, plus `.git` and `node_modules`), even to other computers on your Wi-Fi.

### Option 2: Python

```bash
python3 -m http.server 8000
```

Then open **<http://localhost:8000>**. On Windows, if `python3` isn't found, use `python -m http.server 8000` or `py -m http.server 8000`.

### Option 3: VS Code "Live Server"

Install the **Live Server** extension, right-click `index.html`, and choose **Open with Live Server**.

> **Careful with secrets.** Plain servers (Python, `npx serve`, Live Server) will serve *every* file in the folder, including a `.env` file full of API keys, to anyone on the same network. Use Option 1 whenever a `.env` file exists, and never commit one (it is already in `.gitignore`).

Stop any server with `Ctrl + C`.

---

## Run the tests

```bash
npm test
```

This uses Node's built-in test runner (no installs needed) and checks the quantum engine, the daily puzzles (every puzzle must be solvable in exactly its "par" number of gates), the game rules and the chatbot's FAQ matching. It also checks saving progress in the browser (including streaks, the Chicago-time day change and a full browser storage), the safe link helper in `js/config.js`, and that the dev server refuses private files.

---

## Try it on your phone

1. Put your computer and phone on the **same Wi-Fi**.
2. Start the server (`npm run dev`).
3. Find your computer's local address: on a Mac run `ipconfig getifaddr en0`; on Windows run `ipconfig` and look for "IPv4 Address".
4. On your phone, open `http://<that address>:8000`.

Some school and event Wi-Fi networks block devices from talking to each other. If the page won't load, try your phone's hotspot instead. Only do this on a network you trust.

---

## Where the content lives

The main content (lessons, careers, news, research, puzzles and chatbot answers) lives in the `data/` folder as JSON, so you can change it without touching code. Edit a file, save, and refresh the page. A few short page labels, such as some section headings and the news topic buttons, live in the page scripts (`js/pages/`) and in the HTML files.

| File | Used by |
| --- | --- |
| `data/home.json` | Home page (timeline, 30-second explainer, facts, sources) |
| `data/learn/*.json` | The seven lessons, quizzes and sources |
| `data/careers.json` | Careers page (quiz, roles, sources) |
| `data/news.json`, `data/research.json` | News and Research pages |
| `data/game-puzzles.json` | The daily puzzle (15 one-qubit puzzles) |
| `data/chatbot-faq.json` | The chatbot's questions and answers |
| `data/privacy.json` | The Privacy page (update `lastUpdated` when you change it) |

The project name, menu links and feature switches are in one place: `js/config.js`. If you change a `.css` or `.js` file and don't see the change, do a hard refresh (`Cmd + Shift + R` on Mac, `Ctrl + Shift + R` on Windows/Linux).

Careers data is **illustrative, not job postings**. Every role and local resource is marked `verify: true` so the team can confirm details before relying on them.

---

## Your progress and privacy

**Guest mode (the default).** No account is needed and nothing you do is sent anywhere. Completed lessons, quiz scores, the optional confidence rating and puzzle results are saved in your own browser (localStorage) and stay on your device. The chatbot answers from files on the site: your questions stay on your device and are not stored.

- Progress is saved per web address, so `localhost:8000` and `localhost:3000` each keep their own.
- To start fresh, use **Reset my progress** on the Home page, or clear the site's data in your browser settings.

**Optional accounts (email and password).** When accounts are switched on, signing up stores only:

- your **email**, for logging in and for the confirm and reset emails,
- a **nickname** you choose (not your real name),
- your **progress and settings**, and your chat history only if you turn that on.

We never collect a real name, birthdate, school, address, phone number, race or location, and we do not store your age: sign-up just asks you to confirm that you are 13 or older. Your **password** goes only to Supabase's sign-in service, which stores a bcrypt hash of it. Our code never stores, logs or sends it anywhere else. Row-level security in the database means each person can read and change only their own rows.

**On-demand loading.** A guest who only browses never contacts any third party. The sign-in library (supabase-js) is loaded from the esm.sh content delivery network, and requests go to the Supabase project, only when someone opens a log-in or sign-up form, already has a saved sign-in session, or follows a confirm or reset link from an email. The only extra request on every page is one same-origin `GET api/public-config`, which says whether accounts are switched on. The Supabase service-role key is never used in the browser, and the public key reaches the browser only through that endpoint.

The full, plain-language version is on the site's **Privacy** page (`pages/privacy.html`, text in `data/privacy.json`). To switch accounts on for your own copy of the site, follow [docs/supabase-setup.md](docs/supabase-setup.md) (create a Supabase project, run the SQL in `supabase/migrations/`, and set the environment variables in Vercel). Copy `.env.example` to `.env` for local work and never commit `.env`.

---

## Troubleshooting

| What you see | What to do |
| --- | --- |
| A page with no menu or footer, or "We couldn't load this part of the page" | You probably opened the file directly (`file://`). Start a server (see above) and use the `http://localhost` address. |
| `Address already in use` | Pick another port, for example `PORT=8080 npm run dev`, and open `http://localhost:8080`. |
| `python3: command not found` (Windows) | Use `python` or `py` instead of `python3`, or use `npm run dev`. |
| Your edits don't show up | Hard refresh (`Cmd/Ctrl + Shift + R`). |
| A lesson or page says it couldn't load | The server isn't running, or that JSON file has a typo. The error box lists the file name under "Details for the project team". |

Works in any recent version of Chrome, Edge, Firefox or Safari.

---

## License

MIT. See [LICENSE](LICENSE).
