# The Workbench setup rebuilds a project's areas, with a page per route, for one Apply

- **Date:** 2026-11-10
- **Amends:** Workbench spec §4.2's empty state (why a pass needs a page area, Propose Page Areas and a
  link to Settings), and `decisions/2026-10-29-propose-areas-from-the-repository.md`, whose proposer it
  reuses for an existing project

## Decision

Opening the Workbench on a project with no page area shows the setup in place of the picker; a project
with page areas reaches it from the picker's Set Up (n), which counts the setup's settings and branch
note only, so a page the builder left out is not asked for again. Propose Page
Areas, its dialog and `POST /projects/:projectId/propose-page-areas` are gone: there is one path.

- **One read, one Apply.** `POST /projects/:projectId/workbench-setup` answers `WorkbenchSetupDto`: the
  project's areas rebuilt (`areas`: the whole new list, the areas kept and why, the new pages as rows,
  what was left out and why), the settings it suggests and a branch note. The builder unticks what they
  don't want; Apply sends one `PATCH /projects/:id` with the list (each unticked page folded back by
  `withoutPages`) and the ticked settings. Nothing is saved without it, and the project's own validation
  answers: a 400's words show above the button, and a list the project would refuse
  (`setupAreasProblem`) disables Apply before it is sent. Defaults are ticked.
- **The areas are rebuilt, not patched.** The new list comes from the repository's structure at HEAD, as
  `proposeAreas` reads it (git's object store only, unpinned, nothing of the checkout opened or run),
  with names from paths and no model: the structural candidates, the history merge over the areas with
  no role, each route a page with its route, the root layout and the source folders pages share marked
  shared, and each file in exactly one area that is not a page, beside the pages that overlap shared
  areas only (spec §7.3).
- **A first setup rebuilds; later ones ask.** With no page area the rebuilt list is applied unless the
  builder unticks its pages. Once the project has page areas, the rebuild is one row of its own,
  unticked, and Apply sends the areas only when it is ticked. A rebuild that finds no page, or changes
  nothing, offers no areas.
- **Only areas open tasks name are kept**, exactly as they are, each said with its count ("kept: 146
  open tasks name it"). A kept area whose globs are exactly a page's route folder becomes that page, its
  globs only growing by the page's code, so no open task loses a file it could write; unticking that
  page puts the area back exactly. A new area with no
  role whose files kept areas already hold is left out; a page that would share files with a kept page
  is left out with why. Hazards are never touched. An existing page area that no open task names is
  rebuilt like any other area.
- **A page's code is what only it imports.** Each page's reach is every source file its route folder's
  files import, directly or not (static imports and re-exports, `import()` and `require()` with a
  literal, relative or through tsconfig `paths` and `baseUrl`); a test or story starts no reach. A
  file one page alone reaches is the page's; one two pages reach, or one a layout, router or entry
  file reaches outside the route folders, stays shared. The page takes the largest folder every
  source file of which, tests aside, is its alone (a file nothing reaches keeps its folder out),
  never the app's root nor a folder holding or inside a route folder; fewer than 20 single files left
  over become exact globs.
- **Which screens are pages.** An index page (a route folder's or route group's own `page.*`) is a
  page at the path it shows, `home` at `/`. A screen whose page files only `redirect(` is left out,
  "redirects to another page". A nested route group adds nothing: its screens are pages of their own.
  A screen with no page file at its own path is a page with no route. Over 5,000 source files no
  graph is built and the setup says so. Source text is read by a linear scanner, never by a regex whose
  quantifiers can match the same text, so no repository's file can stall the daemon.
- **An app that names its routes in code** (a Vite or Tauri UI) gets its pages from its `router.*`,
  `routes.*`, `App.*` and `main.*` files: each route's component, through the file's imports or through
  what a component defined there renders, resolved to a folder directly under `views/`, `pages/`,
  `screens/` or `routes/`, with the shortest static path naming it; a page named only by a path with a
  parameter takes the longest static start of it the router also defines, else no route. Its unit is split into its `src/`, shared, and the rest.
- **Reading never reaches a remote.** A partial clone is not read (a missing blob would be fetched,
  running the remote's programs), the object reads run with lazy fetches and every transport off, and
  one setup reads at most 32 MB.
- **Pushing stays the builder's act.** The branch note is a command to copy, never a button: a push
  runs the repository's hooks and sends commits to a remote.

## Why

Slice 0 (the page areas, their roles and routes, the settings a pass needs) took the builder an hour per
project by hand, and Propose Page Areas only added pages beside a list that still bundled routes and left
the root layout unshared. Patching each existing area in place (update, split, mark shared) was tried
first in the plan and turned down by the builder: it kept every hand-made bundle the old proposer had
merged by history. A rebuild gives every project the same shape, and keeping only what open tasks name
protects work in flight; the old list is in the database backup. Cost if wrong: a hand-tuned list is
replaced after the builder reviewed and applied it.

Pages taking only the code no other page imports keeps two lanes in a pass off each other's files (spec
§7.3) while letting a page's feature folder land with it. Counting what a layout reaches as shared stops
the app's shell going to whichever page also imports it; the `/` screen beside a layout is not a layout,
so code it shares with one page goes to that page.
