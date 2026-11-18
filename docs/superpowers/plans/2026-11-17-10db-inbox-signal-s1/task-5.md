# Task 5: daemon — every card says its tier, urgency and how it closes

**Spec:**

- §4.1 "How this is enforced": "At compile time. The tier and `closesWhen` are required on `FlagInput` and on the
  delivery `Card` type …";
- §4.4 Urgency;
- §4.5 How a card closes: its first two bullets;
- §5 Every card type, sorted;
- "Every flag is high", from §1's four mechanisms.

**Part:** A. **Consumes:** Task 3's `CardTier`, `StoredTier`, `CardClosesWhen` and `BY_ANSWER`. Task 4 has already
moved every notice off `flag`.

The edits are mechanical, and the compiler finds every site. Before starting, merge main into the branch, so a raiser
main added since the inventory gets its values here. Give a new raiser a row by the same rules, and name it in the
commit body.

## Files

- Modify `apps/daemon/src/inbox/service.ts`:
  - export `FlagInput` as a type, and add its three required fields;
  - `flagCard` inserts `input.urgency`, where it hardcoded `Urgency.High`;
  - it computes `detail` once: `input.detail` plus `{ [CARD_RESOLVES_WHEN]: closesWhen.when }` when
    `closesWhen.by === 'event'`, else `input.detail ?? null`. It uses that detail on insert and on a refresh;
  - `flagStuckDelivery` passes its values.
- Modify `apps/daemon/src/delivery/cards.ts`:
  - `Card` loses `resolvesWhen`, and gains `tier`, `urgency` and `closesWhen`;
  - `CardText` and `forTasks` change as quoted in the index;
  - every builder declares the three fields, by the table below.
  - A small `shipCard(batch, text)` helper gives every `shipCards.*` card `tier: Ask`, `urgency: High` and
    `closesWhen: { by: 'event', when: { event: 'batch_shipped', batchId } }`. That's what `ship.ts:519` adds today.
- Modify `apps/daemon/src/delivery/context.ts`: `flagOf` passes the three fields through, and stops writing
  `CARD_RESOLVES_WHEN`, since `flagCard` writes it now.
- Modify `apps/daemon/src/delivery/ship.ts:519`: the `resolvesWhen` spread goes.
- Modify `apps/daemon/src/daemon/git-refusal.ts`: `closesWhen` replaces the hand-written `detail[CARD_RESOLVES_WHEN]`.
- Modify every other raiser the compiler names. The inventory found these:
  - `delivery/`: `worktree-repair.ts:141`, `pass-settle.ts`, `pass-stack.ts`, `checkout-return.ts`,
    `left-out-settle.ts`, `skipped-card.ts`, `recover.ts`;
  - `inbox/`: `gate-host-card.ts`, `project-mcp-reader.ts`, `mcp-approval.ts`, `docker-card.ts`, `hazard-card.ts`;
  - `hazards/removal-card.ts`;
  - `watcher/watcher.ts`;
  - `pass/`: `abandon.ts` (the Move variant), `folder.ts`, `move-copy.ts`;
  - `recovery/recover.ts`;
  - `runner/`: `pass-check.ts`, `runner.ts`;
  - `mcp/claim-wait.ts`;
  - `load/`: `monitor.ts`, `disk.ts`;
  - `accounts/`: `model-list-wait.ts`, `pauses.ts`, `runtime.ts`, `limits.ts` and its cards, `preparer.ts` and its
    cards, `move-back.ts`;
  - `self-update/self-update.ts`.
- Modify the fixtures that call `inbox.flag` directly in tests, as the compiler names them. Give each one
  `tier: 'ask'`, `urgency: 'high'`, `closesWhen: BY_ANSWER`, which is today's behaviour.
