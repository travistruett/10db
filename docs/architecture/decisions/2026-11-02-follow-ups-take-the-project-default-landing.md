# A follow-up task lands where the project's tasks land now, and a start warns about a stale landing branch

- **Date:** 2026-11-02
- **Amends:** `decisions/2026-10-30-later-review-rounds-check-only-earlier-findings.md` (a follow-up no longer takes
  its source's landing)

## Decision

- **A follow-up takes `taskLandingFor(project)`**, the landing the project gives new tasks, not the landing of the task
  that filed it. This holds for every follow-up 10db files: the review roles' `followUps` and an implementer's
  `file_follow_up` (`insertFollowUpTask`), and the findings task for a rejection at the retry limit
  (`insertRetryLimitFollowUp`). Its areas still come from the source. A follow-up filed while its source lands on the
  project default gets that default, as before.
- **Starting a task whose landing branch is behind the project's base shows a notice, not a refusal.** When a batch's
  base branch is not the project's, the cut fetches the project's base too and, if `origin/<base>` is not an
  ancestor of `origin/<branch>`, writes the batch notice `landing-behind` (warning): "<branch> lacks N commits
  <base> has". Its body says the work is built from the branch without those commits, that it won't reach the base
  unless the branch is merged into it, and what to do. It runs in both cuts (`start.ts`, `worktree-cut.ts`). A
  comparison that can't be made (the base can't be fetched) writes nothing; the cut's own fetch of the landing
  branch still refuses when origin can't be asked.
- **Starting a task whose landing branch no other open work uses shows a notice too.** A retired branch can be level
  with the base (`next` just after a final merge), so "behind" alone misses it. When the batch's base branch is not
  the project's base, nor the branch the project lands new tasks in, and no other open task (status open, not one the
  batch starts) lands there, and no unfinished batch other than this one has it as its base, the cut writes the batch
  notice `landing-unused` (warning): "Nothing else open lands in <branch>". A done or removed task and a shipped
  batch count as no use. It is written beside `landing-behind`, not instead of it (`landingWarnings` in
  `landing.ts`), in both cuts, and the check reads only the database, so it never blocks a start.

## Why

On 2026-11-02 eleven follow-ups filed while their tasks landed on `next` kept `landing: { kind: 'branch', branch:
'next' }` after the project's tasks had moved to the base and `next` was retired. Six were started, their batches cut
from a `next` that lacked main's fixes, and one pull request merged into `next` and had to be cherry-picked to main.
A task's landing can't change once it has a workstream, so the rest had to be abandoned and recreated.

A follow-up is new work the builder triages from the Icebox; where the project lands work now is the right default,
and the builder edits it before starting, as for any task. A refusal at start was turned down: landing in a
non-base branch is legitimate (a release branch that is behind on purpose), and the builder alone knows. A notice
reaches the builder on the card and in the drawer without asking anything (`decisions/2026-10-31-notices-not-cards.md`).
