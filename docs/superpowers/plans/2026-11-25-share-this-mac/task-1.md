# Task 1: contracts

Read the index's brief and Global Constraints first. Size: Core (part of the auth surface). No tests: these are
schemas, and the tests that read them come with the tasks that use them.

**Files:** `packages/contracts/src/ids.ts`, `protocol.ts`, `health.ts`, `events.ts`, new `sharing.ts`, new
`devices.ts`, new `stream-ticket.ts`, `index.ts` (exports); `packages/contracts/generated/` by its generator only.

**Implements** (quote them exactly from the index's Interfaces): the `ids.ts` additions (`Device`,
`PushSubscription`), `PROTOCOL_VERSION = 16`, everything under `sharing.ts`, `devices.ts` and `stream-ticket.ts`,
`HealthPublicResponse`, and the two `EventType` members with their data schemas registered wherever
`events.ts` registers event data today (follow `SlackConnectionChanged`).

**Notes**

- `PairRequest.code` is normalised by a `.transform` in the schema itself: upper-case, drop `-` and whitespace,
  map `I` and `L` to `1` and `O` to `0` (Crockford's reading rules). Callers compare the normalised value.
- `HealthResponse` keeps its shape; the desktop's poll parses it as today, because the poll sends its token.
- Regenerate the generated contract files the way `packages/contracts/AGENTS.md` (or its package script) says;
  `make gate`'s drift check fails otherwise.
- Bumping the protocol makes a running desktop see a mismatch until it reloads; that is expected.

**Spec:** §2 (Shape on main), §4.4, §5.
