# Evals slice 2: the covered-task marker and the "not run" line

**Size: Feature** (one implementer end to end, one review that blocks only on bugs, one extended e2e flow). The one
permission-shaped part, holding a lane's manifest write as a proposal, follows the principle-proposal precedent.

## Brief

**What changes for you.** A task whose change touches a suite's covered code gets a marker on its board card and a
before/after block in its drawer: "<suite> · not run" until you run the live command in your checkout after it lands,
then "passing" or "regressed". The run's one Inbox item gains a line per covered suite: "changes <path>; <suite>
hasn't run on this; last before: …", with the live command to copy. No second Inbox item is ever made.

**What it buys.** You know which landed work your evals haven't measured yet, and whether a re-run regressed it.

**What could go wrong, and how we'd know.** A suite with loose `coveredPaths` marks most tasks: the marker names the
suite, so a noisy one shows. A lane editing the manifest to drop its own marker: the globs are the manifest as it
stood when the run started, and a lane's manifest write is held as a proposal for you.

**Calls you might disagree with.** Before/after is by time, not by commit, because results live in your checkout.
A result whose dataset fingerprint differs from before's reads "the eval itself changed", never "regressed".

**Needed from you.** Nothing.

## Parts

1. **Snapshot the globs at run start.** When a run starts, keep each suite's key and `coveredPaths` from the project's
   manifest (prefer an existing row or evidence kind over a migration; if a migration is unavoidable, generate it
   last and say so in the report, since slice 5 may add one too).
2. **Match after the gate,** beside `reviewForcedAfter` in `runner.ts` (both the gated path and `finishWithoutGate`):
   the run's changed files against the snapshot, with the same glob matcher the evals module uses (`guard`
   `classifyPath`, as hazards do). Record the covered suites and the matched paths with the run.
3. **Before and after** (pure, `apps/daemon/src/evals/`): before is the newest result for the suite in the checkout
   older than the task's branch point; after is the first newer than the task's last commit. Marker state:
   `not_run` | `passing` | `regressed` (any model that passed before and fails after) | `eval_changed`
   (fingerprints differ). Read from the results the evals module already reads (`read-results.ts`); no new reads of
   result files.
4. **Contracts and route:** the marker on the board's task DTO (small: suite key, state) and a drawer read with
   before/after per suite. Classify any new GET in `screens/render-access.ts`.
5. **The Inbox line:** added to the run's existing single Inbox item, with the suite's live command.
6. **The proposal hold:** a `PUT /projects/:id/evals/manifest` from a lane's session is kept as a proposal the
   builder confirms in the Inbox, the way a lane's principle is. Find how the daemon tells a lane's write from the
   builder's for principles and reuse that; if HTTP routes have no such signal, stop and report, don't invent one.
7. **UI:** a marker on the task card (text, not a pill; DESIGN.md) and a block in the task drawer with before, after
   and the live command. Watchpoints changed the drawer in #881: fit beside its "For you" section.
8. **Docs:** `apps/daemon/src/evals/AGENTS.md` and `apps/desktop/src/views/evals/AGENTS.md` (or the drawer's notes).

## Provider parity

Path matching, the marker and the Inbox line are the daemon's: the same on a Claude plan, Bedrock/API key and a
Codex plan. The live command runs on the project's own key, by the builder; 10db never runs it.

## Tests (`.claude/rules/testing.md`)

- One pure test of the before/after/marker rule table (a pure rule table).
- One test through the wiring that a lane's manifest write is held as a proposal and doesn't change the manifest
  (permissions).
- Extend the evals e2e flow (`apps/desktop/e2e/project-trust.spec.ts`): a task whose change touches a covered path
  shows "not run" on its card and drawer.

## As built

What moved from the plan, and why:

- **Snapshot and match:** an `eval_coverage` evidence row (no migration) is written as a run's first session starts, holding
  each suite's covered globs and the time the snapshot was taken; the row after the gate adds the matched files, the
  last commit's time and what each suite last showed. The snapshot's time, not the base commit's, is the branch point,
  so a result the builder wrote after earlier work landed counts as before.
- **Marker states:** a fifth, `failing`, for a failed result no earlier passing model preceded. Fingerprints are
  compared only when both results record one.
- **Routes:** the markers are not on the task DTO (`listTasks` is synchronous and database-only; the markers read result
  files). They come from `GET /projects/:id/eval-markers` (one query for the project's rows) and
  `GET /tasks/:id/eval-coverage`.
- **Inbox:** the run's existing cards carry the lines (the acceptance card, the no-gate check card, the pass check card
  and the skipped/config card); no card is made for a suite alone.
- **Proposal hold (part 6) is not built; it moves to slice 5.** A lane can't reach the manifest route at all: the data
  dir holding the UI token is a protected read for lanes, so only the builder and their own sessions write it.
- **After** is the first result newer than the task's last commit; a landing time isn't on the workstream or batch, so
  a result written while the task waits on review or CI still counts as after.
- **e2e:** the flow is extended in `loop.spec.ts` (the first test), whose real task changes covered files; the e2e
  repo gained a tracked `src/greeting/README.md` because `**` never matches a dot file.
