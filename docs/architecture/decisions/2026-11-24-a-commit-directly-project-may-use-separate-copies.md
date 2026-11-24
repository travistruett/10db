# A Commit Directly project may use separate copies, one at a time in the pilot

- **Date:** 2026-11-24

## Decision

A project with `delivery: local` may turn on `localCopies` (Settings › Delivery, with a required teardown command). A task the builder places in a Separate copy gets its own branch, folder and databases. Its project's default `workspaceMode` stays `shared`. Only one copy of a project is unfinished at a time, and a task goes into a copy only when the project has a gate, the task's rigor runs a review, and the task lands on the base. `delivery` can't change while a copy is unfinished. Design: `docs/superpowers/specs/2026-11-24-10db-local-copy-landing-design.md` §2.

## Why

Ampsio commits straight to a local branch that is never pushed. Work that fails review reached it (AMP-147 left 11 commits there) and edits from other sessions broke a task's checks (AMP-119). A copy keeps both away from the builder's folder. Parallel copies, batches and the resource broker are left until the pilot's numbers say they are needed, so one copy at a time keeps the first build small and measurable.
