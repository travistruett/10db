# Task 8: settings, placement, e2e and docs

**Size inside the plan:** Feature. **Read:** the index's brief and Global Constraints; spec §2, §12 "Tests" (4),
§14 "Decisions this records". Clear Settings and the placement control with the coordinator first (peer
ownership).

## Files

- Settings › Delivery (`apps/desktop/src/views/settings/**`, the delivery section): for local delivery, a
  **Separate copies** switch (`localCopies`) and a **Teardown command** field (`copyTeardownCommand`), saved through
  the page's one save bar; the contracts refine's message shows when the switch is on with no command.
- The task placement control: offers **Separate copy** for a local project with `localCopies` on, and shows the
  admission refusal's reason when the daemon refuses.
- `apps/desktop/e2e/loop.spec.ts`: extend the first test (its project is local delivery already).
- `docs/architecture/decisions/`: the five records spec §14 names, one file each, in the folder README's format.
- `AGENTS.md` notes in each directory the earlier cards touched, if they didn't write one.

## The e2e extension

In the existing flow, after its first task: turn **Separate copies** on and set a teardown command (a script in
the fixture repo that writes a marker file) through Settings; set the project's gate to a command that passes; put
a second task in a **Separate copy** from its placement control; run it with the fake adapter to verified done; then
assert, through the API and git in the fixture repo, that the task's commit is on the base only after its gate's
evidence exists, that the folder's files show it, that the copy's worktree is gone, and that the teardown marker
was written. A reload loses nothing.

## Tests

The e2e extension above (user-visible feature, `.claude/rules/testing.md`). No component tests.

## Done when

The e2e passes locally once (`pnpm --filter @10db/desktop e2e -- loop.spec.ts`) after card 6 has merged;
typecheck, lint, `make precheck`.
