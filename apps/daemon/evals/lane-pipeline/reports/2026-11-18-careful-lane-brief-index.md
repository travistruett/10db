# A lane's brief indexes its plan and knowledge: the eval so far

## Brief

- **What changes for you:** nothing yet. A lane's brief still pastes its Plan section, the cited Plan entries
  and every recorded decision's choice and rationale. A new daemon setting, `TENDB_LANE_BRIEF=index`, makes the
  brief name them instead and point to the tools that read them (`get_plan_section`, `get_plan_entry`,
  `find_plan_entries`, `find_knowledge`). It also drops the two rule bullets whose tool refusal already says
  what to do. The setting ships off.
- **What it buys:** a typical Careful build brief goes from about **3,531 to 1,755 tokens** (−50%). Its
  re-injection after a compaction goes from about 2,615 to 952.
- **Default: unchanged (full).** The keep rule (criteria met the same or better, and no case that passed in
  the baseline fails in both runs) has not been checked against a real model, so the default can't move.
- **Why no real eval:** there is no saved Careful baseline, a real run spends usage, and a 10db lane's sandbox
  can't read the Claude transcripts a real run needs (`apps/daemon/scripts/eval/AGENTS.md`). The fake agent
  ignores its prompt, so the fake run below proves only the plumbing. No eval case has a Plan or knowledge
  records yet, so no transcript can show a lane fetching them; a follow-up adds such a case.
- **What could go wrong:** a lane may skip `get_plan_section` and build from the task line alone. Only the real
  eval shows that: watch for criteria the baseline met and the index run misses.
- **What is needed from you:** run the real eval from a plain terminal (the follow-up task):
  `make eval RIGOR=careful SAVE_BASELINE=1` on `main`, then `make eval RIGOR=careful BRIEF=index`. If the
  second report's Keep rule says it holds, `index` can become the default; if not, the switch is removed.

## Size, before and after

One typical lane brief, the same task both ways: a Careful build step whose section is Task 3 of
`docs/superpowers/plans/2026-11-13-process-per-rigor.md` (its own section and the Global constraints as shared),
three cited Plan decisions, and a knowledge pack near its 1,500-token budget (nine policies, one heuristic,
three decisions). Tokens are characters ÷ 4 (`CHARS_PER_TOKEN`), an estimate, not a tokenizer count.

| Brief | Characters | Tokens (est.) | Re-injection after compaction (tokens, est.) |
| ----- | ---------: | ------------: | -------------------------------------------: |
| full  |     14,121 |         3,531 |                                        2,615 |
| index |      7,017 |         1,755 |                                          952 |

`briefing.test.ts` ("is smaller than the full brief for a typical task") checks that the index is smaller.

## The rule bullets, and the refusals that replace them

An indexed Claude brief leaves out two bullets. Each one has a tool refusal that names what to do instead:

- **"Edit only files inside your claims…"**: an edit outside the claims is refused by the guard
  (`apps/daemon/src/guard/judge.ts`):

  > `<path> is outside your claims (it is in area "<area>"). Call the request_claim tool for the area you need.`

  and for a hazard path:

  > `<path> is in the "<hazard>" hazard. Call the request_claim tool with kind "hazard" and name "<hazard>" first.`

  While another task holds the claim, `request_claim` itself answers `waiting: true` and says to call again
  with the same opId (`apps/daemon/src/mcp/tools.ts`).

- **"Commit only through the 10db commit tool…"**: git writes are refused by the guard
  (`apps/daemon/src/guard/git-rules.ts`):

  > `Direct git commit is not allowed. Use the 10db commit tool with explicit paths.`

  > `Lanes never push; 10db pushes the work when it ships.`

  > `git <verb> is not allowed. Only read-only git is allowed; commit through the 10db commit tool.`

Kept:

