# 10db local copy landing: a separate copy for a Commit Directly project

**Status:** designed 2026-11-24, not built. Core (git, recovery, sandbox). Size: Core.
**From:** the lane isolation brief (`~/Agents/notes/10db/2026-11-24-lane-isolation-brief.md`, revision 5), its
evidence notes beside it, and three rounds of adversarial review (Astra, rounds 1 to 3).
**Extends:** `2026-10-27-10db-worktree-mode-design.md` (worktrees), `2026-10-29-10db-task-placement-design.md`
(placement per task). **Starts after:** lanes can run Ampsio's backend checks (10db-2b's lane-env work), #811 and
#813 have merged.

## Brief

**What changes for you.** A project that commits directly to a branch (Ampsio: local `build`, never pushed) can put
a task in a **separate copy**: its own branch and folder, its own application database and its own test databases.
10db merges the copy onto `build` only after review accepts the work and the full gate passes on the exact commit
being merged. Your folder and `build` only ever receive finished work. After a landing, 10db runs your project's
after-landing command (Ampsio: snapshot `amps_dev`, then migrate it from a clean copy of the landed commit), then
takes the before and after pictures that the Slack posts use.

This is a **pilot**: one backend task at a time, run once on a Claude lane and once on a Codex lane. Its numbers
decide whether parallel copies, a resource broker, nightly batches and the Here/Away presets get built.

**What it buys.**
- Work that fails review never reaches `build`. AMP-147 left 11 commits there.
- Edits from your other sessions can't break the task's checks (AMP-119; 79 "Write outside every claim" cards).
- Measured numbers for the next decision.

**What could go wrong, and how we'd know.**
- **A landing interrupted by a crash.** A journal records every step. Recovery finishes it, puts it back, or leaves
  one card that says exactly what is half done. It never guesses.
- **A side effect that may or may not have happened** (a migration, a Slack post). It counts as done only with a
  receipt. Otherwise it shows "outcome uncertain" and is never repeated by itself.
- **Your folder has edits where the landing writes.** The landing waits with one card and touches nothing.
- **Docker reach is unchanged** (your decision): a lane can still reach `amps_dev` through Docker, as in the shared
  folder today. The judge stays the guard.

**Calls you might disagree with.**
1. Copies with local delivery need a per-project switch, `localCopies`, off by default. Ampsio turns it on.
2. Each task's copy gets one application database for its whole life, and a fresh test database for each test run.
3. A task in a copy that changes dependency lockfiles is refused in the pilot. Its virtualenv would be the shared
   one.
4. Measurement is a script run during the pilot, not product code.

**What's needed from you.** Approve by replying. Ampsio's side (its AGENTS.md D-13 exception, make targets that act
on the copy they run in, and three small scripts) is an Ampsio task, listed in §9.

## 1. Scope

In:
- separate copies for tasks of a `delivery: local` project with `localCopies` on;
- per-copy setup and teardown commands;
- landing onto the local base after review and gate;
- an after-landing command and pictures, with receipts and a landing journal;
- recovery after a crash at any step.

Out, decided by the pilot's numbers:
- parallel copies and Docker CPU sharing;
- the resource broker;
- batches of several tasks;
- the Here/Away presets;
- reading GitHub's repo rules;
- dependents waiting on a merge in team repos;
- copies for tasks that change dependencies.

## 2. Settings

New project fields (`ProjectInput`, `packages/contracts/src/entities.ts`):

| Field | Type | Default | Meaning |
|---|---|---|---|
| `localCopies` | boolean | false | Allows `workspaceMode: worktree` placement for a `delivery: local` project. |
| `copySetupCommand` | string or null | null | Run once per copy, before any lane starts; prints the copy's environment (§4). |
| `copyTeardownCommand` | string or null | null | Run when the copy is retired; receives that environment. |
| `afterLandingCommand` | string or null | null | Run after a landing (§6), in a scratch worktree of the landed commit. |
| `afterLandingPaths` | list of globs | `[]` | The command runs only when a landing changes a path these match; empty means after every landing. |

