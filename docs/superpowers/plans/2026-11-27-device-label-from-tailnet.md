# A paired device is named by its tailnet name

Size: Core (pairing, part of the auth surface), though the change is only the device's label. One task, about 80
lines, one pull request.

## Brief

**What changes for the builder.** A phone paired from now on is listed by the name Tailscale has for it (on this
tailnet the Android phone reads "Travis's S26") instead of "Android phone" or "iPhone". Two Android phones no longer look alike in Devices and the bar's
Remote access card. Devices already paired keep their names.

**What it buys.** You can tell which device is which before you revoke one.

**What could go wrong, and how we'd know.**
- The lookup fails or is slow. Then the device gets the name the phone sent, as today. The lookup runs only after
  the code is accepted, waits at most 3 s, and never fails a pairing.
- A forged address names the device after another tailnet machine. Only the share listener's `X-Forwarded-For` is
  read: Tailscale Serve replaces a forged one from an untagged peer (`sharing/AGENTS.md`, Serve facts; a tagged peer
  isn't recorded, and could already pick its label through the request body). The address must be a Tailscale
  address before the CLI runs. A process on the Mac itself can still reach the loopback share port with a forged
  header, but that needs a valid pairing code too, and the worst it does is pick the label.
- A wrong pairing code costs a CLI run. It doesn't: a refused or rate-limited code is answered before any lookup.

**Calls the builder might disagree with.**
- The name is the device's own name as Tailscale reports it (`Hostinfo.Hostname`), falling back to the tailnet
  machine name (`ComputedName`) when that is empty or `localhost`.
- No rename of devices paired earlier.

**Needed from the builder:** nothing.

## Global Constraints

- `.claude/rules/code-style.md` and `.claude/rules/testing.md`; zod at the CLI's output.
- Daemon: typecheck, lint and `vitest related` on the files changed. No migration, no contract change, no new
  dependency.
- Provider parity: pairing and Tailscale don't depend on the project's account; every provider behaves the same.
- Comments say what and why, timelessly.

## Interfaces

`apps/daemon/src/sharing/tailscale-cli.ts`:

```ts
/**
 * The name Tailscale has for the machine at `ip`: `Node.Hostinfo.Hostname` unless empty or `localhost`, else
 * `Node.ComputedName`, else the first label of `Node.Name`; trimmed, cut to `DEVICE_LABEL_MAX`, and null when
 * empty. Null too when `ip` isn't a Tailscale address (100.64.0.0/10 or fd7a:115c:a1e0::/48, checked with
 * `node:net`'s `isIP` and a `BlockList`, so nothing else, nor a value starting with `-`, reaches the CLI), or the CLI
 * fails, times out or answers something that doesn't parse. It never rejects.
 */
export async function readTailnetName(run: TailscaleRun, ip: string, timeoutMs: number): Promise<string | null>;
```

`apps/daemon/src/devices/device-service.ts`:

```ts
// DeviceService
/** `peer` is the caller's tailnet address, when the request came through Serve on the share listener. */
pair(body: PairRequest, peer: string | null): Promise<PairResponse>;

// createDeviceService deps gain
readonly tailnetName: (ip: string) => Promise<string | null>;
```

`pair` catches a rejection of `tailnetName` and treats it as null, so the lookup can never fail a pairing whose code
was accepted. In `start.ts`, `tailnetName` resolves the CLI the way sharing does on each call (the `cli` lambda at
the sharing wiring, hoisted so both use it) and returns null when there is none (not installed, or
`TENDB_TAILSCALE=off`, as in the e2e daemon); else `readTailnetName(createTailscaleRun(cli), ip,
TAILNET_NAME_TIMEOUT_MS)`, with `TAILNET_NAME_TIMEOUT_MS = 3_000` beside `readTailnetName`. A fallback logs one
debug line, "no tailnet name for the pairing device", never the address.

The route (`POST /devices/pair` in `api/app.ts`) passes `peer` from `X-Forwarded-For` (the last value, trimmed)
only when `listenerOf(c.env)` is `Listener.Share`, else null, and awaits `pair`.

## State table (design, not a test list)

| Pair request                                            | Label saved                                   |
| ------------------------------------------------------- | --------------------------------------------- |
| Code refused or rate-limited                            | none; no CLI run                              |
| Code accepted, main listener (no peer)                  | the client's label                            |
| Code accepted, share listener, peer not a Tailscale IP  | the client's label; no CLI run                |
| Code accepted, whois answers with a name                | the tailnet name, cut to `DEVICE_LABEL_MAX`   |
| Code accepted, whois fails, times out (3 s) or malformed | the client's label                            |
| CLI not found, or `TENDB_TAILSCALE=off`                 | the client's label; no run                    |
| `tailnetName` rejects                                   | the client's label                            |

The pair is no longer one synchronous step: the code is spent, the lookup waits up to 3 s, then the device is
inserted. What can happen in that gap:

| During the lookup                                     | Outcome                                                         |
| ----------------------------------------------------- | --------------------------------------------------------------- |
| The daemon shuts down or crashes                      | a clean shutdown closes the share listener first, so the lookup usually finishes and the row is inserted with no token delivered (a device to revoke); after a crash, or a lookup outlasting shutdown, the code is spent and there is no row. The builder opens a new code either way |
| Sharing stops, or the phone drops the request         | the row is inserted, the token never arrives: a device to revoke in Devices (the window grows from ~0 to 3 s) |
| The builder opens a new code                          | this pairing still completes with the code it spent             |
| The same code is posted twice                         | the second is refused: the code is spent before the wait        |

## Tasks

1. `task-1.md`: name a paired device by its tailnet name.
