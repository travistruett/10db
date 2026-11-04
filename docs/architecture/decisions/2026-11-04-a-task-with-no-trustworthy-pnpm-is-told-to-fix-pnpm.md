# A task stopped with no trustworthy pnpm is told to fix pnpm before Retry, under its own failure kind

- **Date:** 2026-11-04
- **Amends:** `2026-11-03-a-broken-install-repairs-itself-once.md` (what a task's `install_broken` stop tells the builder)

## Decision

- **A separate failure kind.** When the base update answers `install_broken` with `noPnpm` (`refresh` found no
  trustworthy pnpm and ran no install), the runner fails the workstream with `WorkstreamFailure.NoPnpm`
  (`no_pnpm`). Every other `install_broken` answer keeps `WorkstreamFailure.InstallBroken`. The failure reason is
  the note, as before, and no attempt is counted.
- **The failure line.** The desktop's `failureLine` says, for `no_pnpm`, that 10db found no trustworthy pnpm to
  install the packages, and in place of the Retry half tells the builder to fix pnpm on the login shell's PATH
  before a Retry (a Retry meets the same refusal until then), and to restart 10db after a PATH change. It never
  says Retry installs. `install_broken` keeps "Retry installs the packages again, then runs the X step again."
  The Board card, the drawer and Factory rows all take this line.

## Why

The batch ship card already said this (`shipCards.installBroken`), but a task's failure carried only the kind,
and the desktop cannot tell the cases apart without one. A kind needs no schema change: `workstreams.failure_kind`
is a text column and `failureLine` already gives a kind it does not know the generic line.
