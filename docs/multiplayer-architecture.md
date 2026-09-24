# Adding multiplayer (1v1 battle / Quizizz-style) to MyKotoba

## 0. "Live" explained without the jargon

Three ways to make one player's action appear on another player's screen.

### a) Polling — "Are we there yet?"

Your app asks the server the same question every few seconds.

```
You:   "any updates?"  ──►  server: "no"
       ...3 seconds...
You:   "any updates?"  ──►  server: "yes — they answered"   ← you see it up to 3s late
```

- ✅ Dead simple. Works with the Worker + D1 we already built.
- ❌ Lag = up to your interval. ❌ Each ask is a request (100k/day free).

### b) Durable Object + WebSocket — a phone call that stays open

A WebSocket is one connection that stays open, so either side can talk instantly (no
asking). But there's a catch: **normal Workers are forgetful and scattered** — request 1
might run in Singapore, request 2 in Frankfurt, and neither remembers the other. Two
players would end up talking to two different brains.

A **Durable Object** fixes that. It's one named thing, in one place, that *remembers*:

```
Player A ──┐
           ├── open phone line ──►  🧠 MatchRoom #A7K2  ──► instantly tells both
Player B ──┘                        (one object, one match, remembers the score)

A answers ──► the 🧠 receives it, decides, broadcasts ──► B sees it in ~50ms
```

- ✅ Instant, and the server is the referee (nobody can cheat).
- ❌ New concept. You must handle reconnects, and write game state to `ctx.storage`
  (the object "sleeps" when idle and forgets in-memory variables).

### c) Somebody else does it for you

Firestore `onSnapshot` (which you have today), Supabase Realtime, Pusher/Ably. You open a
listener; the service pushes. Least code, but another dependency — and Firestore's reads
count against your 50k/day.

### Which one when?

| If your feature… | Use |
|---|---|
| tolerates a 2–10 second delay (turn-based, scoreboards, "opponent finished question 3") | **Polling** |
| needs instant, or needs a referee ("who buzzed first") | **Durable Object + WebSocket** |
| you want it working this weekend and don't care about the stack | **Managed realtime** |

---

**Short answer:** the Firebase → D1 migration gives you *half* of what multiplayer needs.
It gives you a **server** (the Worker) and **durable storage** (D1). It does **not** give you
**real-time**, because D1 has no push and polling every 20 s is useless for two people
playing at the same instant.

The good news: **you needed that server anyway.** Everything below assumes it exists.

---

## 1. Why you can't do multiplayer from the browser alone

The moment two players compete, the browser can no longer be trusted:

| If the client decides… | Cheat |
|---|---|
| …who answered first | Send a fake timestamp |
| …what the correct answer is | Read the bundled JSON / network tab |
| …the opponent's score | Send any number you like |
| …when the round starts | Start whenever you want |

So a multiplayer mode **requires an authoritative server** — which is exactly the Worker
we built. That part of the migration is not wasted; it's the prerequisite.

What's missing is the *transport*: pushing "your opponent just answered" to the other
player in ~50 ms instead of "whenever they poll next".

---

## 2. Two very different features — pick the cheap one first

### Mode A — Async race (Quizizz-style, recommended first step)

Both players get the same questions. Each progresses at their own pace. A scoreboard
updates as rounds land. **Nobody is racing for the same buzzer.**

- Latency that's acceptable: 2–10 seconds.
- Works with **what we already built** + one new table. No WebSockets.
- Polling `/api/match/:id` every 3 s while a match is live.
- Effort: **~1 day.**

### Mode B — Live head-to-head battle

Synchronised countdown, both see the same question at the same instant, "who buzzed
first wins the round", live opponent progress bar.

- Latency that's acceptable: <200 ms.
- Needs **WebSockets → Durable Objects**.
- Effort: **~3–5 days** for a first version, plus reconnection/anti-cheat polish.

> Build A first. It's most of the fun for a fraction of the work, and it proves the game
> design before you invest in the real-time layer. Both modes share the same D1 tables.

---

