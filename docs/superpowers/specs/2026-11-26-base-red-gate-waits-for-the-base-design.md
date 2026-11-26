# A task's gate that fails on its base's own failures waits for the base

**Status:** revision 2, 2026-11-26; designed, not built. **Size: Core** (recovery, a migration, a new
`NextAction` kind). This pull request is the spec and
`decisions/2026-11-26-a-gate-failure-the-base-has-holds-the-task.md`; the code is three follow-up tasks (§12).

## Brief

**What changes for you.** Today any gate that exits non-zero queues a fix attempt for the task that ran it
(`runner/runner.ts`, `verify()`, `nextAction: { kind: 'fix' }`). On Ampsio, on 2026-11-24, the base itself was
red at 705b5807f (130 tests and 35 mypy errors on a clean tree), and a task that touched only `.env` was sent to
chase backend failures outside its claim. After this change, a gate whose failures the base already has holds
the task on one Inbox card per project and base branch. The hold uses no fix attempt, and the task gates again
by itself when the base moves.

**What it buys.** No fix session spends a model's time on a failure it can't fix and isn't allowed to touch,
and the builder sees one card saying the base is red, not one failed task per lane.

**What could go wrong, and how we'd know.**

- _A task's own new failure hides behind a red base._ Only when the gate's output can't be read (§2): then it
  is one key, the same as the base's. It is bounded: the task gates again when the base moves, and a green base
  shows the task's own failure.
- _The first gate on a base nobody gated takes the fix loop._ 10db knows the base is red only from runs it has
  already seen (§3); the fix loop is bounded by `maxFixAttempts`, and the second unrelated task on that base
  turns it into a hold.
- _A held task keeps its claims, and the base fix needs the same area._ F2 decides whether the hold frees them
  (§5).

**Calls you might disagree with.**

- 10db never runs an extra gate only to learn the base's state (§3, rejected options).
- Opaque gate output is one key, so a task's own failure can hide behind a red base until the base is green.
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
  failure raises `shipCards.gateFailedUnrelated` for that batch. It never starts a fix, but it is one card per
  batch and knows nothing of the base's own state.
- `runner/runner.ts` sets `baseHead` once, to the checkout's HEAD as the run's first session starts, and keeps
  it; `ownWork` reads the run's own commits from it. In a shared folder that is the head before the run's own
  commits; other lanes' commits after it are filtered out by `runCommits`.
- `delivery/base-update.ts` merges the base into a batch's branch before its gate and moves the run's
  `baseHead` to the merged base (around line 477).
- `delivery/checkout.ts`, `checkoutOf`: a run with no batch worktree works in the project's checkout
  (`repoPath`, a shared folder); a worktree or a separate copy works in `batch.worktreePath`.

## 2. Failure keys

A gate failure is a set of keys, read from `readGateFailures` after `rerunFlaky` (a test that passed on its
rerun is a flake and is never a key):

- `test:<file>\0<name>` for each parsed failing test (`failureKey`);
- `step:<name>` for a failed step whose log names no test;
- with no step parsed at all, one key `exit:<code>`: the gate's output is opaque.

What a log says is project-specific. Today only vitest's lines parse; F3 adds pytest and mypy, so Ampsio's
failures become test and error keys rather than `step:test` and `step:typecheck`.

## 3. The verdict record

A new table, `base_gate_verdicts`: `project_id`, `gate_command`, `commit`, `verdict` (`red` | `green`),
`keys` (JSON array), `evidence_id`, `created_at`. The newest 50 per project and command are kept; older rows
are deleted when a new one is written.

Sources, each written by the daemon, never by an agent:

