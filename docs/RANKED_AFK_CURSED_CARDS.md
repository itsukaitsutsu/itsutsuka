# Ranked update: AFK, limited surrender, and cursed cards

This is a **cumulative update** based on repository commit `3fc935d` (`fix sound`). It includes the earlier solo Abort / mutual party Surrender feature, plus the newly agreed rules. Use this package instead of the earlier exit-feature ZIP. It preserves configurable review time and combo sounds.

**This update needs one new database migration: `0005_ranked_cursed_cards.sql`.** Nothing has been pushed, deployed, or applied to your remote database by the assistant.

## 1. Exact rules

### Normal ending stays

The whole round still ends when either player reaches **four total mistakes**, or when all questions are completed. Wrong answers and timeouts both count as mistakes. Both players continue to share the same question in party mode.

### Party AFK

A player is AFK when either condition occurs:

- They time out on **four consecutive questions**. A submitted correct or wrong answer resets the timeout streak when graded.
- They do not explicitly accept or decline a surrender request within **30 seconds**. Answering questions, reconnecting, or sending another request does **not** count as responding or restart the 30 seconds.

| Server question at AFK ending | AFK player's account | Non-AFK opponent |
| --- | --- | --- |
| Q1–Q20 inclusive | Normal wager loss **plus 5-point fine** | Normal wager winnings |
| Q21 onward | Normal wager loss **plus 10-point fine** | Normal wager winnings **plus 1 point per graded correct answer**, excluding their own cursed-card repairs |

The fine is additional; it is not paid to the opponent. A balance may become negative. The card-loss exception below still applies to a higher-ranked AFK loser.

Example: with a 10-point wager, an AFK player on Q21 loses 20 points total. An opponent with 18 eligible graded correct answers gains 28 points total: 10 wager + 18 late-match bonus.

If both players reach four consecutive timeouts together, both pay the applicable fine, but there is no winner, wager transfer, or opponent bonus. A non-AFK four-total-mistakes ending does not add an AFK fine.

These new AFK fines apply to **party mode**, not solo. Solo retains the four-mistake ending and Abort behavior.

### Three shared surrender opportunities

Surrender opportunities unlock at **Q1, Q10, and Q20**. They are shared by the entire match, not separately allocated to each player.

- Either player may request surrender in the current available window.
- Only the other player's explicit acceptance ends the match by mutual surrender.
- **Keep playing** declines. **Withdraw request** cancels. Either consumes the current opportunity.
- After consuming Q1's opportunity, neither player can request again until Q10. After Q10's, wait until Q20. After the final opportunity is consumed, no more requests are available.
- Unused opportunities do not accumulate: a first request on Q15 uses the Q10 window; a first request on Q21 uses the last window.
- Both the question timer and the independent 30-second response timer continue while a request is pending.
- Reconnecting restores the request, deadline, and consumed opportunities.
- If a normal result was already decided before surrender consent/expiry, that result stands. A late acceptance cannot overwrite it.

Agreed surrender has **no winner and no wager transfer**. Earned cursed-card repairs are saved, as you requested. Leaving the page alone is not surrender and does not cancel timers or the wager.

### Card wagers must be owned

The server checks owned mastery before allowing card-wager play and rechecks it at match start. For ordinary transfers, the loser must own eligible room-tier cards that the opponent does not already own.

If a **higher-ranked player loses to a lower-ranked player**, using their account tiers at match start:

1. The normal point wager still applies, and any AFK fine still applies.
2. Remove only cards the higher-ranked loser **owned before the match** and **answered incorrectly or timed out on**.
3. Remove at most the agreed number of wager cards. Fewer eligible missed cards means fewer removed, possibly zero. The first eligible misses are selected in question order.
4. Do **not** transfer these removed cards to the winner.
5. All of that higher-ranked loser's graded missed cards become cursed, **including unseen cards**, even in a points-only wager.

Correctly answered and unplayed cards are not removed under this exception. Equal-ranked matches and a lower-ranked player losing still use the ordinary card-transfer rules. An unanswered question that was never graded is not recorded as a missed card merely because surrender or response-time AFK ends the round.

### Cursed-card repair

Curses are stored on the player's server account and carried across devices and matches. Browser imports and the account-reset endpoint cannot erase them.

- Cursed cards are placed first in the next solo or shared party round. Remaining curses carry into subsequent rounds if the chosen round is shorter or ends early.
- In party mode, both players see the same card. Curse ownership is personal; a card may be cursed for one or both players.
- Repair questions can be from a different tier than the normal room tier, and the UI labels the card tier.
- The owner gets **0 match score and 0 answer-related account-point change** whether correct, incorrect, or timed out.
- One correct answer clears the curse and adds/restores mastery, without awarding points. Repair progress is kept on solo abort and mutual party surrender.
- A wrong answer or timeout keeps the curse and still counts toward mistakes and consecutive timeouts. This does not exempt the player from wager losses or AFK fines.
- An opponent who does not own that curse earns **+0.5 match score** for a correct answer, not an immediate account-point reward. Their ordinary incorrect/timeout penalties remain.
- If both players own the curse, both have the zero-score repair rule.
- The late AFK bonus excludes the winner's own repair answers so they cannot turn free repairs into points. Correct answers to the other player's curse still count as one correct answer for that separate AFK bonus.

### Solo Abort is retained

Abort ends the solo round immediately and keeps already-graded points, penalties, mastery, and curse repairs. It adds no penalty for unanswered questions. If the last answer already decided the round, abort just skips the final review and keeps the natural result.

