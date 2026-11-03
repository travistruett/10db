# A landing's tasks share one batch, a late task joins it, and a shipped landing starts a new one

- **Date:** 2026-11-02
- **Amends:** `decisions/2026-11-02-shape-session-and-convert.md` (Convert writes landings)

## Decision

**Built (Shape slice 6, spec §10.4):**

- **Data.** Migration 0034 adds `landing_groups` (id, project, title, the shape that proposed it) and
  `tasks.landing_group_id`. `insertLandingGroup` writes the group and sets its tasks in the caller's
  transaction, and refuses a task already in a group or from another project. `TaskDto.landingGroupId` is
  optional and nullable, so a task made any other way reads null and every existing fixture still parses.
- **Convert** writes each selected landing as a group after the tasks exist. A landing naming a pending task
  that isn't selected is refused by name ("Real areas includes Task b, which isn't selected"), as a
  dependency is; one naming a task already in a group is refused too. A landing has no `shape_links` row (the
  table's CHECK keeps exactly one goal, task or decision per row); the group's `shape_id` is the link.
- **Validation** (proposal time) judges a landing's tasks by where they would work and land: a task still in
  the draft gets the project's defaults, a converted one the placement and landing it has. Different places or
  landing targets, or a task already in a group, are refused by name. `sharedLanding` still checks at start.
- **Starting.** `groupByDependency(tasks, landingTitles?)` also groups tasks that share a landing group, and a
  landing's batch is titled after the landing; with no landing groups it groups exactly as before. Before the
  usual split by placement, `planLandings` (`delivery/landing-join.ts`) sends a task whose landing has an OPEN
  batch to that batch (a separate copy's join, or the shared batch's), in the batch's place. A landing whose
  batch is cutting, shipping or failed refuses the start by name rather than splitting the landing. Tasks of
  one landing that would start in different places are refused.
- **A late task after the landing shipped** makes a new batch, with the batch notice `landing-shipped` ("Part
  of Real areas, which has already shipped") written in the same transaction as the batch.
- **Preview** counts pull requests and CI runs, with the landings and without: components of the draft's tasks
  joined by dependency, and for the "with" count by landing. Each pull request is one CI run, since `main` has
  no merge queue (`decisions/2026-11-02-main-has-no-merge-queue.md`).

## Why

- The builder's complaint was 300+ pull requests and so 300+ CI gates; a batch is already one branch and one
  pull request, so sharing a batch is the smallest change that makes a landing real.
- Joining only an OPEN batch reuses `tendb join`'s rule. A cutting or shipping batch can't take a task without
  racing its cut or its gate, and silently starting a second batch would break the landing the builder asked for.
- A notice, not an Inbox card, because nothing asks the builder to act (`decisions/2026-10-31-notices-not-cards.md`).
- Not built here, as the spec lists them under Undo: removing a group with its last unstarted task, and
  ungrouping a task from its drawer.
