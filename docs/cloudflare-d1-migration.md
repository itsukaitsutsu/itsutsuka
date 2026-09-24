# MyKotoba: Firebase → Cloudflare (D1) migration guide

**Audience:** you know React/Vite, but not servers, databases or Cloudflare.
**Goal:** decide whether moving off Firebase is worth it, then do it step by step on the $0 plans.

Everything below is written against *your* code as it exists today (`src/App.tsx`,
`src/components/CardProgress.tsx`, `src/lib/bulkImportStore.ts`, `firestore.rules`).

---

## TL;DR (read this, then decide)

1. **D1 is only a database.** It is not a Firebase replacement. Firestore gives you a
   database *plus* auth, live updates, security rules and a browser SDK in one package.
   D1 is "SQLite on Cloudflare" — nothing more. **Your browser cannot talk to D1 directly,
   ever.** To use it you must write a small server (a Cloudflare **Worker**) that sits
   between the browser and the database.
2. **So the real migration is:** `Firebase → Cloudflare Worker (your code) + D1 (+ your own auth)`.
   That's why it's a project, not a settings change.
3. **Both are genuinely free and both hard-stop** (no surprise bills): Firebase Spark
   blocks you at 50,000 document reads/day; Cloudflare stops you at 100,000 Worker
   requests/day and 5,000,000 D1 rows read/day [2](https://community.cloudflare.com/t/d1-d1-enforces-free-tier-daily-query-limits/954367) [3](https://freetier.co/articles/cloudflare-d1-free-tier-limits-pricing-and-alternatives).
   "Truly free" means *hard cap, then the app breaks*, not *unlimited*.
4. **The free allowance you gain is real and large** (roughly 100× the read headroom), but
   you pay for it with: writing a backend, losing real-time sync, and a **10 ms CPU limit
   per request** that makes password hashing on the free plan impossible.
5. **My recommendation for you:** migrate the *data* to D1 behind a Worker, but **keep
   Firebase Auth for logging in** (it's free, and Firebase passwords literally cannot be
   moved to another system). You can drop Firebase Auth later if you still want to.

---

## Part 1 — The one big idea: what actually changes

### Today (Firebase)

```
┌──────────────┐        firebase/firestore SDK         ┌──────────────────┐
│  React app   │  ───────────────────────────────────► │  Cloud Firestore │
│  (browser)   │  ◄────── onSnapshot (live updates) ── │  + Firebase Auth │
└──────────────┘                                       └──────────────────┘
        ▲
        │ security = firestore.rules (a file in your repo)
```

No server code of yours runs anywhere. That's why `firestore.rules` is 9 KB and is
described in your own code as *"the entire server-side authorisation layer"*.

### After (Cloudflare)

```
┌──────────────┐   fetch('/api/...')   ┌───────────────────┐   SQL   ┌──────┐
│  React app   │ ───────────────────► │  Cloudflare Worker │ ──────► │  D1  │
│  (browser)   │ ◄────── JSON ──────── │  (YOUR code)       │ ◄────── │ SQLite│
└──────────────┘                       └───────────────────┘         └──────┘
        ▲                                      ▲
        │ auth: Firebase ID token              │ security = YOUR code
        │       (sent in header)               │ (no more firestore.rules)
```

Three things you now own that Firebase used to do for you:

| Firebase did it | On Cloudflare you must build it |
|---|---|
| `firestore.rules` (authorisation) | `if (uid !== row.uid) return 401` in every route |
| `onSnapshot` (live updates) | polling, or SSE, or Durable Objects |
| Firebase Auth (login, reset emails) | keep Firebase Auth, or write your own |

---

## Part 2 — The limits, side by side (verified Sept 2026)

### Firebase — Spark plan (free, no credit card)

| What | Free allowance | What happens at the cap |
|---|---|---|
| Firestore document **reads** | **50,000 / day** | app is blocked until it resets |
| Firestore document writes | 20,000 / day | blocked |
| Firestore document deletes | 20,000 / day | blocked |
| Firestore storage | 1 GiB total | blocked |
| Firestore egress | 10 GiB / month | blocked |
| **Authentication (email/password)** | **free up to 50,000 monthly active users** | then $0.0055/MAU |
| Hosting | 10 GB storage, 360 MB/day transfer | blocked |
| Cloud Functions | effectively needs Blaze | — |

Sources: [Firestore pricing (official)](https://cloud.google.com/firestore/pricing),
[Firebase pricing 2026](https://www.budgetforge.dev/tools/firebase-pricing-2026),
[Firebase Auth pricing](https://blog.logto.io/firebase-authentication-pricing).

### Cloudflare — Workers Free plan (no credit card)

| What | Free allowance | What happens at the cap |
|---|---|---|
| **Worker requests** | **100,000 / day** | Error 1027, functions stop, static site keeps loading |
| **CPU time per request** | **10 ms** | Error 1102, that request is killed |
| D1 **rows read** | **5,000,000 / day** | queries fail until 00:00 UTC |
| D1 rows written | 100,000 / day | queries fail until 00:00 UTC |
| D1 storage | 5 GB total (all DBs) | new writes blocked |
| Static assets (Pages / Workers assets) | **unlimited requests**, 500 builds/month | — |
| KV | 100k reads / 1k writes per day | — |
| R2 object storage | 10 GB | — |

Sources: [Cloudflare Workers limits](https://markaicode.com/benchmarks/cloudflare-workers-scalability-benchmark/),
[D1 free tier](https://freetier.co/articles/cloudflare-d1-free-tier-limits-pricing-and-alternatives),
[D1 hard enforcement since 1 Sept 2026](https://community.cloudflare.com/t/d1-d1-enforces-free-tier-daily-query-limits/954367).

### The translation that matters for MyKotoba

Firestore counts **documents**. D1 counts **rows scanned** (like documents) and Cloudflare
counts **requests** (which Firestore does not limit at all). Concretely, for one user
session of your app:

| Operation | Firestore cost | D1 + Worker cost |
|---|---|---|
| Load my profile (`userData/{uid}`) | 1 read | 1 row + 1 request |
| Load discovery progress | **1 read per card** (!) | rows changed since last sync (usually 0) + 1 request |
| Leaderboard top 50 | 50 reads | ~50 rows (indexed) + 1 request |
| Friends / invites | a few reads each | a few rows each |
| Save a quiz result | 1–2 writes | 1–3 rows written |

Two things to notice:

- Firestore charges you **one read per card** every time the discovery collection is read.
  Your `cardDiscovery` subcollection holds one document *per vocabulary card*. A learner
  with 2,000 seen cards costs 2,000 reads on every reconnect — that's 4% of your entire
  daily free quota, for one person, in one tab. **This is very likely the thing that pushes
  you off Firebase first.**
- Cloudflare's new bottleneck is **requests** (100k/day), because you'll replace
  `onSnapshot` with polling. At a 20-second poll, a 30-minute session ≈ 90 requests.
  That's ~1,000 sessions/day — still far more than Firestore's ~166 (50,000 ÷ 300).

**Bottom line:** D1 free gives you roughly **100× the data headroom** and ~5–10× the
traffic headroom, in exchange for writing a backend.

---

## Part 3 — Should you actually migrate? (honest answer)

Migrate if:
- You're hitting (or will hit) 50,000 Firestore reads/day. Check it: Firebase Console →
  Firestore → Usage tab.
- You want to learn how backends work, or you want your data in plain SQL you can export
  with `sqlite3`.
- You want no Google dependency.

**Don't migrate yet if** you're comfortably under the cap and the app works. A cheaper
first fix is to optimise Firestore: stop reading the whole `cardDiscovery` collection
(page it, or keep the "seen" set as one array in the user doc) and cache the leaderboard.
That's an afternoon, not a weekend.

### What you lose by leaving Firestore (honest list)

Firestore is not just a database — it's a database *plus* four services. Here is what
actually disappears, and what that costs you in this app.

| Firestore feature | On Cloudflare | How much it hurts MyKotoba |
|---|---|---|
| **`onSnapshot` live sync** | Nothing in D1. Polling (laggy) or Durable Objects + WebSockets (you build it) | **Most painful.** Especially if you add multiplayer — see `docs/multiplayer-architecture.md` |
| **Offline writes queue** (SDK queues writes offline, flushes on reconnect) | You build a retry queue yourself | Moderate — you already cache to localStorage and show "Saved on this device · waiting for cloud sync" |
| **Security rules** (declarative, audited, apply to every path automatically) | Your own `if` statements, in every route | Moderate — one forgotten `WHERE uid = ?` leaks data |
| **Interactive transactions** (read → decide → write, atomically) | Not supported by D1. Single atomic statements or version checks only | Low — both of yours were replaced with one SQL statement |
| **Atomic transforms** (`increment()`, `arrayUnion()`, `serverTimestamp()`) | Plain SQL (`bonus = bonus + ?`) | None — SQL is better here |
| **Multi-region replication, cross-device conflict handling** | D1 is single-primary; you design version columns | Low at hobby scale |
| **Managed backups / PITR** | `wrangler d1 export` + D1 Time Travel (check current plan limits) | Low — Firestore's managed backups need Blaze anyway |
| **Nice data browser in the console** | Cloudflare's D1 dashboard is functional but plainer | Cosmetic |

### What you gain

- ~**100× the read headroom** (5M rows/day vs 50k docs/day) — the thing that likely
  pushed you here.
- **Real SQL**: joins, aggregates, ad-hoc questions, `sqlite3` export, no denormalising.
- **Unlimited free egress** (Firestore caps at 10 GiB/month).
- **One platform** for hosting, API and database; no Google dependency for data.
- Predictable cost at scale (Firestore reads are $0.06/100k once you pass the cap).

### What you keep (Option A)

Firebase Auth: login, **password-reset emails**, token security, admin-created accounts,
and the uid you already use as your primary key.

**Nothing is irreversible.** You can run both systems side by side (dual-write during the
transition) and keep Firebase as a fallback until you're confident.

If you're not sure: build Step 2 and Step 3 below (database + one Worker route) in a
throwaway branch and see how it feels. Nothing is irreversible.

---

## Part 4 — Pick your login strategy (important, and non-obvious)

Firebase has two separate products: **Auth** (login) and **Firestore** (database). You can
move one and keep the other.

### First: who actually sends that "reset password" email today?

Not Firestore. **Firebase Auth** sends it, using Google's own email infrastructure, for
free. Firestore (your database) has nothing to do with email — it just stores documents.

So the moment you switch Firebase Auth off, **nothing is left to send that email**. It's
not that the feature is "lost" — it's that it was a *service* Google was running for you,
and now it's your job. Your users can still get reset emails; you just have to send them
yourself through an email provider.

Two separate problems then appear, and they're often confused with each other:

| # | Problem | Why it's a problem on the free plan |
|---|---|---|
| 1 | **Checking a password needs CPU** | Workers Free allows **10 ms of CPU per request**. A secure password check (PBKDF2/bcrypt/scrypt) takes ~100–300 ms. Login would be killed with Error 1102. |
| 2 | **Sending the email needs a provider** | Cloudflare's own Email Service requires the **Workers Paid** plan ($5/mo). Gmail/SMTP can't be used from a Worker. |

Both are solved at once by paying $5/mo — which is why you'll read "full migration costs
$5". But **problem 2 has a free workaround** (Resend's free tier: 3,000 emails/month,
100/day, no credit card), and **problem 1 disappears entirely if you never store a
password at all** (passwordless). Which means a full migration can genuinely be $0.

### Cost at a glance

| Option | Login method | Who sends reset email | Monthly cost | Effort |
|---|---|---|---|---|
| **A. Hybrid** | Firebase Auth | Firebase (free) | **$0** | small |
| **B. Own passwords** | email + password in D1 | you (Resend or Cloudflare) | **$5/mo** (CPU) | medium |
| **C. Passwordless** | email one-time code | you (Resend free) | **$0** | medium |
| **D. Passwordless / admin reset** | email code, or admin resets you | nobody | **$0** | small (fits MyKotoba: accounts are admin-made) |

### A vs D, at a glance (the two $0 options)

| | **A — Hybrid** | **D — Full cutover, no email** |
|---|---|---|
| Who checks the password | Firebase (Google) | **your Worker** |
| Where the password lives | Google's system | **your D1 database** (hashed) |
| Do existing users keep their password? | **Yes** | **No** — everyone must set a new one |
| "Forgot password" | self-service, Firebase emails the link | **contact the administrator** (manual reset) |
| Google dependency | still there (Auth only) | **none** |
| Cost | $0 | $0 |
| Work to build | small (send token + verify it) | medium–large (login, sessions, cookies, admin reset) |
| You own login security | no, Google does | **yes — including brute-force, rate limits, cookie flags** |

**"So with D, users can't reset their password?"** Correct — *not by themselves*, as long as
you send no email. They'd message the admin, who resets it. If you want self-service
resets, add a free email provider (Resend) and D becomes:

- **D + emailed reset code** — keep normal passwords (stretched in the browser so the
  Worker stays under 10 ms), and email a one-time code when someone forgets. **$0.**
- **C — passwordless** — drop passwords entirely; email a code at every login. The
  "forgot password" problem disappears because there is no password. **$0.**

Both are full cutovers with self-service account recovery, at zero cost. The only reason
to pay $5 is if you insist on hashing passwords *on the server* (Option B).

Four options:

### Option A — Hybrid: keep Firebase Auth, move data to D1 ⭐ recommended

- Browser logs in with Firebase as it does today → gets a short-lived **ID token**.
- Browser sends `Authorization: Bearer <token>` with every `/api` request.
- Worker verifies the token against Google's public keys (~1 ms CPU — fits the 10 ms
  budget easily) and trusts `payload.sub` as the user id.
- **Why it's great for you:** no password migration (Firebase stores passwords with its own
  scrypt settings and they can't be verified by another system), password-reset emails keep
  working for free, `Login.tsx` / `ForgotPassword.tsx` / `ResetPassword.tsx` stay as they are,
  and the Firebase uid you already use as your document id can be reused as the D1 primary key.
- **Cost:** $0. Firebase Auth is free up to 50,000 monthly active users.

### Option B — Full cutover: your own email + passwords in D1

- Worker sets an httpOnly cookie session; passwords hashed with PBKDF2.
- **The catch:** Workers Free gives you **10 ms of CPU per request**. A properly slow
  password hash needs tens to hundreds of ms. Login would hit Error 1102 and fail.
- **So this option costs $5/month** (Workers Paid → 30 s CPU), or you accept weak hashing
  (don't), or you do the stretching in the browser (clever, but easy to get wrong).
- You'd also need to send reset emails yourself: Cloudflare's own Email Service requires
  Workers Paid; Resend has a real free tier (3,000/month, 100/day)
  [compare](https://emailfordevelopers.com/compare/cloudflare-email-vs-resend/).

### Option C — Full cutover: passwordless (email one-time code / magic link)

- No passwords stored → no hashing problem → fits in 10 ms CPU.
- Needs an email sender (Resend free tier is enough for a hobby app).
- Fits MyKotoba nicely, because accounts are already created by the administrator, not
  self-serve.
- How it works: `POST /api/auth/start {email}` → store `sha256(code)` with a 10-minute
  expiry → email the 6-digit code → `POST /api/auth/verify {email, code}` → compare, set a
  session cookie. A SHA-256 hash + a D1 row is well under 1 ms of CPU.

### Option D — Full cutover: no email at all (admin resets passwords)

Your `Login.tsx` already says *"there is no self sign-up. Accounts are created centrally by
the administrator."* With ~a classroom's worth of learners, the simplest full cutover is:

- Users log in with email + password, hashed **once, slowly, in the browser** (PBKDF2
  600k iterations via WebCrypto, ~300 ms — the user's phone pays that cost, not your
  Worker), and the Worker only does a fast `HMAC(pepper, stretched)` (~0.1 ms).
- Forgot your password? Message the administrator, who runs:
  `npx wrangler d1 execute mykotoba-db --command "UPDATE users SET hash='' WHERE email='...'"`
  or uses a small admin page.
- **$0, no email provider, no CPU problem.** The trade-off: password resets are manual, and
  the browser-side stretching must be implemented correctly (never send the raw password).

> **Newbie translation:** "10 ms CPU" means how long your Worker is allowed to *think*.
> Waiting on the database or on `fetch()` doesn't count — only actual computing. Simple
> JSON + SQL + signature checks are fine (Cloudflare says the average Worker uses ~2.2 ms).
> Password hashing is the classic thing that blows the budget.

**Everything from here assumes Option A** — it's $0, it keeps your reset emails working,
and you can swap to B, C or D later without touching the database. Appendix B has the
details for the other three.

---

## Part 5 — The migration, step by step

### Step 0 — Install the tools

```bash
node -v            # need Node 22+ (current wrangler requires it; Node 20 is EOL)
npm i -g wrangler  # Cloudflare's CLI (or use the local one: npx wrangler)
wrangler login     # opens a browser, authorises the CLI
```

Keep your existing dev server as is: `npm run dev`.

> **Already scaffolded.** Steps 1–6 below exist in this repo: `wrangler.jsonc`,
> `migrations/0001_init.sql`, `worker/`, `src/lib/api.ts`, `src/hooks/usePoll.ts`, plus
> `dev:api` / `db:migrate:*` / `deploy` scripts in `package.json` and a `/api` proxy in
> `vite.config.ts`. Read the steps to understand them; see `worker/README.md` to run them.

### Step 1 — Create the project skeleton (in the same repo)

Your Vite app stays where it is. Add a Worker next to it:

```bash
cd mykotoba
npm i hono                 # tiny router for Workers
npm i -D wrangler @cloudflare/workers-types
mkdir -p worker migrations
```

`wrangler.jsonc` at the repo root:

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "mykotoba",
  "main": "worker/index.ts",
  // Must NOT be newer than the runtime your wrangler ships with, or the Worker
  // refuses to start. Lower it if you see "newest date supported ... is ...".
  "compatibility_date": "2026-05-03",
  "compatibility_flags": ["nodejs_compat"],

  // Your built Vite app. Cloudflare serves these files directly — static file
  // requests do NOT run your Worker, so they don't consume the 100k/day quota.
  // NB: vite.config.ts builds to dist/public (not dist) — note the kebab-case value.
  "assets": {
    "directory": "./dist/public",
    "not_found_handling": "single-page-application" // ← makes wouter/client routes work
  },

  "d1_databases": [
    { "binding": "DB", "database_name": "mykotoba-db", "database_id": "<paste after step 2>" }
  ],

  "vars": {
    "FIREBASE_PROJECT_ID": "kotobacabinet"     // your Firebase project id
  }
}
```

### Step 2 — Create the D1 database

```bash
npx wrangler d1 create mykotoba-db
```

It prints a `database_id`. Paste it into `wrangler.jsonc` above.

### Step 3 — The schema

Save as `migrations/0001_init.sql`. This is a direct translation of your
`firestore.rules` comment block (which documents every collection).

```sql
-- 1. Local mirror of the Firebase Auth user. The uid IS the Firebase uid.
CREATE TABLE IF NOT EXISTS users (
  uid         TEXT PRIMARY KEY,
  email       TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email);

-- 2. userData/{uid}  →  one row, JSON columns (Firestore doc, flattened)
CREATE TABLE IF NOT EXISTS user_data (
  uid          TEXT PRIMARY KEY,
  lists        TEXT NOT NULL DEFAULT '[]',   -- JSON array of WordList
  active_id    TEXT,
  custom_words TEXT NOT NULL DEFAULT '[]',   -- JSON array of CustomWord
  history      TEXT NOT NULL DEFAULT '[]',   -- JSON array of HistoryEntry (max 300)
  share_scores INTEGER NOT NULL DEFAULT 0,   -- SQLite has no bool: 0/1
  nickname     TEXT NOT NULL DEFAULT '',
  friend_code  TEXT NOT NULL DEFAULT '',
  version      INTEGER NOT NULL DEFAULT 0,   -- ← replaces Firestore transactions
  updated_at   TEXT NOT NULL
);

-- 3. userData/{uid}/cardDiscovery/{sha256}  →  one row per card
CREATE TABLE IF NOT EXISTS card_discovery (
  uid        TEXT NOT NULL,
  card_id    TEXT NOT NULL,       -- sha256 hex of key (same as Firestore doc id)
  key        TEXT NOT NULL,       -- "word:[...]" or "jlpt:id"
  seen       INTEGER NOT NULL,    -- 0/1
  version    INTEGER NOT NULL,    -- epoch ms, same as your DiscoveryRecord
  operation  TEXT NOT NULL,       -- uuid, tie-breaker
  updated_at TEXT NOT NULL,
  PRIMARY KEY (uid, card_id)
);
-- Only index what you query. Every extra index costs you rows *written* on
-- every insert (one real D1 user measured 10 rows written per insert purely
-- from indexes: https://github.com/Obein/DNS-Worker/issues/159).
CREATE INDEX IF NOT EXISTS idx_discovery_sync ON card_discovery(uid, version);

-- 4. leaderboard/{uid}
CREATE TABLE IF NOT EXISTS leaderboard (
  uid           TEXT PRIMARY KEY,
  display_name  TEXT NOT NULL,
  total_quizzes INTEGER NOT NULL,
  avg_pct       REAL NOT NULL,
  best_pct      REAL NOT NULL,
  bonus_points  INTEGER NOT NULL,
  best_day      INTEGER NOT NULL,
  jlpt_quizzes  INTEGER NOT NULL,
  jlpt_avg_pct  REAL NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_lb_bonus    ON leaderboard(bonus_points DESC);
CREATE INDEX IF NOT EXISTS idx_lb_avg      ON leaderboard(avg_pct DESC);
CREATE INDEX IF NOT EXISTS idx_lb_quizzes  ON leaderboard(total_quizzes DESC);

-- 5. nicknames/{lowercase}  → uniqueness enforced by PRIMARY KEY
CREATE TABLE IF NOT EXISTS nicknames (
  name TEXT PRIMARY KEY,
  uid  TEXT NOT NULL
);

-- 6. invites/{code}
CREATE TABLE IF NOT EXISTS invites (
  code       TEXT PRIMARY KEY,
  from_uid   TEXT NOT NULL,
  nickname   TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- 7. friendRequests/{uidA_uidB}   (Firestore "array-contains members" → two columns)
CREATE TABLE IF NOT EXISTS friend_requests (
  id         TEXT PRIMARY KEY,   -- "uidA_uidB" (sorted), same as your code
  from_uid   TEXT NOT NULL,
  to_uid     TEXT NOT NULL,
  from_name  TEXT NOT NULL,
  to_name    TEXT NOT NULL,
  code       TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fr_from ON friend_requests(from_uid);
CREATE INDEX IF NOT EXISTS idx_fr_to   ON friend_requests(to_uid);

-- 8. pairs/{uidA_uidB}
CREATE TABLE IF NOT EXISTS pairs (
  id         TEXT PRIMARY KEY,
  uid_a      TEXT NOT NULL,
  uid_b      TEXT NOT NULL,
  names      TEXT NOT NULL,      -- JSON: { uid: nickname }
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pairs_a ON pairs(uid_a);
CREATE INDEX IF NOT EXISTS idx_pairs_b ON pairs(uid_b);
```

Apply it locally and to the real database:

```bash
npx wrangler d1 execute mykotoba-db --local  --file=migrations/0001_init.sql
npx wrangler d1 execute mykotoba-db --remote --file=migrations/0001_init.sql
```

> SQLite gotchas for a Firestore brain: there is no `bool` (use `INTEGER` 0/1), no
> `array` type (store JSON as `TEXT`), no nested documents (use a table + foreign-ish key
> columns), and no automatic timestamps (pass ISO strings yourself).

### Step 4 — Verify the Firebase token in the Worker

`worker/auth.ts`:

```ts
import { createRemoteJWKSet, jwtVerify } from 'jose';   // npm i jose

// Google's public signing keys for Firebase ID tokens. `jose` caches them.
const JWKS = createRemoteJWKSet(
  new URL('https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com'),
);

export type Env = {
  DB: D1Database;
  FIREBASE_PROJECT_ID: string;
};

/**
 * Turns an `Authorization: Bearer <firebase id token>` header into a trusted uid.
 * Throws if the token is missing, expired, or was issued for a different project.
 */
export async function uidFromRequest(request: Request, env: Env): Promise<string> {
  const header = request.headers.get('Authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) throw new HttpError(401, 'Not signed in.');

  const { payload } = await jwtVerify(token, JWKS, {
    issuer:   `https://securetoken.google.com/${env.FIREBASE_PROJECT_ID}`,
    audience: env.FIREBASE_PROJECT_ID,
  });

  const uid = payload.sub;
  if (typeof uid !== 'string') throw new HttpError(401, 'Bad token.');
  return uid;                       // ← this is the same uid you used in Firestore
}

export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
```

### Step 5 — The API (Hono)

> The complete, compiling version lives in **`worker/index.ts`** in this repo — read that
> instead of typing this out. What follows is the abridged version so you can see the shape.

`worker/index.ts` — the core routes. Notice how every handler starts by resolving the uid
from the token, and then filters every query by that uid. **That's your new
`firestore.rules`.**

```ts
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { HttpError, uidFromRequest, type Env } from './auth';

const app = new Hono<{ Bindings: Env }>();

// Allow your Vite dev server and your production domain to call /api.
app.use('/api/*', cors({
  origin: (o) => (o.endsWith('.e2b.app') || o.includes('localhost') || o.endsWith('mykotoba.pages.dev') ? o : ''),
  credentials: true,
}));

app.onError((err, c) =>
  c.json({ error: err.message }, err instanceof HttpError ? err.status : 500));

// ── Helper: every authenticated route uses this ───────────────────────────────
async function me(c: any) {
  return { uid: await uidFromRequest(c.req.raw, c.env), env: c.env as Env };
}

// ── userData/{uid} ───────────────────────────────────────────────────────────
// Replaces: onSnapshot(doc(db,'userData',uid))  +  setDoc(..., {merge:true})
app.get('/api/me', async (c) => {
  const { uid, env } = await me(c);
  const row = await env.DB.prepare(
    `SELECT lists, active_id, custom_words, history, share_scores, nickname, friend_code, version
       FROM user_data WHERE uid = ?`,
  ).bind(uid).first();

  if (!row) {
    // First sign-in: create the row from whatever the browser has cached locally.
    await env.DB.prepare(
      `INSERT INTO user_data (uid, lists, active_id, custom_words, history, updated_at)
       VALUES (?, '[]', NULL, '[]', '[]', ?)`,
    ).bind(uid, new Date().toISOString()).run();
    return c.json({ lists: [], activeId: null, customWords: [], history: [],
                    shareScores: false, nickname: '', friendCode: '', version: 0 });
  }
  return c.json({
    lists:       JSON.parse(row.lists as string),
    activeId:    row.active_id,
    customWords: JSON.parse(row.custom_words as string),
    history:     JSON.parse(row.history as string),
    shareScores: !!row.share_scores,
    nickname:    row.nickname,
    friendCode:  row.friend_code,
    version:     row.version,
  });
});

// Replaces: pushToCloud({...}) — a merge patch with optimistic locking.
// Client sends the version it last saw; if the row changed meanwhile → 409 → refetch+retry.
app.put('/api/me', async (c) => {
  const { uid, env } = await me(c);
  const patch = await c.req.json<{
    lists?: unknown[]; activeId?: string | null; customWords?: unknown[]; history?: unknown[];
    shareScores?: boolean; nickname?: string; friendCode?: string; version: number;
  }>();
  const now = new Date().toISOString();

  const res = await env.DB.prepare(
    `UPDATE user_data SET
       lists        = COALESCE(?, lists),
       active_id    = COALESCE(?, active_id),
       custom_words = COALESCE(?, custom_words),
       history      = COALESCE(?, history),
       share_scores = COALESCE(?, share_scores),
       nickname     = COALESCE(?, nickname),
       friend_code  = COALESCE(?, friend_code),
       version      = version + 1,
       updated_at   = ?
     WHERE uid = ? AND version = ?`,
  ).bind(
    patch.lists        ? JSON.stringify(patch.lists)        : null,
    patch.activeId     !== undefined ? patch.activeId       : null,
    patch.customWords  ? JSON.stringify(patch.customWords)  : null,
    patch.history      ? JSON.stringify(patch.history)      : null,
    patch.shareScores  !== undefined ? (patch.shareScores ? 1 : 0) : null,
    patch.nickname     !== undefined ? patch.nickname       : null,
    patch.friendCode   !== undefined ? patch.friendCode     : null,
    now, uid, patch.version,
  ).run();

  if (res.meta.changes === 0) return c.json({ error: 'stale' }, 409);   // retry upstream
  return c.json({ ok: true, version: patch.version + 1 });
});

// ── cardDiscovery ────────────────────────────────────────────────────────────
// Replaces: onSnapshot(collection(...cardDiscovery)) — but only sends rows that
// changed since `since`, so an idle poll costs ZERO D1 rows.
app.get('/api/discovery', async (c) => {
  const { uid, env } = await me(c);
  const since = Number(c.req.query('since') ?? '0');
  const { results } = await env.DB.prepare(
    `SELECT key, seen, version, operation FROM card_discovery
      WHERE uid = ? AND version > ? ORDER BY version ASC LIMIT 5000`,
  ).bind(uid, since).all();
  return c.json({
    records: results.map((r) => ({ key: r.key, seen: !!r.seen, version: r.version, operation: r.operation })),
    syncedAt: Date.now(),
  });
});

// Replaces: runTransaction() in CardProgress.tsx.
// The whole "read, compare versions, then write" transaction collapses into ONE
// atomic SQL statement. If a stale write arrives, the WHERE clause drops it and
// RETURNING gives back whatever actually won.
app.post('/api/discovery', async (c) => {
  const { uid, env } = await me(c);
  const { records } = await c.req.json<{
    records: { key: string; cardId: string; seen: boolean; version: number; operation: string }[];
  }>();

  const now = new Date().toISOString();
  const statements = records.slice(0, 500).map((r) =>
    env.DB.prepare(
      `INSERT INTO card_discovery (uid, card_id, key, seen, version, operation, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(uid, card_id) DO UPDATE SET
         seen = excluded.seen, version = excluded.version,
         operation = excluded.operation, updated_at = excluded.updated_at
       WHERE excluded.version > card_discovery.version
          OR (excluded.version = card_discovery.version
              AND excluded.operation > card_discovery.operation)
       RETURNING key, seen, version, operation`,
    ).bind(uid, r.cardId, r.key, r.seen ? 1 : 0, r.version, r.operation, now),
  );

  if (!statements.length) return c.json({ settled: [] });
  const settled = (await env.DB.batch(statements))
    .flatMap((r) => (r.results ?? []) as { key: string; seen: number; version: number; operation: string }[])
    .map((r) => ({ key: r.key, seen: !!r.seen, version: r.version, operation: r.operation }));
  return c.json({ settled });
});

// ── leaderboard ──────────────────────────────────────────────────────────────
// Replaces: getDocs(query(collection(db,'leaderboard'), orderBy(sortBy,'desc'), limit(50)))
const SORTS: Record<string, string> = {
  bonusPoints: 'bonus_points', avgPct: 'avg_pct', totalQuizzes: 'total_quizzes',
};
app.get('/api/leaderboard', async (c) => {
  await uidFromRequest(c.req.raw, c.env);          // must be signed in to read
  const sort = SORTS[c.req.query('sort') ?? ''] ?? 'bonus_points';
  const { results } = await c.env.DB.prepare(
    `SELECT uid, display_name, total_quizzes, avg_pct, best_pct, bonus_points,
            best_day, jlpt_quizzes, jlpt_avg_pct, updated_at
       FROM leaderboard ORDER BY ${sort} DESC LIMIT 50`,   // sort is whitelisted: no injection
  ).all();
  return c.json(results);
});

// Replaces: setDoc(doc(db,'leaderboard',uid), {...}) and deleteDoc(...)
app.put('/api/leaderboard', async (c) => {
  const { uid, env } = await me(c);
  const p = await c.req.json<{ publish: boolean; displayName: string; stats?: any }>();
  if (!p.publish) {
    await env.DB.prepare('DELETE FROM leaderboard WHERE uid = ?').bind(uid).run();
    return c.json({ ok: true });
  }
  const s = p.stats;
  await env.DB.prepare(
    `INSERT INTO leaderboard (uid, display_name, total_quizzes, avg_pct, best_pct,
                              bonus_points, best_day, jlpt_quizzes, jlpt_avg_pct, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(uid) DO UPDATE SET
       display_name=excluded.display_name, total_quizzes=excluded.total_quizzes,
       avg_pct=excluded.avg_pct, best_pct=excluded.best_pct,
       bonus_points=excluded.bonus_points, best_day=excluded.best_day,
       jlpt_quizzes=excluded.jlpt_quizzes, jlpt_avg_pct=excluded.jlpt_avg_pct,
       updated_at=excluded.updated_at`,
  ).bind(uid, p.displayName, s.totalQuizzes, s.avgPct, s.bestPct,
         s.bonusPoints, s.bestDay, s.jlptQuizzes, s.jlptAvgPct, new Date().toISOString()).run();
  return c.json({ ok: true });
});

// ── nicknames, invites, friends ──────────────────────────────────────────────

// Replaces: setDoc(doc(db,'nicknames',key), {uid}) — the PRIMARY KEY makes it atomic.
app.post('/api/nickname', async (c) => {
  const { uid, env } = await me(c);
  const { name, previous } = await c.req.json<{ name: string; previous?: string }>();
  const key = String(name).trim().slice(0, 30).toLowerCase();
  if (key.length < 2) return c.json({ error: 'Nickname must be at least 2 characters.' }, 400);

  try {
    await env.DB.prepare('INSERT INTO nicknames (name, uid) VALUES (?, ?)').bind(key, uid).run();
  } catch {
    return c.json({ error: `"${name}" is already taken. Try another.` }, 409);
  }
  if (previous && previous.toLowerCase() !== key) {
    await env.DB.prepare('DELETE FROM nicknames WHERE name = ? AND uid = ?')
      .bind(previous.toLowerCase(), uid).run();
  }
  return c.json({ ok: true, name: key });
});

app.get('/api/invites/:code', async (c) => {
  await uidFromRequest(c.req.raw, c.env);
  const row = await c.env.DB.prepare(
    'SELECT from_uid, nickname FROM invites WHERE code = ?',
  ).bind(c.req.param('code').toUpperCase()).first();
  return row
    ? c.json({ from: row.from_uid, nickname: row.nickname })
    : c.json({ error: 'Code not found.' }, 404);
});

app.post('/api/invites', async (c) => {
  const { uid, env } = await me(c);
  const { code, nickname } = await c.req.json<{ code: string; nickname: string }>();
  try {
    await env.DB.prepare(
      'INSERT INTO invites (code, from_uid, nickname, created_at) VALUES (?,?,?,?)',
    ).bind(code, uid, nickname, new Date().toISOString()).run();
  } catch {
    return c.json({ error: 'That code already exists. Try again.' }, 409);
  }
  return c.json({ ok: true });
});

// Replaces: onSnapshot(query(friendRequests, where('members','array-contains',uid)))
app.get('/api/friend-requests', async (c) => {
  const { uid, env } = await me(c);
  const { results } = await env.DB.prepare(
    `SELECT id, from_uid, to_uid, from_name, to_name, code, created_at
       FROM friend_requests WHERE from_uid = ? OR to_uid = ? ORDER BY created_at DESC`,
  ).bind(uid, uid).all();
  return c.json(results.map((r) => ({
    id: r.id, from: r.from_uid, to: r.to_uid,
    fromName: r.from_name, toName: r.to_name, code: r.code, createdAt: r.created_at,
  })));
});

app.post('/api/friend-requests', async (c) => {
  const { uid, env } = await me(c);
  const { to, code } = await c.req.json<{ to: string; code: string }>();
  const [a, b] = [uid, to].sort();
  const id = `${a}_${b}`;

  const existing = await env.DB.prepare('SELECT 1 FROM pairs WHERE id = ?').bind(id).first();
  if (existing) return c.json({ error: 'You are already friends.' }, 409);

  const pending = await env.DB.prepare('SELECT from_uid FROM friend_requests WHERE id = ?').bind(id).first();
  if (pending) {
    if (pending.from_uid === uid) return c.json({ error: 'You already sent them an invitation.' }, 409);
    // They invited us first → entering their code accepts it immediately.
    await env.DB.batch([
      env.DB.prepare('INSERT OR IGNORE INTO pairs (id, uid_a, uid_b, names, created_at) VALUES (?,?,?,?,?)')
        .bind(id, a, b, '{}', new Date().toISOString()),
      env.DB.prepare('DELETE FROM friend_requests WHERE id = ?').bind(id),
    ]);
    return c.json({ ok: true, autoAccepted: true });
  }
  await env.DB.prepare(
    `INSERT INTO friend_requests (id, from_uid, to_uid, from_name, to_name, code, created_at)
     VALUES (?,?,?,(SELECT nickname FROM user_data WHERE uid = ?),?,?,?)`,
  ).bind(id, uid, to, uid, '', code, new Date().toISOString()).run();
  return c.json({ ok: true });
});

app.delete('/api/friend-requests/:id', async (c) => {
  const { uid, env } = await me(c);
  await env.DB.prepare('DELETE FROM friend_requests WHERE id = ? AND (from_uid = ? OR to_uid = ?)')
    .bind(c.req.param('id'), uid, uid).run();
  return c.json({ ok: true });
});

// Replaces: onSnapshot(query(pairs, where('members','array-contains',uid)))
app.get('/api/pairs', async (c) => {
  const { uid, env } = await me(c);
  const { results } = await env.DB.prepare(
    'SELECT id, uid_a, uid_b, names, created_at FROM pairs WHERE uid_a = ? OR uid_b = ?',
  ).bind(uid, uid).all();
  return c.json(results.map((r) => ({
    id: r.id, members: [r.uid_a, r.uid_b],
    names: JSON.parse(r.names as string), createdAt: r.created_at,
  })));
});

app.post('/api/pairs', async (c) => {
  const { uid, env } = await me(c);
  const { requestId, names } = await c.req.json<{ requestId: string; names: Record<string, string> }>();
  const req = await env.DB.prepare('SELECT * FROM friend_requests WHERE id = ?').bind(requestId).first();
  if (!req) return c.json({ error: 'No such invitation.' }, 404);
  if (req.to_uid !== uid) return c.json({ error: 'Only the invited person can confirm.' }, 403);

  await env.DB.batch([
    env.DB.prepare('INSERT OR IGNORE INTO pairs (id, uid_a, uid_b, names, created_at) VALUES (?,?,?,?,?)')
      .bind(requestId, req.from_uid < req.to_uid ? req.from_uid : req.to_uid,
                       req.from_uid < req.to_uid ? req.to_uid : req.from_uid,
            JSON.stringify(names), new Date().toISOString()),
    env.DB.prepare('DELETE FROM friend_requests WHERE id = ?').bind(requestId),
  ]);
  return c.json({ ok: true });
});

app.delete('/api/pairs/:id', async (c) => {
  const { uid, env } = await me(c);
  await env.DB.prepare('DELETE FROM pairs WHERE id = ? AND (uid_a = ? OR uid_b = ?)')
    .bind(c.req.param('id'), uid, uid).run();
  return c.json({ ok: true });
});

export default app;
```

### Step 6 — The client: one small file replaces the Firestore SDK

Create `src/lib/api.ts`:

```ts
import { auth } from '@/utils/firebase/client';   // still used, but ONLY for the token

const BASE = import.meta.env.DEV ? '/api' : '/api';   // same origin in both cases

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const user = auth.currentUser;
  const headers = new Headers(init.headers);
  headers.set('Content-Type', 'application/json');
  if (user) headers.set('Authorization', `Bearer ${await user.getIdToken()}`);

  const res = await fetch(`${BASE}${path}`, { ...init, headers, credentials: 'same-origin' });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(res.status, body.error ?? `Request failed (${res.status})`, body);
  }
  return res.json() as Promise<T>;
}

export class ApiError extends Error {
  constructor(public status: number, message: string, public body: any) { super(message); }
}

export const api = {
  me:               ()                  => call<MeResponse>('/me'),
  saveMe:           (patch: MePatch)    => call<{ version: number }>('/me', { method: 'PUT', body: JSON.stringify(patch) }),
  discovery:        (since: number)     => call<DiscoverySync>(`/discovery?since=${since}`),
  pushDiscovery:    (records: any[])    => call<{ settled: any[] }>('/discovery', { method: 'POST', body: JSON.stringify({ records }) }),
  leaderboard:      (sort: string)      => call<any[]>(`/leaderboard?sort=${sort}`),
  publish:          (publish: boolean, displayName: string, stats: any) =>
    call('/leaderboard', { method: 'PUT', body: JSON.stringify({ publish, displayName, stats }) }),
  claimNickname:    (name: string, previous?: string) =>
    call('/nickname', { method: 'POST', body: JSON.stringify({ name, previous }) }),
  lookupInvite:     (code: string)      => call<{ from: string; nickname: string }>(`/invites/${code}`),
  createInvite:     (code: string, nickname: string) =>
    call('/invites', { method: 'POST', body: JSON.stringify({ code, nickname }) }),
  friendRequests:   ()                  => call<any[]>('/friend-requests'),
  sendFriendRequest:(to: string, code: string) =>
    call('/friend-requests', { method: 'POST', body: JSON.stringify({ to, code }) }),
  deleteFriendRequest: (id: string)     => call(`/friend-requests/${id}`, { method: 'DELETE' }),
  pairs:            ()                  => call<any[]>('/pairs'),
  confirmPair:      (requestId: string, names: Record<string, string>) =>
    call('/pairs', { method: 'POST', body: JSON.stringify({ requestId, names }) }),
  deletePair:       (id: string)        => call(`/pairs/${id}`, { method: 'DELETE' }),
};
```

Then delete `import ... from 'firebase/firestore'` everywhere (keep `firebase/auth`), and
use **Appendix A** as your line-by-line checklist.

### Step 7 — Replace `onSnapshot` with polling

Firestore pushed changes to you; D1 can't. Add `src/hooks/usePoll.ts`:

```ts
import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * The closest simple equivalent of onSnapshot: re-run `fetcher` on an interval,
 * but only while the tab is visible, and immediately when the user comes back.
 * `since` lets the server return 0 rows when nothing changed.
 */
export function usePoll<T>(fetcher: (since: number) => Promise<T>,
                           onData: (data: T) => void,
                           intervalMs = 20_000) {
  const [error, setError] = useState<unknown>(null);
  const since = useRef(0);
  const fetcherRef = useRef(fetcher);
  const onDataRef = useRef(onData);
  fetcherRef.current = fetcher;
  onDataRef.current = onData;

  const tick = useCallback(async () => {
    if (document.visibilityState !== 'visible') return;
    try { onDataRef.current(await fetcherRef.current(since.current)); setError(null); }
    catch (e) { setError(e); }        // keep the last good data — never blank the UI
  }, []);

  useEffect(() => {
    void tick();
    const id = window.setInterval(tick, intervalMs);
    const onWake = () => void tick();
    document.addEventListener('visibilitychange', onWake);
    window.addEventListener('online', onWake);
    window.addEventListener('focus', onWake);
    return () => {
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', onWake);
      window.removeEventListener('online', onWake);
      window.removeEventListener('focus', onWake);
    };
  }, [tick, intervalMs]);

  return error;
}
```

If 100k requests/day ever becomes your wall, the upgrade path is **SSE** (one long-lived
request per session instead of hundreds of polls) — check Cloudflare's current docs for
the maximum response duration on your plan before you rely on it.

### Step 8 — Run it locally

`vite.config.ts` — add a proxy so the browser's `/api` calls reach Wrangler:

```ts
export default defineConfig({
  // ...existing config...
  server: {
    proxy: { '/api': { target: 'http://127.0.0.1:8787', changeOrigin: true } },
  },
});
```

Two terminals:

```bash
npx wrangler dev                 # API on :8787, uses a local copy of D1
npm run dev                      # Vite on :5173, proxies /api → :8787
```

Add scripts to `package.json`:

```json
"dev:api": "wrangler dev",
"db:local": "wrangler d1 execute mykotoba-db --local --file=migrations/0001_init.sql",
"db:remote": "wrangler d1 execute mykotoba-db --remote --file=migrations/0001_init.sql",
"deploy": "npm run build && wrangler deploy"
```

### Step 9 — Deploy

```bash
npm run build            # produces ./dist
npx wrangler deploy      # uploads the Worker + ./dist as static assets
```

First deploy asks you to create a `*.workers.dev` subdomain. Add your own domain later
under Workers → your worker → Settings → Domains & Routes (Cloudflare must be your DNS
nameserver). Nothing else to configure — no separate hosting service, because the Worker
project serves the built app and the API from the same place.

Also set `FIREBASE_PROJECT_ID` as a **secret** if you'd rather not commit it:
`npx wrangler secret put FIREBASE_PROJECT_ID`.

### Step 10 — Cutover checklist

- [ ] `npm run typecheck` passes with no `firebase/firestore` imports left in `src/`
- [ ] Sign in, create a list, reload → data survives (D1, not localStorage)
- [ ] Open two browsers/devices, mark a card seen → it syncs within one poll interval
- [ ] Leaderboard: turn sharing on, set a nickname, see yourself; try a taken nickname → 409
- [ ] Friends: generate code → send → confirm → remove, from two accounts
- [ ] Reset-password flow still works (it's untouched Firebase Auth)
- [ ] Watch usage for a week: Cloudflare Dashboard → Workers (requests) and D1 → Metrics
      (rows read/written). Set yourself a reminder at 80% of 100k/day and 4M rows/day.
- [ ] Then delete `firestore.rules` and remove the `firebase/firestore` dependency:
      `npm uninstall firebase/firestore` → just `npm uninstall firebase` if you later
      drop Firebase Auth too.

---

## Part 6 — Newbie traps (each of these has bitten someone)

| Trap | Why it bites | Fix |
|---|---|---|
| Trying to call D1 from the browser | There is no browser SDK; the API token would be public | Always go through your Worker |
| Forgetting `uid` in a `WHERE` | You just leaked everyone's data — you *are* the security rules now | Every query starts with the uid from the token |
| String-building SQL | SQL injection | Never interpolate user input; bind `?`. Whitelist sort columns (see `/api/leaderboard`) |
| Assuming D1 has transactions like Firestore | D1 has no interactive (read-then-write) transactions | Use one atomic statement (`INSERT...ON CONFLICT...WHERE`) or optimistic `version` + 409 retry |
| Reading the whole discovery table every poll | Burns your row budget fast | `?since=<version>` and return only changes |
| Adding an index "just in case" | Every index adds rows *written* on every insert | Index only what you query |
| `onSnapshot` muscle memory | D1 has no push | Poll (Step 7) or SSE |
| localStorage as the source of truth | Your app already caches there — keep that, but always reconcile with the server | Your existing `persistWordLists()` pattern is fine |
| 10 ms CPU | Heavy crypto/JSON kills the request | Keep handlers thin; never hash passwords on Free |
| Hitting a cap | Both platforms hard-stop; the app looks "broken", not "billed" | Monitor; Cloudflare emails you at the D1 cap — set your own earlier alert |

---

## Part 7 — Realistic effort

| Piece | Rough time (first time) |
|---|---|
| Step 0–3 (accounts, tools, schema) | 1–2 hours |
| Step 4–5 (Worker API, all routes) | 1–2 days |
| Step 6 (client swap, Appendix A) | 1 day |
| Step 7 (polling + reconciliation) | half a day |
| Step 8–10 (dev wiring, deploy, testing) | half a day |
| **Total** | **~3–4 focused days** |

Suggested order if you want to see progress fast: **`userData` only first**
(`GET/PUT /api/me`), deploy that, then discovery, then leaderboard, then friends. Each
slice is independently shippable and you can run both systems side by side while you go.

---

## Appendix A — Every Firestore call in your repo, and its replacement

`src/App.tsx`

| Line | Today | Replace with |
|---|---|---|
| 355–405 | `onSnapshot(doc(db,'userData',uid))` → sets lists/activeId/customWords/history/shareScores/nickname/friendCode | `GET /api/me` polled every 20 s |
| 390 | `getDoc(doc(db,'invites',code))` (verify my code still points at me) | `GET /api/invites/:code` |
| 396 | `setDoc` create initial user doc from localStorage | server does it inside `GET /api/me` |
| 413–417 | `onSnapshot(query(friendRequests, where('members','array-contains',uid)))` | `GET /api/friend-requests` polled |
| 423 | `pushToCloud({...})` merge patch | `PUT /api/me` (+ `version`, retry on 409) |
| 510–535 | `publishSummary()` → set/delete `leaderboard/{uid}` | `PUT /api/leaderboard` with `{publish:false}` to remove |
| 546–560 | `setDoc(nicknames/{key})` + delete old | `POST /api/nickname` (409 = taken) |
| 582–590 | `generateFriendCode()` — getDoc then setDoc invites | `POST /api/invites` (409 → regenerate) |
| 603–640 | `addFriendByCode()` — invites/pairs/friendRequests reads + writes | `GET /api/invites/:code` then `POST /api/friend-requests` |
| 649–662 | `confirmFriendRequest()` | `POST /api/pairs` |
| 666–676 | `declineFriendRequest()` / `cancelFriendRequest()` | `DELETE /api/friend-requests/:id` |
| 683–686 | `removeFriend()` | `DELETE /api/pairs/:id` |
| 2141 | leaderboard top-50 query | `GET /api/leaderboard?sort=…` |
| 2231–2236 | `onSnapshot(query(pairs, where('members','array-contains',uid)))` | `GET /api/pairs` polled |
| 2254 | `onSnapshot(doc(db,'leaderboard',other))` per friend | fold into `GET /api/pairs` (return each friend's bonus points in one call) |

`src/components/CardProgress.tsx`

| Line | Today | Replace with |
|---|---|---|
| 59–85 | `runTransaction` compare version then set | `POST /api/discovery` (single atomic upsert, `RETURNING`) |
| 88–130 | `onSnapshot(collection(...cardDiscovery))` full collection | `GET /api/discovery?since=<version>` polled |

`src/lib/bulkImportStore.ts`

| Line | Today | Replace with |
|---|---|---|
| 10–18 | `runTransaction`: read user doc, compute, write lists/customWords/activeId | `GET /api/me` → compute with `prepareBulkImport()` → `PUT /api/me` with `version`; on 409 refetch and retry once |

`src/auth/*` — unchanged under Option A (still Firebase Auth).

---

## Appendix B — If you choose to drop Firebase Auth too

**Option B (own passwords):** add a `sessions` table
(`id TEXT PK, uid TEXT, expires_at INTEGER`) and `user_credentials`
(`uid TEXT PK, hash TEXT, salt TEXT, iterations INTEGER`). Use httpOnly,
`Secure`, `SameSite=Lax` cookies. Set the password. **Budget $5/month** for Workers
Paid so the KDF isn't killed by the 10 ms CPU cap — this is the one place I would not
try to stay on the free plan, because cutting PBKDF2 iterations low enough to fit 10 ms
means weak password storage.

**Option C (passwordless):** `POST /api/auth/start {email}` → generate a 6-digit code,
store `sha256(code)` with a 10-minute expiry, email it; `POST /api/auth/verify {email, code}`
→ compare, create a session cookie. No password hashing, so it fits in 10 ms CPU.
Resend's free tier (3,000 emails/month, 100/day) is enough for a hobby app;
Cloudflare's own Email Service needs Workers Paid.

**In both cases**, keep the Firebase uid: export users first
(`firebase auth:export users.json --format=json`) and insert `uid` + `email` into the
`users` table so every other row keeps matching.
