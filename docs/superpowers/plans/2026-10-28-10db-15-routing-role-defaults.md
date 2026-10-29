# 10db Routing Role Defaults Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan
> task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Routing works fully without Artificial Analysis scores. With no score to compare on, each step runs on
a role default drawn from the account's offered Claude Code models: the strongest for plan, plan review and
review, a balanced one for implement, a fast one for QA. With scores, routing chooses by need, cost and budget
exactly as it does today. Each step's reason says which of the two chose it.

**Architecture:** `routing/` stays pure. `catalogue.ts` tags each Claude Code model family with a tier (fast,
balanced, strongest), in strength order. A new `role-defaults.ts` maps each role to a tier and effort and picks
the offered, enabled profile for it; a floor (a risk rule or a persona's minimum score) moves the step to the
strongest tier one effort up. `plan-steps.ts` calls it where it ran the project's model on `UnmeasuredError`.
`escalateStep` climbs the same ladder (the next stronger model, then the next effort) when nothing is measured
on the step's score. The project's `model` and `effort` stay in contracts and the database but routing no
longer reads them; dropping them, with a migration, is a follow-up (a running task edits those files).

**Spec:** queue task 2 (item 105 of the 2026-10-28 UX feedback). Amends decision 57's unmeasured fallback;
recorded in `docs/architecture/decisions/2026-10-28-routing-role-defaults.md`.

## Tasks

### Task 1: Role defaults without scores

- [x] `test-catalogue.ts`: `seedCatalogue()` builds unmeasured profiles from `SEED_PROFILES` (aliases only).
- [x] `role-defaults.test.ts`, table-driven and red first: each role's default on the full catalogue; an
      account offering only some aliases (strongest falls to the next offered, fast rises); a disabled
      exact effort takes the nearest; a floor raises the tier and effort; no offered Claude Code model chooses nothing (the caller throws
      `NoProfileError`).
- [x] `catalogue.ts`: `tier` on each family, `MODEL_TIERS` exported. `role-defaults.ts`: `roleDefault`.

### Task 2: Step plans and reasons

- [x] `plan-steps.test.ts`, red first: a table over no scores, partial scores (some profiles measured; the
      role's own score missing) and full scores, asserting model, effort and that the reason starts
      `by role default:` or `by score:`. The project-model test is replaced.
- [x] `plan-steps.ts`: `UnmeasuredError` runs `roleDefault`; `PlanInput.project` drops `model` and `effort`.
      `router.ts`: the score reason starts `by score:`.
- [x] `team/steps.test.ts`: an unmeasured start runs on the role defaults.

### Task 3: Escalation without scores

- [x] `router.test.ts`, red first: a role-default step on an unmeasured catalogue escalates to the next
      stronger model at its effort, then the next effort at the top model, and stops at the top.
- [x] `router.ts` / `role-defaults.ts`: `strongerDefault`; `escalateStep` uses it when no profile is measured
      on the step's score.

### Task 4: Docs

- [x] Decision file; `apps/daemon/AGENTS.md`'s `routing/` line; the follow-up in `docs/open-items.md`.
- [x] `make gate` prints `GATE PASS`.
