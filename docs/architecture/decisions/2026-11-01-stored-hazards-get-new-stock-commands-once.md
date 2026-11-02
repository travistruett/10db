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
