# Migration checklist — Firestore → D1, one slice at a time

Every slice is independently testable. The app keeps working on localStorage if the API
is down, so nothing breaks half-way. Firestore stays connected until slice 5.

## Before you start (once)

```bash
npx wrangler d1 create mykotoba-db     # paste the printed id into wrangler.jsonc
npm run db:migrate:local               # create tables in your local copy
```

Check `FIREBASE_PROJECT_ID` in `wrangler.jsonc` matches `VITE_FIREBASE_PROJECT_ID` in `.env`.

Terminal 1: `npm run dev:api`  → Worker on :8787
Terminal 2: `npm run dev`      → Vite on :5173, proxies `/api` to the Worker

---

## ✅ Slice 1 — Profile sync (DONE)

**What moved:** lists, custom words, active list, quiz history, share toggle, nickname,
friend code. This is every save in the app (`pushToCloud`) plus the `userData` listener.

| Before | After |
|---|---|
| `onSnapshot(doc(db,'userData',uid))` | `GET /api/me` polled every 20 s (`usePoll`) |
| `setDoc(..., {merge:true})` | `PUT /api/me` with `version` (409 → refetch + retry) |

### How to test it

1. Sign in. Open DevTools → Network → filter `me`. You should see `GET /api/me` every 20 s.
2. Create a word list, add a custom word, finish a quiz. Each save → `PUT /api/me` 200.
3. **Reload the page.** Your list, word and history must still be there.
4. Look at the database:
   ```bash
   npx wrangler d1 execute mykotoba-db --local \
     --command "SELECT uid, version, length(lists) AS lists_bytes FROM user_data"
   ```
   You should see one row, `version` ≥ 1.
5. **Two devices/tabs:** change a list in tab A; within ~20 s tab B updates.
6. Clear `localStorage` and reload — data must come back from D1 (this is the real proof).

Still on Firestore after this slice: card discovery (slice 2), leaderboard (slice 3),
friends (slice 4).

---

## ✅ Slice 2 — Card discovery (DONE — the big one)

**Why it matters:** this was ~99% of your Firestore reads. One document *per card*,
re-read on every reconnect. On D1 with `?since=` you only fetch what changed.

| Before | After |
|---|---|
| `onSnapshot(collection(...cardDiscovery))` | `GET /api/discovery?since=<version>` polled |
| `runTransaction()` compare-version-then-write | `POST /api/discovery` — one atomic SQL upsert |

Files: `src/components/CardProgress.tsx`, `worker/index.ts`

Saving: a learner with 2,000 seen cards goes from **2,000 reads per reconnect** to
**~20 rows**. Verified against real D1: a stale write is rejected (0 rows), a newer one
wins, and when a write loses the race the API returns the record that *did* win — exactly
what the old transaction did, so the client never retries forever.

### How to test it

1. Open a practice deck. Network tab → `discovery` → first load returns your records,
   later polls return `{"records":[], ...}` when nothing changed.
2. Flip a card → `POST /api/discovery`, then the next `GET` returns `[]` for it (it isn't
   re-sent; the cursor moved past it).
3. Reload — your "seen" cards are still marked.
4. **Two browsers:** mark a card in one; within ~20 s it appears in the other.
5. Check the rows:
   ```bash
   npx wrangler d1 execute mykotoba-db --local \
     --command "SELECT COUNT(*) AS cards, MAX(version) AS latest FROM card_discovery"
   ```
6. Confirm the win: Firebase Console → Firestore → Usage. Document reads/day should drop
   sharply — this was the bulk of them.

Still on Firestore after this slice: leaderboard (slice 3) and friends (slice 4).

---

## ✅ Slice 3 — Leaderboard (DONE)

| Before | After |
|---|---|
| `getDocs(query(leaderboard, orderBy, limit 50))` | `GET /api/leaderboard?sort=` |
| `setDoc` / `deleteDoc` on `leaderboard/{uid}` | `PUT /api/leaderboard` with `publish:false` to remove |
| `setDoc(nicknames/{key})` for uniqueness | `POST /api/nickname` (409 = taken) |

Files: `src/App.tsx` (`publishSummary`, `saveNickname`, the `Leaderboard` component)

### How to test it

1. Leaderboard page → set a nickname, tick "Share my scores". You should appear.
2. Try a nickname someone else has → friendly "already taken" message.
3. Untick sharing → you vanish from the board.
4. `npx wrangler d1 execute mykotoba-db --local --command "SELECT uid, display_name, bonus_points FROM leaderboard"`

