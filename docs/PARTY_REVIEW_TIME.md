# Custom party review time — install guide

Prepared against GitHub commit `e9ba915` (`gitattr`). This is an **incremental feature update** for the already-fixed invite-party code. Do not reapply the original invite-party-fix.patch.

## What players get

Open **Ranked → Invite party → Create room**. The form now has **Review time** beside the wager settings:

- Presets: **Off (0s), 1s, 1.5s, 3s, 5s**.
- Custom input: **0–10 seconds**, in **0.5-second steps**.
- Default: **3 seconds**.
- Both players see the room's setting before confirming. The host chooses at creation; it cannot change during the match.
- **0 means no answer-review screen.** Both players must still answer (or reach the shared deadline); then the server moves directly to the next question or settles results. Normal network/processing latency still exists.
- The answer timer remains **10 seconds**. Wagers, scoring and the four-mistake rule are unchanged.
- Solo ranked is unchanged. Existing party rooms keep the three-second default. Create a new room to choose a different value.

## 1. Apply the feature files

Choose **one** method, not both.

### Option A — changed-files ZIP (no patch commands)

1. Extract `party-review-time-files.zip` to a temporary folder.
2. Open that extracted folder. It contains `package.json` and the `src`, `shared`, `worker`, `migrations`, `tests`, and `docs` folders.
3. Copy those files/folders into your existing project folder (the folder containing your current `package.json`). Merge folders and replace matching files. Do **not** delete the existing folders first: the ZIP contains only changed/new files, not the entire app.
4. If you made your own changes to these files after commit `e9ba915`, save a private copy and compare before replacing them.

### Option B — Git patch

Save `party-review-time.patch` in your project folder, open its terminal, and run:

```powershell
git apply --check party-review-time.patch
git apply party-review-time.patch
```

If the check fails, stop and share the error. Do not force it: you may have local edits (for example, a manually changed global `reviewMs`) or a different repository version.

## 2. Apply the NEW database migration

Keep a private database backup **outside the Git repository**. If creating a new one from the project folder on Windows, for example:

```powershell
npx wrangler d1 export mykotoba-db --remote --output=../mykotoba-before-review-time.sql
```

Wait for a successful backup. Do not upload it to GitHub or share its contents.

Then run:

```powershell
npx wrangler d1 migrations list mykotoba-db --remote
```

With the previous party fix installed successfully, the pending migration should be:

```text
0004_ranked_review_time.sql
```

If `0003` still appears, resolve the previous migration first; this feature assumes it succeeded.

Apply the pending migration:

```powershell
npm run db:migrate:remote
```

Enter `y` when asked. **Wait for `0004_ranked_review_time.sql` to show success before deploying.**

This migration adds one `review_ms` column. It does not drop tables, reset accounts, change wagers, or redefine triggers. Do not manually rerun `0003` or edit the already-applied migration.

## 3. Verify and deploy

```powershell
npm run typecheck
npm run typecheck:worker
npm test
npm run deploy
```

`npm run deploy` builds the app and deploys the match-room Worker. If you also use Cloudflare Pages, commit/push the feature files and make sure its new deployment succeeds. Both the Worker and the frontend need this update; Pages alone cannot change server review timing.

No production deployments or remote database changes were made while preparing this update.

## 4. Try it with two accounts

1. Refresh both browsers after deployment.
2. Create a new room with **Off (0s)** selected. Join it from the second account.
3. Both lobbies should say **Review time: Off (0 seconds)**. Confirm on both and start as host.
4. Answer first on one device: it should still wait for the opponent/deadline.
5. Answer on the other device: both should go straight to the next question. **Check that both players can answer that next question**, especially the player who answered last.
6. At the last question or four-mistake limit, results should appear without a review delay and settle the wager once.
7. Repeat with **1.5 seconds** to see the synchronized answer-review pause. Refresh mid-match: the setting should persist.

## Verification performed locally

- **86 tests passed across 12 files.**
- Frontend, Worker and Pages-function type checks passed.
- Production build and Wrangler deployment dry-run passed.
- Local migration `0004` applied; rerunning tracked migrations correctly reported none pending.
- Integration tests cover custom timing, zero-delay transitions, timeouts, four-mistake ending, final-question settlement, payout replay, reconnects, settings consent, invalid values, legacy defaults, and unchanged solo timing.
- A client regression test verifies the last responder is not stuck after a zero-delay transition.
- Real production two-device testing remains your final rollout check; local tests do not prove remote deployment success.

The existing frontend bundle-size warning is unrelated to this feature.
