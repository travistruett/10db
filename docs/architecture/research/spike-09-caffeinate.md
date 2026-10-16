# Spike 09: `caffeinate -w` is tied to the daemon's process

- **Status:** VERIFIED
- **Date:** 2026-10-15
- **Versions:** claude 2.1.300 (Claude Code) · Agent SDK 0.3.299 · Node v25.2.1
- **Command:** `pnpm --dir spikes/agent-sdk spike:09`

## Question

`caffeinate -w` tied to the daemon's process.

## Result

A holder process (standing in for the daemon) spawned `/usr/bin/caffeinate -i -w <its own pid>` as its own child.
While the holder lived, `pmset -g assertions` listed a `PreventUserIdleSystemSleep` assertion named
`"caffeinate command-line tool"` for the caffeinate pid. When the holder was killed, the orphaned caffeinate
exited by itself and the assertion was gone: after 51 ms on SIGTERM and 50 ms on SIGKILL. No model call.

## Evidence

```
INFO SIGTERM: assertion line: pid 68810(caffeinate): [0x0022f54b0001a4ff] 00:00:01 PreventUserIdleSystemSleep named: "caffeinate command-line tool"
PASS SIGTERM: assertion held while the holder lives: present
PASS SIGTERM: orphaned caffeinate exits by itself after the holder dies: 51ms
PASS SIGTERM: assertion released: absent after exit
INFO SIGKILL: assertion line: pid 68872(caffeinate): [0x0022f54c0001a500] 00:00:01 PreventUserIdleSystemSleep named: "caffeinate command-line tool"
PASS SIGKILL: assertion held while the holder lives: present
PASS SIGKILL: orphaned caffeinate exits by itself after the holder dies: 50ms
PASS SIGKILL: assertion released: absent after exit
RESULT 09-caffeinate: no failures
```

## Consequence for M1

M1b keep-awake spawns `caffeinate -i -w <daemon pid>` when the first lane becomes active and kills it when the
last lane ends. A daemon crash, including SIGKILL, releases it automatically (about 50 ms), so recovery needs no
cleanup.