- **The dependency bullet stays in every brief.** A lane that holds the `deps` hazard and runs `pnpm install` is
  let through by the guard. If someone is watching the task, the broker then raises a card that waits for a
  person and names no tool, so the lane has to know about `install_dependencies` beforehand. If nobody is watching, the call is
  skipped with "This changes a dependency or a migration; use the install_dependencies tool". The refusal of
  an unclaimed dependency command now names the tool too:
  > `"pnpm add x" needs the "deps" hazard claim. Call request_claim with kind "hazard" and name "deps" first. Your sandbox can't install dependencies: in a pnpm project, edit package.json with an exact version, then call install_dependencies, which installs and writes pnpm-lock.yaml for you. Never run pnpm add or pnpm install yourself.`
- **A Codex lane keeps all three bullets.** Its guard sends the same reason as `permissionDecisionReason`
  (`apps/daemon/src/sessions/codex-guard.ts`), but no recorded check shows that Codex hands that reason to the
  model. So dropping the bullets there would leave a Codex lane with no instruction. A Codex lane still gets
  the Plan and knowledge index.
- Every other bullet stays: commit before ending the turn, the commands lines, the edit rule, the gate rule,
  the 300-line rule, ask, deviation and hand-off. A pass's rules and a read-only step's rules are unchanged.

## Fake-agent run

Three cases, two runs each, on the fake agent at Careful, 2026-11-18. The first run set `--brief=full` and
served as the baseline for the second (`--brief=index --baseline=…`).

Full brief:

| Case                          | Criteria | Outcomes | Gate           | Review           | Rounds | Sessions | Hand-offs | Spawns | Tokens           | Cost | Wall |
| ----------------------------- | -------- | -------- | -------------- | ---------------- | ------ | -------- | --------- | ------ | ---------------- | ---- | ---- |
| board-column-scrollbar-gutter | 2/2 met  | met, met | passed, passed | approve, approve | 2      | 6        | 0         | —      | 6000 / 1200 / 0  | —    | 11 s |
| commit-tool-skips-bookkeeping | 2/2 met  | met, met | passed, passed | approve, approve | 2      | 6        | 0         | —      | 6000 / 1200 / 0  | —    | 27 s |
| task-why-always               | 2/2 met  | met, met | passed, passed | approve, approve | 2      | 6        | 0         | —      | 6000 / 1200 / 0  | —    | 32 s |
| **Total**                     | 6/6 met  | 6 met    | 6 passed       | 6 approve        | 6      | 18       | 0         | —      | 18000 / 3600 / 0 | —    | 70 s |

Indexed brief, against the full run:

| Case                          | Criteria | Outcomes | Gate           | Review           | Rounds | Sessions | Hand-offs | Spawns | Tokens           | Cost | Wall |
| ----------------------------- | -------- | -------- | -------------- | ---------------- | ------ | -------- | --------- | ------ | ---------------- | ---- | ---- |
| board-column-scrollbar-gutter | 2/2 met  | met, met | passed, passed | approve, approve | 2      | 6        | 0         | —      | 6000 / 1200 / 0  | —    | 27 s |
| commit-tool-skips-bookkeeping | 2/2 met  | met, met | passed, passed | approve, approve | 2      | 6        | 0         | —      | 6000 / 1200 / 0  | —    | 14 s |
| task-why-always               | 2/2 met  | met, met | passed, passed | approve, approve | 2      | 6        | 0         | —      | 6000 / 1200 / 0  | —    | 12 s |
| **Total**                     | 6/6 met  | 6 met    | 6 passed       | 6 approve        | 6      | 18       | 0         | —      | 18000 / 3600 / 0 | —    | 53 s |

Flips between runs: none. Flips against the baseline: none. Keep rule: **holds**, 6 met runs against the
baseline's 6, and no case lost. That proves only that the setting reaches the eval daemon and the run
completes: the fake's tokens are fixed figures and it reads no prompt.

The decision is `decisions/2026-11-18-a-lane-brief-indexes-its-plan-and-knowledge-off-until-the-eval-holds.md`.
