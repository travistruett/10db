# apps/desktop/src/views/goals

Goals (`/goals`, the rail's first project item, above Board): the chosen project's goals, and one goal's page.

- `goals-view.tsx` is the route's view. With no `goal` it shows the chosen project's list; with `?goal=<id>` it
  reads the goal (`useGoal`, `GET /goals/:goalId`) to learn its project, so a link from any project's page opens
  it, then that project's `useGoals` for its summary. `?task=<id>` mounts the Board's `ProjectTaskDrawer` over
  either, as Factory does; closing drops `task` with `replace`. Opening a goal's page reads its digest once
  (`useOpenGoal`), which moves its "since you last looked" mark, as opening it in Factory does.
- `goals-list.tsx` is one raised table, a line per goal on `goals-list.module.css`'s shared columns (dot, title,
  bar and merged/total, status word, the next step's short words, one action, last change) under Needs you
  (failed, waiting on you), In progress, Not started and a folded Done. The title is the link; a click
  anywhere else on the line opens the page too. The title's `HoverCard` holds the objective and the session it
  was planned in (`useShapeOf`). The action is Start Ready Tasks (the goal's `BatchSheet`), Answer (Inbox),
  Open Board (`/board?goal=`) or Retry (the goal's page, where Needs you has each failed run's Retry).
- `goal-next-step.ts` (`nextStep`) is the one rule for what a goal's next step is, by status and ready count:
  a sentence for the page, a few words for the list, and the action. A draft says how many of its tasks are
  ready and what the rest wait on.
- `goal-page.tsx`: the title row holds only the title and the project (`ScopeBadge`); All Goals, the title,
  the status badge and the ⋯ menu (Show on Board, Show in Factory, Remove Draft Goal) open the content. The
  left column is the Next step panel (its button), then Factory's open-goal parts reused whole (`GoalBar`,
  `NeedsYou`, `WaitingOnOthers`, `GoalTasks`, `SinceYouLooked`, `GoalFooter`); the right is About This Goal
  (objective, what matters most, the notes as Markdown, folded until Show All), Done When (each criterion,
  how it is proven and whether it is) and Plan (Planned in and Open Session, or "Adopted from a brief").
- `task-goal-link.tsx` is "Goal · <title>" under a task drawer's title, a link to the goal's page.
- Ways in: the rail; Factory's open goal (Open Goal); the Board's goal line (Open Goal); a Plan's accepted goal
  row (Open Goal); the Accept modal, which stays open when the Accept made a goal, names it and offers Open
  Goal; and a task drawer's goal line. `e2e/sessions.spec.ts` (New Plan) walks Accept, the list, the page and
  a task's drawer.
