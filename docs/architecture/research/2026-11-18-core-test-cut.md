# Core unit tests: folds, merges and removals

One cut over the core unit tests: `apps/daemon/src/{guard,sandbox,permissions,trust,git,delivery,pass,runner,recovery}`,
`packages/db/src/migrations-*`, `packages/harness/src` and `tests/repo/src/git-guard.test.ts`. Rule tables fold into one
test per rule and verdict, which loops over every input with `expect.soft` labelled with that input. Flow tests that
boot the same lane or repository in the same state merge into one test that keeps the union of their checks. Tests
whose subject is not a protected rule are removed. Production code is unchanged, apart from one unused re-export.

## Brief

- **What changes:** core runs 2,418 tests instead of 8,431. Each table row is still checked as a labelled input.
  Every sandbox, guard, permission, secret, claim, recovery, git and migration rule that had a test still has one on
  the real thing. The five files that caught real bugs (`gate-sandbox`, `lane-sandbox`, `mcp-sandbox`, `fast-path`,
  `worktree-recover`) are untouched.
- **What it buys:** fewer lane and repository boots in the slowest files. `runner.test.ts` goes from 282 tests to
  156, `pr-watch` from 134 to 28, `batch-card` from 112 to 37, and `pr-catch-up` from 73 to 29. Before the cut,
  core's files of 4 s or more summed to 1,575 CI seconds (table below). The after number is in the pull request's
  test-report comment, which compares this branch's timing artefacts with main's.
- **What could go wrong:** a merged test could pass for a reason its parts did not, or a folded table could stop
  naming the row it breaks. Guards: each folded security table was made red once by breaking its rule (below). One
  merge that read state an earlier phase left behind was undone.
- **Calls you might disagree with:** a folded table now counts as one test, so a broken rule shows as one failing
  test that names every input it breaks. Wording, card, account, usage, rigor and review-round tests are gone.
- **Needed from you:** nothing.

## How it was counted

Both counts are collected with every `it.each` row expanded, as CI's timing reporter counts them. `vitest list` does
not expand an each-table, so it was not used for these numbers. The method was
`vitest run --project daemon --project daemon-delivery --project db --project harness --project repo -t <a name no test has>`
with the JSON reporter. That run collects every test and runs none. "Before" was run on a copy of `d1ef5f3e` (the
commit this branch starts from), "after" on this branch. Locally the base count is 8,431 tests. The task measured
8,659 from CI artefacts, and the difference is files outside this set that it counted as core.

| Area                 | Before | After | CI s before (files of 4 s or more) | Untouched real-catch files    |
| -------------------- | -----: | ----: | ---------------------------------: | ----------------------------- |
| guard                |  2,640 |   203 |                       under 4 each | —                             |
| tests/repo git-guard |    608 |    40 |                                 31 | —                             |
| permissions          |    539 |    61 |                       under 4 each | —                             |
| trust                |    340 |   198 |                       under 4 each | fast-path (146)               |
| sandbox              |    800 |   315 |                     12 (untouched) | gate, lane, mcp-sandbox (151) |
| git                  |    653 |   258 |                                 52 | —                             |
| recovery             |     40 |    17 |                                  5 | —                             |
| harness              |     62 |    10 |                       under 4 each | —                             |
| db migrations        |     41 |    17 |                       under 4 each | —                             |
| runner               |    652 |   279 |                                289 | —                             |
| delivery             |  1,801 |   882 |                                889 | worktree-recover (50)         |
| pass                 |    255 |   138 |                                297 | —                             |
| **Total**            |  8,431 | 2,418 |                              1,575 | 347                           |

CI seconds before are `tests/repo/src/shard-weights.ts`: medians over three main runs, listed for files of 4 s or
more. The pull request's test-report comment has the after seconds.

## What was folded, merged and removed

- **guard** (`a673cb8c`): every `it.each` of the judge, unread commands, numeric names, lane read-only, pass git,
  background loops, plain command, command forms, ANSI-C, braces and hook asks became one test per rule, looping the
  same inputs. Seven rows that repeated another row's input and verdict were dropped. Nothing was removed.
