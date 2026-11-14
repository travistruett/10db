# Codex protocol types are generated from the pinned binary and checked by a stamp

- **Date:** 2026-11-12

## Decision

- `pnpm --filter @10db/daemon generate:codex` (`apps/daemon/scripts/codex-generate.ts`), run on a Mac, fetches
  and verifies the pinned Codex tarball through `ensureAgent` (the live tests' tools folder, checked against
  `CODEX_SHA512`) and runs `codex app-server generate-ts` and `codex app-server generate-json-schema` in a temp
  dir, with only `PATH`, `HOME` and `CODEX_HOME` set to that dir, so the generator never sees the builder's
  Codex home.
- It writes `apps/daemon/src/sessions/codex-generated/`:
  - `ts/`: the import closure of the three root unions (`ClientRequest`, `ServerRequest`,
    `ServerNotification`) and the responses 10db reads, copied byte for byte with `v2/` kept.
  - `schema/` and `fixtures/`: the per-type JSON schema and the sampled payloads (`sampleInstances` in
    `scripts/codex-samples.ts`) for each type `codex-protocol.ts` reads. A sample is a base instance and one
    instance per `oneOf`/`anyOf` branch, `type` list entry and `enum` value, with every other choice at its first
    option. It holds an object's required properties and those whose schema offers null, which is how the
    schema writes a Rust `Option` that serde sends as null.
  - `STAMP`: the Codex version and a sha256 over every other file in the folder.
  - It refuses to write any file over 1 MB, the pre-commit hygiene limit, and writes nothing then.
- The folder is checked in and never edited by hand. Prettier, ESLint and knip ignore it, and the repo's
  model-name scan skips it.
- The daemon's `drift` script (`scripts/codex-stamp-check.ts`), and so `make gate`, checks only that `STAMP`
  names `CODEX_VERIFIED_ON` and that its hash matches the folder. It never runs the binary.
- `codex-protocol.ts` stays the loose runtime validator. `codex-protocol.test.ts` holds it to the generated
  output two ways:
  - A type test checks that each generated type, with `bigint` read as `number`, is assignable to its runtime
    schema's input.
  - A fixture test checks that every sampled payload passes the generated schema (`z.fromJSONSchema`) and the
    runtime one, and that every `MODEL_ITEMS` name is an item type the pin has.
- Renovate's Codex PR note names `generate:codex`, since the drift check fails until the folder is regenerated
  for the new release.

## Why

- The hand-written types went stale. Codex 0.167.0 sends `{ type: 'gcp' }` for an account, which the hand union
  lacked, so the account read threw on a GCP home instead of refusing it as the wrong credentials.
- The pinned build is darwin-arm64, so it can't run in CI's Linux shards or a lane's gate. Checking a stamp lets
  every gate catch a pin bump with no regeneration, and a hand edit, an added file or a removed file in the
  folder, without the binary.
- Validating with `z.fromJSONSchema` at runtime was turned down: it is strict on objects, so a field a newer
  Codex adds would break a session, and it gives no static types (research T2 in
  `docs/architecture/research/2026-11-11-sessions-research.md`).
- codex-acp was turned down: it loses receipts and adds a second pin (research T2).
- The type test runs from the generated type to the runtime input, not from the runtime output to the
  generated type. That is the direction a tolerant reader needs. The other direction fails on every field 10db
  reads loosely, and misses a variant Codex adds.
- Fixtures are sampled from the generated schema, not recorded from a live session. A recording can't show a
  variant 10db's own account doesn't have, such as a GCP account. Sampling is deterministic, so the stamp
  covers the fixtures too.
- The sampler keeps a property that may be null. Sampling required properties only would leave out every
  `Option` field, and so `GetAccountResponse.account`, which Codex always sends. No fixture would then have held
  an account, and the `gcp` variant would have gone unseen. A field Codex leaves out instead (`field?: T` in
  the generated types) is caught by the type test.
