# Supabase setup (optional accounts)

Quantum South Side works fully as a **guest** site. Accounts are optional. This guide turns them on with [Supabase](https://supabase.com) (free plan is fine for testing).

You do not need to follow it to run the site. If you skip it, the site hides all account buttons and runs in guest mode with no errors.

> Dashboard menu names can change slightly. If a name below does not match what you see, look for the closest one. The page addresses in the notes can help.

**What you will do**

1. Create a Supabase project
2. Run the database files
3. Change the Auth settings
4. Copy three values
5. Use them locally and on Vercel
6. Test

---

## 1. Create a Supabase account and project

1. Go to <https://supabase.com> and sign up.
2. Click **New project** and pick an organization.
3. Give it a name, for example `quantum-south-side`.
4. Choose a **database password** and save it in a password manager.
   - This password is only for direct database access.
   - The website never uses it. Do not put it in `.env` or Vercel.
5. Pick the region closest to Chicago (for example East US) and click **Create new project**.
6. Wait about two minutes until the project is ready.

## 2. Run the database files

The files are in `supabase/migrations/`. Run them **in order**.

1. In the dashboard open **SQL Editor** and click **New query**.
2. Open `supabase/migrations/001_init.sql`, copy everything, paste it, click **Run**.
   - You should see **Success. No rows returned.**
3. Open a new query. Paste `002_accounts.sql` and click **Run**. Same success message.
   - 002 builds the full design. It also upgrades what 001 made.
   - It is safe to run again if you are unsure.
4. Optional but recommended: paste `003_rls_tests.sql` and click **Run**.
   - It pretends to be two students and a guest and checks that nobody can see anyone else's data.
   - At the end you should see: **All RLS tests passed. Nothing was saved (the test data was rolled back).**
   - If a test fails, the error says which one. Re-run 002 and try again.

To check the tables, open **Table Editor**. You should see `profiles`, `user_settings`, `progress`, `saved_careers`, `roadmap_steps`, `saved_circuits` and `chat_messages`, each marked with RLS on.

**What the files do (in short)**

- Each student can only see and change their own rows (Row Level Security).
- Guests (not signed in) cannot touch the tables at all. They use their own device.
- When someone signs up, a database trigger creates their profile (nickname only) and default settings.
- `get_impact_stats()` returns five totals (numbers only) for a future impact page. It never returns names or emails.
- `delete_old_chat_messages()` is an optional clean-up for admins. See the comments in `002_accounts.sql` if you want to schedule it (**Integrations > Cron**).

## 3. Change the Auth settings

Open **Authentication** in the left menu.

### 3a. Email sign-in and password rules

1. Go to **Sign In / Providers** and open **Email**.
2. Make sure **Enable Email provider** is **on** (it is on by default).
3. Turn **Confirm email** **on**. Students must click the link in their email before they can log in. (Hosted projects have it on by default, but check.)
4. Set the **Minimum password length** to **10**.
   - The website checks the same rule (at least 10 characters, with a letter and a number).
   - Do not choose stricter Supabase password requirements than that. If Supabase asks for more than the site does, students would see confusing errors.
5. Click **Save**.

Keep **Allow new users to sign up** on (under the general Auth settings). Leave anonymous sign-ins off.

### 3b. Site URL and Redirect URLs

Open **URL Configuration**.

**Site URL** is the main address of your site.

- Local testing: `http://localhost:8000`
- After you deploy: `https://YOUR-SITE.vercel.app` (use your real Vercel address, or your own domain)

**Redirect URLs** is the list of addresses Supabase may send people back to. Add every address below. Replace `YOUR-SITE` with your real address.

| Page | Local | Vercel |
| --- | --- | --- |
| Confirm email (log-in page) | `http://localhost:8000/pages/login.html` | `https://YOUR-SITE.vercel.app/pages/login.html` |
| Reset password | `http://localhost:8000/pages/reset-password.html` | `https://YOUR-SITE.vercel.app/pages/reset-password.html` |
| Home | `http://localhost:8000/index.html` | `https://YOUR-SITE.vercel.app/index.html` |

Also helpful:

- If you open the site at `http://127.0.0.1:8000` instead of `localhost`, add the same three with `127.0.0.1`.
- For local testing you can add one wildcard instead: `http://localhost:8000/**`. Supabase recommends exact paths (no wildcard) for production.
- Vercel makes a different address for each preview deployment. Add the ones you test, or use a wildcard (see the wildcard rules in the [Supabase Redirect URLs guide](https://supabase.com/docs/guides/auth/redirect-urls)).
- The confirmation link goes to `pages/login.html?confirmed=1`. If you click it and land on the home page instead of the log-in page, the list did not match. Add `https://YOUR-SITE.vercel.app/pages/login.html**` (the `**` also matches the `?confirmed=1` part), or use the wildcard above for local testing.

### 3c. Email sending (important before real students use it)

Supabase's built-in email service is only for trying things out:

- It sends very few emails (about 2 per hour).
- It may only deliver to addresses of people on your Supabase team. Other addresses fail with "Email address not authorized".

Before real students sign up, set up your own email service: **Authentication > Emails > SMTP Settings** (also called **Custom SMTP**; the page address ends in `/auth/smtp`). Use a sender your school or club owns. After that, raise the limit on the **Rate Limits** page if you need to.

## 4. Copy three values

You need the project address, the public key and (for server functions) the secret key.

1. **Project URL** (looks like `https://abcdefghijkl.supabase.co`). Click **Connect** at the top of the dashboard and copy the URL.
2. Go to **Project Settings > API Keys**.
3. **Public key.** Copy either one of these (both are safe for browsers):
   - the **anon** key (labelled `anon` / `public`, on the "Legacy API keys" tab), or
   - the **publishable** key (starts with `sb_publishable_`).
4. **Secret key.** Copy the **service_role** key (legacy) or the **secret** key (starts with `sb_secret_`).

Names for the three values in this project:

| Name | What it is | Who may see it |
| --- | --- | --- |
| `SUPABASE_URL` | Project URL | Anyone (it goes to the browser) |
| `SUPABASE_ANON_KEY` | The public key from step 3 | Anyone (it goes to the browser) |
| `SUPABASE_SERVICE_ROLE_KEY` | The secret key from step 4 | **Only the server. Never anyone else.** |

**Why the secret key is dangerous.** It skips every privacy rule in the database. Anyone who gets it can read and change every student's data.

- Never put it in browser code, in a `.js` or `.json` file, in a screenshot, in a chat, or in the repo.
- Only server functions that do admin jobs may read it. The sign-up, log-in and progress features do not read it at all.
- If it ever leaks, go to **Project Settings > API Keys** and rotate it right away.

The public key is different. It is meant to be public. The database rules (RLS) are what protect the data. The site gets the URL and public key from `api/public-config`, not from the code, so nothing is hard-coded.

## 5. Local setup

1. Copy the template:

   ```bash
   cp .env.example .env
   ```

2. Open `.env` and paste your values after `SUPABASE_URL=`, `SUPABASE_ANON_KEY=` and `SUPABASE_SERVICE_ROLE_KEY=`. No quotes needed.
3. Start the site:

   ```bash
   npm run dev
   ```

4. Open <http://localhost:8000>. You should now see **Log in** and **Sign up** in the menu.

Good to know:

- `.env` is listed in `.gitignore`, so Git will not commit it. Check with `git status`: `.env` must not appear.
- The dev server never serves `.env`, even to other computers on your Wi-Fi.
- Without `.env` (or with empty values) the site runs as guest-only. That is normal.
- After you change `.env`, stop the server (Ctrl+C) and run `npm run dev` again.

## 6. Vercel setup

1. Push the project to GitHub and import it in [Vercel](https://vercel.com) (**Add New > Project**).
2. Open your project, then **Settings > Environment Variables**.
3. Add these three variables (one at a time: **Name**, **Value**, **Save**):
   - `SUPABASE_URL`
   - `SUPABASE_ANON_KEY`
   - `SUPABASE_SERVICE_ROLE_KEY`
4. For **Environments**, tick **Production** and **Preview** for each one.
5. Choose the **Secret** type for `SUPABASE_SERVICE_ROLE_KEY` so nobody can read it again after saving. (Vercel offers **Config** or **Secret** for each variable.)
6. **Redeploy.** Variable changes only apply to new deployments. Open **Deployments**, pick the latest one and choose **Redeploy**.
7. Go back to Supabase **URL Configuration** and make sure your real Vercel address is in **Site URL** and **Redirect URLs** (step 3b).

The other names in `.env.example` (`LLM_*`, `JOBS_API_*`) are for optional AI and job-listing features. Leave them out until you use those features.

## 7. Test it

**By hand (about five minutes)**

1. Open the site and click **Sign up**.
2. Use a real email you can open. Pick a nickname that is **not** your real name. Use a password with 10 or more characters, a letter and a number.
3. Tick both boxes and submit. You should see **Check your email to confirm your account**.
4. Open the email and click the link. You should land on the log-in page.
5. Log in. Your nickname should appear in the menu.
6. Click the menu and sign out. Log in again to be sure it works.
7. Try **Forgot password?**. It always says the same thing, whether or not the email has an account.
8. In Supabase open **Table Editor > profiles**. You should see one row with your nickname. There is no email and no password in this table.
9. To remove a test account: **Authentication > Users**, delete the user. All their rows disappear with it.

**Automatic database test (no Supabase needed)**

```bash
npm install
npm run test:rls
```

This runs the real SQL files on a throwaway database in memory and checks security rules, limits, triggers and upgrades. It takes a few seconds. All lines should say `PASS`. Plain `npm test` does not need this step.

## 8. Optional: Google sign-in

Google sign-in is **off** by default. The site works fully without it.

1. In Supabase open **Authentication > Sign In / Providers > Google**, turn it on, and copy the **callback URL** shown there.
2. In [Google Cloud Console](https://console.cloud.google.com) create an OAuth client (type **Web application**).
   - Authorized JavaScript origins: your site address (for example `http://localhost:8000` and `https://YOUR-SITE.vercel.app`).
   - Authorized redirect URI: the Supabase callback URL.
3. Paste the Google **Client ID** and **Client secret** into the Supabase Google provider page and save.
4. In `js/config.js` set `FEATURES.googleSignIn` to `true`.

Google may share an email address and a name with the sign-in. This site only stores an email, a nickname and progress. Think about this before turning it on for students.

## 9. Common problems

**No email arrives.**
- Look in the spam folder.
- The built-in Supabase email service sends only a few emails per hour and may only deliver to your own team's addresses (step 3c). Set up custom SMTP.
- Wait an hour and try again, or use another test address.

**"Email not confirmed" when logging in.**
Click the link in the confirmation email first. The log-in form has a **Resend confirmation email** button.

**The link says the redirect URL is not allowed, or opens the wrong page.**
Add the exact address to **Authentication > URL Configuration > Redirect URLs** and check **Site URL** (step 3b).

**I do not see Log in / Sign up anywhere.**
The site hides accounts when the settings are missing. Check:
- `.env` exists and `SUPABASE_URL` and `SUPABASE_ANON_KEY` are filled in (local), or the variables are set for the right environment and you redeployed (Vercel).
- Open `/api/public-config` in the browser. It should show `"configured": true`. If it shows `false` or "not found", the variables are missing.
- `FEATURES.accounts` in `js/config.js` is `true`.

**"Password is too weak" or "Password should be at least ..." on sign-up.**
The password needs 10 or more characters, a letter and a number. Also check that Supabase's **Minimum password length** is not higher than 10.

**Log-in says "Email or password is incorrect".**
That message is the same on purpose, so nobody can find out which emails have accounts. Check both, or use **Forgot password?**.

**Sign-up works but there is no profile row.**
Run `002_accounts.sql` again. It also creates missing profiles for existing accounts.

**`npm run test:rls` says the package is missing.**
Run `npm install` first.

## 10. Privacy note

What an account stores:

- **Email** (in Supabase Auth, only for logging in and reset emails)
- **Password** (in Supabase Auth only, stored as a one-way hash that nobody can read; there is no password column in our tables)
- **Nickname** (2 to 30 letters, numbers, spaces or underscore; never an email address)
- **Progress and settings** (topics finished, quiz and game results, theme and text size, and optional saved items)

What it never stores: real names, birthdates, ages (the "I am 13 or older" box is checked and then forgotten), schools, addresses, phone numbers, race or location.

Why this keeps students safer:

- Less data means less to lose.
- Row Level Security means a student can only reach their own rows, even if the website had a bug.
- Guests never contact the database.
- The impact totals are only counts. They never contain a name or email.
- Chat history is off by default. If a student turns it on, messages older than 90 days can be deleted with `delete_old_chat_messages()`.

Tell students plainly: **do not use your real full name as your nickname.**
