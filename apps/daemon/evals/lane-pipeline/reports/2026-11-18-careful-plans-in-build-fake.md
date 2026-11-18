# Careful plans in its Build session: the eval so far

## Brief

- **What changes for you:** nothing yet. Each rigor's process has a new switch, Plan in the Build session,
  and it is off everywhere. With it on, a Careful task runs Build then Review: the Build session writes its
  plan first with the planning skill, and the task drawer shows that plan. Critical keeps its Plan and Plan
  Review either way.
- **Careful's default: off.** The keep rule (criteria met the same or better, and no case that passed in the
  baseline fails in both runs) has not been checked against a real model, so the setting can't be kept on.
- **Why no real eval:** there is no saved Careful baseline, a real run spends usage, and a 10db lane's
  sandbox can't read the Claude transcripts a real run needs (`apps/daemon/scripts/eval/AGENTS.md`).
- **What the run below proves:** the plumbing. The fake agent runs the real daemon, MCP tools, gate and
  review; with the setting on, each run takes two sessions instead of three and the build records its plan.
  It says nothing about plan or code quality: its tokens are the fake's fixed figures, and it has no cost.
- **What is needed from you:** run the real eval from a plain terminal (the follow-up task):
  `make eval RIGOR=careful SAVE_BASELINE=1` on `main`, then `make eval RIGOR=careful PLANS_IN_BUILD=1`.
  The second report's Keep rule section says whether Careful's default may turn on.

## Fake-agent run

Three cases, two runs each, on the fake agent, 2026-11-18. The first run set Careful's `plansInBuild` off
(`--plans-in-build=0`) and served as the baseline for the second (`--plans-in-build=1 --baseline=…`).

Setting off (Plan, Build, Review):

| Case                          | Criteria | Outcomes | Gate           | Review           | Rounds | Sessions | Hand-offs | Spawns | Tokens           | Cost | Wall |
| ----------------------------- | -------- | -------- | -------------- | ---------------- | ------ | -------- | --------- | ------ | ---------------- | ---- | ---- |
| board-column-scrollbar-gutter | 2/2 met  | met, met | passed, passed | approve, approve | 2      | 6        | 0         | —      | 6000 / 1200 / 0  | —    | 14 s |
| commit-tool-skips-bookkeeping | 2/2 met  | met, met | passed, passed | approve, approve | 2      | 6        | 0         | —      | 6000 / 1200 / 0  | —    | 22 s |
| task-why-always               | 2/2 met  | met, met | passed, passed | approve, approve | 2      | 6        | 0         | —      | 6000 / 1200 / 0  | —    | 10 s |
| **Total**                     | 6/6 met  | 6 met    | 6 passed       | 6 approve        | 6      | 18       | 0         | —      | 18000 / 3600 / 0 | —    | 46 s |

Setting on (Build, which plans first, then Review):

| Case                          | Criteria | Outcomes | Gate           | Review           | Rounds | Sessions | Hand-offs | Spawns | Tokens           | Cost | Wall |
| ----------------------------- | -------- | -------- | -------------- | ---------------- | ------ | -------- | --------- | ------ | ---------------- | ---- | ---- |
| board-column-scrollbar-gutter | 2/2 met  | met, met | passed, passed | approve, approve | 2      | 4        | 0         | —      | 4000 / 800 / 0   | —    | 16 s |
| commit-tool-skips-bookkeeping | 2/2 met  | met, met | passed, passed | approve, approve | 2      | 4        | 0         | —      | 4000 / 800 / 0   | —    | 12 s |
| task-why-always               | 2/2 met  | met, met | passed, passed | approve, approve | 2      | 4        | 0         | —      | 4000 / 800 / 0   | —    | 8 s  |
| **Total**                     | 6/6 met  | 6 met    | 6 passed       | 6 approve        | 6      | 12       | 0         | —      | 12000 / 2400 / 0 | —    | 36 s |

Flips between runs: none. Flips against the baseline: none.

Keep rule: **Holds**: 6 met runs against the baseline's 6, and no case lost. On the fake agent this only
shows the rule is computed; it is not the evidence the keep rule asks for.

The decision is `decisions/2026-11-18-a-rigor-can-plan-in-its-build-session-off-until-the-eval-holds.md`.
