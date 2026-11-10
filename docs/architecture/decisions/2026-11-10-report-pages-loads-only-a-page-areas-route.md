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
- Every route is refused in a read-only step, for a task in a separate copy, for a pass page with no turn
  open, and on a project with no app address. Each refusal says why.
- A stored route is matched again when its picture is taken, against the page areas as they are then, so a
  route whose page area was removed or changed is not loaded. A turn picture loads its turn's routes; a pass
  page's after loads its last turn's, and any other task's after its run's, at most four.

What remains: a GET with side effects on a parameter path of a declared page (`/people/42` doing something
on load) is still possible. So is a value that names an undeclared sibling route: `/people/[id]` accepts
`/people/export` when `export` is no page area's literal segment, and the app may serve its own route there.
Both are accepted: the pattern is the builder's own page, declared as one, and loaded the same way by its
before, turn and after pictures; a sibling the builder wants kept out is declared as its own page area, which
makes its segment a literal no parameter takes.

## Why

Workbench spec §10 "Which pages". The browser loads a reported route signed in with the builder's dev login.
A free path made 10db a confused deputy: an agent could have it do a signed-in GET of any path (an API that
deletes, say) that the agent's own sandbox cannot reach signed out. Limiting routes to declared pages, with
plain parameter values and no agent query, keeps the browser on pages the builder named. Turned down: any
`PageRoute` on the app's origin (the deputy above), and keeping the agent's query (`?action=delete`).