- **(i) A gate on the base itself.** Any 10db gate that ran on a clean tree whose HEAD is a commit of the base
  branch (reachable from the base ref). In a shared folder that is a task's gate after its commits land, so
  its verdict is recorded at that HEAD. A tree with any uncommitted change (another lane's edits included)
  records nothing: the gate tested more than the commit.
- **(ii) A landing gate that passed.** A separate copy's landing gate on C that passed and fast-forwarded the
  base: green at C.
- **(iii) Two unrelated tasks agree.** When runs of two unrelated tasks (no dependency either way, different
  batches) gated against the same base B fail with overlapping keys, a derived red record at B holds the
  overlap. This is direction (c) of the task. In a shared folder two runs rarely start at the same head, so
  "the same B" also covers two bases where one is an ancestor of the other: the record is written at the newer
  of the two, where both runs' history meets. Two bases on diverged lines give no record.

Rejected, with reasons:

- **Gating the base tip** (direction (b)). A shared folder can't check out the base while lanes work in it, and
  Ampsio's gate runs in containers that sync from the main checkout (`make watch`), so a detached worktree of
  the base can't run it.
- **A baseline gate per new base.** About 18 minutes per base move on Ampsio, on a Mac that runs one
  unattended job at a time.

## 4. The rule

Read in `verify()` after the gate's base update, before this gate's own record is written:

- **B** is the run's base: `row.baseHead`. In a shared folder it is the head before the run's own commits; in a
  worktree or copy it is the base the update merged in.
- **K** is the newest red record at B or at an ancestor of B (`git merge-base --is-ancestor`), with no green
  record between it and B.
- **The failure is the base's** when K exists, every one of the run's keys is in K, and no key's test file is
  one the run changed (`touchedBy` against the run's own files, found as `coverageOf` finds them).
- **Otherwise it is the task's**: today's fix loop.

| Placement     | B                                       | Sources that give K |
| ------------- | --------------------------------------- | ------------------- |
| Shared folder | the head before the run's commits       | (i), (iii)          |
| Worktree      | the base the update merged in           | (ii), (iii)         |
| Separate copy | the base tip merged into C (landing)    | (ii), (iii)         |

A key outside K means the task added a failure, and the task fixes it with the base's failures in view (the fix
brief names which keys K already holds). A touched test file means the task may have changed the test, so it is
the task's to look at.

## 5. The hold

- The run goes `WAITING_HUMAN` with a new `NextAction`, `{ kind: 'base_red', inboxId, heldAt, branch }`.
  `heldAt` is the base tip as read at the hold: the shared folder's HEAD, or the base ref.
- No attempt is counted, and the evidence is stored as for a fix.
- Claims are kept. The risk is a base fix that needs the same area; F2 chooses between keeping them and
  releasing them for the hold, and says which.
- One card per project and base branch, foldKey `local-base-red:<projectId>:<branch>`, Ask tier: the red
  commit, up to 10 keys, a link to the log, and how many tasks wait. It is folded, never one per task.
- The card's action **File Fix Task** files a task for the base. That task's own run, and a held run the
  builder retries from its task, own the keys: they take the fix loop.
- The card is withdrawn when no run waits on it.

## 6. Resume

The scheduler tick (`scheduler/`, which already keeps queue waits) reads each held run's base tip: the shared
HEAD, or the base ref as the base update reads it. When it differs from `heldAt`, the run goes `QUEUED` with
`{ kind: 'verify' }`, and its result is classified again:

- still red on base keys: held again, no attempt counted;
- green: it passes, as any gate does;
- a failure of its own: the fix loop.

`recovery/recover.ts` leaves a `base_red` run waiting, as it does `builder_review`, and raises its card again if
it was closed some other way; the tick resumes it.

## 7. Provider parity

The gate, the verdict record, the classifier and the hold are the daemon's. They behave the same on a Claude
plan, Claude through Bedrock or an API key, and a ChatGPT/Codex plan; no provider lacks anything here.

## 8. Trust and limits

Nothing here crosses a hard limit: the daemon reads git and its own gate output, writes its own database, and
runs no command it did not already run. Nothing waits on the builder except the one card, and a held task moves
on by itself when the base moves.

## 9. State table (design)

| Verdict at B      | Keys ⊆ K | Touched | Output   | Result                                  |
| ----------------- | -------- | ------- | -------- | --------------------------------------- |
| none              | –        | –       | any      | fix loop                                |
| green after red   | –        | –       | any      | fix loop                                |
| red               | yes      | no      | parsed   | hold                                    |
| red               | yes      | no      | opaque   | hold (`exit:<code>` matches)            |
| red               | no       | –       | any      | fix loop; brief names K's keys          |
| red               | yes      | yes     | parsed   | fix loop                                |
| held, base moved  | –        | –       | –        | gate again; classified as above         |
| held, still red   | yes      | no      | any      | held again, no attempt                  |
| held, now green   | –        | –       | –        | passes                                  |

## 10. Tests (for the follow-ups)

Under `.claude/rules/testing.md` the classifier is a pure rule table and recovery is core:

- the classifier as one pure table test over §9's rows;
- one `createTestEngine` test through the wiring: a held run with one card, the base moves, the gate passes,
  the run is done and the card withdrawn.

## 11. Relation to other specs

`2026-11-25-failures-reach-you-only-when-you-can-act-design.md`, "Waits on other work", waits on an open fixing
task. This hold comes before a run fails, so triage never sees it; when F2 lands and a base-fix task is open,
its card can name that task.

## 12. Follow-ups

- **F1** Gate runs keep a base verdict record and classify failures against it (migration, classifier, §10's
  table test).
- **F2** A task whose gate fails only on its base's failures is held on one card and resumes when the base
  moves (`base_red`, the card, the tick, recovery, the desktop label; after F1). It carries the task's second
  acceptance criterion.
- **F3** Gate failure keys parse pytest and mypy output.

Gating the base tip (b) is not filed.

## Appendix: round-1 review and what revision 2 did

The plan-reviewer was dispatched twice on revision 1 and neither run returned a report, so revision 2 rests on
the author's own check, and 10db's review step on this pull request is the independent review before code.

- §1's code references were checked against `apps/daemon/src`: `readGateFailures`, `failingTests`,
  `failureKey` and `touchedBy` in `delivery/gate-failures.ts`, and the `baseHead` move at `base-update.ts:477`.
- Source (iii) asked for "the same B", which a shared folder almost never gives, since each run starts at the
  head of its own moment. Revision 2 lets one base be an ancestor of the other and writes the record at the
  newer one.
