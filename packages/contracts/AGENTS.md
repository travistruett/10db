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
- This package depends on zod only. It never imports another workspace package.
