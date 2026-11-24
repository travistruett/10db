# Task 3: the copy id in every command

**Size inside the plan:** Core (sandbox; a wrong id reaches the folder's databases). **Read:** the index's brief
and Global Constraints; spec §4 "The copy id", §10 "Provider parity".

## Files

- `apps/daemon/src/sandbox/command-env.ts`: `COPY_ID_VARIABLE`, `withCopyId`.
- `apps/daemon/src/sandbox/env-allowlist.ts`: `TENDB_COPY_ID` in `ALLOWED_NAMES`.
- `apps/daemon/src/sandbox/lane-sandbox.ts`: `LaneSessionInput.copyId` (`:156`) and `TakeoverSandboxInput.copyId` (`:223`);
  `withCopyId` applied last to the command
  env (before `createLaneEnvFile`, `:486-490`) and to `shellEnv` (`:571`).
- `apps/daemon/src/sandbox/gate-sandbox.ts`: `GateRunInput.copyId` (`:58`); applied last to `commandEnv`
  (`:284-291`).
- `apps/daemon/src/sandbox/mcp-sandbox.ts`: `McpSandboxInput.copyId`; applied after `...server.env` (`:163-170`).
- `apps/daemon/src/delivery/copy-id.ts` (new): `CopyJournalMissingError`, `copyIdForBatch`.
- Callers that build these inputs: the runner's session start and resume (lanes, reviewer and takeover sessions),
  the gate runner's callers for a batch (`delivery/ship.ts` `runGate`, `local-check.ts`), and MCP server start for a
  session. Each passes `copyIdForBatch(db, batchId)`; callers with no batch pass null.
- A test beside `lane-sandbox.ts`'s existing tests (extend one if it already builds both providers' configs).

## Interfaces it implements or calls (quoted from the index)

```ts
export const COPY_ID_VARIABLE = 'TENDB_COPY_ID';
export function withCopyId(
  env: Readonly<Record<string, string>>,
  copyId: CopyId | null,
): Record<string, string>;
export function copyIdForBatch(db: DbReader, batchId: BatchId | null): CopyId | null;
// calls: getLocalCopy, isLocalCopy (card 1)
```

## Behavior

- `withCopyId` copies `env`, deletes the name, and sets it when `copyId` isn't null.
- `copyIdForBatch` decides from pinned facts only, never the project's current delivery: a row's `copyId` whenever
  the batch has a row; `CopyJournalMissingError` for a batch with a worktree, a null `repo` and a state past
  CUTTING but no row, or a row whose `copyId` doesn't parse; null otherwise. The session start, gate or teardown that asked then
  raises one card and doesn't run, so a copy's command never runs without its id.
- `packages/db/src/store/projects.ts` `updateProject` refuses a change of `delivery` while `unfinishedCopyOf`
  answers a batch: "<title> is in a separate copy; let it ship or abandon it first".
- The final check (`local-check.ts` `finalCheck`) is skipped for a copy batch (index call 6); its step checks run
  with the id.

## Tests (core: sandbox)

One wiring test, through the real sandbox builders: for a resumed copy session, the Claude env file, Codex
`shellEnv`, an MCP server whose own `env` sets `TENDB_COPY_ID=ffffffffffff`, and the gate env all carry the
journal's id; the Claude profile's `credentials.envVars` denies don't name it; and a gate with `copyId: null` whose
project env sets the name gets none. Value card: `protects=one copy id per command; fails_when=a copy's command
reads another copy's or the folder's database; why_new=sandbox core`.

## Done when

The test proven red first; typecheck, lint, `make precheck`.
