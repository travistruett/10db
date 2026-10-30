# The builder's MCP tools are a UI-token endpoint, reached through a stdio bridge

- **Date:** 2026-10-29

## Decision

- The daemon serves a stateless streamable-HTTP MCP endpoint at `/builder/mcp`, behind the UI-token middleware (it is not in `OPEN_PATHS`). Its tools are `list_projects`, `list_flows`, `list_tasks`, `create_task`, `edit_task`, `remove_task`, `start_task`, `move_task` and `list_inbox`. They are defined in `@10db/contracts` (`builder-mcp-tools.ts`), apart from the lane tools in `mcp-tools.ts`, and the two name lists are disjoint.
- A builder's client reaches it through `builder-mcp.mjs`, a stdio MCP server bundled beside `daemon.mjs` and run with the app's `tendb-node`. It answers `initialize` and `tools/list` itself from the same definitions, and forwards only `tools/call`: it reads `daemon.json` and `ui-token` from the data directory for each call, checks the pid in `daemon.json` is alive before it reads the token, and sends one POST with the bearer token. Every failure is a JSON-RPC error with the request's id.
- 10db parses tool input itself; the SDK's validation text never reaches the client. `create_task` refuses what the New Task form refuses, in the form's words, and a task that is not Ready is not started.
- Setup is one command with no token copied by hand (`docs/builder-mcp.md`). The drafting guidance of the user-level `10db-task` skill moves into the server's instructions and the `create_task` and `edit_task` descriptions, so every MCP client gets it, and the setup doc tells the builder to delete that skill.

## Why

- **A managed session cannot reach it.** Each of these holds on its own:
  - A lane's MCP token is not the UI token, so the middleware answers 401 (`apps/daemon/src/api/app.test.ts`, `test/builder-mcp.test.ts`).
  - The UI token fails `/mcp`'s session lookup, so the two endpoints cannot stand in for each other.
  - Lanes run with `strictMcpConfig` and are given only 10db's `/mcp` and the repo servers the builder approved; none names `/builder/mcp`.
  - The UI token lives in `ui-token` in the data directory, which the lane sandbox and the guard deny to Bash, the file tools, the gate and repo MCP servers (R5), so a lane can neither read it nor pass it on.
  - The bridge is not a way round that: it is a separate process the builder's client starts, outside any lane.
- **No token by hand.** The port can change (`TENDB_PORT`, development daemons) and the UI token is random at each start, so a client configured with a fixed URL and header would need the token copied again after every restart. The bridge reads both files at each call, so a restart, or a new port, costs nothing. A stdio server works with every stdio MCP client.
- **A session started before 10db is open still works.** Claude Code marks a server failed for the whole session if `initialize` fails. The bridge answers `initialize` and `tools/list` without the daemon and turns a missing or dead daemon into an error on the call alone, so it recovers once 10db opens.
- **The SDK's `McpServer` without `registerTool`.** Handlers for the tool list and the call are set on the server directly, so 10db's own parse and wording reach the client and refusals match the form.
- **Alternatives turned down.** A fixed HTTP URL with a header (a token to copy after each restart). A lane-style per-client token (a new secret store for one caller). Reusing `/mcp` with a builder flag (it would put the UI token on the endpoint lanes call, and the tool lists would overlap).
