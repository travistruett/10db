# A rigor can plan in its Build session, and the setting stays off until the eval holds

- **Date:** 2026-11-18
- **Amends:** `decisions/2026-11-13-each-rigor-sets-its-review-rounds-and-fix.md` (adds a process field)

## Decision

A playbook row has a process field `plansInBuild` beside `reviewRounds`, `fixBy` and `approvesPlan`
(project → global → default, per field; column `playbook_rows.plans_in_build`, migration 0093). When it is on,
`resolveSteps` drops the row's Plan step and marks the build step `plansFirst`, but only where no separate plan
is wanted: the steps (the row's and its kinds') hold no Plan Review, and the row does not have the builder
approve the plan. So Critical, whose row has a Plan Review and plan approval, keeps its Plan and Plan Review as
the fresh-eyes check whatever the field says, and a kind that adds a Plan Review keeps the Plan too.

A `plansFirst` build step:

- is briefed to plan first with the planning skill, which it loads, and to record the plan with
  `complete_step` (summary only) before it edits a file, calling it again if the plan changes;
- records the plan as the step's result through `complete_step` (no verdict, no follow-ups); any other build
  step is still refused;
- cannot commit until it has recorded a plan (the commit tool refuses), so the rule ships with its mechanism;
- keeps its plan when a review sends the work back, and the fix session is shown it as "Your plan:".

The task drawer shows the latest plan a run recorded (`planOf` in contracts: a Plan step's result or a
`plansFirst` build step's) above the latest review. The playbook row drawer has a Plan in the Build session
switch, disabled where a Plan Review or plan approval keeps the Plan step.

The default is off for every rigor, Careful included. The eval runner takes `PLANS_IN_BUILD=1|0` and prints a
Keep rule section against the baseline (`keepRule` in `apps/daemon/scripts/eval/compare.ts`: met runs over the
cases both reports share are at least the baseline's, and no shared case met in at least one baseline run is
met in neither run now). Careful's default turns on only in a later change whose real eval report shows the
rule holding.

Per provider: the setting behaves the same on a Claude plan, Bedrock, an API key and a ChatGPT/Codex plan. The
tools are 10db's own MCP tools on every provider, and a Codex session, which has no plugin, gets the planning
skill's text inlined in its brief as it does every skill. The eval itself runs only on the default Claude
account today (`apps/daemon/scripts/eval/AGENTS.md`).

## Why

Each step is a fresh session that sees only the earlier steps' summaries, capped at 8,000 characters. When the
session that writes the plan is the one that carries it out, the plan and its reasons stay in context, and the
session can change the plan mid-turn when the code disagrees with it. A Plan Review or the builder's approval
exists to judge a plan before the build, which only works when someone other than the builder wrote it, so
those rows keep a separate Plan step.

The default stays off because this change could not carry a real eval: no Careful baseline is committed, a real
run spends usage, and a 10db lane's sandbox cannot read the transcripts a real run needs. The keep rule says to
leave the setting off unless the eval holds, so off is the only default this change can justify. The fake-agent
run proves the plumbing (Careful runs Build then Review, the build records its plan, the keep rule is computed),
not the quality; its report is `apps/daemon/evals/lane-pipeline/reports/2026-11-18-careful-plans-in-build-fake.md`.

Turned down: dropping Critical's Plan too (it would remove the one fresh-eyes check before the build); leaving
`complete_step` refused on build steps and having the plan only in the session's text (the drawer could not
show it and a fix session would lose it); a separate plan tool (one more tool to brief, where `complete_step`
already records a step's result).
