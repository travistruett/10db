# F1: card hygiene

**Size: Feature.** Milestone F1 of `docs/superpowers/specs/2026-11-25-failures-reach-you-only-when-you-can-act-design.md`
(its "Card hygiene" section and Builder's cut). No migration. One implementer, end to end.

## Brief

**What changes for you.**
- **One failed card per task.** A task whose runs keep failing has one "Workstream failed" card, titled "(3 runs)"
  once it stands for three. Its answers act on the newest run. When a later run of the task finishes, it closes.
- **The CI cap card replaces "Pull request checks failed".** When 10db stops fixing a pull request's checks, the
  checks card closes in the same write, and isn't raised again while the stop stands.
- **Factory shows a failure once.** A failed run whose card is open is one row in Needs You, titled by the card,
  with Open, Answer (opens the Inbox), Retry and Close. It is no longer also part of a cause row.
- **Skip cards close once their task is done**, even when they list calls you could still run. A finished task's
  skips raise no card at all. **Run These Now** is in the task drawer instead, beside "Skipped While Nobody Was
  Watching", once the run has ended.
- **"Write outside every claim" waits 3 minutes** for an ordinary path. It is carded only if it is still there,
  still outside every claim and still ownable then, or at the step's end, whichever is first. A sensitive path
  (agent config, `.env`, `.git`) still cards at once.

**What it buys.** Of the Nov 25 Inbox: a task's failures stay one card however its runs restart (the 3 cards
for "The backend on build passes make gate" came from Retries, which #840 already closes the card for; the fold
covers a new run of the task), the 5 stale skip cards close by themselves, the 6 copy stray cards that closed
within 2 minutes never show, and #851's two cards for one failure become one.

**What could go wrong, and how we'd know.**
- *A stray that matters waits 3 minutes.* Only ordinary paths wait. Sensitive ones card at once. The step end cards
  whatever still waits.
- *A done task's skipped calls go unseen.* They are in the drawer with Run These Now. A card that lists config the
  run wrote stays open, since that config waits on your approval.
- *A folded card's answer acts on the wrong run.* The fold replaces the card's options, detail and target with the
  newest run's, so Retry and the batch answers act on it.

**Calls you might disagree with.**
- A finished task's skips raise no card at all, rather than a card that closes at once.
- A skip card that lists config the run wrote stays after the task is done (the spec closes every skip card).
- Carded failures keep Retry and Close in Factory beside Answer, rather than offering only the card's options.

**Needed from you:** nothing.

## Parts

| Part | Where | What |
| --- | --- | --- |
| Fold per task | `apps/daemon/src/runner/failed-card.ts`, `runner.ts`, `recovery/recover.ts` | `flagFailedRun` raises under fold key `failed:<taskId>`. A repeat refreshes the card, counts the runs in `detail.failedRuns`, retargets the newest run and keeps earlier runs in `releasedWorkstreams` (Factory's human-touch figures). `markDone` withdraws it (`withdrawFailedCard`). |
| Cap card replaces checks | `delivery/ci-stop.ts`, `delivery/pr-watch.ts` | `stopCiFixing` withdraws `prCardKey.checks(root)` in its write. `record` raises no checks card while `ciStopped` is set. |
| Factory dedupe | `apps/desktop/src/views/factory/factory-overview.tsx`, `needs-you-panel.tsx` | Failed runs targeted by an open failed card become `carded` rows (`FailedRun`). Only the rest go to `failureCauses`. |
| Skip cards close | `delivery/skipped-card.ts`, `daemon/services.ts`, `api/app.ts`, `views/board/task-skips.tsx` | `closeFinishedSkippedCards` drops `stillOffersRun`. `raiseSkippedCard` raises no card for a finished task unless it lists config. `POST /workstreams/:id/skips/run` (`runSkippedCalls`) makes the follow-up the card's Run these now makes, from the drawer. |
| Stray wait | `watcher/watcher.ts` | `dueStrays` holds ordinary strays for `strayWaitMs` (3 min, injected), then cards them only if they are still stray and `anyCouldOwn`. A timer re-reads the held paths. `stepEnd` cards what waits. |

## Provider parity

Nothing here depends on the provider. The cards, watcher and Factory are 10db's own, and they work the same for
every account kind.

## Tests

- **Fold** (escaped bug: three cards for one task): `runner.test.ts`, "folds every failed run of a task into the
  task's one failed card, which closes when a later run finishes". Real pipeline, fake adapter. It went red on
  `main`'s runner (three open cards).
- **Stray wait** (claims, core): `watcher.test.ts`, "holds an ordinary write outside every claim for the wait…".
  It went red on `main`'s watcher (all three paths carded at the first batch).
- The other watcher, take-out and proposal-lane tests pass `strayWaitMs: 0`, since they test what cards, not when.
- `skipped-card` tests change to the new rule: a done task's card closes, and a done run raises none.
- **e2e:** `loop.spec.ts` (flow 2) reads the finished task's answered question in its drawer instead of an Inbox
  card.