- **tests/repo git-guard** (`3271d246`): each verdict table runs every command through the real hook, and every table
  also checks that the hook exits 0. No command row was dropped.
- **permissions, trust** (`a5547cfb`): the rules, grants, policy, written-config, limits and call-judge tables were
  folded. No input row was dropped.
- **sandbox** (`e7a19f46`): the file-access, profile, toolchain, setup, env and MCP-launch tables were folded on real
  fixtures. Lane-process tests that drive the same real processes were merged. Three rows that repeated another row
  were dropped.
- **git, recovery** (`79b60962`): the git trust, config trust, remote URL, trust card, conflict text and network
  tables were folded. Scenarios that build the same repository in the same state were merged. A row that changes
  state still gets a fresh repository. Every test added by a `fix` commit was kept.
- **harness, db migrations** (`416db6e9`, `2a15ac9d`): folded only. Migration tests on one migrated database were
  merged, and the refuse-and-change-nothing rows loop over a copy each.
- **runner** (`53d7e15c` removes, `39691f55` merges): removed tests of card, notice and prompt wording, accounts and
  account moves, usage thresholds, review rounds and rigor, the Light safety net and Park blocks. Runner and pass-lane
  tests that boot the same lane merged: cancels at three points, crash retries, the batch base at launch, MCP server
  asks and review reruns. That is 27 fewer engine boots in `runner.test.ts`.
- **delivery** (`b816f405`, `9928a6de`, `e75ef8bb` remove, `8df6e05d` merges): deleted `cards`, `pr-scopes` and
  `pr-pictures` (card and PR wording, not a protected rule) and `git-spawns` (a count of git calls, not a rule).
  Removed PR title and body wording, notice prose, gh error wording, install-log wording and card bookkeeping from the
  PR watch, catch-up, ship, CI-fix, batch, landing and worktree tests. Tests that boot the same harness in the same
  state merged. Every push, merge, branch, claim, restart, migration carry and numbering, and secret test stays.
- **pass** (`fb796595` remove, `282e3404` merges): removed card, notice and thread wording and display reads: the
  turn list, the pass view, the start preview's copy of the open's refusals, and `turn-holds` (which turn lists a
  shared hold). Close, abandon, sign-off, take-out and put-back tests on one pass world merged.
- **deleted elsewhere:** `runner/check-answer`. Its one test checked that an error class is a conflict (a 409), which
  is not a protected rule.

**Merges undone or corrected:** in `base-update`, "the second pass throws before it installs" counts lockfile reads.
After the refused-host and no-pnpm phases its count differs, so it is back on a fresh world as its own test. In
`migration-carry`, the folded FIFO and link rows first expected `merged` where the originals expect `uncarried`; the
fold now checks `uncarried` for all four rows, the symlink row included.

## Protected families and the tests that keep them

| Family                            | Still covered by                                                                                                                         |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Sandbox file access and secrets   | `sandbox/file-access`, `sandbox/profile`, `sandbox/env-allowlist`, `sandbox/env-file`, `gate-sandbox`, `lane-sandbox`, `mcp-sandbox`     |
| Guard decisions                   | `guard/judge`, `guard/hook-asks`, `guard/lane-read-only`, `guard/unattended`, `tests/repo/git-guard`                                     |
| Permissions                       | `permissions/rules`, `permissions/expected-write`, `permissions/trust-switches`                                                          |
| Trust and limits                  | `trust/fast-path`, `trust/crosses-limit`, `trust/policy`, `git/trust`, `git/config-trust`, `git/remote-url`                              |
| Claims acquired, held, released   | `guard/judge` (claimed areas, hazards), `runner/runner` (cancel releases claims, hazard brought in), `pass/shared-hold`, `delivery/ship` |
| Recovery after a crash or restart | `recovery/recover`, `delivery/recover`, `delivery/restart`, `delivery/restart-cut`, `worktree-recover`, `pass/resume`                    |
| Git merges, pushes, reverts       | `git/merge`, `git/revert`, `delivery/pr-catch-up`, `delivery/ship`, `delivery/worktree-ship`, `pass/close`, `pass/abandon`               |
| Worktrees and branches            | `git/worktrees`, `delivery/worktree-start`, `delivery/branch-cleanup`, `git/branch-moves`, `delivery/checkout-return`                    |
| Migration carry and numbering     | `delivery/migration-carry`, `delivery/migration-numbers`, `delivery/migration-steps`, `delivery/migrations-base`, `db/migrations-*`      |

