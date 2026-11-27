# Task 1: name a paired device by its tailnet name

Read the index's brief and Global Constraints first. Size: Core (pairing).

**Files:** `apps/daemon/src/sharing/tailscale-cli.ts` (and its test file), `apps/daemon/src/devices/device-service.ts`,
`apps/daemon/src/api/app.ts` (the pair route), `apps/daemon/src/daemon/start.ts` (where `createDeviceService` is
built: pass `tailnetName` with the same `TailscaleRun` sharing uses), `apps/daemon/src/sharing/AGENTS.md` or the
devices module's note, one line. Any other caller of `devices.pair` (tests, `request-path.test.ts`) awaits it.

**Implements** (from the index's Interfaces, exactly): `readTailnetName`, `DeviceService.pair(body, peer)` and the
`tailnetName` dep.

**State-table rows:** all of them.

**Notes**

- In `pair`, the order is: the fqdn check, the code attempt (refusals throw as today), then the name lookup, then
  `insertDevice`. The lookup comes after the code is spent, so a wrong code never runs the CLI. The insert stays one
  write.
- `tailscale whois --json <ip>` is the command. `Node.Name` is the MagicDNS name with a trailing dot. Parse only
  `Node.ComputedName` and `Node.Name` with zod, both optional strings; an empty name counts as none.
- The Tailscale address check is a pure function. Accept IPv4 in 100.64.0.0/10 and IPv6 in fd7a:115c:a1e0::/48, and
  nothing else (no host names, no ports, no brackets).
- Cut the name to `DEVICE_LABEL_MAX` before it is saved.
- The route reads the header only on the share listener; on the main listener the header is whatever the client
  sent.

**Tests:**
- One pure table test of the Tailscale-address check (it's a parser at a trust boundary): inside and outside both
  ranges, edge addresses, junk.
- One test of `readTailnetName` with a fake `TailscaleRun` (a child process we don't own): a name, a timeout, junk
  output.
- No route test: the pair route's existing tests must still pass with the await.
- The commit carries a value card (`why_new=pairing`).

**Spec:** the 2026-11-27 hand-off's §3.4 facts, in the index's brief.