## 2. Replace/add these files

Download `ranked-afk-cursed-files.zip` and extract it to a temporary folder. It contains changed files only, not the whole project.

Back up your local edits first. Copy files into their matching paths under:

`E:\Side_Quest\bot\kotoba\database\minimal\artifacts\mykotoba`

For an existing file, replace the **entire file, line 1 through the end**. Do not append the new code. If you have edits newer than commit `3fc935d`, compare/merge them before replacing.

### Required application files — 8 replacements + 1 new file

| Path | Action / purpose |
| --- | --- |
| `shared/ranked.ts` | Replace: policy version, timers, curse and result types |
| `worker/index.ts` | Replace: account/ownership checks and new-room policy version |
| `worker/matchRoom.ts` | Replace: authoritative timing, consent, scoring, settlement, recovery |
| `worker/rankedAccounts.ts` | Replace: persistent curses and result counts |
| `worker/rankedQuestions.ts` | Replace: prioritized shared repair questions |
| `worker/rankedPolicy.ts` | **Add new file:** repair and card-loss rules |
| `src/components/RankedBattle.tsx` | Replace: timers, surrender limits, repair labels, result breakdown |
| `src/components/RankedMode.tsx` | Replace: account curse count and rules explanation |
| `src/components/RankedPartyModal.tsx` | Replace: card-wager explanation |

### Required new migration

- **Add** `migrations/0005_ranked_cursed_cards.sql`.
- Do not edit or manually rerun old migrations 0001–0004.

### Tests and documentation

Replace:

- `tests/RankedBattle.test.tsx`
- `tests/rankedRoom.integration.test.ts`
- `tests/rankedApi.integration.test.ts`
- `tests/helpers/rankedWorker.ts`

Add:

- `tests/rankedPolicy.test.ts`
- `docs/RANKED_AFK_CURSED_CARDS.md`

The helper includes privileged test-only inspection and failure injection. Keep it under `tests/helpers`; never copy its routes into the production Worker.

The optional `ranked-afk-cursed.patch` is an alternative for a clean `3fc935d` checkout. It is cumulative and will not apply cleanly over the earlier exit patch. Use either file replacement or the patch, not both. Always run `git apply --check` before applying a patch.

## 3. Validate, migrate, deploy

Run from your project root. Stop if a command fails.

### A. Check the code

```powershell
npm run typecheck
npm run typecheck:worker
npm run typecheck:functions
npm test
```

### B. Back up the remote database and inspect pending migrations

Use your normal private database backup procedure. Do not commit or upload the backup to the public repository.

```powershell
npx wrangler d1 migrations list mykotoba-db --remote
```

On your already-updated site, **only 0005 should be pending**. If this lists older migrations you already executed manually, stop and reconcile the migration history before proceeding. Do not blindly rerun 0003/0004 on an existing schema.

### C. Apply the new migration BEFORE deploying the code

```powershell
npx wrangler d1 migrations apply mykotoba-db --remote
```

Confirm that `0005_ranked_cursed_cards.sql` succeeded. It adds an empty `cursed` JSON column to existing accounts without deleting points/mastery or resetting matches. The migration runner records it so subsequent runs do not apply it again. Do not separately execute the SQL file after using the migration runner.

### D. Deploy

```powershell
npm run deploy
```

This builds and deploys the Worker/assets using your existing configuration. If your frontend also lives on a separate Cloudflare Pages deployment, redeploy that frontend through your usual workflow too.

Prefer finishing existing matches before the update. Existing live pre-update snapshots retain the old settlement policy rather than being retroactively fined; old lobbies must be recreated. New rooms use rules version 3 and require the refreshed client to explicitly accept those rules.

Refresh both browsers and start a **new match**. Choose more than 20 questions in Ranked setup if you want to test the Q21+ rules; a 10-question match cannot reach them.

## 4. Live checks for you

Use test accounts, since AFK testing intentionally changes balances.

1. Four consecutive timeouts in party: verify normal wager loss plus 5, and account unlock afterward.
2. Make a wrong submitted answer interrupt the timeout streak: total mistakes still end at four, but no AFK fine if the streak is below four.
3. Request surrender, answer questions but ignore its buttons: verify response-time AFK after 30 seconds unless the normal match ended first.
4. Decline at Q1, verify request locked until Q10; withdraw there, verify Q20 unlock; decline again and verify no further requests.
5. Use a long round to reach Q21: verify the 10-point fine and the opponent's correct-answer bonus.
6. Higher-ranked loss: verify capped removal of owned missed cards, no transfer of those cards, and curses for unseen misses too.
7. Next round: verify cursed cards appear first, owner scores 0, opponent scores 0.5 for correct, and one correct repair restores mastery without account points.
8. Accept mutual surrender after a repair: verify no wager transfer and the repair stays saved.
9. Repeat with zero and nonzero review, and reconnect during a pending request.

## 5. Local verification

- **139 tests passed across 13 files**, including local real Durable Object + D1 integration tests and React UI tests.
- All three TypeScript checks passed.
- Production frontend build and Worker deployment dry-run passed.
- Local Wrangler migrations 0001–0005 passed; running the local migration runner again reported no migrations to apply.
- Recovery tests cover saved AFK/early-end intent, no double fines/payouts, account unlock, persisted repair queues, and replay of an old settlement after a newer match.
- The existing large-bundle warning remains; no unrelated dependency upgrades were made.

No production deployment, remote migration, or live browser/listening test was performed by the assistant.
