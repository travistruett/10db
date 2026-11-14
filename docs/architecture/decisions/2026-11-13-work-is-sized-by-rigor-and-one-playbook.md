# Each task gets a rigor and kinds, and one playbook decides its process, models and effort

- **Date:** 2026-11-13
- **Supersedes:** flows as the way a task's steps are chosen, risk tags, risk floors (`routing/floors.ts`),
  routing patterns, role settings, and persona model pins and minimum scores, once PR 2 of the design lands.

## Decision

Design: `docs/superpowers/specs/2026-11-13-10db-right-sized-work-design.md`.

- A task has one **rigor**, Light, Standard, Careful or Critical, and a set of **kinds** from a global, editable
  list (seeded: security, auth, migration, dependency, schema, infra, ui, docs). A kind can raise the rigor
  (`minimumRigor`), carries today's risk-tag behaviours as separate switches, can add steps, attach skills, and
  override a role's persona, model or effort. A kind's model and effort overrides only raise.
- A **playbook** says what each rigor runs: its steps, review rounds, how a send-back is fixed, whether the
  builder approves the plan, and how the task ships; and for each rigor and role, a persona, a model requirement
  (Automatic at least N, a rung, top of a rung, or one model) and an effort. Projects override any cell or row
  setting. The builder's pin on a task wins over everything.
- Rules settle a task's rigor and kinds first (areas and hazards a kind is implied by, the builder's pins); the
  judge answers the rest from closed lists (`task_rigor`, `task_kinds`); without a decision account, rules and the
  project's default rigor size the task. Agents can resize a task with `resize_task`.
- Security, auth and migration stay Careful with Frontier reviews at high effort, and migration adds a Frontier
  Plan Review: deliberately stronger than today's top-of-tier pattern and floors.
- Light and Standard tasks of one goal ship as one pull request; Careful and Critical ship alone.

## Why

The builder's QA of the Models page found no place to set a role's model and effort, and a "Needs" number that
came from code and was copied into every flow. The builder has also watched work default to the heavy path:
a session per small fix, many steps where a few would do, ten pull requests where two or three would do. About
ten overlapping mechanisms steered a step, and nobody could predict what a task would get.

Turned down: merging patterns and floors into one rules list on top of flows and role settings (keeps the
overlap); letting the judge pick model and effort directly (opaque, and stale with every model release); making
security, auth and migration Critical (QA and a wait on the builder for every security fix). Review, not build,
gets the strongest model, because a missed check or an irreversible migration costs far more than the model,
and these tasks are a small share of the work.
