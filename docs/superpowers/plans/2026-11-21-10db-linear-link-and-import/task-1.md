# Card 1: a chat's or Plan's call to an MCP tool goes to the judge, as a lane's does

**Size:** Core (permissions). The builder's call: "Judge, like lanes". It lands first in this PR, before the Feature parts.
**Supersedes:** the part of `decisions/2026-11-05-plan-runs-commands-and-project-tools-through-the-lane-broker.md`
that makes "a call to a project MCP tool always answer `ask`". The rest of that record and
`2026-11-05-one-answer-allows-every-tool-an-approved-mcp-server-listed.md` stand.

## Rule

`judgeProjectTool` (`apps/daemon/src/shape/confinement.ts:200`) mirrors `judgeCommand`'s `judged` rule (`:171-195`):

| Session's judge (`ShapeAccess.judge`) | Call from the session | No `prepare` (`access.commands` undefined) |
|---|---|---|
| `tendb` (10db's judge) | bare allow: the chat's hook judge (`chat/hooks.ts:752-770`) runs 10db's judge with the policy line on Claude (`claude-session.ts:318`) and on Codex (`codex-guard.ts:204`); it allows, refuses or asks (a card). With the judge down, `floorVerdict` re-judges on `rules`: a card | refused, as today |
| `native` (Claude's auto mode) | bare allow, which is no decision (`claude-mapping.ts:279`): MCP tools are not in `allowedTools`, so auto mode's classifier decides | refused |
| `rules` or absent | `ask`, as today: a card | refused |

- By account: Codex sessions always run 10db's judge (`capabilities.ts:69`), so Codex Auto-review is not involved.
  A Claude plan, API key or Bedrock account is `native` where auto mode runs (`autoModeRuns`, `capabilities.ts:43`),
  else 10db's judge.
- Covers every non-10db `mcp__` tool a chat or Plan session runs: the repo's approved `.mcp.json` servers, the
  builder's own servers and the claude.ai connectors. Lanes are unchanged. `chat/confinement.ts:214` reaches this
  through `judgeShapeCall` unchanged.
- Agents: Plan's own `tendb-*` agents have no MCP tools (`shape/policy.ts:126`, `:132`). A general-purpose agent a
  chat launches inherits them, and `judgeChatCall` drops `agentId` (`chat/confinement.ts:156-160`), so its calls go
  to the judge too, as a lane's subagents' do. Leave that as is; don't start passing `agentId` through.
- **No new grant.** The server-wide "Always allow every `<server>` tool" stays as the 2026-11-05 decision has it
  (repo servers, bound to the approved config and the listed tools). On `rules` a builder's own server or a
  connector keeps the per-tool card. `rules` is the floor (no judge configured, or the judge down), so this is rare.
- Nothing else in the confinement changes: hosts, the sandbox and `commandsAsk` for commands all stay.

## Files

- `apps/daemon/src/shape/confinement.ts`: `judgeProjectTool`, and the comments that say an MCP call answers `ask`
  (`:21-25`, `:199`, `:447-449`).
- `apps/daemon/src/shape/AGENTS.md` (the confinement line: "a project MCP tool `ask` from the session" becomes the
  judge rule), `apps/daemon/src/chat/AGENTS.md` if it repeats it.
- A new decision `docs/architecture/decisions/2026-11-21-a-conversations-mcp-calls-go-to-its-judge.md`, superseding
  the part named above. Why: parity with lanes and with Claude Code's auto mode, where MCP calls go to the
  classifier; the builder said that after signing in to an integration, its calls should be seamless.

## Tests

- One test in `shape/confinement.test.ts` (pure, the rule table): a builder MCP call from the session answers
  exactly `{ decision: 'allow' }` (no `settled`, which would skip the judge and the classifier) on `tendb` and
  `native`, and `ask` on `rules`. Red first.
- Live: in the dev app, on a project whose judge is 10db's or auto mode, a Plan session's Linear `list_teams` runs
  with no card. Report what it showed.
