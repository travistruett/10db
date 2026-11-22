# Card 1: a chat's or Plan's call to an MCP tool goes to the judge, as a lane's does

**Size:** Core (permissions). The builder's call: "Judge, like lanes". It lands first in this PR, before the Feature parts.
**Supersedes:** the part of `decisions/2026-11-05-plan-runs-commands-and-project-tools-through-the-lane-broker.md`
that makes "a call to a project MCP tool always answer `ask`". The rest of that record and
`2026-11-05-one-answer-allows-every-tool-an-approved-mcp-server-listed.md` stand.

## Rule

`judgeProjectTool` (`apps/daemon/src/shape/confinement.ts:200`) mirrors `judgeCommand`'s `judged` rule (`:171-195`):

| Session's judge (`ShapeAccess.judge`) | Call from the session | Call from an agent it launched | No `prepare` (`access.commands` undefined) |
|---|---|---|---|
| `tendb` (10db's judge) | bare allow: `session-judge.ts` runs 10db's judge with the policy line; it allows, refuses, or asks (a card) | refused, as today | refused, as today |
| `native` (auto mode, Codex Auto-review) | bare allow, which is no decision: the provider's own flow and classifier decide (trust line §8, as `judgeWeb` does) | refused | refused |
| `rules` or absent | `ask`, as today: a card | refused | refused |

- Covers every non-10db `mcp__` tool a chat or Plan session runs: the repo's approved `.mcp.json` servers, the
  builder's own servers and the claude.ai connectors. Lanes are unchanged. `chat/confinement.ts:214` reaches this
  through `judgeShapeCall` unchanged.
- On `rules`, the card for a builder's own server or a claude.ai connector also offers **Always allow every
  `<server>` tool in this project**. The rules match the server by name and source, with no config hash: a builder
  server's config is the builder's, outside the repo. A repo server keeps its hash-bound grant (`mcpToolGrant`,
  `permissions/mcp-server-rule.ts:55`). If this needs more than the grant's existing rule shape and one source
  field, leave it out and report it; the judge rows are the builder's ask.
- Nothing else in the confinement changes: hosts, the sandbox, agents' refusal and `commandsAsk` for commands
  all stay.

## Files

- `apps/daemon/src/shape/confinement.ts` (`judgeProjectTool`), and the grant above if it fits
  (`inbox/permission-broker.ts:580`, `daemon/shape-session-tools.ts:389`, `permissions/mcp-server-rule.ts`).
- `apps/daemon/src/shape/AGENTS.md` (the confinement line: "a project MCP tool `ask` from the session" becomes the
  judge rule), `apps/daemon/src/chat/AGENTS.md` if it repeats it.
- A new decision `docs/architecture/decisions/2026-11-21-a-conversations-mcp-calls-go-to-its-judge.md`, superseding
  the part named above. Why: parity with lanes and with Claude Code's auto mode, where MCP calls go to the
  classifier; the builder said that after signing in to an integration, its calls should be seamless.

## Tests

- One test in `shape/confinement.test.ts` (pure, the rule table): a builder MCP call from the session answers a
  bare allow on `tendb` and `native` and `ask` on `rules`; from an agent it is refused on all three. Red first.
- Live: in the dev app, on a project whose judge is 10db's or auto mode, a Plan session's Linear `list_teams` runs
  with no card. Report what it showed.
