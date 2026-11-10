# A pass runs no plan, review or gate per turn; one model review reads its pull request when it opens

- **Date:** 2026-11-10
- **Amends:** `decisions/2026-10-28-optional-gate.md`

## Decision

A task in a Workbench pass runs its project's implement step alone, on any project, whatever its flow
holds: no plan step, no review step and no gate after a turn (`delivery/pass-open.ts`, `passPlan`). The pass
is reviewed once, at its pull request: after Open Pull Request pushes the branch, outside the delivery key and
under the pass's one abort (`delivery/pass-checks.ts`), `delivery/pass-review.ts` asks the model of the
project's review step, with its effort and a ten-minute timeout, to read the diff from the tip the last review
read (`passes.reviewed_sha`) or else the base, at most 400 kB a time, the new commits first. Each finding is
a thread notice on the page whose area holds the file it names, else a header notice; every one is offered
with Send to Agent and none is sent by itself (D19). A tip read already is not reviewed again unless a cut
review left files unread. A project with no review step gets no review.

## Why

Workbench spec §6.1, §8.3, D21: the builder looks at every turn, so a per-turn review or plan spends a lane
on what the builder is already judging, and a per-turn gate would test pages that are still moving. What
ships is the pull request, so that is what is reviewed, once, by the model the project already chose for
review. Turned down: the project's flow per turn (slow, and it fights the look-and-reply loop), and no review
at all (the pull request would carry no read but the builder's).