Changes to existing rules:
- The refine "A worktree per task needs pull request delivery" (`entities.ts:620`) and `placementFor`
  (`packages/db/src/store/tasks.ts:362-374`) accept `delivery: local` when `localCopies` is on.
- The project's default `workspaceMode` stays `shared` for Ampsio. The builder names the copy on the pilot task.
  `isolate` proposals then work as they do for pull-request projects.
- `localCopies` requires `copySetupCommand` to be set: a copy without its own database would fall back to the
  project's own database.

Each run pins its placement, target branch and delivery when it starts. Changing settings later never moves running
work.

## 3. The copy's life

A local copy is a batch, as a worktree batch is today. The states are `BatchState`'s own; nothing new.

1. **Cut** (`delivery/worktree-cut.ts`). As for a pull-request worktree, with one difference: the branch is created
   at `refs/heads/<base>` (the local base), not `refs/remotes/origin/<base>`, and nothing is fetched. A project
   with no origin is fine.
   - Seed and install happen as today (`worktree-seed.ts`, `worktree-dependencies.ts`).
   - The cut records `batches.cut_from` as the base commit.
2. **Setup** runs right after the cut, before any lane starts:
   - The copy's tracked files equal `cut_from`, checked with the private-index status check every other step uses,
     so the command runs builder-committed code only.
   - It runs through the gate runner (`createGateSandbox`, `forRun`), with the project's Docker and localhost
     switches and `TENDB_COPY_ID` set.
   - Its standard output is parsed as `KEY=VALUE` lines (§4).
   - Failure or a timeout fails the cut with a card that names the command's output and log, and removes the copy
     as a failed seed does today.
3. **Open.** Lanes work in the copy and commit to its branch. Step checks and the final check (`local-check.ts`
   `stepCheck`, `finalCheck`) run in the copy, with the copy's environment.
4. **Land** (§5) once the task is Done by review (its run accepted) and nothing in the batch is unfinished.
5. **Retire.** On SHIPPED, ABANDONED or a failed cut:
   - The teardown command runs in a fresh scratch worktree of the base's current tip (no seed, no install), never
     in the copy. It gets the copy's stored environment.
   - The worktree goes as today (`worktree-cleanup.ts`).
   - A failed teardown leaves one card naming the resources, and keeps the stored environment so it can be retried.

A FAILED batch keeps its copy and its database for Retry, as worktree batches do now.

## 4. The copy's environment

- **Shape.** The setup command prints one `KEY=VALUE` per line.
  - Keys match `^[A-Z][A-Z0-9_]{0,63}$`; values are at most 4 KiB with no newline; at most 32 pairs.
  - It is parsed with zod at the boundary.
  - A key the env allowlist would never pass to a command (`sandbox/env-allowlist.ts`, for example `DOCKER_CONFIG`)
    is refused, which fails the cut.
  - Values can hold the copy's own database password, so every value is treated as a secret: never logged, never on
    a card, never in an event.
- **Stored** in one macOS Keychain item per copy (`10db copy <batch id>`), the way Slack tokens are kept
  (`stakeholders/AGENTS.md`), never in SQLite. SQLite records only the keys, in a new table
  `copy_environment_keys (batch_id, key)`, written in the cut's transaction, so recovery and teardown know what to
  expect. The item is deleted once teardown succeeds.
- **Handed** to every lane session and every gate run of the batch, on every start and resume:
  - Claude lanes, any account (plan, API key, Bedrock): `LaneSandbox.forSession` adds the pairs to the env file
    the sandboxed shell sources (`sandbox/env-file.ts`).
  - Codex lanes: the same pairs go into `shellEnv`, which `codex-lane-config.ts:65` sets as
    `shell_environment_policy.set`.
  - Gate runs: `forRun` adds them to the run's env.
  - One function, `copyEnvironmentOf(batchId)`, reads the Keychain item. It is the only reader, so the providers
    can't differ. An item that can't be read fails the session's start with one card. It never starts the lane
    without its environment, which would fall back to the project's own database.
