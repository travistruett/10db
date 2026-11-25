# Task 4: tickets, the socket registry and the device service

Read the index's brief and Global Constraints first. Size: Core (credentials and revoke).

**Files:** new `apps/daemon/src/devices/tickets.ts`, `sockets.ts`, `device-service.ts`; `devices/index.ts`;
`devices/AGENTS.md`.

**Implements:** `TicketOwner`, `Tickets`, `createTickets`, `SocketLike`, `SocketRegistry`,
`createSocketRegistry`, `PairingRefusedError`, `SharingNotReadyError`, `DeviceService` (with `isActive`) and
`createDeviceService`, as quoted in the index.

**Rules**

- A ticket is 24 random bytes, base64url, held in a map with its owner and expiry (30 s on the `Clock`). `spend`
  deletes it on any lookup, so a ticket presented twice fails the second time even when the first was refused for
  its listener. Expired entries are swept on each `issue`. `TicketScope` has no render scope: a render token is
  never issued one.
- The registry maps sockets to owners. `closeDevice` closes every socket whose owner has that `deviceId` with
  `4401` and `'device revoked'`; `closeListener` closes every socket issued on that listener with `4410` and
  `'sharing stopped'`. Closing removes the entry.
- `pairingCode()` throws `SharingNotReadyError` unless `sharing().state` is `ready`; the URL is
  `${sharing().url}/app/pair#code=${code}`.
- `pair(body)`: `codes.attempt(body.code)`; `RateLimited` throws `PairingRefusedError` with `rateLimited: true`,
  `Refused` with `false`. On `Ok`, mint the token, `insertDevice` in one write, and answer once with the token and
  `host: { name, fqdn, port, protocolVersion }` (the name is the fqdn's first label).
- `authenticate(token)`: parse, `getDevice`, refuse a revoked or unknown device (for an unknown id, still run
  `secretMatches` against a fixed dummy hash, so the timing doesn't tell the two apart), then `secretMatches`. On a
  pass, call `touchDevice` only when `lastUsedAt` is null or at least 60 s old on the clock.
- `isActive(id)`: `getDevice` is present and `revokedAt` is null.
- `revoke(id)`: `revokeDevice` in one write, then `sockets.closeDevice(id)` after the write commits.

**Tests:** one, `tickets.test.ts`: a ticket spends once, fails after 30 s, and fails on the other listener. The
revoke path is tested on the real share listener in task 10. Value card:
`protects=a stream ticket works once, briefly, on the listener that issued it; fails_when=a ticket is reusable, outlives 30 s or crosses listeners; why_new=core: permissions; no_claim=revoke closing sockets`.

**Spec:** §5.1–§5.4.
