# The judge takes a copy's project commands as the copy's own

- **Date:** 2026-11-25

## Decision

A session that runs in a separate copy gets one more environment line in its `TrustPolicy`, `Separate copy:`
(`apps/daemon/src/trust/policy.ts`, from `buildTrustPolicy`'s `copyId`, which the runner reads from the copy's
journal row). The line tells every judge that reads `policy.environment` (10db's crosses-limit judge on every
provider, and Claude's auto mode) that:

- the session has its own folder, branch and databases, and every command it runs gets `TENDB_COPY_ID` with the
  copy's id;
- the project's own commands (make targets, scripts, copy wrappers) read the id and act on the copy's own
  databases and dev stack, those whose names hold the id, so running checks, tests, migrations and generators
  through them, preparing or resetting the copy's databases and taking its stack down with its volumes destroy
  nothing others have, and loading the dev config they read is not reading a secret;
- everything else on the Mac stays shared: a command naming another database, volume or compose project, and a
  `docker compose down -v` or `docker volume rm` without the copy's own name.

`LIMIT_QUESTIONS`' "Destroying Data It Didn't Create" `false` criterion counts the databases, volumes and
containers the session lines name as the session's own. Outside a copy no line names any, so nothing changes
there. A raw compose command in a copy must carry a project name that holds the copy id (`-p`) or go through a
project target; otherwise it is judged as reaching the builder's stack. `COPY_ID_VARIABLE` lives in
`@10db/contracts` beside `CopyId`, so `trust/` and `sandbox/` both name it.

## Why

In the first separate-copy pilot the judge refused a wrapper's `manage.py check` as reading secrets and
`make migrate`, a stack's `db-prepare` and its `down --volumes` as destroying data: it was told nothing about the
copy, so it judged them against the shared databases. The separate-copy spec
(`docs/superpowers/specs/2026-11-24-10db-local-copy-landing-design.md`) makes scoping a copy's databases by
`TENDB_COPY_ID` the project's contract; the judge now trusts that contract. A project whose target isn't
copy-aware would reach the shared database, which the contract rules out.

Compose names a project after the folder it runs in, and a copy's folders have the same names as the builder's,
so a plain `docker compose down -v` in a copy would take down the builder's stack. That is why only a name
holding the id counts as the copy's.

Turned down:

- A fast-path rule keyed on the wrapper's or a target's name. A rule keyed on names can't bound what the named
  program then runs, the same reason the fast path has no exception for a program in the checkout.
- Naming one project's database pattern in the line. The line names what holds the id, which every copy-aware
  project's names do.
