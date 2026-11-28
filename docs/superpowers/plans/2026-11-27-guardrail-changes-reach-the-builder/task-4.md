# Task 4: the ownership test's three judge questions run in shadow

Read the index's Brief and Global Constraints first. Size: Core (a judge decision that will later decide who owns
a move). Starts after task 3 has merged.

**Files:**

- `packages/contracts/src/judge.ts`: `JudgeDecision.OwnershipTest`, its config default and its label. Additive: a
  stored config without it reads with the default, as the later decisions there do. Regenerate
  `packages/contracts/generated/` with the package's script; never edit it by hand.
- New `apps/daemon/src/ownership/shadow.ts`, `index.ts`, `AGENTS.md`.
- `apps/daemon/src/delivery/ship.ts`: one call after the pull request is recorded.
- The event schema in `packages/contracts` for `ownership.shadow`.
- `apps/desktop`: only what a new decision needs to show in Settings › Decisions (its label), if the table is not
  built from the contract already.

**Implements** (index, Interfaces): `JudgeDecision.OwnershipTest`. **Calls:** `ownershipTest`,
`OwnershipQuestion`, `guardrailHits`, `judge.assess`, `fenced`.

**The decision.** Enabled, floor 0.8, the default model. One `assess` call carries three questions, with ids from
`OwnershipQuestion`:

| Id                  | Asks                                                                                     | Yes means                                    |
| ------------------- | ---------------------------------------------------------------------------------------- | -------------------------------------------- |
| `one_way_door`      | Does this change do something that can't be taken back once it merges or runs?            | Destroyed data, a sent message, a live write |
| `product_and_taste` | Does it change what the product does or how it looks beyond what the task asked for?      | New scope, a new look, a dropped criterion   |
| `promise`           | Does it publish, release or message anyone outside the project in the builder's name?     | A release, a public post, a first message    |

The wording is settled in the pull request and read against spec §1's "How 10db recognises it" column. The prompt
watchpoint covers it; say in the commit's note what each question should make the model answer.

**When it is asked.** Once per ship of a root batch, after its pull request is recorded, off the ship's path: a
job that the ship does not wait for and whose failure changes nothing. The judge reads the tasks' titles and
criteria and the pull request's diff, fenced and capped as `watchpoints/question.ts` caps its diff. CI-fix batches
and catch-ups do not ask.

**What is logged.**

- The call's row in `judge_calls`, with `JudgeOutcome.Shadow` and the reading, as `watchpoints/question.ts` and
  `shape/jev.ts` record theirs.
- One `ownership.shadow` event: the batch, the three answers with their confidences, the guardrail hit count, and
  what `ownershipTest` returned (`owns`, `doubt`).

Nothing reads the event or the row to act: no card, no hold, no move. The held pull request of task 3 does not
import this module, and a test in `tests/repo` is not needed for that; the import graph is two files.

**Provider parity.** The call needs an account decisions run on: OpenRouter, an Anthropic API key or Bedrock. On a
project with only a Claude plan or only a ChatGPT/Codex plan the judge answers with its fallback outcome
(`fallback_no_key`), which is logged, and no event is sent. Nothing depends on the answers, so every feature of
this plan behaves the same there. Spec stage 12 closes the gap.

**State-table rows:** the shadow line of the index.

**Tests.** No new unit test: `ownershipTest` is covered by task 1, and the judge's shadow outcome by its own
tests. Evidence instead, attached with `record_evidence`: through `createTestEngine` (or the delivery harness)
with the fake judge answering, ship one batch and read back from the real SQLite file one `judge_calls` row for
`ownership_test` with outcome `shadow`, and the `ownership.shadow` event; and show that the same ship with the
judge answering yes to all three opens the same pull request, arms auto-merge as before and raises no card. If
that run finds a bug, it gets its one regression test.

**After a week.** Not this task: spec §5 has a new judge question run in shadow for a week against what was
actually answered before it acts. Stage 11 reads the logged calls and decides what acts.

**Spec:** "2. Who decides", "The ownership test"; "5. How self-healing fails, and its guards", "Wrong automatic
decisions"; "10. Per provider", "The judge rows".
