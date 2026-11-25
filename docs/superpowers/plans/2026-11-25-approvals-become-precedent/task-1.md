# Task 1: the Makefile reader keeps a recipe inside a conditional

**Size: Core** (what the judge is shown), small. Read the index's Brief and Global Constraints first. Needs
nothing; its own pull request.

## Why

Ampsio's `t:` recipe sits inside `ifdef IN_COPY … else … endif`. `parseRules` closes a rule at the first line
that isn't a recipe line, so the judge is shown `recipe: ""` and a `.env` prerequisite, and scores `make t`
0.71–0.79.

## Files

- `apps/daemon/src/trust/make-rules.ts`, `parseRules`: while a rule is open, a conditional directive line
  (`ifdef`, `ifndef`, `ifeq`, `ifneq`, `else`, `endif`, with any indent that isn't a tab) doesn't close it and is
  kept in the recipe as written, so the judge reads both branches and the test between them. Outside a rule it is
  skipped, as today. A rule head still closes the rule.
- `apps/daemon/src/trust/call-runs.ts`, `recipeCommands`: a directive line is not a command, so it is not
  followed. The scripts on both branches are followed, inside the existing bounds.
- `apps/daemon/src/daemon/docker-need.ts` shares `parseRules`: check its reading of a recipe still holds with
  directive lines in it.
- `apps/daemon/src/trust/AGENTS.md`: one clause in the `call.runs` note.

## Interfaces

None change. `MakeRule.recipe` may now hold directive lines.

## Spec sections

"Today, in the code" (the `parseRules` item); "Today's evidence", item 4.

## Tests

One case added to the existing `callRuns` test in `apps/daemon/src/trust/call-runs.test.ts`: a target whose
recipe is inside `ifdef … else … endif` gives both branches' lines and follows a script named on each. Prove it
red first. Value card: `protects=the judge is shown a conditional recipe; fails_when=parseRules drops lines after
a directive; why_new=the judge's reader (escaped: make t scored under the floor); no_claim=that the judge then
allows the call`.

## After it merges

Run `apps/daemon/scripts/crosses-limit-replay.ts` live once tsk_01a20e8c-fcee has added its `make t` cases, and
write the before and after scores on that task. Until then the effect on the score is unverified.
