# Card 6: the Settings row, the Linear tab, the routes, the e2e

**Spec:** the brief's note and switch (moved from part 2); "Reporter" › "States" (failed shown on the card's
Linear tab); "Provider parity" (Your MCP servers off says so on the card).
**Track:** A, after card 5, and after #742 (the Title Case sweep) has landed on `main` and been merged into the
integration branch.

## Files

- Routes in `apps/daemon/src/api/app.ts` and services:
  - `GET /tasks/:taskId/linear-posts` → `LinearPostDto[]`;
  - `GET` and `PUT /projects/:projectId/integrations/linear/reporter` → `LinearReporterSettings & { blockedBy }`.
    PUT with `on: false` drops pending rows and refreshes the Inbox card.
  - Contracts are in card 1; add the response schema beside them.
- `apps/desktop/src/daemon/`: the query and mutation hooks, as in `sign-in-queries.ts`. Invalidate on
  `linear_post.changed`.
- `apps/desktop/src/views/settings/sign-ins/project-rows.tsx` `LinearProjectRow`, in the bound branch:
  - a **Report To Linear** switch (the Slack row's switch is the model);
  - a **How To Update Linear** textarea that saves on blur;
  - the `blockedBy` line, dim, when set (e.g. "Off: Your MCP servers is off in Trust.").
  - Keep the card's shape: one control on the line, the rest under it.
- `apps/desktop/src/views/board/task-drawer.tsx`: a **Linear** tab, shown only when `task.external` is set. It
  lists the rows newest first: event, attempt, state, when, then a link to the comment when there is one, the
  status set, the withheld pattern or the last error. Put the tab's body in its own file
  (`views/board/linear-tab.tsx`).
- `apps/desktop/e2e`: extend flow 2 (`loop.spec.ts`), or the Plan flow that already makes `AMP-1`
  (`sessions.spec.ts`), whichever reaches a linked task's run with less setup.
  - Bind the project. Use the fake script for the binding check, or the route the check's tool writes through.
  - Run the linked task to Done with a fake reporter script (`get_workspace` with a scripted result, then
    `report_linear_workspace`, `save_comment`, `report_linear_post`).
  - Wait on the condition, with a 90 s deadline (the reporter's 30 s delay runs on the daemon's real clock), until the drawer's Linear tab shows the run's rows as recorded.
  - Turn Report To Linear off on the Integrations row and check that it says Off.
  - No new spec file.
- `apps/daemon/src/sessions/fake-*`: the script entry for the reporter's brief, keyed as the fake adapter keys
  chats (the brief's first line).

## State-table rows

any / reporter turned off → pending dropped (the PUT); pending / fifth failure → failed, shown on the tab.

## Tests

The e2e extension only; no component tests.

## Done when

The e2e passes locally (`pnpm --filter @10db/desktop e2e -- <spec> -g <test>`). You clicked through the
Integrations row and a linked task's Linear tab against the real daemon (`make dev` or the `10db-dev-window`
skill), with screenshots in your scratch folder named in your report. The checks in Global Constraints pass.
