# Ranked "Connection interrupted. Reconnecting automatically…" loop — root cause and fix

## Symptom

Opening any ranked room (solo or party) shows

> Connection interrupted. Reconnecting automatically…
> Connecting to your match…

forever. The HTTP preflight (`GET /api/ranked/matches/:id`) succeeds, so the
WebSocket is what fails, and it fails on every retry.

## Root cause (two layers)

### 1. Production D1 is missing migration `0005_ranked_cursed_cards.sql`

The current code (`worker/matchRoom.ts → finish()`) settles every match with
`UPDATE ranked_accounts SET … cursed = ? …`. On the live database that column
does not exist yet, so settlement throws
`D1_ERROR: no such column: cursed`.

This was verified by replaying the flow against Miniflare with migrations
0001–0004 only: the last question of a round produces exactly this error, and
every reconnect after that is rejected.

### 2. The Durable Object turned that error into a permanent, opaque reconnect loop

- `MatchRoom.fetch()` ran `tick()` (which calls `finish()` when a deadline has
  passed) **before** accepting the WebSocket. Any settlement error was returned
  as an HTTP `409` JSON body. A browser cannot read the body of a failed
  WebSocket upgrade: it only fires `onerror` + `onclose(1006)`, which the client
  renders as "Connection interrupted…" and retries with back-off — forever,
  because the alarm retries the same failing query every 10 s and every new
  connection hits the same overdue deadline.
- `exclusive()` re-threw from inside `blockConcurrencyWhile()`. When an
  exception escapes `blockConcurrencyWhile`, the runtime **resets the whole
  Durable Object**, which drops every player's socket in the room. So a
  server-side failure for one player also kicked the opponent.

## What changed

### Server (`worker/matchRoom.ts`)

- `exclusive()` now returns errors as values and re-throws *outside*
  `blockConcurrencyWhile`, so a failure never resets the object or drops the
  other player's socket.
- `fetch()` accepts the WebSocket **before** running `tick()`. If `tick()` fails
  the player still receives the current room state plus an `{type:'error'}`
  frame with the real message, and a 10 s recovery alarm is scheduled. The round
  settles automatically once the underlying problem (e.g. the migration) is
  fixed — no client action needed.
- Permanent refusals (not a member, legacy room, match not found) are delivered
  over an accepted socket and closed with code **4403**; the client stops
  retrying and shows the reason. Transient failures close with **4409**; the
  client keeps the message visible and retries with back-off.
- `webSocketMessage()` catches errors thrown while *reading storage* and answers
  with an error frame instead of crashing the handler.
- `alarm()` no longer re-arms itself for `RoomError` (unrecoverable) conditions.

### API (`worker/index.ts`)

- `GET /api/health` now reports `missingColumns` for columns added by
  migrations 0003–0005, not just missing tables.
- `GET /api/ranked/matches/:id`, `/ws` and `/start` return **503** with a clear
  "Ranked database migrations are pending: ranked_accounts.cursed (apply
  migrations/0005_ranked_cursed_cards.sql)" message instead of letting the room
  crash mid-round.

### Client (`src/components/RankedBattle.tsx`)

- Understands close codes 4403 (give up, show reason) and 4409 (retry, keep
  the server's message). The generic "Connection interrupted" text can no
  longer overwrite a real server error.
- The "Connecting to your match…" placeholder shows the attempt number and a
  **Back to modes** button while reconnecting or after a permanent failure, so
  the player is never trapped on the page.
- Also retries when the preflight fails with `ApiError(0)` (offline), which was
  previously treated as permanent.

Shared close codes live in `shared/ranked.ts` (`WS_CLOSE`).

## Deploy

```bash
# 1. Apply the pending migration to the REAL database first.
npx wrangler d1 migrations list mykotoba-db --remote     # should list 0005 as pending
npm run db:migrate:remote

# 2. Deploy the Worker (Durable Object + API) and the frontend.
npm run typecheck && npm run typecheck:worker && npm test && npm run build
npm run deploy
# If the frontend is served by Cloudflare Pages, push/retry the Pages deployment too.

# 3. Verify.
curl https://mykotoba.pages.dev/api/health   # "ok": true and no "missingColumns"
```

Rooms that got stuck before the fix will settle themselves: the Durable Object
alarm retries settlement every 10 s and succeeds as soon as the column exists.
After that the accounts' `active_match` is cleared and players can start new
rounds.

## Tests added

- `tests/rankedRoom.integration.test.ts`
  - non-member socket refusal is delivered over the socket with code 4403 and
    the room keeps working;
  - a settlement failure on connect (column removed) keeps both the existing and
    the reconnecting socket alive with the error message, keeps the recovery
    alarm armed, and settles automatically once the schema is repaired.
- `tests/RankedBattle.test.tsx`
  - 4403 stops retrying and shows the reason;
  - 4409 keeps the server message (not "Connection interrupted") and retries;
  - the player can leave via **Back to modes** while stuck connecting.
