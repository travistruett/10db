# The Conventional Commit scope is optional; the scope list stays

- **Date:** 2026-10-28
- **Supersedes:** the "scope required" part of governance decision G2 (`docs/architecture/decisions.md`)

## Decision

`commitlint.config.js` no longer sets `scope-empty: never`. `feat: add area editing` and
`feat(desktop): add area editing` both pass; `feat(random): ...` still fails, because `scope-enum` keeps
the list `daemon`, `desktop`, `contracts`, `db`, `harness`, `repo`, `ci`, `docs`, `deps`. The type is
still required and still comes from `@commitlint/config-conventional`. The `commit-msg` hook and the
`policy` job's pull request title check apply the same rules.

## Why

release-please reads the type to pick the version bump and ignores scopes (`release-please-config.json`).
The scope bought only a tidier log, yet 10db opens pull requests with a per-project title prefix, and a
forgotten scope blocked merges. Turned down: dropping the scope list as well, which would let a typo such
as `feat(dameon)` through; with the list kept, a scope that is given is still checked.
