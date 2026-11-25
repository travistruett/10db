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
