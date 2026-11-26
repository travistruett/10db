# Task 3: device tokens and pairing codes

Read the index's brief and Global Constraints first. Size: Core (credentials).

**Files:** new `apps/daemon/src/devices/tokens.ts`, new `apps/daemon/src/devices/pairing-codes.ts`, new
`apps/daemon/src/devices/index.ts`, new `apps/daemon/src/devices/AGENTS.md` (the module note).

**Implements:** `mintDeviceToken`, `parseDeviceToken`, `secretMatches`, `PairAttempt`, `PairingCodes` and
`createPairingCodes`, as quoted in the index.

**Rules**

- A token is `tdb_<deviceId>_<secret>`, the secret 32 bytes from `crypto.randomBytes`, base64url (which may
  itself hold `_` and `-`). `parseDeviceToken` takes the `tdb_` prefix, then the id **by its fixed length**
  (`dev_` plus a 36-character UUIDv7, validated with `DeviceId.safeParse`), then one `_`, then the rest as the
  secret, which must be 43 base64url characters. Anything else returns null; it never throws.
- `secretMatches` hashes the presented secret with SHA-256 and compares the two 32-byte digests with
  `crypto.timingSafeEqual`.
- A pairing code is 8 characters from Crockford's alphabet, from `random` (default `crypto.randomBytes`) without
  modulo bias. It is held in memory only.
- `open()` replaces any open code. A code expires 5 minutes after `open()` on the injected `Clock`.
- `attempt(code)`, on the normalised code, in order: (1) count the try in a sliding minute shared by every caller;
  the 11th try within a minute returns `RateLimited` without reading the code; (2) no open code, an expired one,
  or a spent one: `Refused`; (3) a code that isn't 8 characters, or a mismatch (SHA-256 of both, compared with
  `timingSafeEqual`): count it as a wrong try on the open code, and on the fifth burn the code; `Refused`;
  (4) a match: spend the code; `Ok`.

**Tests:** one file, `pairing-codes.test.ts`, with the clock injected: a match spends the code (a second try with
it is refused); a fifth wrong try burns it (the right code is then refused); a too-long code counts as a wrong
try; the code is refused after 5 minutes; the 11th try in a minute is rate-limited before the code is read (the
right code on that try is still rate-limited, and works after the minute). One `tokens.test.ts` case: 200 minted
tokens each parse to their own id and match, and a token with one secret character changed, another device's id,
or a malformed shape does not. Value card:
`protects=pairing codes and device tokens accept only the right secret within their limits; fails_when=a limit or a comparison is loosened, or a secret holding '_' misparses; why_new=core: permissions; no_claim=the HTTP status codes`.

**Spec:** §1 R6 and R7, §5.1, §5.2.
