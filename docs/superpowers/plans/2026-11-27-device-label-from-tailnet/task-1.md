# Task 1: name a paired device by its tailnet name

Read the index's brief and Global Constraints first. Size: Core (pairing).

**Files:** `apps/daemon/src/sharing/tailscale-cli.ts`, a new `apps/daemon/src/sharing/tailscale-cli.test.ts`, `apps/daemon/src/devices/device-service.ts`,
`apps/daemon/src/api/app.ts` (the pair route), `apps/daemon/src/daemon/start.ts` (where `createDeviceService` is
built: the `tailnetName` closure the index's Interfaces describe), `apps/daemon/src/sharing/AGENTS.md` or the
devices module's note, one line. Every caller of `devices.pair` awaits it: `request-path.test.ts`'s `pair()` helper (about 17 uses) and anything in
`apps/daemon/scripts/acceptance-checks.ts`.

**Implements** (from the index's Interfaces, exactly): `readTailnetName`, `DeviceService.pair(body, peer)` and the
`tailnetName` dep.

**State-table rows:** all of them.

**Notes**

- In `pair`, the order is: the fqdn check, the code attempt (refusals throw as today), then the name lookup, then
  `insertDevice`. The lookup comes after the code is spent, so a wrong code never runs the CLI. The insert stays one
  write.
- `tailscale whois --json <ip>` is the command. Checked on this Mac against the paired Android phone:
  `Node.Hostinfo.Hostname` is "Travis's S26", `Node.ComputedName` is `travis-s26`, and `Node.Name` is
  `travis-s26.<tailnet>.ts.net.` (trailing dot). Parse only those three with zod, all optional strings; an empty
  name counts as none. Catch `JSON.parse`. Record these fields in `sharing/AGENTS.md`'s Serve facts.
- `pair` catches a rejected `tailnetName` and uses the client's label.
- The Tailscale address check is private to `tailscale-cli.ts` (`node:net` `isIP` and a `BlockList`): IPv4 in
  100.64.0.0/10 and IPv6 in fd7a:115c:a1e0::/48, nothing else (no host names, ports or brackets).
- Trim the name and cut it to `DEVICE_LABEL_MAX`; empty counts as none.
- Check `apps/desktop/src/served/this-device.tsx`: if the phone's own page shows a label it stored at pairing rather
  than the server's, say so in the PR (no change needed in this task).
- The route reads the header only on the share listener; on the main listener the header is whatever the client
  sent.

**Tests:**
- One table test of `readTailnetName` in `tailscale-cli.test.ts`, with a fake `TailscaleRun` (a child process we
  don't own) that records whether it ran: addresses inside and outside both ranges, edge addresses and junk (no run,
  null); a whois answer with a Hostname, with `localhost`, with only `Name`; a timeout; junk output.
- One case in `request-path.test.ts`, which drives the share listener through the real pipeline: a pair with
  `X-Forwarded-For` saves the fake `tailnetName`'s name, and a wrong code never calls it. It fails if the lookup
  moves before the code check (the main listener never routes the pair, so the listener check has no test).
- The commit carries a value card (`why_new=pairing`).

**Before the PR:** pair the builder's phone against the dev daemon only if that's cheap; otherwise say in the PR that
the header's value through Serve is still unchecked.

**Spec:** the 2026-11-27 hand-off's §3.4 facts, in the index's brief.
