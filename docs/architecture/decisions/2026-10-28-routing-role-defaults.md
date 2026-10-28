# A step with no score to compare on runs on its role's default model

- **Date:** 2026-10-28
- **Amends:** decision 57 (its unmeasured fallback)

## Decision

When no enabled, costed profile the account offers has a score for the kind a step compares on, the step runs
on its role's default instead of the project's model and effort:

| Role                      | Tier      | Effort |
| ------------------------- | --------- | ------ |
| plan, plan review, review | strongest | high   |
| implement                 | balanced  | high   |
| QA                        | fast      | medium |

Each Claude Code model has a tier in `apps/daemon/src/routing/catalogue.ts`, weakest first: haiku is fast,
sonnet balanced, opus and fable strongest. A tier runs the strongest enabled model the account offers in it;
when it offers none there, the nearest tier, the stronger on a tie. The effort is the role's, or the nearest
enabled one, the higher on a tie. A floor above the step's need (a risk rule or a persona's minimum score)
moves the step to the strongest tier, one effort up. A role-default step is not pinned: a retry climbs the
same ladder, to the next stronger model at the nearest effort, then the next effort on the strongest. When the
account offers none of Claude Code's models, the plan is refused (`NoProfileError`).

When scores exist, routing is unchanged: the cheapest measured profile at or above the minimum, within the
ceiling (decision 57). Each step's reason starts `by score:` or `by role default:`.

Routing no longer reads the project's `model` and `effort`. The columns stay until a follow-up drops them with
a migration (`docs/open-items.md`).

## Why

Without an Artificial Analysis key every step ran on one model, so a plan, an implementation and a QA pass
cost and reasoned the same; 10db should work fully from the subscription's models and only get better with
scores. Spec decision 16 (no named tiers) still holds where there are scores: tiers order the models only
when nothing measures them. The tiers come from Claude Code's own aliases, which the catalogue already maps,
so no AA data is needed. Running the project's model when the account offers nothing was turned down: it
would run a model the account says it doesn't offer. A floor with no score to measure it by can't be checked,
so it buys the strongest model and more effort rather than being ignored.
