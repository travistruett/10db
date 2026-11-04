# A broken install starts over and installs once more by itself, and raises a card only if that is broken too

- **Date:** 2026-11-03
- **Amends:** `2026-11-03-a-broken-install-is-not-a-failed-gate.md` (what a broken install before a gate does first)

## Decision

- **One automatic recovery.** In the base update's install (`base-update.ts` `install`), when an install leaves the
  copy's packages unresolved, 10db removes `node_modules` and installs again (`refresh` with `startOver`, which
  removes `node_modules` whatever its state), then checks again. If the packages now resolve, the step goes on: the
  gate starts, or the shipping gate runs, with no card and no attempt counted. The same code serves the task's
  gate and the shipping gate, since both call `beforeGate`.
- **The check after the second pass reads the copy.** `install` calls `checkInstall` itself, whatever the second
  pass answered: that pass can throw, or skip its own check when a failed first install took `node_modules` and the
  recorded lockfile with it. Only a whole copy goes on. A second install that exits non-zero with every link whole
  counts as repaired: the packages resolve, the gate runs with the failure in its note, and the next gate installs
  again, as it does for any first install that fails that way.
- **Only a second broken install in a row is reported.** When the copy is not whole after the second pass, `beforeGate`
  answers `install_broken` exactly as before, so the runner's `install_broken` failure and card and the shipping
  gate's `BatchFailure.InstallBroken` card are unchanged. Its note now says that two installs did not bring the
  packages back.
- **A failed install is not started over again by the gate.** `refresh` already starts over once when its install
  fails and leaves the copy broken, and deliberately does not after a timeout (it would only wait again) or a
  refused host (the same refusal would come back). `installOnce` marks a failed install `final`, and `install`
  reports it as it is: a timeout or a refused host raises the `install_broken` card without a second install, and
  any other failure runs at most two installs in one gate (`refresh`'s own pair), not four. The second pass
  applies only to an install that exited zero and left the copy broken. `refresh` adds no retry of its own to a
  start over it was asked for, since that install already is the start over from nothing, so that path runs two
  installs as well. The card's note says only that the install did not bring the packages back when no start
  over happened.
- **History.** A repaired install leaves the batch notice `install-repaired` (`installNotices.repaired`): the drawer
  shows "The install in this copy was repaired at <UTC time>", and its body names what was unresolved. The next
  repair replaces it with its own time. The time is the delivery context's clock.

## Why

On 2026-11-03 every Retry on an `install_broken` card succeeded, so the card only added a wait for a person
without telling 10db anything it could not do itself. The Retry did what the recovery now does: the next gate
checked the copy, started over and installed. A second broken install in a row is evidence that a rerun will not
help, which is what a card for a person is for.

Reading the first install's result inside the same gate, not rerunning the whole step from the runner, keeps one
code path for the verify and shipping gates and spends no attempt, event or gate slot on the repair.
