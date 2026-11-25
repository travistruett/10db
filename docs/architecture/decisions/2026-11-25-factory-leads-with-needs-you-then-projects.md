# Factory leads with what needs the builder, then shows each project's work as a bar

- **Date:** 2026-11-25
- **Supersedes:** `decisions/2026-11-19-factory-is-a-live-list-across-projects.md` (its list of sections; its
  section rules in `live-groups.ts` stay as the table every part below reads)

## Decision

Factory's page, under **Live**, is three parts, narrowed by its Project filter:

- **At a glance:** five figures. The first counts runs and Workbench passes waiting on the builder. The second
  counts failed runs and says how many causes they come from. The third
  counts the Mac's lanes in use out of its cap (`GET /admission`'s `lanesRunning` and `machineLaneCap`) while
  every project is shown, and the shown project's running work under the Project filter, with how many are
  queued. Then pull requests open, and merged
  today.
- **Needs you:** one panel across projects. It lists each run waiting on the builder, named by the open Inbox
  card that targets it, with Open and Answer (the Inbox, filtered to the project). It lists each Workbench pass
  with pages waiting. Failed runs are grouped by cause: the same project, failure kind and failed step. A lone
  failure reads as its task, with `failureLine` and Retry. Several read as what happened, with the tasks' titles,
  Show and Retry All, which retries each run `canRetryRun` allows, one after another. A dim line under the panel
  names who the builder waits on (a question out with someone else). With nothing to show, the panel is absent.
- **Projects:** each shown project is one accordion row: its tile and name, a bar split by where its work stands,
  one line of the same counts in words, and its last activity. The bar shows only this view's runs (open work and
  today's merges), never the backlog. Green is only merged work, and in review is striped blue. A project that
  needs the builder (a run, or a Workbench pass with pages waiting) or has a run going sorts first and starts open; an idle one sorts last and starts folded. With
  one project shown, it starts open. Opened, it holds its goals (the goal list as before, each row with a small
  bar of merged, in review and the rest), then its work in no goal. That work lists what needs the builder,
  failed, running (with step progress) and waiting runs. Its pull requests open and its merges today sit behind one
  line each, which opens them.

The flat list of every run by section is gone. Activity, Metrics and the admission note stay as they were.

## Why

The flat list grew with the factory: seven failures with the same cause took seven rows with seven Retry
buttons, and nothing said how far any project had got. The builder asked for a view that shows where work stands,
with things waiting on people and things in motion, and drill-down by project and goal.

Every agent tool we looked at (Claude Code's agent view, Devin, Cursor's agents window) puts what needs the person
first and folds the rest into counts. None rolls work up by project or goal with progress. The builder's own data
shaped the rest: most work is in one project and few tasks are in a goal, so a goals-first page (the earlier
design) would hide nearly everything under "Not in a goal". Projects come first, and goals are a layer inside a
project only when it has some.

Turned down:

- A grid of projects by pipeline stage. It is the most visual of the three, but it repeats the Board's columns and
  needs a second panel to say what is in a cell.
- Lane tiles with a pipeline stepper per lane. They show capacity well, but say nothing about how a project is
  doing; the lane count is one figure at a glance instead.
