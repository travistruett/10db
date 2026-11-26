# Evals slice 3: New Eval files a task that drafts an eval

**Size: Feature** (one implementer end to end, one review that blocks only on bugs, one extended e2e flow).

## Brief

**What changes for you.** **New Eval** appears on the Evals page, on each No Eval row (found or assessed), and on a
Shape goal's proposed eval (`PlanEval`). It opens a short form, prefilled from where you pressed it, and files a
normal task, "Write the eval for <behavior>". The task's brief carries ampsio's rationale: Decision, Evidence,
Oracle, Coverage and bar, Models, and Execution. The lane drafts the cases, graders and free companion in the
project's own format by the project's own eval skill, and opens a PR. It never runs the live arm.

**What it buys.** The eval backlog on the No Eval tab becomes one click to work.

**What could go wrong, and how we'd know.** A project with no eval skill: the brief says so and points at the
existing eval files as the format to follow. A lane that tries the live arm: the brief forbids it, and the live
command needs the project's key, which lanes don't get.

**Calls you might disagree with.** The task is filed as a normal task on the project's account, not a new kind of
flow. `PlanEval` gains optional `decision` and `oracle`, so older Shape plans still parse.

**Needed from you.** Nothing.

## Parts

1. **Contracts:** `PlanEval` widens with optional `decision` and `oracle` (`packages/contracts/src/shape.ts`); the
   Shape prompt or schema that writes a `PlanEval` asks for them. A `NewEvalRequest` body: behavior (required),
   decision, evidence, oracle, coverage and bar, models, execution, and where it came from (page, gap, plan eval).
2. **Daemon route** `POST /projects/:id/evals/tasks`: zod-parses the body, finds the project's eval skill at HEAD
   (`.claude/skills/*/SKILL.md` and `.agents/skills/*/SKILL.md` whose name or description mentions evals;
   ampsio keeps `llm-eval` in both), and files a normal task through the existing task-create path. Its title is
   "Write the eval for <behavior>"; its description has the six rationale sections, the skill to follow (by name
   for the lane's own agent, by path when the project has it only for the other agent), the files a gap names, the
   project's existing suites as format examples, and "Never run the live command or any paid model call".
3. **UI:** a New Eval button in the Evals page header; a row action on No Eval rows (prefills behavior and the
   `where` paths); a button where Shape shows a goal's `PlanEval` (prefills objective → behavior, decision, oracle,
   models, baseline → bar). One Mantine modal (`new-eval-modal.tsx`) with the fields; on submit it files the task
   and links to it.
4. **Docs:** the evals module notes (daemon and desktop) and the `10db-task` skill's evals section if it lists
   what the page can do.

## Provider parity

The task is a normal lane on the project's account. A Claude lane follows the skill from `.claude/skills`; a Codex
lane from `.agents/skills`. Where a project has the skill only for one agent, the brief names the file's path and
the lane reads it as a file. Same on a Claude plan, Bedrock/API key and a Codex plan.

## Tests (`.claude/rules/testing.md`)

No unit test (nothing here is core). Extend the evals e2e flow (`apps/desktop/e2e/project-trust.spec.ts`): New Eval
from a No Eval row files a task titled "Write the eval for …" that shows on the board.
