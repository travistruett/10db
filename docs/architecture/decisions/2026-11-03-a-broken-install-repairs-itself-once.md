# A broken install starts over and installs once more by itself, and raises a card only if that is broken too

- **Date:** 2026-11-03
- **Amends:** `2026-11-03-a-broken-install-is-not-a-failed-gate.md` (what a broken install before a gate does first)

## Decision

- **One automatic recovery.** In the base update's install (`base-update.ts` `install`), when an install leaves the
  copy's packages unresolved, 10db removes `node_modules` and installs again (`refresh` with `startOver`, which
  removes `node_modules` whatever its state), then checks again. If the packages now resolve, the step goes on: the
  gate starts, or the shipping gate runs, with no card and no attempt counted. The same code serves the task's
  gate and the shipping gate, since both call `beforeGate`.
- **The check after the second pass reads the copy.** When `refresh`'s retry after a failed install already
  was the second install, there is no second pass and the result is reported as it is. Otherwise `install` calls `checkInstall` itself, whatever the second
  pass answered: that pass can throw, or skip its own check when a failed first install took `node_modules` and the
  recorded lockfile with it. Only a whole copy goes on. A second install that exits non-zero with every link whole
  counts as repaired: the packages resolve, the gate runs with the failure in its note, and the next gate installs
  again, as it does for any first install that fails that way.
- **Only a second broken install in a row is reported.** When the copy is not whole after the second pass, `beforeGate`
  answers `install_broken` exactly as before, so the runner's `install_broken` failure and card and the shipping
  gate's `BatchFailure.InstallBroken` card are unchanged. Its note says what ran (`installsSaid`), from the count
  of installs over both passes and whether one removed `node_modules`:
  - none ran: "No install ran, so node_modules is as it was" (the reason follows, e.g. no trustworthy pnpm);
  - one ran: "10db installed from the lockfile and that install did not bring them back", or, when it removed
    `node_modules` first, "10db removed node_modules and installed from the lockfile, and that install did not
    bring them back";
  - two ran: "10db installed from the lockfile and then installed again by itself, and neither install brought
    them back", or, when one removed `node_modules`, "... installed from the lockfile, then removed node_modules
    and installed again by itself, and neither install brought them back".
- **A gate runs two installs at most.** `refresh` already starts over once when its install fails and leaves the
  copy broken, and deliberately does not after a timeout (it would only wait again) or a refused host (the same
  refusal would come back). `installOnce` marks a failed install `final`, and `install` reports it as it is: a
  timeout or a refused host raises the `install_broken` card without a second install, and any other failure
  runs at most two installs in one gate (`refresh`'s own pair), not four. The same holds when `refresh`'s start
  over exits zero and the copy is still broken: that result is `installed` with two installs, not `final`, but
  the gate's second pass would be the same install from nothing a third time, so `install` reports it as it is
  (no third install). The one case that skips the second pass is `refresh`'s retry after a failed install
  (two installs). A copy that is broken on arrival is different: `refresh` starts over before installing
  (`node_modules` removed, one install), and if that install exits zero and the copy is still broken the gate's
  second pass still runs, which is two installs. `refresh` adds no retry of its own to a start over it was asked
  for, since that install already is the start over from nothing.
- **History.** A repaired install leaves the batch notice `install-repaired` (`installNotices.repaired`): the drawer
  shows "The install in this copy was repaired at <UTC time>", and its body names what was unresolved. Both repairs
  leave it: the gate's second pass, and `refresh`'s own start over after a failed install left the copy broken.
  `refresh` reports what that install left as `leftBroken`, and `recordInstall`, which every caller of `refresh`
  runs, writes the notice when the copy is whole afterwards, so a repair at the cut, in Retry's repair and in
  `install_dependencies` leaves it as the install before a gate does. A retry that exits non-zero with every
  package resolved leaves it only before a gate, the one caller that goes on then (`goesOnAfterFailure`), with the
  failure in the gate's note. The others stop on that failure, so no repair reached anything: the cut refuses and
  its batch is gone, Retry's repair drops the copy, and `install_dependencies` tells the lane the install failed.
  A copy `refresh` starts over before its first install, because it was already broken, leaves no notice when that
  install brings it back: nothing failed. The next repair replaces it with its own time. The time is the delivery
  context's clock. The notice is history, not a
  wait: the desktop's `taskHistory` (`task-state.ts`) keeps listing it in the drawer after the run failed or
  the batch closed, was abandoned or had its pull request merged, when `taskNotices` drops the batch's notices.
  The card's state line does not show it then.

## Why

On 2026-11-03 every Retry on an `install_broken` card succeeded, so the card only added a wait for a person
without telling 10db anything it could not do itself. The Retry did what the recovery now does: the next gate
checked the copy, started over and installed. A second broken install in a row is evidence that a rerun will not
help, which is what a card for a person is for.

Reading the first install's result inside the same gate, not rerunning the whole step from the runner, keeps one
code path for the verify and shipping gates and spends no attempt, event or gate slot on the repair.
