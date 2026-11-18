# A judge flags new tests that duplicate or fold into existing ones, and never blocks

- **Date:** 2026-11-18

## Decision

- **One decision, `test_value`**, built like the others: one typed `judge.choose` call per new test, a confidence, a
  floor (default 0.8), its own model and its own switch in Settings › Decisions (Delivery). With the judge or the
  decision off, nothing about a task changes: no call, no follow-up, nothing added to a brief.
- **What it reads.** For each non-merge commit the run made (`baseHead..head`, first parent), each test case
  (`it` or `test` call, or the `it.each(...)('name'` call) whose first line the commit added, with the commit's
  value card (the `Value:` paragraph of its message), the tests beside it (its own file's, nearest first, then those
  of test files in the same directory that import a module it imports), and the repository paths of the modules it
  imports. A row added to an existing table is not a case, and neither is a changed test whose first line did not
  change. At most 12 new tests are judged per run, 4 at a time.
- **What it answers**, one option per question: `keep`, `move_cheaper`, and `fold_into_<n>` and `duplicate_of_<n>`
  for each of up to 20 neighbours, named by number in the criteria. An answer below the floor, a fallback or a
  choice that is none of the options is `keep`.
- **Where it runs, so it is not a second reviewer.** On a task whose plan has no Review step after the implement step
  that just passed (and none forced by the safety net), each answer other than `keep` becomes one Icebox follow-up
  task naming the new test and the existing one, at most 10 and none twice for the same test. On a task with a
  Review step, the Review's first-round brief lists the answers other than `keep` as input, and no follow-up is
  filed for them. QA, Plan Review and later review rounds are told nothing.
- **It never blocks or fails a step.** It runs after the gate has passed, any error or timeout is `keep`, and its
  calls are bounded by the judge's own timeout.
- **Provider parity.** The judge calls OpenRouter on the builder's OpenRouter account whatever account the project
  runs on, so the decision behaves the same on a Claude plan, Bedrock, an API key and a ChatGPT/Codex plan.

## Why

Test-to-code added lines on main ran at about 1.0 to 1.6 for four weeks even with value cards: the rules ask the
author to justify a test, and nobody asks whether a test the author justified is one that already exists. A
reviewer reading a whole diff does not look for that; a judge shown only the new test beside its neighbours does.

A separate reviewer would answer the same question the Review step answers, so a task with a Review gets the answers
as input to it, and one without a Review gets follow-ups it would never otherwise get.

Rejected: blocking a step on an answer (a judge reading names and bodies is often wrong, and the builder asked for
advice); reading the whole repository for neighbours (the same-file and same-module tests are where a duplicate
lives, and the state stays a few thousand characters); one call per commit (a per-test answer names the existing
test).

The judge reads text, not runs: it cannot tell that a test is the only one that fails for a regression, so a flag is
a follow-up to check, and the follow-up's text says so.