---

## ✅ Slice 4 — Friends (DONE)

| Before | After |
|---|---|
| `onSnapshot(friendRequests where members array-contains)` | `GET /api/friend-requests` polled |
| `onSnapshot(pairs where members array-contains)` | `GET /api/pairs?withBonus=1` polled |
| `onSnapshot(doc(db,'leaderboard',other))` per friend | folded into the pairs call (1 request, not N) |
| `getDoc/setDoc` on `invites` | `GET /api/invites/:code`, `POST /api/invites` |

Files: `src/App.tsx` (friends section, `Friends` component)

### How to test it

Two accounts (use a normal + an incognito window):

1. Account A: Friends page → **Generate code**.
2. Account B: enter that code → "Invitation sent!".
3. Account A: the invitation appears → **Confirm**.
4. Both show each other as friends; bonus points appear if both are sharing.
5. Remove the friend → both sides update within ~20 s.
6. `npx wrangler d1 execute mykotoba-db --local --command "SELECT * FROM pairs"`

---

## ✅ Slice 1b — Bulk import (DONE)

`commitBulkImport()` used a Firestore transaction. It now uses optimistic locking:
read `/api/me` (with version) → compute → `PUT` with that version → 409 means
refetch and retry (3 attempts). Files: `src/lib/bulkImportStore.ts`.

---

## 🔶 Slice 5 — Cut the cord

### 5a. Delete the rules file (done in this zip — repeat it on your PC)

```
Remove-Item firestore.rules
```

Only two mentions of Firestore were left in the code, both of them lying to
users, and both now fixed:

| Was | Now |
| --- | --- |
| `"…The Firestore rules in Firebase Console are probably outdated"` (`explainFirestoreError`) | deleted — the function had **zero** call sites, it was dead code from the Firestore era |
| `"…Check your account and Firestore rules, then retry"` (import dialog) | `"…your session expired. Sign in again, then retry the same preview."` — keyed off `ApiError.status` (401/403) instead of Firestore's `code` |

No `firebase/firestore` import remains anywhere in `src/` or `worker/` — only
comments. Verified again after the deletions above.

> Heads-up: deleting `firestore.rules` on your computer does **not** change the
> rules running in Google's cloud (those live until you publish new ones). It
> doesn't matter — nothing reads Firestore any more.

### 5b. About "uninstall firebase/firestore"

**That command doesn't exist, and you don't need it.** You cannot uninstall one
sub-path of a package; `firebase/auth` and `firebase/firestore` ship inside the
same `firebase` package, and you still need `firebase/auth` (Option A). Firestore
already left your app the moment the last import disappeared — that is why the
bundle fell from **3,069 kB → 2,614 kB** (−455 kB). Nothing to do here. ✅

### 5c. Verify Firestore usage is 0 (your turn — 2 minutes in a browser)

1. Open <https://console.firebase.google.com> and click your project.
2. In the left menu, click **Firestore Database**.
3. Click the **Usage** tab (top centre, next to *Data* / *Rules* / *Indexes*).
4. Set the range to **Last 30 days**.
5. Look at the three graphs: **Document reads**, **Document writes**,
   **Document deletes**.
   - ✅ **What you want:** the line drops to **0** on the day you extracted the
     slice 3 + 4 zip and stays flat.
   - ⚠️ **If you still see reads:** the app is still talking to Firestore
     somewhere. Run `npm run typecheck` and search your own edits for
     `firebase/firestore` — anything you added outside the 7 files this zip
     overwrites will not have been fixed by extracting it.

### 5c-2. Before ANY `wrangler` command with `--remote`

`wrangler.jsonc` line 21 must hold your **real** D1 database id, not
`REPLACE_WITH_YOUR_D1_DATABASE_ID`. Get it with `npx wrangler d1 list`, or
dashboard → Storage & Databases → D1 → mykotoba-db → **Database ID**.

Two traps worth remembering:

- **Local dev hides the mistake.** `wrangler dev` just uses that string as the
  name of a local SQLite file, so a placeholder "works" locally and only fails
  the moment you touch the real API.
- **Changing the id points at a different local database.** If you fix it after
  using the app locally, re-run `npm run db:migrate:local` — otherwise you will
  see `no such table: …` for tables that do exist elsewhere.

