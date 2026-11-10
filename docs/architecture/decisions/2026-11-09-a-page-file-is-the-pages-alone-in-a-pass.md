# In a pass a file under a page area is the page's alone, even when a shared area or a held hazard also matches it

- **Date:** 2026-11-09
- **Amends:** `decisions/2026-11-09-an-area-is-a-page-or-shared.md`; sits beside
  `decisions/2026-10-29-per-copy-hazards-and-waiting-claims.md`

## Decision

For a lane in a Workbench pass (`GuardInput.inPass`), the judge (`apps/daemon/src/guard/judge.ts`) allows a
write to a path that matches a page area only when the lane holds that page. Holding a shared area that also
matches is not enough, and neither is holding a hazard that matches: the rule is checked before the judge's
allow for a held hazard. The denial names the page. Outside a pass the judge is unchanged.

Two tasks may not open a pass holding the same area, or two pages whose globs can share a file
(`passPagesProblem`, `packages/contracts/src/page-areas.ts`); saving two such pages was already refused. A page
may overlap a shared area. A task in a pass holds its pages, and any area with no role, for its life
(`passHeldAreas`); a shared area is never claimed when the pass opens.

The hold's record and the shared change, which also leave a page's files out, come with shared holds in a later
slice; the runner sets `inPass` once a pass's turns run there.

## Why

`classifyPath` lists every area whose globs match a path and the judge allows a write when any of them is held,
so a task holding a shared area for a turn could write another page's files, and its shared change would carry
them. In a pass a page's files belong to one task, which keeps its work and signs it off; nothing else may write
them. Narrowing every shared area's globs instead would make each project's areas depend on its routes' layout.

Turned down: applying the rule outside a pass, which would change what every built lane may write; refusing a
page that overlaps a shared area, which real projects' root layouts and component folders do.
