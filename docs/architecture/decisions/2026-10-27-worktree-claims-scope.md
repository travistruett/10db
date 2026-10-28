# Area claims are scoped to the batch in worktree mode

- **Date:** 2026-10-27

## Decision

`claims.scope` is the project id for hazards, and for areas in shared mode; in worktree mode it is the batch id
for areas. The unique index on active claims is `(scope, kind, name)`, and `acquireClaims` takes an optional
`areaScope` (areas use it when given, hazards always use the project). The scheduler's launch claims and
an agent's `request_claim` both take the scope from `claimScopeOf` (`delivery/checkout.ts`). The watcher watches each live
checkout and judges a write by the checkout it happened in; its claim holders for a path are the batch's
workstreams for areas and the project's for hazards, and stray-write cards fold per checkout.

The change is three migrations: `0003_worktree_mode` (the project and batch columns, the batch index,
`claims.scope text NOT NULL DEFAULT ''`), `0004_claims_scope` (a custom migration:
`UPDATE claims SET scope = project_id`) and `0005_claims_scope_index` (the index swap). The default `''` exists
only to add the column; `acquireClaims` always writes a scope.

## Why

Areas stop two lanes editing the same files in one checkout, and separate worktrees can't collide. Hazards name
shared resources (ports, a database, Docker) that a worktree doesn't duplicate, so they stay project-wide.
SQLite can't add a `NOT NULL` column without a default, and the new index must exist only after the backfill,
or two projects holding the same hazard name would collide, hence three migrations.