- **Ampsio's** setup prints, for example, `DATABASE_URL`, `DATABASE_OWNER_URL`, `AMPS_LANE_DB` and
  `AMPS_TEST_DB_PREFIX`, all naming `amps_lane_<copy id>`. `AMPS_TEST_DB` itself is set per test run by Ampsio's
  make targets, `<prefix>_<run>`, dropped when pytest exits (`test_utils/run_tests.py`).

## 5. Landing

Landing runs in the project's ship queue (`delivery/jobs.ts`), one job at a time. A new table, `landings`, holds the
journal: `(id, batch_id, step, expected_tip, candidate, attempt, detail, updated_at)`, one row per landing. Every
step writes its row before acting and after. Steps:

1. **Preconditions.**
   - The task is Done with its review accepted, and no workstream of the batch has work in hand.
   - The copy is clean (no uncommitted files, private-index check).
   - Your folder is on `<base>`. If not, wait with one card, "Your folder isn't on build", and recheck every
     minute and when the watcher reports a change in the folder.
2. **Base update in the copy.**
   - Read `T = refs/heads/<base>`. If the copy's branch doesn't contain `T`, merge `T` into it in the copy with
     `Git.mergeIntoBranch` (`resolve: { generated }`, as `base-update.ts` does today).
   - A conflict goes back to the task as a fix, as base-update conflicts do now.
   - Record `expected_tip = T` and `candidate = C`, the copy's head.
3. **Gate on `C`.** Unless the latest passing final check already ran on `C`, run the full gate on `C`
   (`gateInScratch` in `delivery/scratch-gate.ts`, the one slot) with the copy's environment. `gateInScratch` is
   keyed by a pass today (`passId`, its scratch branch name); it's generalized to take a batch for this.
   - A failure fails the batch with today's gate-failure card and fix loop.
4. **Promote**, under your folder's repo lock (`withRepoLock`):
   - Read the base again. If it isn't `T`, go back to step 2 (attempt + 1). Past 3 attempts, wait with one card:
     "build keeps moving; landing waits".
   - Capture the **before** pictures now (§7), while your folder still shows `T`.
   - Promote with `Git.mergeIntoBranch({ repo: <your folder>, branch: <base>, from: C })`. `C` contains `T`, so
     this is the fast-forward path: `update-index --refresh`, the check for your edits in the written paths
     (`changes`, `untrackedInTheWay`), `read-tree -m -u T C`, then `update-ref` compare-and-swap `T → C`, putting
     the files back if the ref raced (`git.ts:3441-3475`).
   - `blocked` (your edits where it writes): wait with one card naming the files. The card is withdrawn when they're
     clean or committed, and the landing retries.
   - **The editor-save window.** `read-tree -m -u` refuses a file whose stat no longer matches the index after the
     refresh ("not uptodate"), so a save after the check is refused, not overwritten. The plan's first card proves
     this on Apple Git 2.50 and on CI's git. If either git overwrites, promotion instead defers whenever any written
     path's mtime is newer than the check, and this spec is amended.
5. **After landing** (§6), then the **after** pictures and the Slack post (§7).
6. **Done.** The batch goes SHIPPED, the copy is retired (§3), and the journal row is closed.

## 6. After-landing command

- **What runs.** It runs only when the landing changed a path that `afterLandingPaths` matches (Ampsio:
  `amps/backend/**/migrations/**`). With no globs, it runs after every landing.
- **Where.** It runs in a fresh scratch worktree of `C`, never your folder, through the gate runner with the
  project's switches. `TENDB_LANDED=<C>` and `TENDB_FOLDER=<your folder>` are set.