## Red checks

Each folded security table was run once against a broken rule. The breaks were made locally and not committed. Each
failure named the input it broke:

- `permissions/rules`: a read tool allowed outside the repository, 11 inputs (`Read outside, absolute: ~/.ssh/id_rsa`, …).
- `guard/judge`: `rm -r` outside the repository allowed, 9 inputs (`rm -rf in home: rm -rf ~/projects`, …).
- `guard/lane-read-only`: `ps` showing the environment let through (`ps -Eww`, `ps aux -wwE`, `ps -o pid,etime`, …).
- `sandbox/file-access`: secret files no longer protected, 5 tests (`Grep naming the file there`, …).
- `git/config-trust` and the real-repository `git/trust`: any subsection key trusted (`remote.origin.receivepack`,
  `url.https://evil/.insteadof`, …).

`tests/repo/git-guard` was not checked this way. Its rule is `.claude/hooks/git-guard.mjs`, which a lane may not write.

## Per file

| File                                           | Before |   After |
| ---------------------------------------------- | -----: | ------: |
| delivery/base-update.test.ts                   |     98 |      57 |
| delivery/batch-card.test.ts                    |    112 |      37 |
| delivery/branch-cleanup.test.ts                |     36 |      12 |
| delivery/cards.test.ts                         |     84 | deleted |
| delivery/checkout-return.test.ts               |     34 |      11 |
| delivery/ci-failure-action.test.ts             |     16 |       3 |
| delivery/ci-fix-batch.test.ts                  |     16 |      15 |
| delivery/ci-fix-text.test.ts                   |     27 |       3 |
| delivery/ci-fix.test.ts                        |     21 |       5 |
| delivery/ci-stop.test.ts                       |     24 |       9 |
| delivery/dependency-change.test.ts             |     14 |      12 |
| delivery/flaky-tests.test.ts                   |     16 |       6 |
| delivery/gate-failures.test.ts                 |      7 |       4 |
| delivery/git-spawns.test.ts                    |      1 | deleted |
| delivery/goal-start.test.ts                    |     13 |      12 |
| delivery/grouping.test.ts                      |     13 |      12 |
| delivery/hand-made-worktrees.test.ts           |     10 |       7 |
| delivery/landing-start.test.ts                 |      8 |       3 |
| delivery/landing.test.ts                       |     42 |      15 |
| delivery/local-check.test.ts                   |      7 |       2 |
| delivery/migration-carry.test.ts               |     30 |      12 |
| delivery/migration-steps.test.ts               |     21 |       8 |
| delivery/migrations-base.test.ts               |      6 |       4 |
| delivery/notices.test.ts                       |     22 |       5 |
| delivery/pass-open.test.ts                     |     45 |      20 |
| delivery/pass-pr.test.ts                       |     29 |      13 |
| delivery/pass-review.test.ts                   |     13 |       4 |
| delivery/pass-settle.test.ts                   |     32 |      19 |
| delivery/placement-checkout.test.ts            |     39 |      17 |
| delivery/placement-start.test.ts               |     21 |      20 |
| delivery/pr-catch-up.test.ts                   |     73 |      29 |
| delivery/pr-pictures.test.ts                   |      8 | deleted |
| delivery/pr-scopes.test.ts                     |     24 | deleted |
| delivery/pr-template.test.ts                   |      9 |       1 |
| delivery/pr-text.test.ts                       |     46 |       3 |
| delivery/pr-watch-pass.test.ts                 |      7 |       1 |
| delivery/pr-watch-queue.test.ts                |     15 |       5 |
| delivery/pr-watch.test.ts                      |    134 |      28 |
| delivery/recover.test.ts                       |     14 |      10 |
| delivery/restart-cut.test.ts                   |      5 |       2 |
| delivery/restart.test.ts                       |     30 |      16 |
| delivery/retired-landings.test.ts              |     10 |       6 |
| delivery/ship-gate-failures.test.ts            |     13 |       5 |
| delivery/ship.test.ts                          |     56 |      43 |
| delivery/start-card.test.ts                    |     14 |       2 |
| delivery/start.test.ts                         |     51 |      11 |
| delivery/worktree-card.test.ts                 |     20 |      15 |
| delivery/worktree-dependencies.test.ts         |     47 |      14 |
| delivery/worktree-ship.test.ts                 |     49 |      25 |
| git/branch-moves.test.ts                       |     13 |       7 |
| git/chat-git.test.ts                           |     44 |      18 |
| git/claude-code-bookkeeping.test.ts            |     21 |       5 |
| git/config-trust.test.ts                       |     29 |       4 |
| git/conflict-text.test.ts                      |     10 |       2 |
| git/git.test.ts                                |    108 |      56 |
| git/hand-made-worktrees.test.ts                |      7 |       3 |
| git/keep-work.test.ts                          |     11 |       7 |
| git/lane-writable.test.ts                      |     19 |       2 |
| git/merge.test.ts                              |     48 |      25 |
| git/network.test.ts                            |     13 |       1 |
| git/operation.test.ts                          |     10 |       4 |
| git/remote-url.test.ts                         |     30 |       3 |
| git/restore.test.ts                            |      8 |       5 |
| git/revert.test.ts                             |     12 |       6 |
| git/run-as-builder.test.ts                     |     14 |       7 |
| git/shared-chain.test.ts                       |     10 |       6 |
| git/survey.test.ts                             |      4 |       1 |
| git/trust-card.test.ts                         |     25 |       5 |
| git/trust.test.ts                              |    151 |      69 |
| git/worktree-list.test.ts                      |     12 |       2 |
| git/worktrees.test.ts                          |     52 |      18 |
| guard/ansi-c.test.ts                           |     50 |       2 |
| guard/background-loops.test.ts                 |     77 |       5 |
| guard/braces.test.ts                           |     47 |       3 |
| guard/catch-all.test.ts                        |     43 |      11 |
| guard/command-forms.test.ts                    |     53 |       1 |
| guard/hook-asks.test.ts                        |    228 |      25 |
| guard/judge.test.ts                            |    894 |      69 |
| guard/judged-rules.test.ts                     |    372 |       4 |
| guard/lane-read-only.test.ts                   |    129 |      28 |
| guard/numeric-names.test.ts                    |    116 |      15 |
| guard/pass-git.test.ts                         |     90 |       2 |
| guard/plain-command.test.ts                    |     57 |       3 |
| guard/pre-tool-use.test.ts                     |     30 |       6 |
| guard/shell-words.test.ts                      |     28 |       2 |
| guard/unattended.test.ts                       |     76 |      21 |
| guard/unread-commands.test.ts                  |    330 |       2 |
| guard/unread-hazards.test.ts                   |     20 |       4 |
| pass/abandon.test.ts                           |     31 |      13 |
| pass/close-lists.test.ts                       |      4 |       2 |
| pass/close-request.test.ts                     |      6 |       1 |
| pass/close.test.ts                             |     29 |      15 |
| pass/goal-pages.test.ts                        |      2 |       1 |
| pass/hand-edits.test.ts                        |      6 |       3 |
| pass/join.test.ts                              |      9 |       6 |
| pass/kept-work.test.ts                         |      8 |       7 |
| pass/merged-open.test.ts                       |     10 |       8 |
| pass/put-back.test.ts                          |      6 |       5 |
| pass/resume.test.ts                            |      9 |       7 |
| pass/sign-off.test.ts                          |     37 |      14 |
| pass/start-preview.test.ts                     |     12 |       1 |
| pass/take-out.test.ts                          |     27 |       8 |
| pass/turn-holds.test.ts                        |      7 | deleted |
| pass/turns.test.ts                             |      4 |       1 |
| pass/view.test.ts                              |      3 |       1 |
| permissions/expected-write.test.ts             |     23 |      17 |
| permissions/lane-auto-mode.test.ts             |      4 |       2 |
| permissions/rules.test.ts                      |    502 |      32 |
| recovery/recover.test.ts                       |     40 |      17 |
| runner/check-answer.test.ts                    |      1 | deleted |
| runner/check-targets.test.ts                   |     12 |       1 |
| runner/feedback.test.ts                        |     15 |       9 |
| runner/forced-review.test.ts                   |     43 |       3 |
| runner/handoff-rule.test.ts                    |     17 |       3 |
| runner/kind-switches.test.ts                   |      8 |       1 |
| runner/lane-conversation.test.ts               |      2 |       1 |
| runner/lane-messages.test.ts                   |      8 |       6 |
| runner/limit-ship.test.ts                      |     10 |       1 |
| runner/model-start.test.ts                     |     17 |       4 |
| runner/next-action.test.ts                     |     50 |       6 |
| runner/pass-items.test.ts                      |      3 |       2 |
| runner/pass-lane.test.ts                       |     61 |      38 |
| runner/plan-approval.test.ts                   |     13 |       5 |
| runner/read-back.test.ts                       |     13 |       4 |
| runner/resolve-step.test.ts                    |     19 |       6 |
| runner/routed-wait.test.ts                     |     17 |       9 |
| runner/runner.test.ts                          |    282 |     156 |
| runner/skip-stopped-turn.test.ts               |      8 |       5 |
| runner/step-skills.test.ts                     |      9 |       1 |
| runner/test-value.test.ts                      |      4 |       2 |
| runner/turn-check-queue.test.ts                |     16 |       4 |
| runner/turn-checks.test.ts                     |     11 |       8 |
| runner/turn-files.test.ts                      |      6 |       1 |
| runner/unrequested-handoff.test.ts             |      7 |       3 |
| sandbox/command-env.test.ts                    |     11 |       4 |
| sandbox/docker-access.test.ts                  |      5 |       2 |
| sandbox/env-allowlist.test.ts                  |     41 |       4 |
| sandbox/env-file.test.ts                       |     24 |       7 |
| sandbox/file-access.test.ts                    |    177 |      27 |
| sandbox/lane-processes.system.test.ts          |      5 |       4 |
| sandbox/lane-processes.test.ts                 |     45 |      25 |
| sandbox/lane-writable.test.ts                  |      9 |       2 |
| sandbox/mcp-refusals.test.ts                   |      7 |       4 |
| sandbox/mise-config.test.ts                    |     11 |       5 |
| sandbox/plugin-wrapper.test.ts                 |     21 |      10 |
| sandbox/process-table.test.ts                  |      8 |       3 |
| sandbox/profile.test.ts                        |     65 |      14 |
| sandbox/setup-definitions.test.ts              |      8 |       1 |
| sandbox/setup-dir.test.ts                      |     37 |      10 |
| sandbox/setup-reads.test.ts                    |     34 |       4 |
| sandbox/stale-files.test.ts                    |     16 |       7 |
| sandbox/temp-dir.test.ts                       |     22 |       9 |
| sandbox/toolchain-reads.test.ts                |     49 |      13 |
| sandbox/your-mcp-launch.test.ts                |     53 |       8 |
| trust/auto-mode-models.test.ts                 |     21 |       1 |
| trust/call-judge.test.ts                       |     16 |       2 |
| trust/call-summary.test.ts                     |     20 |       3 |
| trust/crosses-limit.test.ts                    |     14 |      11 |
| trust/floor-notice.test.ts                     |     19 |       2 |
| trust/go-ahead.test.ts                         |      7 |       2 |
| trust/grants.test.ts                           |     22 |       6 |
| trust/limits.test.ts                           |      7 |       2 |
| trust/live-systems.test.ts                     |      5 |       3 |
| trust/policy.test.ts                           |     23 |       9 |
| trust/skip.test.ts                             |     10 |       5 |
| trust/written-config.test.ts                   |     25 |       1 |
| db/src/migrations-conversations.test.ts        |     10 |       4 |
| db/src/migrations-model-ids.test.ts            |      9 |       3 |
| db/src/migrations-model-tiers.test.ts          |      7 |       3 |
| db/src/migrations-pre-playbook-routing.test.ts |     13 |       5 |
| harness/src/harness.test.ts                    |     51 |       7 |
| harness/src/personas.test.ts                   |     11 |       3 |
| tests/repo/git-guard.test.ts                   |    608 |      40 |
