# An area is a page or shared, and a page may name its route; two pages may not share a file

- **Date:** 2026-11-09
- **Amends:** `decisions/2026-10-29-propose-areas-from-the-repository.md`

## Decision

`AreaDef` (`packages/contracts/src/entities.ts`) gains two optional fields, stored with the area in
`projects.areas`, so no migration:

- `role`: `page` (a screen of the project's app) or `shared` (code many pages use: components, global styles,
  public files). Absent, the area behaves exactly as before; nothing reads `role` yet but the checks below.
- `route`: on a page only, the path in the app that shows it (`/people`). A page with no single path (a
  dynamic screen, a route group of a few screens) has none. A route starts with `/` and holds no space or
  control character.

**Checked where areas are saved.** `areaRolesProblem` (`packages/contracts/src/page-areas.ts`) refuses a route
on an area that is not a page, and two page areas that can share a file, naming both and a glob of each. Both
`ProjectInput` (create) and `ProjectPatch` (Settings) run it, so the daemon answers 400; the add-project form
and Settings › Areas and hazards run it too before sending. A page may overlap a shared area, and a catch-all
page overlaps nothing, since the catch-all holds only files no other area matches.

"Can share a file" is judged from the globs alone (`globsOverlap`, `packages/contracts/src/glob-overlap.ts`),
so a file added later counts too. It reads a glob as the guard's `areaMatches` does: `*`, `?` and classes take
dot names, a `**` at the end takes at least one name, and accents are composed (NFC) and case folded, as the
guard folds a path. What it cannot read exactly it reads wider (an extglob is any one name, a class holding a
POSIX class any character, a brace range `*`), so it can refuse two pages that do not really meet, never pass
two that do.

**The proposer proposes a role and a route.** Only a framework app split by route group and screen
(`area-candidates.ts`) gets roles. This changes the split of `decisions/2026-10-29-propose-areas-from-the-repository.md`
in one place: a plain route folder beside the route groups (`app/login/` beside `app/(app)/`) is a screen of
its own, with every folder below it, as a screen inside a group is; it was part of the app's candidate. Each
screen is a page when a page file (`page.tsx`, `.jsx`, `.ts`, `.js`, `.mdx` or `.md`) is in it or below it, its
route its folders below the route folder with route groups left out (`app/(product)/app/memos` is
`/app/memos`); a dynamic screen (`[id]`), a parallel route slot (`@modal`), an intercepting route
(`(.)photo`) or a path no route can be (one with a space) is a page with no route; a private folder among the
screens (`_parts`) is shared; a route group too small to split is one page with no route. A screen or small
group with no page file (route handlers, `api/`) has no role: it is neither a screen nor code pages share. The
app's own files (the root layout), a group's own files (its layout) and the folders beside the routes are
shared. Every other candidate has no role. Merged
candidates, by history or by the model, keep a role all members share and lose the route. The model is asked
to keep each screen on its own.

**The builder sets them.** The add-project form and Settings › Areas and hazards show each area's role (No role,
Page, Shared) and a page's route, and send exactly what the builder left. A route is kept in the form while the
role changes and sent only for a page. Merging two areas in the form keeps the role both have, and drops the route.

## Why

The Workbench (`docs/superpowers/specs/2026-11-09-10db-workbench-design.md` §7) holds a page for a task's life
and a shared area one turn at a time, and opens a page by its route. A file under two pages would belong to two
tasks at once, so the overlap is refused where the areas are made, not first found when a pass opens. Judging it
from globs rather than from the repository's files catches a file added later and needs no git read in the
schema, which the UI shares.

Turned down: checking overlap against the tracked files at save time, which misses files to come and needs
the daemon; giving every proposed folder a role, when only a framework's routes say what a screen is; refusing
a page with no route, which the bundled areas of a real project need until they are split.
