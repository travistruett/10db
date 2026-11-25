# Task 2: the devices tables, store and migration

Read the index's brief and Global Constraints first. Size: Core (data and credentials).

**Files:** `packages/db/src/schema.ts`, new `packages/db/src/store/devices.ts`, `packages/db/src/store/index.ts`,
`packages/db/drizzle/` (generated only), `docs/architecture/db-storage.md` (a new "Devices" entry).

**Implements:** the `devices` and `push_subscriptions` tables and every `store/devices.ts` function in the
index's Interfaces, with their doc comments as the contract.

**Notes**

- Columns follow `packages/db/AGENTS.md`: prefixed UUIDv7 ids, `created_at` and `updated_at` as ISO text.
  `token_hash` is the lower-case hex SHA-256 of the secret; the store never sees a token or a secret.
- Each function that changes a row emits its `device.changed` event in the same `WriteContext`
  (`ctx.emit({ type: EventType.DeviceChanged, entityType: 'device', entityId: id, data: { change } })`).
- `revokeDevice` deletes the device's `push_subscriptions` rows explicitly in the same write, rather than
  relying on the cascade, since the row stays.
- **The migration:** run `gh pr list --state open` and check that no other open PR adds a file under
  `packages/db/drizzle/`. If one does, stop and report it. Then `pnpm --filter @10db/db generate`, and commit the file so CI is green on the integration branch. It is a branch-only placeholder: task 12 restores `drizzle/` from main and generates once more after the final merge of `main`. Use a fresh `TENDB_DATA_DIR` for any by-hand run.

**Tests:** one, in `packages/db/src/store/devices.test.ts`, on a real temp database (`createTestStore`).
Insert a device, add a push subscription for it with a direct insert in the test (no store export for it in this slice), revoke it, and assert: `listDevices` drops it, `getDevice` keeps it
with `revokedAt`, its subscription is gone, a second `revokeDevice` returns false, and exactly two `device.changed` events were written (paired, then revoked; none for the second revoke). Value card:
`protects=a revoked device keeps no push subscription and leaves the list; fails_when=revoke forgets the subscriptions or emits twice; why_new=core: permissions and data; no_claim=the token check`.

**Spec:** §5.4, §6.
