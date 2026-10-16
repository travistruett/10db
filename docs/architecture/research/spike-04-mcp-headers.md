# Spike 04: Per-session MCP config carries HTTP headers, and repo MCP tools reach `canUseTool`

- **Status:** VERIFIED
- **Date:** 2026-10-15
- **Versions:** claude 2.1.300 (Claude Code) · Agent SDK 0.3.299 · Node v25.2.1
- **Command:** `pnpm --dir spikes/agent-sdk spike:04`

## Question

Per-session MCP config can carry HTTP headers; if not, use the stdio shim.

## Result

**Headers.** A per-session `mcpServers['10db']` HTTP config sent its `Authorization: Bearer <random per-run
token>` on every request, handshake included, and the server compared the exact value. The JSON-RPC sequence was
`server/discover`, `initialize`, `notifications/initialized`, a `GET` (answered by the stateless transport),
`tools/list`, `tools/call`. The stateless `WebStandardStreamableHTTPServerTransport` (a fresh server and
transport per request) worked with `claude`. The server was `connected` both at `init` and after the turn, with
and without `alwaysLoad`, and the tool was called in both runs: `ALWAYS_LOAD_NEEDED=no`.

**Pass-through.** With five servers in `mcpServers` (all `connected` at `init`), `canUseTool` was called for
`mcp__repohttp__whoami` (HTTP), `mcp__repostdio__echo` (stdio) and `mcp__10db__x__echo`, none of which is in
`allowedTools`. Each call reported `mcpServer.name` as the server key and `mcpServer.source` as `"dynamic"`. The
allowed HTTP call then reached `/repo`; the denied stdio call never reached its server (a `start` line and no
`call` line). `mcp__10db__whoami`, covered by `allowedTools: ['mcp__10db__*']`, skipped the callback, and the
SDK printed a `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED` warning saying so. `TENDB_RULE_MATCHES_10DB__X=no`: the
`mcp__10db__*` rule did not cover the server named `10db__x`, whose call went to `canUseTool` and was denied.

**Stdio environment.** `STDIO_ENV_KEEPS_PATH=yes` and `STDIO_ENV_INHERITS_SESSION=yes`. A server with a declared
`env` received the whole session environment plus keys Claude Code adds: `AI_AGENT`, `CLAUDECODE`,
`CLAUDE_AGENT_SDK_CLIENT_APP`, `CLAUDE_AGENT_SDK_VERSION`, `CLAUDE_CODE_ENTRYPOINT`,
`CLAUDE_CODE_MESSAGING_SOCKET`, `CLAUDE_CODE_MESSAGING_TOKEN`, `CLAUDE_CODE_SESSION_ID`, `CLAUDE_PROJECT_DIR`,
`COREPACK_ENABLE_AUTO_PIN`, `HOME`, `LANG`, `NoDefaultCurrentDirectoryInExePath`, `PATH`, `SHELL`, `SPIKE_MARKER`,
`SPIKE_SESSION_SENTINEL`, `TERM`, `TMPDIR`, `USER` and `__CF_USER_TEXT_ENCODING` (names only). That includes a
messaging token. The same server launched through `/usr/bin/env -i PATH=… HOME=…` saw
`STDIO_ENV_I_KEYS=HOME,PATH,__CF_USER_TEXT_ENCODING` and no sentinel. `__CF_USER_TEXT_ENCODING` is set by macOS
CoreFoundation inside the process itself; it is not a session variable.

## Evidence

```
INFO requests seen by server (alwaysLoad): [{"method":"POST","path":"/mcp","auth":"match","rpc":"server/discover"},{"method":"POST","path":"/mcp","auth":"match","rpc":"initialize"},{"method":"POST","path":"/mcp","auth":"match","rpc":"notifications/initialized"},{"method":"GET","path":"/mcp","auth":"match","rpc":""},{"method":"POST","path":"/mcp","auth":"match","rpc":"tools/list"},{"method":"POST","path":"/mcp","auth":"match","rpc":"tools/call"}]
PASS server connected (at init or after the turn): connected / connected
PASS tool was called: 1 tools/call request(s)
PASS every request carried the session token: ["match","match","match","match","match","match"]
PASS agent relayed the tool result: WHOAMI-OK auth=match
ALWAYS_LOAD_NEEDED=no
INFO pass-through: canUseTool calls (tool, mcpServer.name, mcpServer.source): [{"tool":"mcp__repohttp__whoami","server":"repohttp","source":"dynamic"},{"tool":"mcp__repostdio__echo","server":"repostdio","source":"dynamic"},{"tool":"mcp__10db__x__echo","server":"10db__x","source":"dynamic"}]
PASS canUseTool saw the passed-through HTTP tool
PASS canUseTool saw the passed-through stdio tool
PASS the allowed HTTP tool ran after canUseTool allowed it: 1 tools/call on /repo
PASS the stdio server started from the passed-through config
PASS the denied stdio tool never reached its server: 0 call(s)
STDIO_ENV_KEEPS_PATH=yes
STDIO_ENV_INHERITS_SESSION=yes
PASS the env -i server started
PASS the env -i server saw no session variable: null
PASS the env -i server saw only PATH and HOME (plus OS-added keys): HOME,PATH,__CF_USER_TEXT_ENCODING
STDIO_ENV_I_KEYS=HOME,PATH,__CF_USER_TEXT_ENCODING
INFO mcp__10db__x__echo: asked, ran: {"asked":true,"ran":false}
TENDB_RULE_MATCHES_10DB__X=no
RESULT 04-mcp-headers: no failures
```

The first run's only FAIL was the exact-match `HOME,PATH` check, because of `__CF_USER_TEXT_ENCODING`. The plan
classes a key the OS or Node adds as fine, so the check now ignores that one key.

## Consequence for M1

- M1b's `mcpServers['10db']` doesn't need `alwaysLoad`; setting it to `true` is harmless and stays as a guard
  against tool search on larger tool sets.
- M1a MCP server: one Hono route `/mcp`, with a stateless `WebStandardStreamableHTTPServerTransport` per request.
  The bearer token resolves to a session, and agent-supplied IDs are ignored. The route must accept
  `server/discover` and `GET` as well as the usual methods. The stdio shim is not needed.
- Pass-through: M1b passes repo MCP servers through with no allow rule (decisions 39 and 51). `canUseTool` and the
  permission broker received every call to their tools in this probe, for HTTP and stdio alike. Not tested: a
  settings-file allow rule. The SDK's `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED` warning says "Allow rules from settings
  files can also shadow the callback", and under `settingSources: ['project']` a repo's committed
  `.claude/settings.json` loads. So a repo could auto-approve its own `mcp__<server>__*` tools or `Bash` past the
  broker. M1b must close that, for example by enforcing the broker in `PreToolUse`.
- Stdio environment: M1b launches approved repo stdio servers as
  `/usr/bin/env -i PATH=… HOME=… <declared env> <command>` (decision 52). With `STDIO_ENV_INHERITS_SESSION=yes`, a
  declared `env` alone would have leaked the session environment, including `CLAUDE_CODE_MESSAGING_TOKEN`.
  `__CF_USER_TEXT_ENCODING` is added by macOS inside the server process, and belongs in the comment on M1b's
  `STDIO_BASE_ENV`.
- `STDIO_ENV_KEEPS_PATH` is a record only: M1b passes `PATH` itself through `env -i`.
- `mcp__10db__*` does not match `10db__x`; M1b drops such names anyway.
