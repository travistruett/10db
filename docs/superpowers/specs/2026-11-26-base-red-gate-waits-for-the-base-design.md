# A task's gate that fails on its base's own failures waits for the base

**Status:** revision 4, 2026-11-26; designed, not built. **Size: Core** (recovery, a migration, a new
`NextAction` kind). This pull request is the spec and
`decisions/2026-11-26-a-gate-failure-the-base-has-holds-the-task.md`; the code is three follow-up tasks (§12).

## Brief

**What changes for you.** Today any gate that exits non-zero queues a fix attempt for the task that ran it
(`runner/runner.ts`, `verify()`, `nextAction: { kind: 'fix' }`). On Ampsio, on 2026-11-24, the base itself was
red at 705b5807f (130 tests and 35 mypy errors on a clean tree), and a task that touched only `.env` was sent to
chase backend failures outside its claim. After this change, a gate whose failures the base already has holds
the task on one Inbox card per project and branch. The hold uses no fix attempt, and the task gates again by
itself when the base moves.

**What it buys.** No fix session spends a model's time on a failure it can't fix and isn't allowed to touch,
and the builder sees one card saying the base is red, not one failed task per lane.

**What could go wrong, and how we'd know.**

- _A task's own new failure hides behind a red base._ Only when the gate's output can't be read (§2): then it
  is one key, the same as the base's. It is bounded: the task gates again when the base moves, and a green base
  shows the task's own failure.
- _10db hasn't seen the base fail yet._ It knows only what its own gates recorded (§3): in a shared folder, an
  earlier gate on a clean tree; in a worktree or copy, two unrelated tasks failing the same way. Until then the
  task takes the fix loop, bounded by `maxFixAttempts`.
- _Two unrelated tasks that break the same test the same way are taken for a red base._ Both wait on the card,
  which names the test; Retry from a task sends it to the fix loop.
- _A held task keeps its claims, and the base fix needs the same area._ F2 decides whether the hold frees them
  (§5).

**Calls you might disagree with.**

- 10db never runs an extra gate only to learn the base's state (§3). While a worktree task is held it does
  fetch the base every few minutes, to see it move (§6).
- Opaque gate output is one key, so a task's own failure can hide behind a red base until the base is green.
- In a worktree or copy, a held task's own gate speaks for the base: held again marks the new base red, and a
  pass marks it green (§3 (iv)).
- No base-fix task is filed by itself; the card offers File Fix Task.

**Needed from you:** nothing.

---

## 1. Today, in the code

- `runner/runner.ts`, `verify()`: after the gate, a failure that is only in tests is run once more on just the
  failing files (`rerunFlaky`, `delivery/flaky-tests.ts`); a rerun that passes counts as passed. Anything still
  failing increments `attempt`, stores the evidence and queues `{ kind: 'fix', evidenceId }`, or fails the run
  with `GateFailed` past `maxFixAttempts`. Nothing asks whether the base fails the same way.
