# Scope follows the question: global views sit above the project, and the sidebar says which is which

- **Date:** 2026-11-09

## Decision

- **Three levels.** A view is global when it answers "what needs me?" or "what is running, and on what?": the
  Inbox, Factory, and the app-wide settings (accounts, updates, keep-awake, lane permissions). A view belongs to a
  project when it shows how one repo's work is shaped: the Board, Plan, Knowledge and the project's settings. A
  task, a goal and a conversation are objects, reachable from either level.
- **Global views show every project.** They narrow by a project filter the view shows, and never by the
  project chosen in the sidebar. Factory lists every project's goals, grouped by project.
- **A goal and a Plan conversation never span projects.** Both stay inside one project.
- **The sidebar** (`apps/desktop/src/shell/app-layout.tsx`) reads top to bottom: Inbox and Factory; a "Project"
  label over the project switcher, then that project's Board, Plan, Knowledge and Project Settings (which opens
  the project's General section); and Settings at the foot, which opens the first app-wide section. The Settings
  sidebar already reads Back to Board, the project's sections, then Global.

## Why

One project switcher at the top of the sidebar changed every view at once, so the chosen project was a filter the
builder could not see: a card waiting in another project went unnoticed from the Board. Tools that run work
unattended converge on one cross-project place for what is running and what needs a person (a cross-repo agent
list, a sidebar of every repo's workspaces), and keep per-repo configuration inside the repo. The builder expects
2 to 10 projects.

Turned down:

- **A Board across all projects.** Columns, areas, hazards and the gate are each project's own, so a merged Board
  would mix rules; Factory is the cross-project view.
- **Listing every project in the sidebar with a status dot.** It may come later; the switcher keeps this change
  to the order and grouping of what is already there.
