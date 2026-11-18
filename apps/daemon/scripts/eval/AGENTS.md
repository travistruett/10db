# Lane-pipeline eval

Replays past merged 10db tasks through the real lane pipeline at one rigor, twice per case, and
writes one report: per case and in total, the outcome, gate, review verdict and rounds, sessions,
hand-offs, subagent spawns, tokens, cost and wall time, and the cases whose outcome flipped between
the two runs or against the saved baseline. Use it to compare a pipeline change with today's
pipeline: change one thing, run the set, keep the change only if it scores the same or better.

## Commands

| Command                                    | Does                                                 |
| ------------------------------------------ | ---------------------------------------------------- |
| `make eval RIGOR=standard`                 | real run on the default Claude account; spends usage |
| `make eval RIGOR=standard AGENT=fake`      | the fake agent: proves the plumbing, spends nothing  |
| `make eval RIGOR=standard CASES=a,b`       | only the named case ids                              |
| `make eval RIGOR=standard SAVE_BASELINE=1` | also saves the report as the rigor's baseline        |
| `make eval RIGOR=careful PLANS_IN_BUILD=1` | the rigor plans in its Build session for the run     |

`RIGOR` is `light`, `standard`, `careful` or `critical`. The CLI (`scripts/eval.ts`) also takes
`--baseline=<report.json>`, `--parallel=<n>` (default 2) and `--case-timeout-minutes=<n>` (default 90).
`scripts/eval.sh` refuses a real run in CI. `PLANS_IN_BUILD=1` (or `0`; `--plans-in-build`) sets the rigor's
`plansInBuild` on the eval daemon's global playbook once it starts, and the report records it; left out, the
playbook runs as 10db ships it.

**Recording the real baseline:** from a plain terminal signed in to Claude (not a 10db lane, whose
sandbox can't read `~/.claude/projects`), run `make eval RIGOR=standard SAVE_BASELINE=1`. It starts
real sessions and spends usage. The baseline is written to
`apps/daemon/evals/lane-pipeline/baselines/<rigor>.json`; commit it. Later runs at that rigor compare
with it.

## What a run does

- Each case-run gets a `git archive <baseCommit>` snapshot committed once into a fresh repo, with a
  bare `origin` whose `main` sits there. A snapshot carries no later history, so a lane can't read
  the merged answer, and the builder's checkout is never written. A real run installs dependencies
  in the snapshot and gates with `make check-changed`; the fake gates with `git diff --quiet HEAD`.
  The install is `mise exec -- pnpm install --frozen-lockfile --prefer-offline` run in the snapshot
  (`snapshot-install.ts`), so the snapshot's own node and pnpm run, not the runner's checkout's, and
  that snapshot's `mise.toml` is trusted for the command alone. No env variable is needed. A failed
  install stops the run with its own output in the error.
- One daemon runs from source with its own data dir and worktree root inside the work dir
  (`daemon-env.ts`), billing and provider variables dropped, and the off switches set. It refuses to
  start on the builder's data dir or worktree base, so no task, card, batch or worktree lands in the
  builder's 10db.
- Each project is shared mode with local delivery, one lane; the task gets an explicit rigor. The
  runner polls the eval database read-only and answers only plan-approval cards.
- The eval daemon keeps 10db's overload hold: on a busy Mac its lanes and gates wait, and wall time
  grows. Compare runs made on an otherwise quiet Mac.
- The fake agent runs a script book built from the steps the rigor resolves to on 10db's default
  playbook, with `plansInBuild` applied (`fake-book.ts`): reviewers approve, a build that plans first
  records a plan through `complete_step`, and the implementer writes and commits `EVAL-FAKE-<id>.md`
  beside the first reference path in the case's areas.

## Grading

"Criteria met" means the workstream reached DONE (its gate passed), the last reviewing step
approved where the rigor has one, and all four lane rules held (`grade.ts`):

- claims: every changed path sits in the task's areas or a claim the workstream took;
- commit tool: every commit since the base carries the `10db-Op` trailer;
- no push: `origin`'s refs didn't move;
- deps: a manifest or lockfile change comes with an `install_dependencies` op.

Otherwise the outcome is `not_met`, `failed` (not DONE) or `timed_out`. There is no model-graded
rubric of the diff yet; the reference diff is `git diff <baseCommit> <mergedCommit>` in this
repository.

## Keep rule

With a baseline, the report's Keep rule section says whether a change is kept (`keepRule` in
`compare.ts`): over the cases both reports have, the change's met runs are at least the baseline's,
and no case met in at least one baseline run is met in neither run now. A case only one side has
decides nothing. It names the counts and the cases lost. A pipeline change's report, with a brief for
the builder, is kept in `apps/daemon/evals/lane-pipeline/reports/<date>-<change>.md`.

## Work dir

`$TMPDIR/10db-eval-*/`, printed at the start: `data/` (the eval daemon's database), `worktrees/`,
`transcripts/<case>-<n>/`, `daemon.log`, `report.json` (`EvalReport` in `report.ts`) and
`report.md`. `repos/` and `origins/` are removed once the report is written.

## Transcripts

Claude Code writes a lane's transcript to `<configDir>/projects/<checkout slug>/<session id>.jsonl`,
plus `<session id>/subagents/`. `configDir` is the account's `config_dir`, else the login's
`CLAUDE_CONFIG_DIR`, else `~/.claude`. The builder's own `cleanupPeriodDays` reaches lane sessions
and can prune or stop them, so the eval daemon sets `TENDB_LANE_TRANSCRIPT_DAYS=30`, which lane
sessions put in their inline settings. `transcripts.ts` copies each session's files into the work
dir before the report is written and counts `Agent` and `Task` tool calls as spawns. A real run
lists the sessions with no transcript and exits 1. The fake writes none, so its spawns are empty.

## Provider parity

A run uses the default Claude account only, and says so when it starts. Bedrock, API-key and
ChatGPT/Codex accounts are not run yet; Codex keeps rollout files, not Claude transcripts, so its
transcripts and spawns are unsupported until a follow-up adds them.

## Adding a case

Pick a merged squash commit of about 300 lines or fewer from `git log --first-parent main`. Add
`apps/daemon/evals/lane-pipeline/cases/<id>.json` (`EvalCase` in `case.ts`): the task text and
acceptance criteria from its pull request, its areas from `project.json`, `baseCommit` (the first
parent), `mergedCommit` and any tags. `cases.test.ts` checks that the set parses, has 10 to 15 cases
and keeps a case for every tag. A new case changes the set, so record a new baseline after it.
