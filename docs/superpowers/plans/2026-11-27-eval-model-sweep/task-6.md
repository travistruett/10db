# Task 6: Switch to <model>, and Check the Slot (Track A)

**Files:** new `apps/daemon/src/evals/switch-task.ts` (beside `new-eval-task.ts`, reusing its skill lookup),
`apps/daemon/src/api/app.ts`, `apps/desktop/src/views/evals/try-models-modal.tsx`,
`apps/desktop/src/views/board/eval-marker.tsx` (the covered task's Evals block), `apps/desktop/src/views/evals/AGENTS.md`,
`apps/daemon/src/evals/AGENTS.md`.

**Implements:** `POST /projects/:projectId/evals/:suiteKey/switch` `EvalSwitchBody` → `TaskDto` (index, Interfaces).

- The task "Switch <slot or suite> to <model>": the winning run's report path and cost; the suites whose latest result
  names the same `slot`, listed; the project's eval skill as slice 3 names it, with "follow its steps for changing
  a model"; and "edit code and run free checks only; the builder runs the paid checks from the pull request's Evals
  block". Areas from the suite's covered paths, as slice 3 does.
- The covered task's Evals block (slice 2) offers **Check the Slot** when its task was filed by a switch: a `try`
  sweep of the listed suites on the new model, through task 5's window. Results show as each suite's marker.

**Rows:** none new (a `try` sweep).

**Tests:** none (a task draft and UI; the sweep is task 3's). Extend task 5's e2e by one step: Switch files a task
whose description lists the other suite on the slot.

**Index sections:** Design › Switch; Brief.
