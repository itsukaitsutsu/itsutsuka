# Invite-party repair — deployment and verification

## What changed

This repair replaces the separate, incomplete party quiz with a server-authoritative ranked room flow.

- Shared question, choice order, clock deadline, answer lock, and 3-second review phase for both players.
- The same CSV vocabulary and progress identities as the app, across N5–N1. Questions use the lower account tier, not a hard-coded N5 deck.
- Four distinct option labels; question-local choice IDs; no correct-answer field until both answers or the deadline resolve.
- Correct **+1**, incorrect **−2**, timeout **−1**. Both players finish the current question; **the entire round ends when either reaches four mistakes**.
- A player reaching four mistakes alone loses. If both reach four together, or all questions finish, higher score wins. Equal scores tie. These rules are shown before consent.
- Host-only start; both members must be connected and explicitly confirm. Atomic room capacity checks, membership enforcement, duplicate/stale/late-answer rejection.
- Automatic reconnect, clock-offset correction, restored answer locks, and single-active-tab handling. Leaving a live room does not cancel the wager: server alarms keep it running.
- Saved results: winner/tie, scores, end reason, before/after account balances, and actual gained/lost mastery cards.
- Account-backed ranked points and mastery shared by solo and party modes. Casual discovery/history are not altered by either ranked mode.
- Removed the nonfunctional required friend-code input from Create Room. Create a room, copy its room code, and have the other player join that code.
- Enabled WebSocket forwarding in Vite's development proxy.

## Wager semantics

These are **in-app ranked points/mastery**, not money.

Each player needs enough points. During a live match, both ranked accounts are locked against other matches and resets. Balances are not subtracted in the lobby. On completion, one stake transfers from loser to winner, once, in an atomic D1 batch. A tie transfers nothing. Party quiz scores do **not** also change the account balance or award question mastery; they determine the winner of the agreed wager.

A card wager transfers actual unique mastered cards in the room tier. Each player must own enough cards the opponent does **not** already own. Eligible stakes are randomly selected and persisted at start. If both players have identical mastery, use points-only betting. Wagers do not automatically promote/demote tiers; solo mastery can earn promotions.

Solo ranked is now graded by the server against the same account. Its existing resource rules are retained: first-time correct mastery +1 point, repeat correct mastery +0, wrong −2 and remove the answered card's mastery plus one other mastered card, timeout −1. Solo's displayed round score counts every correct answer, while its results show the actual account change. The server advances after the review phase rather than a client-controlled Next button.

## Apply the code

The companion `invite-party-fix.patch` was prepared against the repository revision recorded in the handoff. From a clean checkout of that revision:

```bash
git switch -c fix/invite-party-sync
git apply --check /path/to/invite-party-fix.patch
git apply /path/to/invite-party-fix.patch
npm ci
```

Alternatively, use the supplied updated source ZIP. Do not deploy the test helper Workers under `tests/helpers/`: their privileged inspection/auth bypasses exist only in the test bundle.

## Required database migration

**Back up your production D1 database first.** The project uses Firebase for authentication, but ranked balances and rooms use D1 + Durable Objects.

```bash
npx wrangler d1 export mykotoba-db --remote --output=/safe/path/before-ranked.sql
npm run db:migrate:local
# Review pending migrations, then apply to production when ready:
npm run db:migrate:remote
```

The scripts now use Wrangler's tracked migration runner and apply `0001`, `0002`, and `0003` in order. If `0001`/`0002` were previously executed manually, their `IF NOT EXISTS` declarations allow them to be tracked safely. **Do not manually execute `0003` repeatedly**: it adds columns. If you already applied `0003` manually, reconcile Wrangler's migration tracking before using the runner.

`0003_ranked_accounts.sql` creates account balances, adds match mode/question count/result/protocol fields, and adds guards for atomic account locks and room capacity. Existing matches retain protocol version 1; newly created rooms use version 2.

## Deploy BOTH server and frontend

### Worker + assets deployment

Verify `.env` Firebase settings and the D1 database ID / `FIREBASE_PROJECT_ID` in `wrangler.jsonc`. Then:

```bash
npm run typecheck
npm run typecheck:worker
npm run typecheck:functions
npm test
npm run build
npx wrangler deploy --dry-run
npm run deploy
```

`wrangler.jsonc` already declares the SQLite `MatchRoom` Durable Object and its `MATCH_ROOM` binding. No new Durable Object class migration is needed.

### If you keep Cloudflare Pages hosting

