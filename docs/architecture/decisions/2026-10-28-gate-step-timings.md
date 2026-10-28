# The gate's summary line gives every step's seconds

- **Date:** 2026-10-28
- **Amends:** the M0 plan's gate summary line
  (`docs/superpowers/plans/2026-10-13-10db-01-m0-scaffold.md`, "`make gate`, which prints exactly one final
  line")

## Decision

`scripts/gate.sh` times each step it runs and lists every step in the order it ran, joined with `·`, in
its one summary line. A step that ran shows its whole seconds (`lint 31s`) whether it passed or failed; a
skipped step shows why (`rust skipped`, `e2e skipped (sandboxed)`). The run's total stays last, in
parentheses:

```text
GATE PASS format 4s · lint 31s · typecheck 22s · … · rust skipped (210s)
GATE FAIL: test — logs in .gate/; format 4s · lint 31s · test 92s (127s)
```

The line still starts `GATE PASS` or `GATE FAIL: <failed steps> — logs in .gate/`, and the exit code is
unchanged. An unknown step (`unknown-step:<name>`) is listed among the failures and has no time.

## Why

Nobody could say which step made the gate slow: the script didn't time its steps, and CI prints the
`.gate/*.log` files only when the gate fails. Every 10db lane runs its project's gate before a task is
done, so the gate's length is a floor on every task, and speeding it up has to start from numbers. Putting
the times in the line that is already printed shows them in CI's gate step and in every local run with no
extra step, file or click. Failed steps keep their time because a step that hangs into a timeout is one
of the cases worth seeing.

The consumers keep working: AGENTS.md, CONTRIBUTING.md and the PR template look for the `GATE PASS`
prefix, the daemon's gate runner reads the exit code and keeps a raw tail
(`apps/daemon/src/verify/gate-runner.ts`), and `tests/repo/src/gate.test.ts` pins the format. A separate
timings file was turned down: the gate's tests expect `.gate/` to hold only step logs, and a file nobody
opens shows nothing.
