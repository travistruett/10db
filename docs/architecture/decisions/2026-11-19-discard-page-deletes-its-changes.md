# Discard Page deletes the page's changes and removes a task the pass made

- **Date:** 2026-11-19
- **Amends:** `decisions/2026-11-14-abandon-pass-deletes-unsigned-pages-work.md`, which kept Take Out as the
  way to set a page aside with its work

## Decision

A page's one action for leaving a pass is **Discard**, on its ⋯ menu (its queue row and its title row). The
page menu's Take Out ("Remove: its changes move to its Board task") is gone. Discard Pass is the pass menu's name
for Abandon; the daemon's Abandon is unchanged.

- **One rule for page and pass.** Discard deletes the changes; a task the pass made for the page
  (`tasks.made_by_pass_id`) is retired; a task brought in from the Board goes back to it open, with no saved
  work; committed (signed-off) pages stay.
- **It is a take-out.** `POST /passes/:passId/tasks/:taskId/take-out` takes `discard: true`. The take-out runs
  its recorded steps as one asked for alone (stopped by files that keep changing, refused once the pass is not
  open, a refused Drop kept on the chain), and its step 5 is the Abandon's: `deleteAbandonedWork`, then
  `leaveAbandonedPass` in one write. The thread says "Discarded from <pass>; its changes were deleted."
- **A restart deletes too.** The take-out row is written with `discarded` set, and step 5 reads the row, so a
  take-out that resumes at start-up finishes as a Discard, not a keep. No migration: the column exists.
- **The confirm says what goes.** It names the shared changes that stay because a later page stands on them,
  and that a task 10db made is removed while one from the Board goes back there. Discard sends Drop for every
  shared change the daemon allows and Keep for the rest.
- An Abandon's card names every page of the pass whose take-out row is `discarded`, so a page discarded
  before the Abandon is named among those whose changes were deleted, which is true.
- Close Pass keeps its own take-out of unfinished pages, which keeps their work with their tasks.

## Why

The builder found Remove and Discard side by side confusing, and Remove's "its changes move to its Board task"
made no sense to them: discarding a page means being rid of it. The daemon already had exactly that step inside
an Abandon; reusing it keeps one code path for deleting a page's work, recorded step by step.

Turned down: composing the Discard in the desktop from a take-out, `DELETE /tasks/:taskId/kept-work` and Board
Remove. It removed joined Board tasks too, against the rule, and a restart between the calls left the work kept.