- Tests: extend `apps/daemon/src/delivery/cards.test.ts` and `apps/daemon/src/inbox/inbox.test.ts` ("a flag with a
  fold key").

## The table

Abbreviations:

- **A** is ask, **S** is status;
- **H**, **N** and **L** are high, normal and low;
- **ans** is `{ by: 'answer' }`;
- **ev:x** is `{ by: 'event', when: { event: 'x', … } }`;
- **wd:"…"** is `{ by: 'withdrawn', when: '…' }`. Write the quoted words as the `when` string.

| Raiser (file) | Tier | Urg | closesWhen | Note |
| --- | --- | --- | --- | --- |
| `forTasks(…)`: every `startCards.*`; `worktreeCards.pathExists/seedFailed/installFailed` at a cut; `wrongBranchCard('not_joined')`; `cutInterrupted` | A | H | ev:tasks_started (ans when no task ids) | builders return `CardText`; `forTasks` sets the fields |
| `shipCards.*` (via `shipCard`), `wrongBranchCard('not_shipped')` | A | H | ev:batch_shipped | |
| `shipCards.baseConflict` | A | H | ev:batch_shipped | Dismiss-only: follow-up task to add `actions` |
| `leftOutCards.*` with options; `revertKept` while shipping | A | H | ev:batch_shipped | |
| `leftOutCards.notStarted` not answerable; `revertKept` shipped, closed or abandoned | A | N | ans | Dismiss-only, no closer: for S2 to decide |
| `worktreeCards.missing('waits')` | A | H | ans | Abandon |
| `worktreeCards.missing('failed')`, `inTheWay`, `notReopened`, `notWhole`, `installFailed` at repair | A | H | ans | Retry / Abandon batch |
| `worktreeCards.keptDirty`, `keptIgnored` | A | N | wd:"the batch's worktree is removed (worktree-cleanup)" | |
| `worktreeCards.orphanKept`, `orphanIgnored` | A | N | wd:"the orphan worktree is removed (worktree-sweep)" | |
| `worktreeCards.leftBehind`, `removeFailed` | A | N | ans | |
| `baseCards.lostUnreadable`; `shipCards.migrationsLost` unreadable | A | H | ans | Clear the notice acts |
| `wrongBranchCard('waits')`, `('failed')` | A | H | ans | `// S2: branch_ready; Switch Back` |
| `checkoutCards.*` (Your checkout stays on) | A | N | ans | |
| `prCards.catchUpStopped` | A | H | wd:"GitHub reads the pull request as mergeable (pr-watch, ship)" | |
| `prCards.ciStopped` | A | H | wd:"the pull request's CI passes or it ends (clearCiStop)" | |
| `prCards.noRunner` | A | H | wd:"a new head, a merge or a close (pr-watch)" | |
| `prCards.checksFailed` | A | N | wd:"the checks pass or the pull request merges (pr-watch)" | |
| `prCards.rerunFailed` | A | N | ans | Dismiss-only, no closer: for S2 to decide |
| `prCards.closed` | A | N | ans | Delete Branch / Keep |
| `prCards.ghUnavailable` | A | N | wd:"gh works again (pr-watch)" | `ghUnavailableText` too |
| `branchCards.abandoned`, `checkedOut` | A | N | ans | |
| `branchCards.withoutBatch` | A | N | wd:"no branch under 10db/ lacks a task (branch-sweep)" | `// S2: Delete Them / Keep` |
| `passCards.unopened` | A | H | ans | `// S2: Open the Folder; closes when the branch is gone` |
| `pass-settle.ts` move card, `pass-stack.ts` retarget card | A | N | wd:"the pass settles or the pull request is already on its base" | |
| `skipped-card.ts` | A | N | ans | |
| `inbox/service.ts` `flagStuckDelivery` (Retry delivery) | A | H | ans | |
| `inbox/gate-host-card.ts` | A | N | ans | |
| `inbox/mcp-approval.ts` | A | N | ans | |
| `inbox/docker-card.ts` `raiseDockerMayBeNeededNote` (Docker needed) | A | N | ans | |
| `inbox/docker-card.ts` `raiseDockerOnNote` (Docker is on) | A | L | ans | **row added**: not in §5 |
| `inbox/hazard-card.ts` via `hazards/removal-card.ts` | A | N | wd:"no hazard removal is pending (removal-card)" | |
| `inbox/project-mcp-reader.ts:69` (stops sessions from starting) | A | H | ans | `// S2: mcp_config_changed; Open the Config` |
| `inbox/project-mcp-reader.ts:24` (can't run as written), `:92` (check it) | A | N | ans | same S2 note |
| `watcher.ts:252`, `:264` (outside every claim) | A | H | ans | §4.5 "Stray-write cards are `by: 'answer'`"; `// S4: Trust This Version` |
| `watcher.ts:430`, `:442` (inside another workstream's claim) | A | H | ans | `// S4: Keep It / Show the Diff` |
| `pass/abandon.ts` with Move | A | N | wd:"the folder moves to the return branch (abandon)" | |
| `pass/folder.ts` (waiting for Your folder) | A | H | wd:"the folder is back, or the pass is abandoned" | |
| `pass/move-copy.ts` | A | N | ans | |
| `recovery/recover.ts:279`, `runner.ts:1200` (Workstream failed) | A | H | wd:"the run is retried, cancelled or shipped (cancelForWorkstream)" | |
| `runner/pass-check.ts` (Turn failed) | A | H | wd:"the page's next turn starts (withdrawPageItems)" | |
| `runner.ts:2195` (cannot run), not retried or nothing left | A | H | ans | `// S2: Choose Another Model` |
| `mcp/claim-wait.ts` (Claim deadlock) | A | H | wd:"the deadlock clears (claim-wait)" | |
| `load/disk.ts` (low disk) | A | H | wd:"free disk is above the floor again (disk)" | `// S2: Open Capacity Settings` |
| `load/monitor.ts` (overloaded) | S | L | wd:"the load hold lifts (monitor)" | `// S2: status line` |
| `accounts/model-list-wait.ts` | S | L | wd:"the account's model list arrives" | `// S2: status line` |
| `self-update.ts:451` (shaping hold) | S | L | wd:"the shaping hold is released" | `// S2: status line` |
| `self-update.ts:547` (Updating 10db failed) | A | N | ans | `// S2: update_installed; Try Again` |
| `daemon/git-refusal.ts` with a candidate | A | H | ev:checkout_trusted | |
| `daemon/git-refusal.ts` without a candidate | A | H | ans | `// S2: the next git call of that kind passes; Open the Checkout` |
| `accounts/runtime.ts` limit, cap, refused; `preparer.ts` sign-in, credentials, confirm, secret | A | H | wd:"the account is ready or the pause ends (accounts/stale-cards)" | |
| `accounts/limits.ts` usage high | A | N | wd:"usage drops below the threshold (limits)" | |
| `accounts/limits.ts` moved; `preparer.ts` recorded; `move-back.ts` | A | L | ans | undo offers (§4.4) |

## Steps

1. **Red.** In `delivery/cards.test.ts`, add one table, `every delivery card's tier, urgency and closer`. It has a
   row per builder in this table that `cards.ts` exports, and per outcome or variant. Each row calls the builder
   with the file's `batch` fixture and asserts `tier`, `urgency`, `closesWhen.by`, and `closesWhen.when` for an
   event closer:
   - `forTasks(startCards.noOrigin(project), [taskId])` → A, H, `event` / `tasks_started`;
   - `forTasks(…, [])` → `answer`;
   - `shipCards.gateFailed(…).card` → A, H, `event` / `batch_shipped`.

   Run `pnpm --filter @10db/daemon exec vitest run src/delivery/cards.test.ts`. Expected: it fails to compile,
   because the fields don't exist.
2. **Red.** In `inbox/inbox.test.ts` "a flag with a fold key", add rows:
   - a flag with `urgency: 'low'` is stored low;
   - a flag with `closesWhen: { by: 'event', when: { event: 'batch_shipped', batchId } }` stores
     `detail.resolvesWhen`, and `cardsResolvedByEvent` finds it;
   - a refresh of that flag keeps `detail.resolvesWhen`.

   Expected: they fail, because the fields don't exist and urgency is high.
3. Implement `FlagInput`, `flagCard`, `Card`, `forTasks`, `shipCard` and `flagOf`. Then follow the compiler through
   every raiser, using the table. Write each `// S2:` and `// S4:` note on the line above the `closesWhen`.
4. **Green.**
   - Run `pnpm --filter @10db/daemon exec vitest related src/inbox/service.ts src/delivery/cards.ts
     src/delivery/context.ts src/daemon/git-refusal.ts --run --maxWorkers=2`.
   - Run the tests of every module whose raiser changed, by `vitest related` on those files, in batches of about 10
     files.
   - Typecheck and lint the daemon.
   - `rg -n "Urgency.High" apps/daemon/src/inbox/service.ts` finds nothing.
5. Commit, naming every path. The message is `feat(daemon): every card declares its tier, urgency and how it
   closes`. The body lists any rows the main merge added, and carries:

   ```
   Value: protects=no flag is high by default, and every card's tier, urgency and closer are
     declared where it is built; fails_when=a card drops back to high, a builder's urgency or closer
     drifts from the sort table, or an event closer is lost on refresh; why_new=cards.test.ts
     checked only text and options; no_claim=that S2's closers exist, or that a raiser outside
     cards.ts matches the table (S3's repo test)
   ```