- `delivery/gate-failures.ts`: `readGateFailures(checkout, output)` reads the failed steps from the gate's
  `FAILED <step>: …` lines or its `GATE FAIL:` summary, and each step's failing tests from its log through
  `failingTests` (vitest's ` FAIL ` lines). `failureKey` keys a test as `<file>\0<name>`. `touchedBy(file,
changed)` says whether a test file a runner printed is one of a set of repo-relative paths.
- The CI precedent: `delivery/ci-failure-class.ts` sorts a pull request's failing required checks by name
  against the checks red on its base, and a check red on both is the base's
  (`decisions/2026-11-24-a-red-base-is-one-fix-not-a-fix-per-pull-request.md`). One card per repository and
  branch, `prCards.baseRed` in `delivery/cards.ts` (foldKey `base-red:<repo>:<branch>`), says the base is red
  and how many wait. This spec is the same rule for the gate on the Mac, where there is no CI run of the base to
  read.
- The ship gate already has a narrower rule: in `delivery/ship.ts`, a ship gate (a copy's landing gate
  included) that fails only in tests the batch did not change (`outsideTheBatch`) runs once more, and a second
  failure raises `shipCards.gateFailedUnrelated`. A ship gate never starts a fix; it fails the batch with a card.
- `runner/runner.ts` sets `baseHead` once, to the checkout's HEAD as the run's first session starts.
  `runCommits` (`delivery/run-commits.ts`, through `ownWork`) reads the run's own commits from it: in the
  project's checkout only those its sessions made through the commit tool, since other lanes commit on the same
  branch; in a worktree every commit since it.
- `delivery/base-update.ts` merges the base into a batch's worktree before its gate, and `moveBase` moves
  `batch.baseSha` and its tasks' `baseHead` to the merged base (around line 477). A batch with no worktree goes
  through `shared()`, which counts the base's new commits and never merges, so nothing moves its tasks'
  `baseHead`; nothing moves it for a run with no batch either.
- `delivery/checkout.ts`, `checkoutOf`: a run with no batch worktree works in the project's checkout
  (`repoPath`, a shared folder); a worktree or a separate copy works in `batch.worktreePath`.
- `daemon/start.ts` rechecks waiting copy landings on a minute timer on the injected clock: the folder watcher
  reports writes, not HEAD or ref moves.

## 2. Failure keys

A gate failure is a set of keys, read from `readGateFailures` after `rerunFlaky` (a test that passed on its
rerun is a flake and is never a key):

- `test:<file>\0<name>` for each parsed failing test (`failureKey`);
- `step:<name>` for a failed step whose log names no test;
- with no step parsed at all, one key `exit:<code>`: the gate's output is opaque.

What a log says is project-specific. Today only vitest's lines parse; F3 adds pytest and mypy, so Ampsio's
failures become test and error keys rather than `step:test` and `step:typecheck`.

## 3. What 10db records

Two new tables, written only by the daemon, never by an agent.

**`base_gate_verdicts`**, a verdict at a commit on a base line (§4): `project_id`, `gate_command`, `commit`,
`verdict` (`red` | `green`), `keys` (JSON array, empty when green), `source` (`gate` | `landing` | `two_runs` |
`held_run`), `evidence_id`, `created_at`. Per project and gate command the newest 200 by the commit's date are
kept, not by when the row was written: a derived row can be written at an older commit, and must not outlive a
green row at a newer one.

**`gate_failure_runs`**, the latest failing gate of a run in a worktree or copy, which source (iii) compares:
one row per run, `workstream_id`, `project_id`, `gate_command`, `task_id`, `batch_id`, `base_branch`, `base`
(`batch.baseSha` after the gate's base update), `head`, `keys`, `evidence_id`, `created_at`. The run's next
failing gate replaces it; its next passing gate, or the run ending, deletes it.

Sources of `base_gate_verdicts`:

- **(i) A gate in the shared folder.** Any 10db gate in the project's checkout (a task's gate, a Commit
  Directly task's final gate, the ship gate of a batch with no worktree) that ran on a clean tree writes its
  verdict at HEAD. A tree with any uncommitted change, another lane's included, writes nothing: the gate tested
  more than the commit.
- **(ii) A copy's landing gate that passed.** The landing fast-forwards the base to C, so C is on the base:
  green at C.
- **(iii) Two unrelated runs agree** (direction (c)), in worktrees and copies only. When a run's gate fails,
  10db looks in `gate_failure_runs` for a run of another batch on the same base branch, whose task and this one
  have no `dependsOn` path either way, and whose base holds this run's base or is held by it. Their overlapping
  keys are written red at the older of the two bases, the one both trees hold; then this run is classified
  against it (§4). In a shared folder (iii) never applies: a later gate there holds the earlier run's commits,
  so two runs failing the same way may both be failing on one run's break.
- **(iv) A held run gates again**, in a worktree or copy (§6). Held again: red at its base (`batch.baseSha`)
  with the keys it was held on. Passed: green at its base. The hold already rests on the run's own commits not
  bringing those keys, so its result on a new base speaks for that base. In a shared folder (i) records the
  same gate.

Rejected, with reasons:

- **Gating the base tip** (direction (b)). A shared folder can't check out the base while lanes work in it, and
  Ampsio's gate runs in containers that sync from the main checkout (`make watch`), so a detached worktree of
  the base can't run it.
- **A baseline gate per new base.** About 18 minutes per base move on Ampsio, on a Mac that runs one
  unattended job at a time.

## 4. The rule

Read in `verify()` after the gate and `rerunFlaky`, before this gate writes any record, over the records of the
project and gate command. The **base line** is the commits whose records speak for the run's base; **not the
base's** is what the gated tree holds beyond it.

| Placement                                            | Gated tree                                         | Base line                           | Not the base's                                           | Writes                                 |
| ---------------------------------------------------- | -------------------------------------------------- | ----------------------------------- | -------------------------------------------------------- | -------------------------------------- |
| Shared folder: no batch, or a batch with no worktree | the checkout's HEAD                                | every commit HEAD holds             | the run's own commits (`runCommits` from `row.baseHead`) | (i)                                    |
| Worktree batch                                       | HEAD after the base update merged `origin/<base>`  | every commit `batch.baseSha` holds  | the rest of HEAD: the run's and its batch-mates' commits | a `gate_failure_runs` row; (iii); (iv) |
| Separate copy, a task's gate                         | HEAD after the update merged the local base branch | as a worktree                       | as a worktree                                            | as a worktree                          |
| Separate copy, the landing gate                      | C                                                  | – (it starts no fix, so no hold)    | –                                                        | (ii)                                   |

`row.baseHead` doesn't bound a shared folder's base line. It is the HEAD of the run's first session and
nothing moves it (§1), while the gate tests a HEAD that holds every commit other lanes made since; those are
the base's. Every record on a base line is read, whichever source wrote it, so a worktree reads a shared
folder's (i) records at commits its base holds.

**A key came from the base** when a red record R on the base line holds it, and:

1. no other record on the base line at R's commit, or at a commit that holds it, lacks the key: a later green,
   or a later red without it, may mean it was fixed since;
2. none of the commits that may have brought it is the run's own: the commits R holds that no green record on
   the base line holds (`git rev-list R --not G…`).

Both err toward the fix loop. A red record without the key may come from a gate that stopped before the step
that runs it, so it ends the key's stretch in 1 but never narrows the commits in 2.

Condition 2 always holds in a worktree or copy, whose base line has none of the run's commits. In a shared
folder it tells a run's own break from another lane's. Task D starts at a head with a green record; lane A
commits a1, which breaks t, and A's gate records red at a1; then D commits, gates and fails on t. For D, a1 is
the only commit since the green record and it isn't D's, so D is held. For A, a1 is its own, so A takes the
fix loop, and stays there at every later gate: a1 is always among the commits that may have brought t.

**The failure is the base's** when every one of its keys came from the base and no key's test file is one the
run changed (`touchedBy` against the run's own files, read as `coverageOf` reads them). **Otherwise it is the
task's**: today's fix loop, and the fix brief names the keys that came from the base. A touched test file means
the task may have changed the test, so it is the task's to look at.

Known limits, each sending the run to the fix loop rather than holding it:

- A shared folder's gate records only on a clean tree, so while lanes hold uncommitted edits there is less to
  read.
- A break another lane commits after the run's first commit, with no green record between them, can't be told
  from the run's own (condition 2).
- A failure a batch-mate brought is not the base's, as today.

F1 reads the records on a line with one `git rev-list` of it, not one call per row.

## 5. The hold

- The run goes `WAITING_HUMAN` with a new `NextAction`, `{ kind: 'base_red', inboxId, heldAt, branch }`.
  `heldAt` is the tip of the base line it gated on: the shared folder's HEAD, or `batch.baseSha`. `branch` is
  the shared folder's branch (`row.branch`, or the batch's branch when it has no worktree) or the batch's base
  branch.
- No attempt is counted, and the evidence is stored as for a fix.
- Claims are kept. The risk is a base fix that needs the same area; F2 chooses between keeping them and
  releasing them for the hold, and says which.
- One card per project and branch, foldKey `local-base-red:<projectId>:<branch>`, Ask tier: the newest red
  record's commit, up to 10 keys, a link to its log, and how many tasks wait. It is folded, never one per task.
- The card's action **File Fix Task** files a task for the base. That task's own run, and a held run the
  builder retries from its task, own the keys: they take the fix loop.
- The card is withdrawn when no run waits on it or gates in its turn (§6).

## 6. Resume

The daemon's minute timer (as for copy landings, §1) reads each card's tip T: the shared folder's HEAD, a
copy's local base branch, or `origin/<base>`, fetched at most every 5 minutes while the card holds a run (the
base update's fetch, in the project's checkout). A held run whose `heldAt` is T waits on. For the others:

- **A record at T decides first.** A red record at T that holds every one of the run's keys moves `heldAt` to
  T, and nothing runs. Any other record at T, or none, makes the run due.
- **One run per card gates at a time.** Of the due runs, the one whose last gate is oldest goes `QUEUED` with
  `{ kind: 'verify', baseRed: inboxId }`, so a restart knows the card's turn is taken. The others wait for its
  outcome:
  - **passes**: in a worktree or copy, (iv) writes green at its base. Every other run on the card goes
    `QUEUED` with `verify`, and the gate slots order them as for any gate;
  - **held again**: in a worktree or copy, (iv) writes red at its base with the keys it was held on (in a
    shared folder (i) wrote its record if the tree was clean). Each other run whose keys are all among those
    moves `heldAt` to the tip it gated on, and the next due run goes;
  - **fails on its own, or ends with no verdict** (stopped, timed out, a base conflict): it leaves the card as
    any gate failure does, and the next due run goes.

The order bounds a wrong mark. A held run whose own work fails with the new base (the key came back through
its merge) is held again and marks the base red; at the next move another run gates first, and its pass marks
the base green and releases the rest. A shared folder's tip moves at every lane's commit: a lane's own gate at
the tip answers by the first rule, and the second sends at most one held run per card through the gate per
move.

A base that never moves holds its runs until the builder acts on the card (File Fix Task, or Retry from the
task); the card says so.

`recovery/recover.ts` leaves a `base_red` run waiting, as it does `builder_review`, and raises its card again if
it was closed some other way; the timer resumes it.

## 7. Provider parity

The gate, the records, the classifier and the hold are the daemon's. They behave the same on a Claude plan,
Claude through Bedrock or an API key, and a ChatGPT/Codex plan; no provider lacks anything here.

## 8. Trust and limits

Nothing here crosses a hard limit: the daemon reads git and its own gate output, writes its own database, and
runs no command it did not already run; the timer's fetch is the base update's own, to the origin the builder
trusted. Nothing waits on the builder except the one card, and a held task moves on by itself when the base
moves.

## 9. State tables (design)

Classifying a failing gate (§4):

| Red records on the base line                 | Every key from the base | A key's test file touched | Output | Result                                |
| -------------------------------------------- | ----------------------- | ------------------------- | ------ | ------------------------------------- |
| none                                         | no                      | –                         | any    | fix loop                              |
| hold a key, then a record without it         | no                      | –                         | any    | fix loop                              |
| hold every key, an own commit may bring one  | no                      | –                         | any    | fix loop                              |
| hold some keys                               | no                      | –                         | any    | fix loop; brief names the base's keys |
| hold every key, conditions 1 and 2 hold      | yes                     | no                        | parsed | hold                                  |
| hold every key, conditions 1 and 2 hold      | yes                     | no                        | opaque | hold (`exit:<code>` matches)          |
| hold every key, conditions 1 and 2 hold      | yes                     | yes                       | any    | fix loop                              |

Resuming a held run (§6):

| Held run                                      | Result                                                                          |
| --------------------------------------------- | ------------------------------------------------------------------------------- |
| T is `heldAt`                                 | waits                                                                           |
| a red record at T holds every key             | `heldAt` moves to T; no gate                                                    |
| T moved, no such record                       | due; one run per card gates, oldest last gate first                             |
| its turn passes                               | green at its base (worktree, copy); the rest gate                               |
| its turn is held again                        | red at its base (worktree, copy); others with every key in it move `heldAt`     |
| its turn fails on its own, or has no verdict  | it leaves the card; the next due run gates                                      |

## 10. Tests (for the follow-ups)

Under `.claude/rules/testing.md` the classifier and the resume decisions are pure rule tables, and recovery is
core:

- the classifier as one pure table test over §9's first table, the records and their ancestry given as data;
- the resume decisions as one pure table test over §9's second table;
- one `createTestEngine` test through the wiring, on a real git repository: two held runs on one card, the
  base moves, one gates and passes, the other is released and passes, and the card is withdrawn.

## 11. Relation to other specs

`2026-11-25-failures-reach-you-only-when-you-can-act-design.md`, "Waits on other work", waits on an open fixing
task. This hold comes before a run fails, so triage never sees it; when F2 lands and a base-fix task is open,
its card can name that task.

## 12. Follow-ups

- **F1** Gate runs keep a base verdict record and classify failures against it: §3's two tables and their
  migration, sources (i) to (iii), §4's classifier with its base line per placement, and §10's classifier
  table.
- **F2** A task whose gate fails only on its base's failures is held on one card and resumes when the base
  moves: `base_red`, the card, the timer and its fetch, the one-run turn and source (iv), recovery, the desktop
  label; after F1. It carries the task's second acceptance criterion.
- **F3** Gate failure keys parse pytest and mypy output.

Gating the base tip (b) is not filed.

## Appendix: reviews and what each revision did

Revisions 2 and 3 rest on the author's own checks: a reviewer was dispatched four times on revisions 1 and 2
(the plan-reviewer three times, a general-purpose agent on Fable once), and no run returned a report. Revision 2 let source (iii) take two bases on one line; revision 3 sent one
held run per card back through the gate rather than every one.

10db's review step, round 1, on revision 3 (us.anthropic.claude-opus-5-5) is the independent review before
code. Its findings, and what revision 4 did:

1. _§4, shared folder: B misses other lanes' commits._ A shared folder's base line is every commit the gated
   HEAD holds, and condition 2 keeps the run's own commits out. "A recorded commit that is not one of the run's
   own" was not enough by itself: a commit after the run's first one holds that commit's change.
2. _(iii) in a shared folder blames a task's own break on the base._ (iii) applies only in worktrees and
   copies. Its record goes at the older base, which both trees hold; revision 2 wrote it at the newer, which one
   tree lacks. Condition 2 never counts a key a run's own commit may have brought as the base's.
3. _(iii) has no data to read._ `gate_failure_runs` holds each worktree or copy run's latest failing gate, its
   fields and when it goes. Unrelated is another batch on the same base branch with no `dependsOn` path; a run
   with no batch is in a shared folder, where (iii) doesn't apply.
4. _§6 can leave runs held for good in a worktree or copy._ The chosen run's outcome now moves the others: a
   pass releases them, held again moves their `heldAt` by (iv)'s record, its own failure passes the turn. The
   turn rides on its `verify` action across a restart, and the oldest-last-gate order bounds a wrong mark to one
   base move.
5. _The placement table left out a batch with no worktree, and whether K reads (i) records in a worktree._ The
   table has the row (it is a shared folder), and every record on a base line is read whatever wrote it. The
   separate copy's row was also wrong: its task gate merges the local base as a worktree's does, and its landing
   gate starts no fix.
6. This appendix replaces revision 3's, and the decision record follows (iii) and (iv).
