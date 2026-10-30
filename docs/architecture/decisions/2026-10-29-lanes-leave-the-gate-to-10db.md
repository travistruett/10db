# Lanes leave the gate to 10db, and the fix brief names the failing step

- **Date:** 2026-10-29
- **Amends:** `decisions/2026-10-28-gate-step-timings.md` (the gate's output gains a line per failing step)

## Decision

An agent in a 10db lane never runs the full gate. Its brief tells it to run only the checks for what it
changed (the changed packages' tests, typecheck and lint) and to end its turn once the criteria are met and
committed; 10db runs the gate after the step. Root `AGENTS.md` keeps "done means `make gate` printed
`GATE PASS`" for contributors working by hand and says lanes leave the gate to 10db.

`scripts/gate.sh` prints one line per failing step before its summary line, naming the command that reruns
that step and its log:

```text
FAILED test: pnpm test (log .gate/test.log)
GATE FAIL: test — logs in .gate/; format 4s · lint 31s · test 92s (127s)
```

The summary line stays last and unchanged. The fix brief after a failed gate reads those lines
(`apps/daemon/src/briefing/failed-steps.ts`) and names each failing step, its command and its log; a gate
whose output has none gets a brief that points at the output and says to rerun only the check that failed.
No brief, harness skill or default persona tells an agent to run the gate (the `test-first` skill the default
Implementer uses said to); `apps/daemon/src/briefing/briefing.test.ts` and `packages/harness/src/harness.test.ts`
fail if one does.

## Why

Lanes ran `make gate` themselves, then 10db ran it again: about seven minutes of CPU each on a Mac already
running two lanes and their gates. The instructions disagreed: the lane brief said 10db runs the gate, root
`AGENTS.md`, which every agent reads, said done means `GATE PASS`, and the fix brief without evidence said
"The gate failed. Run it". The fix brief with evidence gave only the gate's tail, so the agent had to work
out which step failed and how to rerun it, and the easy answer was the whole gate again.

The failing-step line is plain text the gate already knows, so any project's gate can print it; the daemon
parses only that line and falls back to the raw output, so a project whose gate prints something else loses
nothing. Parsing the summary line's step names was turned down: it gives names, not commands, and a name
means nothing outside 10db's own gate.
