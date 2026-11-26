# Evals slice 4: `eval.definition_changed`, classified, into watchpoints

**Size: Feature** (one implementer end to end, one review that blocks only on bugs, one extended e2e flow).

## Brief

**What changes for you.** When a run's change touches an eval's definition (the manifest's `definitionPaths`), the
run's "For you" section (task drawer and PR body) shows it under the Evals watchpoint with what kind of change it is:
**bar lowered**, **cases removed**, **golden changed**, **grader changed**, **model judge added**, or
**definition changed, unclassified**. 10db also emits `eval.definition_changed` with that classification.

**What it buys.** A lane that weakens an eval to pass it shows up in what you judge, named, not as one more file.

**What could go wrong, and how we'd know.** A classifier that misses a pattern says "unclassified", which still
shows; it never hides a change. A false "bar lowered" would show on a change that didn't lower one; the hit names
the line it read.

**Calls you might disagree with.** Classification is by line patterns in code, never a judge, so it is the same on
every provider. Watchpoints #881 landed with a hook for exactly this (`WATCHPOINT_HIT_SOURCES`), so the event is
consumed now instead of waiting.

**Needed from you.** Nothing.

## Parts

1. **Classifier** (pure, `apps/daemon/src/evals/definition-change.ts`): a rule table over one file's unified patch,
   answering the kinds above with the line that showed each:
   - bar lowered: a `minimum_rate=` (or `min_rate`/`threshold`) number that went down, or a manifest `bar` change;
   - cases removed: a removed `Case(` line, or removed entries in a JSON/YAML/JSONL cases file;
   - golden changed: a changed `expected`/`expected_output`/`golden` value, or a changed file under `golden*/`;
   - grader changed: a changed file or function named `grader`/`grade`/`scor*`;
   - model judge added: an added line naming a judge model (`judge`, `llm_judge`, a model id beside a grader).
   Anything else: unclassified.
2. **Contracts:** `EventName.EvalDefinitionChanged: 'eval.definition_changed'` and its payload (project, workstream,
   suite key, path, kinds). A reason on a watchpoint hit's file if `WatchpointFileHit` has no field for it.
3. **A second hit source** in `apps/daemon/src/watchpoints/hits-after.ts`: the run's changed files that are a suite's
   `definitionPaths` become a hit on the watchpoint whose key is the Evals starter's (or whichever of the builder's
   watchpoints covers the path), with the classification as the reason. The source needs the file's patch: extend
   `WatchpointHitSource` the smallest way that reads only definition files' text (they're already read when the
   glob matcher hits `**/evals/**`). Emit the event once per run from `watchpointReadingAfter`, beside the reading
   it records.
4. **UI:** the reason shows in the drawer's For you file line and the PR body's For you section (`delivery/pr-text.ts`).
5. **Docs:** `apps/daemon/src/evals/AGENTS.md` and `apps/daemon/src/watchpoints/AGENTS.md` (the hit-sources line).

## Provider parity

Classification and the hit are the daemon's code: the same on a Claude plan, Bedrock/API key and a Codex plan. No
model is called.

## Tests (`.claude/rules/testing.md`)

- One pure test of the classifier's rule table (a pure rule table), each kind and the unclassified fallback.
- Extend an e2e flow that already shows a watchpoint in For you (`apps/desktop/e2e`, the task flow added by #881):
  a run that lowers a `minimum_rate=` shows "bar lowered".

## As built

- The event's types live in `packages/contracts/src/eval-definition-change.ts`, not `evals.ts` (`evals.ts` imports
  `entities`, which imports `watchpoint-hit`: a cycle). The event constant is `EventType.EvalDefinitionChanged`.
- A manifest `bar` change is not classified: it is an app setting, not a line in the patch.
- The Evals watchpoint also takes definition files no watchpoint covers. With no `evals` watchpoint and no other
  covering one there is no hit and no event, because the event rides on the reading.
- Bars pair a removed line with an added one (same text with the numbers masked, else the next in order), every bar
  on a line is read, a deleted bar line counts as lowered, and a lowered-then-restored pair cancels. Cases count
  `Case(` lines or the file's entries by syntax; golden needs a value line on both sides; judges compare counts.
- The drawer's reason is plain text; the PR body rebuilds it with code spans.