## 3. Mode A: what to add (no new infrastructure)

### D1 — two tables

```sql
CREATE TABLE IF NOT EXISTS matches (
  id             TEXT PRIMARY KEY,     -- 6-char room code, doubles as the Durable Object id later
  host_uid       TEXT NOT NULL,
  mode           TEXT NOT NULL,        -- 'race' | 'battle'
  level          TEXT NOT NULL,        -- N5..N1
  question_count INTEGER NOT NULL,
  status         TEXT NOT NULL,        -- lobby | live | done | abandoned
  winner_uid     TEXT,
  created_at     TEXT NOT NULL,
  finished_at    TEXT
);

CREATE TABLE IF NOT EXISTS match_players (
  match_id  TEXT NOT NULL,
  uid       TEXT NOT NULL,
  nickname  TEXT NOT NULL,
  score     INTEGER NOT NULL DEFAULT 0,
  correct   INTEGER NOT NULL DEFAULT 0,
  joined_at TEXT NOT NULL,
  PRIMARY KEY (match_id, uid)
);
CREATE INDEX IF NOT EXISTS idx_match_players_uid ON match_players(uid, joined_at DESC);
```

Cost check: one match = 1 + 2 rows written. Even 1,000 matches/day is 3,000 rows — 3% of
your 100,000/day free writes. Nothing.

