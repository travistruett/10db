# Task 12: docs, the decision, and the final migration

Read the index's brief and Global Constraints first. Size: Core (the trust-boundary docs).

**Files:** a new decision in `docs/architecture/decisions/`, named `2026-11-25-a-shared-mac-answers-on-its-tailnet-address` (the
decisions README gives the format), `docs/architecture/03-trust-boundaries.md` §4.1 and §4.2, `docs/security.md`
("One macOS user"), `apps/daemon/AGENTS.md` and `apps/desktop/AGENTS.md` (their loopback lines),
`tests/repo/src/dev-ui-origin.test.ts` if it must learn the share listener's list,
`packages/db/drizzle/` (regenerated).

**The decision** amends `2026-10-29-dev-ui-over-the-factory.md`: the dev UI's origin stays loopback; the share
listener, behind `tailscale serve` on the tailnet only, accepts the tailnet origin and the desktop's origins for
device tokens only; the main listener gains a Host check. It records the calls in the spec's brief (no token
expiry, any device can pair, the phone's token in `localStorage` for slice 2) with their costs.

**Docs** say a shared Mac answers its tailnet through `serve`, to device tokens only, and that the daemon still
binds only `127.0.0.1`. Name the auth matrix's file.

**The migration, last:** merge `main` into the integration branch for the final time, run `gh pr list --state
open` and check no other open PR adds a migration, then (the coordinator runs this; a subagent's git guard denies it) `git checkout --no-overlay origin/main -- packages/db/drizzle`, check `git status` shows the placeholder deleted, (nothing
in `drizzle/` is edited by hand) and `pnpm --filter @10db/db generate` once. Commit, then `make precheck`.

**Tests:** none new; `tests/repo` runs in precheck.

**Spec:** §8.