`wrangler.jsonc` is deliberately **not** in the migration zip any more, so an
extract can never reset your id again.

## 🔍 The 10-second check when anything "doesn't work"

Open **<https://mykotoba.pages.dev/api/health>** in your browser. No login
needed — it never reads your data. It reports exactly what the Worker itself can
see, so it answers "is it the config or is it my account?" in one glance.

**Healthy looks like this:**

```json
{
  "ok": true,
  "time": "2026-…",
  "firebaseProjectId": "kotobacabinet",
  "database": "bound",
  "tables": ["card_discovery","friend_requests","invites","leaderboard",
             "nicknames","pairs","user_data","users"]
}
```

| What it says instead | What's wrong | Fix |
| --- | --- | --- |
| `"firebaseProjectId": "(MISSING)"` | variable not set for **this** environment | Pages → Settings → Environment variables → `FIREBASE_PROJECT_ID` = `kotobacabinet` (add to Production *and* Preview) |
| `"database": "(MISSING) — …"` | D1 binding not attached | Pages → Settings → Functions → D1 database bindings → name must be exactly **`DB`** |
| a `hint` about 8 tables, or `"databaseError": "no such table: …"` | tables never created on the **real** database | `npx wrangler d1 execute mykotoba-db --remote --file=migrations/0001_init.sql` |

Remember: after any change, **Deployments → ⋯ → Retry deployment**.

### If `/api/health` is green but sign-in still fails

The backend is fine, so it's the account or Firebase. In order:

1. **Does the account exist?** Firebase Console → **Authentication** → **Users** — your email must be listed.
2. **Is the domain allowed?** **Authentication** → **Settings** → **Authorized domains** — `mykotoba.pages.dev` must be there. Without it, login is refused (`auth/unauthorized-domain`) and password-reset emails cannot be sent at all.
3. **What does the browser say?** Open the site → **F12** → **Console** tab (not Network) → try signing in:
   - `auth/unauthorized-domain` → step 2
   - `auth/wrong-password` / `auth/user-not-found` → step 1
   - `auth/invalid-api-key` → the build didn't get `VITE_FIREBASE_API_KEY` (Pages → Environment variables)
4. **Signed in, but empty or broken?** **Network** tab → filter `api/` → click `me`:
   - **200** → working
   - **401** → `FIREBASE_PROJECT_ID` mismatch
   - **500** → D1 binding (see the health table)

---

### 5d. Give the site a backend — Pages is static-only right now

**Checked on 2026-09-23:** <https://mykotoba.pages.dev/api/me> returned your
app's own *"404 Page Not Found"* page. That means Pages is serving
`dist/public` as static files and **no API is running behind it** — the
migrated code is live (the bundle contains the D1 client), but every
`/api/...` call hits the SPA router instead of a server. Locally it works
because `npm run dev:api` is running.

Two new files fix it (both in this zip):

| File | Why |
| --- | --- |
| `functions/api/[[path]].ts` | Pages Functions: forwards every `/api/*` request to the same Hono app you run locally |
| `public/_routes.json` | **Only** `/api/*` goes to the Function. Without it Pages runs the Function for your 2.6 MB bundle, every image and every audio file — that eats the 100,000 requests/day free budget in no time |

Then tell Pages about your database — dashboard, click by click:

1. Open <https://dash.cloudflare.com> → **Workers & Pages** (left menu) → click **mykotoba**.
2. **Settings** tab → **Functions** → **D1 database bindings** → **Add binding**
   - Variable name: `DB` ← exactly this, the Worker reads `env.DB`
   - D1 database: `mykotoba-db`
3. Still in Settings → **Environment variables** → **Add**
   - `FIREBASE_PROJECT_ID` = `kotobacabinet`
   - ⚠️ use the environment dropdown and add it to **Preview** as well, or
     preview deployments return **401** on every call.
4. **Deployments** tab → **Retry deployment** on the newest one (or just push a
   commit — Pages rebuilds automatically).

Now create the tables on the **real** database. You have only ever migrated the
local copy, so the remote one is still empty:

```
npx wrangler d1 execute mykotoba-db --remote --file=migrations/0001_init.sql
```

(answer `Y` to `Ok to proceed?`)

**How to tell it worked** — open <https://mykotoba.pages.dev/api/me>:

