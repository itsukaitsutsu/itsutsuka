# Ranked combo sounds — fix and manual edits

Based on repository commit `a87de31`. Fixes both solo ranked and invite-party modes, including review time 0. No database migration is needed.

## Why it failed

`src/components/RankedBattle.tsx` always selected `quizCombo1` / `feedbackAudio.combo[0]`. It also gated playback on the review phase, which is deliberately skipped when review time is zero.

The fix stores the streak on the server and triggers sound from newly resolved answer counts, independently of the review screen. Streaks cap at 5, reset on wrong answers or timeouts, and survive reconnects. Duplicate snapshots do not replay sounds, and a freshly opened page does not replay old answers. Party feedback waits for both answers/the deadline; it does not leak the outcome early.

## Installation — choose one method

### Replace files

Extract `ranked-combo-fix-files.zip` and merge its folders into the existing project, replacing matching files. Do not delete the existing folders: this is a changed-files ZIP, not a full project.

Three application files are changed:

- `shared/ranked.ts`
- `worker/matchRoom.ts`
- `src/components/RankedBattle.tsx`

Two updated regression test files are included:

- `tests/RankedBattle.test.tsx`
- `tests/rankedRoom.integration.test.ts`

Alternatively apply `ranked-combo-fix.patch` after `git apply --check`. Do not apply the original party patch again.

### Manual edits

Line numbers below refer to commit `a87de31` before edits; use the matching text if they move.

1. **`shared/ranked.ts`, line 15:** in `BattlePlayer`, replace `mistakes: number; answered:` with `mistakes: number; combo?: number; answered:`.
2. **`worker/matchRoom.ts`, line 39:** in the initial player object, replace `mistakes: 0, answered: false` with `mistakes: 0, combo: 0, answered: false`.
3. **`worker/matchRoom.ts`, immediately after line 118** (`const a = p.answer!; p.score += a.delta;`), insert:

```ts
      p.combo = a.result === 'correct' ? Math.min((p.combo ?? 0) + 1, 5) : 0;
```

4. **`src/components/RankedBattle.tsx`, line 6**, replace the sound-settings import with:

```ts
import { playUserSound, type SoundSlot } from '@/lib/soundSettings';
```

5. **Same file, line 23**, replace `const sounded = useRef('');` with:

```ts
  const sounded = useRef<{ scope: string; answered: number } | null>(null);
```

6. **Same file, lines 83–90**, replace the entire sound `useEffect` (the one checking `state?.phase !== 'review'`) with:

```ts
  useEffect(() => {
    if (!me) return;
    const scope = `${matchId}:${playerId}`;
    const answered = me.correct + me.mistakes;
    const previous = sounded.current;
    sounded.current = { scope, answered };

    if (!previous || previous.scope !== scope || answered <= previous.answered || me.combo === undefined) return;

    const combo = Math.min(Math.max(me.combo, 0), 5);
    const correct = combo > 0;
    const slot: SoundSlot = correct ? `quizCombo${combo}` as SoundSlot : 'quizIncorrect';
    void playUserSound(playerId, slot, () =>
      playFeedback(correct ? feedbackAudio.combo[combo - 1] : feedbackAudio.wrong)
    );
  }, [me?.correct, me?.mistakes, me?.combo, matchId, playerId]);
```

Do not remove the neighboring timer or WebSocket effects.

## Test and deploy

```powershell
npm run typecheck
npm run typecheck:worker
npm test
npm run deploy
```

Stop on any error. Deploy BOTH Worker and frontend. If using Cloudflare Pages, push/redeploy the updated Pages frontend as well. Refresh both browsers and start a new round after deployment. New rounds start combo tracking from zero; rounds already active before this update do not have a recorded previous streak.

Keep Sounds enabled. Any custom Combo 1–5 sound settings are still used; otherwise the corresponding default audio plays. Browser autoplay restrictions and device mute still apply.

## Verification

93 tests passed; all three type checks, production build, and Worker deployment dry-run passed. Added tests cover 1→2→3→4→5→5 playback, all five default fallbacks, mistake/timeout reset, zero-review and final-answer sounds, reconnect persistence, duplicate-state suppression, and no feedback from opponent-only updates. Both solo and party were exercised in the Cloudflare local runtime.

These checks validate sound-slot selection and game state. They do not claim a listening test in your production browser. No GitHub push, production deployment, or remote database change was performed.