- **Receipt.** Exit 0 is the receipt; the project's command must exit non-zero unless its own check passed. Ampsio's
  runs `pg_dump`, `db_prepare` (which runs `migrate`, then `check_db_security`, `db_prepare.py:61-63`), and
  `verify-backend`.
- **Not started:** the journal says so, and recovery may start it.
- **Started, no receipt** (crash, timeout, or the daemon stopped mid-run): **outcome uncertain**, one card. It isn't
  rerun on its own. The card offers Run again and Mark done.
- **Failed:** one card with its output.
  - The landing stays SHIPPED: `build` already holds the work.
  - Pictures wait.
  - The card names the snapshot path the command printed (`TENDB_SNAPSHOT=` on its output, if any), and says a
    restore excludes uploaded files and discards everything written after the snapshot. 10db never restores
    anything.

## 7. Pictures and Slack

- **Why this is needed.** A task in a copy gets pictures only from the landing: today `takesPictures` requires
  shared placement (`pictures/picture-routes.ts:74-82`). The landing calls the camera explicitly, with the task's
  routes (`pictureRoutes`).
- **Before:** at step 4, before promotion.
- **After:** after a successful after-landing command, or straight after promotion when none ran.
- **What they show.** The project's `appUrl` (your stack), signed in by the project's dev-login command (Ampsio:
  the `frontend-e2e` tenant). This is the same exposure as pictures today.
- **The Slack post** counts as done only on `files.completeUploadExternal` succeeding (`slack/client.ts:266-277`),
  not on the file id that `files.getUploadURLExternal` returns earlier.
  - The journal records "posting" before the first call and "posted" with the reply.
  - A crash in between is outcome uncertain, with one card (Post again, Mark done). It is never reposted by itself.
  - Recipients and send settings apply as today.

## 8. Recovery

At startup, `delivery/recover.ts` reads every open `landings` row and the real state:

