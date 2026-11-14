# A pass whose pull request merges while it is open closes by itself, and its unfinished pages carry over

- **Date:** 2026-11-10
- **Amends:** `decisions/2026-11-09-close-pass-shows-its-lists-and-stops-agents-only-on-confirm.md`

## Decision

When the pull request watch reads an open pass's pull request as merged, the pass closes by itself
(`pass/merged-open.ts`, `createPassCloses().closeMerged`). The close is Close Pass's own steps, from a plan
10db writes in the confirming write, recognised by its token `merged-while-open` so a restart runs it the
same way: every unfinished page is taken out, nothing is signed off, placed or dropped, no gate runs and
nothing is pushed, D8 fast-forwards the return branch, and the pass is `CLOSED`. The pages signed off after
the last push are not lost: with unfinished pages, those pages carry over to a follow-on pass, opened as
Start Pass opens one after the close job (so it stacks on the closed pass and puts their work back), whose
pull request carries the later sign-offs; with none, the branch is pushed and a follow-on pull request is
opened against the base in the merged one's place on the batch, the base taken in first by a merge that
changes no file when its tree is the pushed tip's. One card, `pass_follow_on`, says what happened, names the
follow-on pass or pull request, and marks the carry-over done for start-up. Close Pass on a merged pass is
refused (409) and starts this close; Open Pull Request is not offered.

## Why

Workbench spec §5.4, call 6: a merged pass that stays open keeps taking sign-offs that no pull request
holds. Reusing the close keeps one recorded sequence with its recovery and its Abandon. Writing the plan
rather than asking the builder keeps the merge from waiting on a modal; taking every unfinished page out is
the only choice that loses no work. Turned down: leaving the pass open with a notice (the next sign-off lands
on a merged branch), and a separate close sequence (a second set of steps to recover).
