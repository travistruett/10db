# apps/daemon/src/devices

Credentials for paired devices on the share listener.

- `tokens.ts`: a device token is `tdb_<deviceId>_<secret>`, the secret 32 random bytes in base64url. The secret may
  hold `_` and `-`, so `parseDeviceToken` cuts the id out by its fixed length (`dev_` plus a 36-character UUIDv7)
  and never splits on `_`. The database keeps only `sha256(secret)` as hex; `secretMatches` compares digests with
  `timingSafeEqual`.
- `pairing-codes.ts`: one open code, in memory only. `open()` replaces it; it lasts 5 minutes on the injected
  clock, is spent by a match, and is burned by the fifth wrong try. Every `attempt` first counts in a sliding
  minute shared by all callers; the 11th returns `RateLimited` before the code is read. Callers pass the code
  already normalised (`PairRequest` in `@10db/contracts`). Refusals are not told apart.
- `tickets.ts`: a stream ticket is 24 random bytes in base64url, held in memory with its owner for 30 s on the
  injected clock. `spend` deletes on any lookup, so a ticket refused for its listener is burned too; each `issue`
  sweeps the expired. There is no render scope: a render token never gets a ticket.
- `sockets.ts`: open sockets by owner. `closeDevice` closes with `4401 'device revoked'`, `closeListener` with
  `4410 'sharing stopped'`; closing removes the entry.
- `device-service.ts`: pairing, `authenticate`, `revoke`. An unknown id still runs `secretMatches` against a dummy
  hash so timing doesn't tell it from a wrong secret. `authenticate` writes `last_used_at` at most once a minute.
  `revoke` closes sockets after its write commits.
- Routes a device calls on itself: `DELETE /devices/me` (Forget This Device, the same `revoke`), `PUT` and
  `DELETE /devices/me/push` (`push/AGENTS.md`). They answer 409 to a caller that is not a paired device, and sit
  before `/devices/:deviceId` in `api/app.ts` so `me` is never read as an id. The pairing dialog on the Mac
  (`views/settings/pair-device-modal.tsx`) calls `POST /devices/pairing-code`, and closes when the devices list gains
  a device (`device.changed { change: 'paired' }` refetches it).
