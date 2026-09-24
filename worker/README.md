# MyKotoba API (Cloudflare Worker + D1)

A small backend that replaces Cloud Firestore. **Firebase Auth stays** — the browser
sends its Firebase ID token, this Worker verifies it and reads/writes D1.

```
React app ──Bearer <firebase id token>──► Worker (this folder) ──SQL──► D1
                                              ▲
                                              └── verification = your security rules
```

## What's here

| File | Purpose |
|---|---|
| `worker/index.ts` | Every API route. **This is your new `firestore.rules`.** |
| `worker/auth.ts` | Verifies Firebase ID tokens (~1 ms CPU) → trusted `uid` |
| `migrations/0001_init.sql` | D1 schema — 1:1 with the collections in `firestore.rules` |
| `src/lib/api.ts` | Browser client (replaces `firebase/firestore` imports) |
| `src/hooks/usePoll.ts` | Polling hook that stands in for `onSnapshot` |
| `wrangler.jsonc` | Worker + D1 + static assets config |

For the invite-party repair, balance migration, and Pages Durable Object binding, see [RANKED_PARTY_FIX.md](../docs/RANKED_PARTY_FIX.md).

## One-time setup

```bash
# Node 22+ is required by the current wrangler (Node 20 is end-of-life)
node -v

# 1. Create the database, then paste the id it prints into wrangler.jsonc
npx wrangler d1 create mykotoba-db

# 2. Create the tables (local copy + the real one)
npm run db:migrate:local
npm run db:migrate:remote

# 3. Check FIREBASE_PROJECT_ID in wrangler.jsonc matches VITE_FIREBASE_PROJECT_ID in .env
```

## Everyday commands

```bash
npm run dev:api     # Worker on :8787 (uses the LOCAL D1 copy, no login needed)
npm run dev         # Vite on :5173, proxies /api → :8787
npm run typecheck:worker
npm run deploy      # builds the app, then deploys Worker + static assets together
```

Smoke test the API without signing in:

```bash
curl http://127.0.0.1:8787/api/health              # {"ok":true,...}
curl http://127.0.0.1:8787/api/me                  # 401 {"error":"Not signed in."}
```

## Routes

| Method | Path | Replaces (Firestore) |
|---|---|---|
| GET | `/api/me` | `onSnapshot(doc(db,'userData',uid))` |
| PUT | `/api/me` | `pushToCloud()` / `setDoc(...,{merge:true})` |
| GET | `/api/discovery?since=` | `onSnapshot(collection(...cardDiscovery))` |
| POST | `/api/discovery` | `runTransaction()` in `CardProgress.tsx` |
| GET | `/api/leaderboard?sort=` | leaderboard top-50 query |
| PUT | `/api/leaderboard` | `publishSummary()` (publish or remove) |
| POST | `/api/nickname` | `nicknames/{name}` claim + release old |
| GET | `/api/invites/:code` | invite lookup |
| POST | `/api/invites` | `generateFriendCode()` |
| GET | `/api/friend-requests` | live friend-request listener |
| POST | `/api/friend-requests` | `addFriendByCode()` |
| DELETE | `/api/friend-requests/:id` | decline / cancel |
| GET | `/api/pairs?withBonus=1` | pairs listener + per-friend leaderboard reads |
| POST | `/api/pairs` | `confirmFriendRequest()` |
| DELETE | `/api/pairs/:id` | `removeFriend()` |

## Rules for adding a route

1. First line: `const uid = await uidFromRequest(c.req.raw, c.env);`
2. Every query filters by that `uid` — never trust an id from the request body.
3. Bind every value with `?`; never build SQL with string concatenation.
4. Keep it thin — Workers Free gives you 10 ms of CPU per request.

## Verified / known caveats

- ✅ Worker boots locally, `/api/health` 200, unauthenticated routes return JSON 401,
  unknown `/api/*` returns JSON 404.
- ✅ Schema applies cleanly; verified that a **stale** discovery write is dropped, a
  **newer** one wins, `version`-guarded updates reject stale patches, nickname and
  invite uniqueness raise `UNIQUE constraint failed` (the API turns those into 409).
- ⚠️ **Node 22 + `wrangler@latest` needed for the SPA fallback.** Older wrangler (e.g.
  4.86 on Node 20) does not expose the `ASSETS` binding, so hard-refreshing a client
  route such as `/dashboard` returns 404 instead of `index.html`. The code detects the
  missing binding and logs a warning.
- ⚠️ `compatibility_date` must not be newer than your runtime supports, or the Worker
  refuses to start. If you see "newest date supported … is YYYY-MM-DD", set it to that.
- ⚠️ In local `wrangler dev`, `result.meta.changes` is not populated, so the 409
  stale-check on `PUT /api/me` is effectively skipped locally. It works on real D1.
