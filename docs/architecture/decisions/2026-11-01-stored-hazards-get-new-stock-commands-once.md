# Stored hazard lists get each new revision of the stock commands once

- **Date:** 2026-11-01

## Decision

A project stores the hazard list it was added with, so a command added to `DEFAULT_HAZARDS` later never
reached it: projects added before #202 had no `bun add`, `yarn remove`, `pnpm ci` and the rest, and in
auto mode those commands went to Claude Code's classifier instead of a card.

- `STOCK_HAZARD_REVISIONS` (`packages/contracts/src/entities.ts`) lists the commands each release added to
  the stock hazards after the first, oldest first, keyed by hazard name: #108 and #202 so far. A contracts
  test checks that the first release's commands plus every revision are exactly `DEFAULT_HAZARDS`, so a
  command added there without a new revision fails the test.
- `addStockHazardCommands` (`packages/db/src/store/stock-hazards.ts`) runs at each daemon start, after the
  migrations. It adds the commands of every revision the database has not had to each project's stored
  hazard of the same name, after the commands already there, and records the count in the app setting
  `hazards.stock_revision`. Once that count is the latest, it does nothing.
- A database that never recorded a count works out each project's from its list: the latest revision any
  of whose commands the list holds. A project added after #202 holds some of #202's commands, so a command
  its builder removed is not added back.
- A command the builder removes after the step ran stays removed, since the step adds only revisions newer
  than the recorded count. A hazard the builder renamed, removed or added is left alone; whole hazards are
  never added.

## Update, 2026-11-08: globs, more stacks, container runners

- A revision is now `{ commands?, globs? }`, each keyed by hazard name, so a release can add stock globs
  too. `addStockHazardCommands` adds both, and the inferred count for an unrecorded database looks at both.
  The third revision adds the lockfile and manifest globs of npm, pnpm, yarn, bun, uv, Poetry, pip, Go and
  Bundler at any depth (`amps/frontend/pnpm-lock.yaml` was missed by the root-only `pnpm-lock.yaml`), the
  Alembic, Rails and Prisma migration folders, and the writing commands of uv, Poetry, pip, Go modules and
  Bundler, and the commands that create or apply migrations (Django, Alembic, Rails, Prisma).
- The guard reads `docker compose exec|run [flags] <service>`, `docker exec [flags] <container>`,
  `uv run`, `poetry run` and `bundle exec` as runners (`RUNNERS` in `guard/command-forms.ts`), so
  `docker compose exec -T backend uv lock` is the `uv lock` hazard command. A container runner's command
  may be another runner. A shell a runner chain runs (`docker compose exec backend bash -c '…'`) has
  its `-c` script and here-strings judged, scanned and matched like a shell heading the line.
- A preview flag needs no hazard claim only on the command whose program reads it as one, after that
  command's words (`PREVIEWS` in `guard/command-forms.ts`: `makemigrations --dry-run`, `migrate
--check|--plan`, `uv lock|sync --check`, `npm install --dry-run`, `cargo add|update --dry-run`,
  `pip install --dry-run`, `poetry … --dry-run`, `rake --dry-run`). A package manager script gets the
  flag as an argument (`pnpm db:migrate --check` still needs the claim), npm reads an unknown flag as
  a setting, and Django before 4.2 writes the migrations on `makemigrations --check`. Read-only
  commands such as `go mod verify` and `showmigrations` are not on a hazard's list.
- The hook's "hazard program followed by an expanding word" ask is skipped when the literal words
  before the expansion can begin no hazard command in any plain reading (runners unwrapped), no word
  before it re-reads its arguments as shell (`watch`, `sh`, `xargs`), and the command after a runner
  chain is no wrapper or interpreter without its script (`uv run env $x`, `uv run node $F` still ask).
  So `python -m pytest tests/*.py` and `go test ./... -run $T` run with no card, while `python
manage.py $x`, `uv run $x` and `go mod $x` ask. JS package managers keep the narrower pnpm reading
  of dec_01a1999a, since their subcommand words are rewritten (`pnpm run x` is `pnpm x`).

## Why

- Reading the defaults plus a project's own additions at each read can't keep a builder's removal without
  storing the removals, which is a schema change and an edit model the Settings page doesn't have.
- A SQL migration that merges one set of commands works once, and every later default would need another
  hand-written migration in SQLite's JSON functions. The revision list keeps one place to add to and is
  checked by a test.
- One count for the database is enough: every project added after the step runs gets the full defaults
  from `ProjectInput`, and the step runs before the daemon serves any request.
- The guess for an unrecorded database is wrong only for a list from which the builder removed every
  command of its newest revision; that list gets them back once.
