# A pass's page is the Workbench's everywhere else: In progress, no Park the task, no batch Abandon

- **Date:** 2026-11-10

## Decision

While a pass holds a task (`passHoldsTasks`), every other view treats it as the Workbench's:

- The Board puts it In progress (`deriveBoardStatus`'s `inPass`), so a Ready page, a question or a failed
  turn never sits in Blocked; a run paused by a usage limit or held stays Blocked, as any run does. Its card says Workbench, not Shared branch; one that
  waits on the builder says "Waiting on you in the Workbench"; its drawer names the pass's branch with
  Open Workbench and offers no batch action.
- A question its run asks, its own or the shared-code question, carries no Park the task.
- Factory counts a Ready page (`pass_review`) as running neither in a goal nor in Not in a goal.

A task taken out of a pass keeps its last run in the pass's batch; the Board shows it as a task with no run
(`board/pass-page.ts`), so it shares no branch and offers nothing of the pass's.

## Why

Browser QA found the Board showing pages as members of an ordinary shared batch: "Shared branch", a drawer
offering the batch's Abandon (which the daemon refuses for a pass's batch), and Ready pages in Blocked with
"answer in Inbox", while the Workbench, not the Inbox, is where a page is answered and signed off. Park the
task stops a run and parks its task in the Icebox, which a pass has no place for: a page leaves its pass by
Take Out, and the shared-code question already took Park as Keep It to This Page. Counting a Ready page as
running told the builder agents were working when they were waiting on them. Leaving the Board's column to
the run's state and adding a Workbench line was turned down: the column is where the builder looks for what to
do next, and for a page that is the Workbench.
