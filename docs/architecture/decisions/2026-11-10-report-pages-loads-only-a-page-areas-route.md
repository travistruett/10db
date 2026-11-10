# report_pages loads only a page area's route

- **Date:** 2026-11-10
- **Amends:** `decisions/2026-11-10-task-pictures-come-from-a-pinned-chromium-and-stay-on-the-mac.md`

## Decision

The lane tool `report_pages` names routes the task's turn (a pass page) or run (a task outside a pass) adds to
its pictures, at most four (`REPORTED_ROUTES_MAX`). A route is kept only as one of the project's page area
routes (`keptRoute`, `mcp/report-pages.ts`):

- Each literal segment equal; each parameter segment (`[id]`, `[...slug]` or `:id`, as area routes write
  parameters) filled with one value matching `[A-Za-z0-9_-]{1,64}`, so no escape, dot or slash, and refused
  when it equals a literal segment of any page area's route at the same depth (`/people/new` is that page,
  not `/people/[id]`).
- The reported query is dropped; the matched area route's own query, if it has one, is kept exactly.
- Every route is refused in a read-only step, for a task in a separate copy, and on a project with no app
  address. Each refusal says why.

What remains: a GET with side effects on a parameter path of a declared page (`/people/42` doing something
on load) is still possible. That is accepted: the page is the builder's own, declared as a page, and loaded
the same way by its before, turn and after pictures.

## Why

Workbench spec §10 "Which pages". The browser loads a reported route signed in with the builder's dev login.
A free path made 10db a confused deputy: an agent could have it do a signed-in GET of any path (an API that
deletes, say) that the agent's own sandbox cannot reach signed out. Limiting routes to declared pages, with
plain parameter values and no agent query, keeps the browser on pages the builder named. Turned down: any
`PageRoute` on the app's origin (the deputy above), and keeping the agent's query (`?action=delete`).
