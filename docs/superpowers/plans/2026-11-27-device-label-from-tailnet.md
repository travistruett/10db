# A paired device is named by its tailnet name

Size: Core (pairing, part of the auth surface), though the change is only the device's label. One task, about 80
lines, one pull request.

## Brief

**What changes for the builder.** A phone paired from now on is listed by its name on the tailnet (for example
`pixel-8`) instead of "Android phone" or "iPhone". Two Android phones no longer look alike in Devices and the bar's
Remote access card. Devices already paired keep their names.

**What it buys.** You can tell which device is which before you revoke one.

**What could go wrong, and how we'd know.**
- The lookup fails or is slow. Then the device gets the name the phone sent, as today. The lookup runs only after
  the code is accepted, waits at most 3 s, and never fails a pairing.
- A forged address names the device after another tailnet machine. Only the share listener's `X-Forwarded-For` is
  read: Tailscale Serve replaces a forged one (`sharing/AGENTS.md`, Serve facts). The address must be a Tailscale
  address before the CLI runs. A process on the Mac itself can still reach the loopback share port with a forged
  header, but that needs a valid pairing code too, and the worst it does is pick the label.
- A wrong pairing code costs a CLI run. It doesn't: a refused or rate-limited code is answered before any lookup.

**Calls the builder might disagree with.**
- The name is the tailnet's machine name, as `tailscale status` shows it, not a friendlier one.
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
 * The tailnet's name for the machine at `ip`: `Node.ComputedName`, else the first label of `Node.Name`. Null when
 * `ip` isn't a Tailscale address (100.64.0.0/10 or fd7a:115c:a1e0::/48), or the CLI fails, times out or answers
 * something that doesn't parse. It never rejects.
 */
export async function readTailnetName(run: TailscaleRun, ip: string, timeoutMs: number): Promise<string | null>;
```

`apps/daemon/src/devices/device-service.ts`:

```ts
// DeviceService
/** `peer` is the caller's tailnet address, when the request came through Serve on the share listener. */
pair(body: PairRequest, peer: string | null): Promise<PairResponse>;

// createDeviceService deps gain
readonly tailnetName?: (ip: string) => Promise<string | null>;
```

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
| No Tailscale CLI (`tailnetName` absent)                 | the client's label                            |

## Tasks

1. `task-1.md`: name a paired device by its tailnet name.
