# One gate runs at a time on the machine

- **Date:** 2026-10-28

## Decision

The daemon holds one in-memory limiter of gate slots, shared by every gate it starts: a lane's verify gate
(`runner/runner.ts`) and a batch's ship gate (`delivery/ship.ts`) both call the one `GateRunner` that
`startDaemon` builds by wrapping the sandboxed runner with `limitGates` (`verify/gate-slots.ts`). The default is
1 slot; `TENDB_GATE_SLOTS` (an integer from 1 to 64, read by `env.ts`) sets `limits.gateSlots`. There is no UI
setting.

A gate asks for a slot before it starts and holds it until it has a verdict, on every exit path: pass, fail,
timeout, abort and throw. Waiting gates are served in the order they asked. The gate timeout is counted by the
gate runner from the moment the gate starts, which is after the slot is held, so waiting never spends it. An
abort while waiting removes the waiter and returns an aborted result without running the gate, which the
callers already treat as "shutdown or cancel stopped it".

A gate that has to wait says so: the wrapper logs `gate waiting for another gate to finish` with the number of
gates ahead, and the caller's `onWaiting` hook logs it with the workstream or batch id. The workstream stays
`VERIFYING` and the batch `SHIPPING`; no state, event or contract changed.

## Why

On 2026-10-28 several parallel `make gate` runs on one Mac pushed the load average past 100, and tests timed
out for no reason in the code. A gate runs a whole project's test suite, so two at once on a laptop is slower
than one after the other. The scheduler limits lanes per account (`maxLanes`), but lanes spend most of their
time waiting on a model, not on the CPU, and nothing limited gates: several tasks verifying together, or a
verify gate next to a ship gate, recreated the overload.

- **Why 1.** The failure that happened was two or more gates at once. A builder whose machine can take more
  raises `TENDB_GATE_SLOTS`; a slow default costs a wait, a fast one costs flaky timeouts.
- **Why machine-wide, not per project.** The scarce thing is the CPU, memory and disk of one Mac, which all
  projects share. A per-project limit would let three projects run three gates.
- **Why wrap the runner rather than change the sandbox or the callers.** One wrapper in the composition root
  covers both call sites and any future one, and leaves `sandbox/` alone.
- **Why a log line, not an event.** The UI shows a workstream as verifying and a batch as shipping, which stays
  true while waiting. A new event or field would need a contract change for a message the builder reads in the
  daemon log; a UI surface for it can follow when a builder asks.
- **Recovery.** The slots are memory only. A gate that waits has recorded no `gate_pid`, so recovery has no
  process to kill; it re-queues a `VERIFYING` workstream for a verify and re-runs a `SHIPPING` batch's steps,
  as for any gate that had not finished. A restart starts with every slot free, so none leaks.
