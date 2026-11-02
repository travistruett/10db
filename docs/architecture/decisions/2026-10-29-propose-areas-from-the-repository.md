# A new project's areas are proposed from the repository's files and history, for the builder to edit

- **Date:** 2026-10-29
- **Amends:** the project setup flow, which created every project with one area, `repo`, over `**`

## Decision

Adding a project proposes its areas before it is saved. One daemon function, `proposeAreas`
(`apps/daemon/src/folders/propose-areas.ts`), answers `POST /folders/propose-areas` with `{ path }`, a
repository's top level, and returns `AreaProposalResult`: areas, each `{ name, globs, reason }`, and who named
them (`model` or `structure`). Settings can call the same function later; nothing in Settings › Areas and
hazards changes with it.

- **Signals, read without running the repository.** `Git.survey` reads the tracked files at HEAD
  (`ls-tree -r -z --name-only`) and the files of the latest 400 commits (`log --name-only -z`, no merges, no
  renames, no external diff, no textconv, no mailmap, no signature check, `HEAD --` so no path is ever
  read as a revision). That is git's object store only: no file of the
  checkout is opened, no hook, filter, pager, fsmonitor, `diff.external` or `gpg.program` the repository
  configures can run (`trust.test.ts` runs `survey` against each), and the call is unpinned
  like `Git.inspect`, so a folder only being looked at raises no trust card. A commit that changed over 200 files
  is left out of the history.
- **Candidates from structure** (`area-candidates.ts`, pure). A folder holding a manifest (`package.json`,
  `Cargo.toml`, `go.mod`, `pyproject.toml` and the like) is a unit: one candidate, never merged with another
  unit. A framework app with route groups (`app/(group)/…` or `pages/`) is split by group and, where a group
  holds at least three screens, by screen; its other top folders (`lib/`) stand beside them, and so do the
  other folders on the way to its routes (`src/components/` beside `src/app/`). Other folders with
  at least three files are candidates; what is left (top-level files, small folders) is one more. A repository
  that is one package is split by its top folders. Together the candidates hold every tracked file, and each
  file matches the globs of the candidate that holds it and no other; a test checks that over hundreds of
  layouts made at random. Node's matcher lets no `*` or `**` match a name that starts with a dot, so each
  file's glob comes from where its candidate holds it: below a folder held whole, `dir/**` takes the files
  with no dot name, `dir/**/.*` the dotfiles and `dir/**/.*/**` the files below one dot folder, at any depth.
  A file below a second dot name is taken from its last dot folder (`dir/.storybook/**/.*`), because the
  matcher never matches a dot name at the end of a pattern holding two `**`: `**/.*/**/.*` matches nothing.
  A folder name is taken literally (`literal-glob.ts`): each character glob syntax reads becomes a class that
  matches only itself, so a Next.js screen `[orgId]` gets `[[]orgId]/**`, not a class matching `o/`. Node's
  matcher reads a backslash as a separator, never an escape, and a project refuses one, so where no exact glob
  exists (a backslash, a stray bracket, braces holding a comma or `..`) those characters become `?`, which also
  matches a name differing only there. Because that `?` could match a sibling folder (`a?b/**` takes `axb/`
  too), and the guard allows a write when any matching area is claimed, candidates whose `?` globs match
  another candidate's files are made one candidate, so each file still lands in exactly one area.
- **Candidates merged by history.** Two folder or route candidates that changed together in at least four
  commits, and in at least three quarters of the commits of the one that changed less, are merged. A commit that
  touched more than four candidates says nothing about any pair. A commit's files are placed by the folders each
  candidate holds, not by matching globs, so a file the commit removed counts too, and each file costs a few
  map lookups. Both steps run on the daemon's event loop: for 100,000 files and 400 commits they take under a
  tenth of a second together, where matching every commit file against every glob took most of a second.
- **A model names and merges the candidates.** The daemon sends the default account's `haiku` one question
  (`SessionAdapter.complete`): the numbered candidates with their path, kind and file count, as text. The model
  runs in a new empty folder with no tool, no settings file, no MCP server and no saved session, after the same
  account check a session gets, and gives up after two minutes. Its JSON answer is checked, not trusted: every
  candidate in exactly one area, no two units in one area, names that are lowercase words and used once, a
  non-empty one-line reason. An area named like a default hazard (`harness`, `migrations`, `deps`) becomes
  `<name>-area`, since an area and a hazard may not share a name. Any other failure, or no model, leaves the
  candidates named from their paths (`structure`); the proposal never fails because the model did.
- **The builder edits the proposal in the add-project form.** Each area shows its name, its globs one to a
  line, and its reason. The builder renames, merges (an area into another), removes and adds areas, and Create
  Project waits for a valid list: names the project would accept, none repeated or taken by a hazard, every area
  with a valid glob, at least one area. The project is created with exactly that list. When the proposal fails
  the form starts from one area, `repo`, says so, and still lets the builder split it; a repository with no
  commit is proposed the same one area. Its globs are `WHOLE_REPOSITORY_GLOBS` in `@10db/contracts`: `**`,
  `**/.*` and `**/.*/**`, every file with at most one dot name in its path.
- **The builder never has to wait for the proposal, and a proposal nobody wants stops.** While areas are
  being proposed Create Project is enabled; using it drops the proposal and creates the project with the
  `repo` area. Choosing another folder, creating, or closing the form aborts the request, and the daemon
  aborts the model question with it (the request's signal reaches `AreaNamer` and `CompletionSpec.signal`),
  which stops the Claude Code process it started. The model has `NAMING_MS` (30 s) in the daemon before
  names come from paths; the form gives the whole proposal 45 s, then falls back to the `repo` area and says
  the proposal took too long.

- **One area is the catch-all, so a file added later has an area.** Proposed globs cover only the files that
  exist when the proposal is made, and glob matching has no negation, so a new package, app, top-level folder
  or first dotfile fell in no area and the guard refused it (found in review of PR #138). An area may carry
  `catchAll: true` (`AreaDef`, stored with the area, no migration). `classifyPath` puts a path in the
  catch-all only when no other area matches it, whatever the catch-all's own globs say, as CODEOWNERS falls
  back to its widest rule; a path with a `.git` part is in no area, the catch-all's included. A lane holding
  only the catch-all therefore cannot edit a file another area holds, and a lane holding another area cannot
  edit a file that falls through. A project has at most one (`atMostOneCatchAll`, checked on create, on patch
  and on a proposal) and a project with none classifies exactly as before, so the single `repo` area over
  `**` and every project made before this change are unchanged. The proposal marks the area that holds the
  rest candidate (the top of the repository and its small folders); that candidate is kept even when it holds
  no file yet, with the globs `*` and `.*`, so a repository of packages only still has a catch-all. If a
  model merges the rest into another area, that area is the catch-all. The form and Settings show a
  "Catch-all" checkbox on each area; choosing one clears the others, and clearing it leaves the project with
  none.

## Why

A project with one area covering every file makes every task in Your folder mode overlap every other, so
nothing runs in parallel, and splitting the repository by hand takes knowing its seams. Structure is the
signal that is cheap and exact; history finds the folders that are really one piece of work. A model is good
at naming and at judging which small neighbours belong together, and is the only part that costs anything or
can fail, so it is a refinement with a checked answer and a fallback, not a dependency.

Turned down: running the repository's own tooling (a workspace listing from `pnpm` or `cargo`) to find
packages, since that runs code from the repository; reading the checkout's files, which a lane could have
written; letting the model write globs, which would make a bad answer a wrong claim on files; a single
`**` area with a hint in the form, which leaves the builder to find the seams.