A Pages frontend deploy alone is **not enough**. Deploy the `mykotoba` Worker above so its exported `MatchRoom` class is updated. In Pages → Settings → Bindings, ensure:

- `DB` → the same D1 database used by the Worker.
- `MATCH_ROOM` → `MatchRoom` in the deployed `mykotoba` Worker.
- `FIREBASE_PROJECT_ID` → your Firebase project.

Apply bindings in the intended environment (Production/Preview). Redeploy Pages so `functions/api/[[path]].ts` and the new frontend ship together. Use an isolated database/Worker for staging; do not point a test deployment at production balances.

The frontend uses same-origin `/api` requests and WebSockets. Locally, run `npm run dev:api` and `npm run dev` in separate terminals. The Vite proxy now supports `ws: true`.

## One-time account transition

On the first visit to Ranked:

- An existing server account is loaded and never overwritten by browser state.
- If this browser has `kotoba-ranked-v1`, the user chooses **Import my progress** or **Start fresh**. Only import data that belongs to the signed-in player; the old cache was not account-scoped.
- Imported mastery is deduplicated and limited to real vocabulary identities. Positive points are capped at the valid mastery count; tier is recomputed. This may reduce a legacy balance.
- Initialization is insert-only. Resetting preserves the account row, so it cannot be used to repeatedly re-import points.

**Trust limitation:** legacy browser data has no verifiable history. This is a one-time, bounded compatibility import, not proof that the user earned those cards. For a strictly trusted competition, initialize accounts fresh and disable legacy imports before rollout. New solo/party answers and settlements are server-graded, but a public vocabulary-learning game is not a comprehensive anti-cheat system.

Create **new room codes after deployment**. Old rooms use the old protocol and are rejected with an explanatory message; they cannot safely be resumed with the new wager rules. Let old matches finish before deploying.

## Verification performed locally

- Pure rules/question tests: vocabulary parity across all 7,970 words, every-tier unique options, progress keys, winner/tie logic, solo resource effects, eligible card transfers, and legacy validation.
- Real **workerd/Miniflare Durable Objects + D1** integration: shared questions/options/deadlines, masked answers, duplicate/stale/late packets, reconnect/refresh, disconnect timeouts, four-mistake termination, card/point settlement, payout replay, readiness/funds failures, nonmember denial, atomic lock rollback, and solo credits.
- Authenticated API integration with **test-only substituted authentication**: wager validation, one-time initialization, concurrent join capacity, idempotent rejoin, failed-start propagation, and locked reset rejection. These tests do not verify real Firebase sign-in/token verification.
- React tests: submission identity, no premature reveal, answer-lock restoration, server clock offset, guest/host consent controls, and persisted results display.
- Large snapshot tests: chunked storage keeps full-tier rounds below individual Durable Object value limits.
- Existing app tests remain included in `npm test`.

### Manual staging check still required

Use two **different signed-in accounts** in separate browser profiles/devices:

1. Open Ranked on both, initialize/import, and verify both balances.
2. Create a points-only room; join from the second account using the displayed room code.
3. Verify wager/tier/count, confirm on both, and start as host.
4. Check identical options; answer early on one device and wait. No answer is revealed until both resolve.
5. Refresh after submitting; the answer must stay locked. Disconnect one device; it must time out rather than freeze the room.
6. Make one player reach four mistakes. Both should get the same result after the review; the winner gains exactly the stake and the loser loses exactly it.
7. Refresh results; balances must not change again. Verify them in Ranked setup and from another device.
8. Try a tie, insufficient funds, and a card wager with distinct mastery.
9. Play a solo round and verify its resulting balance is available for party wagers, without changing Casual progress.

No production database, deployment, GitHub push, or real-user balances were modified during this repair.

## Maintenance

When editing the vocabulary CSV files, run `npm run ranked:bank` and commit the regenerated `worker/rankedBank.json`. The parity test catches stale Worker data. The Worker deliberately does not import Vite's CSV/audio loaders.

The existing project still reports dependency audit findings and a large frontend-bundle warning. Those are separate from this ranked-room repair and were not resolved by broad dependency upgrades.

## Handoff verification

Prepared against repository commit `fa15fc27a79c7338afa8ba8c11f2e773a5f6a85d`.

Final local checks: **67 tests passed across 11 files**; frontend, Worker, and Pages-function type checks passed; production build and Wrangler deployment dry-run passed; all three local D1 migrations applied and a second migration run correctly reported no pending migrations.
