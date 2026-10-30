# Lanes run at utility priority, niced, not in the background

- **Date:** 2026-10-30
- **Amends:** `decisions/2026-10-30-lane-and-gate-priority.md`

## Decision

On macOS a lane's `claude` is launched as `nice -n 10 taskpolicy -c utility <claude> …` instead of
`taskpolicy -b <claude> …`. Its QoS is capped at utility, the same cap a gate gets, and it is niced by 10 so
that within that cap a gate (not niced) comes first. The order stays: the builder's apps, then gates, then lane
work. Off macOS nothing changes (`nice -n 19` for lanes, `nice -n 10` for gates).

## Why

Background QoS throttles disk and network as well as CPU. Within half an hour of installing the background
priority, three lane sessions failed with "Claude Code reported no account within 15 s", and each one paused
the whole account as signed out until the builder answered Resume, although the account was signed in. Timed on
the builder's Mac at a load average near 18, a minimal `claude -p` took 4 s at normal priority, 10 s under
`taskpolicy -b`, and 4 s under either `taskpolicy -c utility` or `nice -n 15`; a lane session also starts its
plugins, hooks and MCP servers, so background QoS pushed its start past the 15 s wait. Utility QoS still yields
the CPU to the builder's interactive apps, which was the point, without slowing the start.