| You see | Meaning |
| --- | --- |
| `{"error":"Not signed in."}` with HTTP **401** | ✅ the API is live |
| the "404 Page Not Found" page | ❌ still static-only — check the `functions/` folder was committed |
| `{"error":"no such table: …"}` | ✅ API live, but you skipped the remote migration above |

**Alternative (if you'd rather not click through the dashboard):** deploy it as a
Worker instead of Pages. `npx wrangler deploy` reads the D1 binding and
`FIREBASE_PROJECT_ID` straight out of `wrangler.jsonc`, so there is nothing to
configure — but you get a new `*.workers.dev` URL instead of
`mykotoba.pages.dev`. Pages Functions run on the same free limits (100k
requests/day, 10 ms CPU per request), so the choice is about convenience only.

### 5e. A week later: switch Firestore off

Once the live site has run clean for a week:

1. Firebase console → **Firestore Database** → **Usage** → confirm still 0.
2. **Firestore Database** → the three-dot menu → **Delete database**.
   Typing the project id confirms it.
   - This does **not** touch Firebase Auth — your users can still sign in.
   - You have no data in there, so there is nothing to lose.
3. Delete `firestore.rules` from your git history only if you care — leaving it
   in the repo is harmless.

After that, Firebase is doing exactly one job for you: **passwords and login**.
Everything else is Cloudflare, on a plan with no credit card behind it.

---

## ✅ Tests — rewritten for the D1 API (DONE)

The four test files that mocked Firestore could not run at all: `vitest`,
`@testing-library/react`, `@testing-library/dom` and `jsdom` were missing from
`package.json`. All four now run against an in-memory fake of the Worker.

```
npm install          # pulls the new devDependencies
npm test             # 39 tests, 6 files — all green
npm run test:watch
```

What changed:

| File | Was | Now |
| --- | --- | --- |
| `tests/helpers/fakeApi.ts` | — | in-memory stand-in for the Worker (version-guarded writes, 409 on stale, unique nicknames/invites) |
| `tests/helpers/eventually.ts` | — | `waitFor()` replacement (see note below) |
| `tests/fixtures/new_bulk_test.csv` | referenced but never committed | generated from the real vocabulary (773 rows: 772 matches + 1 new word) |
| `tests/bulkImportStore.test.ts` | mocked `runTransaction` | real optimistic locking, 409 retry path |
| `tests/CardProgress.test.tsx` | mocked `onSnapshot` | poll + push against the fake API |
| `tests/bulkImportFlow.test.tsx` | mocked `runTransaction` | full app, 773-row CSV import, reload survives |
| `tests/practiceDiscovery.test.tsx` | mocked `onSnapshot` | full app quiz (rewritten — see below) |

Two real bugs surfaced while porting them, both now fixed in `src/`:

1. **Hot retry loop** — `CardProgress` re-flushed immediately after a failed
   write, so a dead connection meant a request every few milliseconds. It now
   only re-flushes when something *newer* appeared; retries wait for the 30 s
   interval or the `online` event.
2. **`Failed to fetch` shown to users** — `api.ts` let a rejected `fetch()`
   escape as a raw `TypeError`. It now throws `ApiError(0, 'Cannot reach the
   server. Check your internet connection.')`, and the import dialog maps
   status 0 to the friendly "needs an online connection" message.

Two testing notes worth knowing:

- `waitFor()` deadlocks in this app (its internal interval stops resuming once
  the provider's promise chains are in flight). `tests/helpers/eventually.ts`
  polls with an `act()`-wrapped sleep instead. Use `waitFor` elsewhere if you
  like — it works in the other files.
- `practiceDiscovery.test.tsx` was written against a quiz UI that does not
  exist in this commit (`progress`, `button-save`, `button-restart`,
  `progress-sync-error`, `quiz-stats-recent` are nowhere in `src/`). It was
  rewritten to test the quiz that *is* there: opening a card writes one
  discovery row, a later visit shows `Seen before`, and an offline write stays
  optimistic and syncs once the connection returns.

---

## Watching your budget

After each slice, check what you actually spend:

- **Cloudflare:** Dashboard → Workers (requests/day) and D1 → Metrics (rows read/written).
- **Firebase:** Console → Firestore → Usage (reads/day). This number should fall sharply
  after slice 2.

Set yourself a reminder at 80% of 100,000 requests/day and 4,000,000 rows/day — both
reset at 00:00 UTC.