| Journal step | Real state | Recovery |
|---|---|---|
| base update | copy branch has or lacks the merge | redo step 2 from the copy's real head |
| gating | gate pid gone | rerun step 3 |
| promoting | base = `C` | promotion happened: record it, go on to step 5 |
| promoting | base = `T`, folder's written paths match `T` | nothing written: retry step 4 |
| promoting | base = `T`, written paths match `C` in files and index, nothing else changed in them | crashed between `read-tree` and `update-ref`: compare-and-swap `T → C`; if that races, card |
| promoting | base is neither `T` nor `C` | card: "build moved while a landing was interrupted"; leave everything; the copy keeps the work |
| promoting | written paths mixed between `T` and `C`, or edited | card naming the paths; touch nothing |
| after-landing started, no receipt | | outcome uncertain card (§6) |
| posting, no "posted" | | outcome uncertain card (§7) |
| retire | teardown not done | run teardown (it must be idempotent; Ampsio's drops `IF EXISTS`) |

Recovery never runs `read-tree`, a reset or a checkout on your folder for anything but finishing a compare-and-swap
whose files already match `C`.

## 9. Ampsio's side (an Ampsio task, its own process)

1. **AGENTS.md D-13.** One line: 10db may create private branches and worktrees for its copies. Sessions still never
   create or switch branches.
2. **Make targets act on the checkout they run in.** Today `gate.sh`, `make t`, `make lint`, `make migration` and
   `make api-client` `exec` into the one `amps` stack, and `verify-backend` refuses a checkout whose files differ
   from that container.
   - In a copy (detected by `AMPS_LANE_DB` set), they run in a one-off container from the backend image, with the
     copy's `amps/backend` mounted and the copy's environment, on the stack's network.
   - In your folder, nothing changes.
   - Whether `docker compose run -v` can add or override a bind mount on a service that defines one has to be
     verified first; a plain `docker run` on the network is the fallback.
3. **Setup:**
   - `CREATE DATABASE amps_lane_<id> TEMPLATE <migrated test template>`, with the template found the way
     `database_template.ensure_template` finds it;
   - grants as `prepare_roles_and_database` gives;
   - print the pairs in §4.
4. **Teardown:** drop `amps_lane_<id>` and any `amps_lane_<id>_*` test databases, `IF EXISTS`.
5. **After landing:**
   - `pg_dump -Fc amps_dev` to `~/Agents/scratch/ampsio/<date>/`, keeping the newest 5;
   - `db_prepare` from the landed scratch worktree, which has its own `amps/backend` mounted read-only;
   - `verify-backend` once `make watch` has synced;
   - print `TENDB_SNAPSHOT=<path>`.
6. **Pilot tasks** change no lockfile (§2, call 3). A copy task whose diff touches `uv.lock` or `pnpm-lock.yaml`
   fails its final check with a card saying the pilot doesn't support it.

## 10. Provider parity

- **Same everywhere.** The copy, its database, the gate, landing and recovery are 10db's, not the model's, so they
  behave the same on every account. The copy's environment reaches Claude lanes (plan, API key, Bedrock) through
  the env file, and Codex lanes through `shellEnv`, both from `copyEnvironmentOf`.
- **Unattended.** A capability an account lacks is skipped and reported the same way on every account. The project
  is never moved to another account.
- **The pilot** runs on a Claude plan lane and a Codex lane. API-key and Bedrock lanes are checked before any preset
  ships.

## 11. Trust and limits

- **Builder-committed code only.** Setup and teardown run builder-committed code: the cut's own tree, or a scratch
  worktree of the base. The after-landing command runs the landed commit, which passed review and the gate.
- **Docker reach is unchanged** (the builder's decision): with `sandboxDocker` on, a lane and a gate get the engine
  (`sandbox/lane-sandbox.ts:477`, `gate-sandbox.ts:281`) and can reach any database or folder. The judge is the
  guard, as in the shared folder. This spec adds no new reach.
- **New secrets:** none beyond the copy's own database password, kept in the Keychain and never shown.
- **Coordination:** copy tasks take area claims scoped to the batch (W9), and hazard claims (`migrations` project-wide)
  as today. A copy task adding a migration still waits for the `migrations` claim.

## 12. Tests

Following `.claude/rules/testing.md`; all core (git, recovery).

1. **Promotion in a real git repository:**
   - a dirty written path blocks and writes nothing;
   - a save after the refresh is refused by `read-tree` (the editor window, §5 step 4);
   - a raced compare-and-swap puts the files back.
2. **Recovery rows** for "promoting" (§8), in a real repository and a real SQLite file: base at `C`; at `T` with
   nothing written; at `T` with the written files matching `C`; base moved elsewhere.
3. **One run through the real pipeline** (`createTestEngine`, the fake adapter): a copy task in a local project
   lands only after review and gate; `build` moved during the gate means a second gate on the new candidate; the
   after-landing command's missing receipt becomes outcome uncertain and isn't rerun.

No e2e test is added; the cards reuse existing card kinds. Value cards go with each commit.

## 13. Measurement (a script, not product code)

`scripts/pilot-measure.mjs` in the coordinator's scratch, not the repo. Read-only SQLite plus `docker stats` sampled
every 5 s during gates. It reports per pilot task:
- outcome;
- refusals (`skipped_actions`);
- gate wait (queued to slot held);
- wall time;
- peak Docker CPU and memory;
- disk used by the copy and its databases.

Baseline: the shared-folder profile (`2026-11-24-ampsio-lane-profile.md`).

## 14. Decisions this records

One file each under `docs/architecture/decisions/` when built:
- a Commit Directly project may use separate copies behind `localCopies`;
- a copy lands only after review and a gate on the exact commit;
- a side effect counts only with a receipt, otherwise "outcome uncertain";
- Docker reach for copies is unchanged in the pilot (the builder's call).
