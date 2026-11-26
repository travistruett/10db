# packages/contracts

zod schemas are the single source of truth for everything that crosses a process boundary: the
HTTP API, the event stream, MCP tool inputs and outputs. TypeScript types are `z.infer` of them;
never hand-write a parallel interface.

- One file per concept (`health.ts`, later `events.ts`, `mcp-tools.ts`). Export the schema and its
  type under the same name.
- Register every externally visible schema in `CONTRACT_SCHEMAS` (`src/json-schema.ts`).
  `pnpm --filter @10db/contracts generate` writes `generated/*.schema.json`; commit the output.
  `make gate` fails on drift.
- Changes are additive. Removing or narrowing a field is a protocol change: bump
  `PROTOCOL_VERSION` and record a decision.
- This package depends on zod and uuid only. It never imports another workspace package, never
  imports `node:*` (the UI bundles it), and holds no I/O.
- Pure domain rules shared by the daemon and the UI live here too: the workstream state machine
  (`workflow.ts`) and the vocabularies (`states.ts`).
- Separate copies (`local-copy.ts`, spec `docs/superpowers/specs/2026-11-24-10db-local-copy-landing-design.md`): `ProjectDto`/`ProjectPatch` carry `localCopies`, `copyAppCommand` (prints a copy's own app address; null when copies serve none) and `copyTeardownCommand` (the refine and `NAME_COPY_TEARDOWN` require a command while copies are on); `LocalCopyDto`, `CopyStep`, `CopyWait` and the branded `CopyId` describe a copy's journal row; `COPY_ID_VARIABLE` (`TENDB_COPY_ID`) is the variable a copy's commands carry it in, which the sandbox sets and the judge's policy names; `APP_URL_VARIABLE` (`TENDB_APP_URL`, `entities.ts`) names the address a dev login signs in on; `COPY_NEEDS_REVIEW` is the refusal for a task whose process runs no review.
