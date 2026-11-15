# Convert shows the builder's cut of a Plan with more than five milestones, and only the needed ones become tasks

- **Date:** 2026-11-14
- **Amends:** `decisions/2026-11-02-shape-session-and-convert.md` (what Convert refuses and what it writes)

## Decision

- **A milestone is a goal of the Plan**, imported (`plan-import`) or written in Shape, in the order the Plan states
  its goals. Convert counts the goals still pending. With more than five pending (`MILESTONES_BEFORE_CUT`) and a
  Convert that would convert one, it refuses until the request carries `cut`: one mark per pending milestone,
  `needed`, `later` or `cut` (`MilestoneMark`). It refuses before anything is written, and says which milestones
  are unmarked. The desktop's Convert modal shows the list first: each milestone has a mark instead of a tick, and
  Convert stays off until every one has one.
- **Only the needed milestones become tasks.** A milestone marked `needed` is added to the selection; one marked
  `later` or `cut` that is also selected is refused. `later` stays pending on the Plan. `cut` is dropped as Drop
  drops a row (`rejected`), so its outline stays on the Plan as a tombstone and Restore brings it back.
- **A later milestone converts once those before it have merged.** In a Plan with more than five goals, a milestone
  converted without a `needed` mark is refused while any milestone before it is still pending (not cut) or
  converted with a task still open. A task is merged when its status is `done`, as a task's dependents read it; a
  removed task needs nothing. So at most one milestone is planned ahead of the work. The marks of a cut decide that
  call alone and are not held to this, since the builder has just said what the goal needs.
- **It holds at every rigor.** The cut is a Plan and Convert rule, not a playbook step, so it does not read the
  rigor: `routing/playbook-defaults.ts` still gates only Critical on plan approval, and this adds nothing there.
- **Provider-independent.** Convert is the daemon's own write, so a Claude plan, Claude through Bedrock or an API
  key and a ChatGPT/Codex plan behave alike.
- A Convert that selects no goal (loose tasks, decisions, principles) asks for no cut, since a loose task is no
  milestone.

## Why

The build-process audit (`research/2026-11-14-build-process-audit.md` §3.2) found a plan of 20 milestones that was
never cut against what the builder needed, and later plans written before their predecessors merged. Nothing in
10db asked "which of these do you need for the goal". The builder's judgment goes in a cut they mark once, and the
rest of the Plan stays as an outline.

Turned down: a stored mark per milestone (a column and a migration, for marks that `pending` and `rejected` already
carry); gating every Plan's goals on their predecessors (it would change Plans of a few goals that convert together);
a cut list through the rigor playbook (the rule must hold at every rigor).