### Worker routes

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/matches` | create a room → returns a 6-char code |
| POST | `/api/matches/:id/join` | join with the code |
| GET | `/api/matches/:id` | poll state: roster, scores, current round |
| POST | `/api/matches/:id/answer` | submit one answer — **server scores it** |
| POST | `/api/matches/:id/finish` | close the match, write the result |

### The one rule that matters

The client sends `{ questionId, choiceIndex }` — never the score, never the answer key.
The Worker loads the question from your existing `src/lib/*.json` banks (or D1), decides
correct/incorrect, and stores the score. Questions are revealed at round start; the
answer key is only ever sent after the round closes.

---

## 4. Mode B: the real-time layer (Durable Objects)

### The shape

```
Browser A ─┐                                 ┌─► live match state (in the DO)
           ├─ WSS ──► Worker ──► Durable ────┤
Browser B ─┘                     Object      └─► on match end: ONE write to D1
                                 (1 per match)
```

A **Durable Object** is a tiny single-threaded server that lives at one Cloudflare
location and holds one match. Because it's single-threaded, it is a natural referee:
messages arrive in a definite order, so "who answered first" has one true answer.

- One DO instance per match, id = the room code.
- Live state (scores, round, who buzzed) lives in the DO — **not** in D1.
- When the match ends, write the final result to D1 (a few rows) and let the DO die.

### Free-plan numbers (verified Sept 2026)

| Meter | Free plan |
|---|---|
| DO requests | 100,000 / day |
| DO duration | 13,000 GB-s / day (~28 hours of active object time) |
| DO storage | 5 GB total, 1 GB per object |
| Max DO classes | 100 |
| Incoming WebSocket messages | billed **20:1** — 100 messages = 5 requests |
| Outgoing WebSocket messages | **not charged** |
| WebSocket protocol pings | **free** |
| CPU per invocation | 30 s (vs 10 ms for a plain Worker on Free) |

Sources: [Durable Objects limits](https://developers.cloudflare.com/durable-objects/platform/limits/),
[Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/).

**The trick that makes this free: the WebSocket Hibernation API.** With hibernation the
object *sleeps* while players stay connected, and you stop paying duration. It wakes in
milliseconds when a message arrives. For a two-player match with a few dozen messages,
the cost rounds to zero.

### Sketch

```ts
import { DurableObject } from 'cloudflare:workers';

export class MatchRoom extends DurableObject {
  constructor(private state: DurableObjectState, env: Env) { super(state, env); }

  async fetch(request: Request) {
    const url = new URL(request.url);
    if (url.pathname !== '/ws') return new Response('Not found', { status: 404 });

    const pair = new WebSocketPair();
    // acceptWebSocket (NOT accept) => survives hibernation
    this.state.acceptWebSocket(pair.server);
    pair.server.serializeAttachment({
      uid: url.searchParams.get('uid'),
      name: url.searchParams.get('name') ?? 'Player',
    });
    this.broadcast({ type: 'roster', players: await this.roster() });
    return new Response(null, { status: 101, webSocket: pair.client });
  }

  // Wakes the object (free) when a message arrives.
  async webSocketMessage(ws: WebSocket, message: string) {
    const me = ws.deserializeAttachment<{ uid: string; name: string }>();
    const msg = JSON.parse(message);

    if (msg.type === 'answer') {
      // THE SERVER IS THE REFEREE. Client sends only its choice.
      const correct = await this.judge(msg.questionId, msg.choiceIndex);
      if (correct && !this.roundWinner) this.roundWinner = me.uid;  // first correct wins
      await this.addScore(me.uid, correct);
      this.broadcast({ type: 'score', players: await this.roster(), roundWinner: this.roundWinner });
    }
  }

  async webSocketClose(ws: WebSocket) { /* mark player dropped, keep their seat ~30 s */ }

  private broadcast(payload: unknown) {
    const data = JSON.stringify(payload);
    for (const socket of this.state.getWebSockets()) socket.send(data);
  }
}
```

Wire it up in `wrangler.jsonc`:

```jsonc
"durable_objects": {
  "bindings": [{ "name": "MATCH_ROOM", "class_name": "MatchRoom" }]
},
"migrations": [{ "tag": "v1", "new_sqlite_classes": ["MatchRoom"] }]
```

### Three gotchas that will bite you

1. **Hibernation wipes your in-memory variables.** `this.players = []` disappears when the
   object sleeps. Persist match state with `this.state.storage.put()` (or the DO's own
   SQLite) and rehydrate when you wake. Only truly ephemeral things stay in memory.
2. **Send a heartbeat.** Have the client ping every ~30 s and reconnect with backoff.
   Cloudflare handles WebSocket *protocol* pings for free, but an app-level ping plus
   reconnect logic is what makes a flaky phone network survivable.
3. **Don't write every answer to D1.** That's what the DO is for. Write once, at the end.
   Otherwise you'll burn row-writes on state that only lives 3 minutes.

---

## 5. The honest alternative

**Firebase is genuinely better at real-time than what we just built.** Firestore's
`onSnapshot` (and especially Realtime Database) would give you sub-second sync with a few
lines client-side and no Durable Objects at all. There's real irony in migrating *off* the
thing that's good at the feature you're adding.

So there are three legitimate paths:

| Path | Live sync | Cost | Complexity |
|---|---|---|---|
| **D1 + Durable Objects** | ~50 ms | $0 | one stack, but DOs are a new concept |
| **D1 + Firebase real-time for matches only** | ~100 ms | $0 | two stacks; Firestore reads back on your quota |
| **Supabase / Pusher / managed realtime** | ~50 ms | free tiers exist, then $10–25/mo | least code, another vendor |

If your goal is "learn the Cloudflare stack" or "one backend", go Durable Objects. If your
goal is "ship the game this month", the managed-realtime option is the shortcut.

---

## 6. What stays the same either way

- All the D1 tables from the migration — profiles, lists, history, leaderboard, friends.
- The Firebase-ID-token auth: a WebSocket can't send an `Authorization` header, so pass
  the token in the query string when opening the socket and verify it inside the DO's
  `fetch()` **before** calling `acceptWebSocket`.
- `src/lib/api.ts` — just add the match endpoints.
- Your existing `invites`/`pairs` pattern becomes matchmaking: a friend's code → a room.

## 7. Suggested build order

1. **Mode A (async race)** — tables + 5 routes + a polling screen. Ships in a day, and it
   is already fun with two people on a sofa.
2. Play it. Decide whether the "buzz in first" mechanic actually matters.
3. If it does, add `MatchRoom` (Durable Object), reuse the same tables, and swap the
   polling screen for a WebSocket one. The rest of the app never notices.
