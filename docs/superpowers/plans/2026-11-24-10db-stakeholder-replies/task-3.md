# Card 3: Codex answers a one-shot question, with no tools

**Spec:** none; this is the provider parity row "ChatGPT/Codex plan" of the index.
**Track:** B, after card 1, alone. Core: the tool lock is a sandbox matter.

## Why

`AgentAdapter.complete(spec: CompletionSpec): Promise<string>` is how 10db asks a model one question with no
tools (`sessions/types.ts`, `CompletionSpec`). The Claude adapter implements it (`claude-adapter.ts`:
`tools: []`, `maxTurns: 1`, an empty cwd, a `canUseTool` that denies). The Codex adapter rejects with
`CODEX_NO_QUESTIONS` (`codex-adapter.ts`, the `complete:` line). The answer writer (card 4) needs it on Codex
and OpenRouter accounts.

## Files

- `apps/daemon/src/sessions/codex-complete.ts` (new): `completeWithCodex(spec, opts)`. It does one ephemeral
  `codex app-server` thread with one turn:
  1. Start `codex app-server` with the spec's `env` and `cwd` (the caller's empty folder). Send `initialize`, as
     `openCodexHome` in `codex-mcp-sign-in.ts` does.
  2. Check the account the way `probeAccount` does. A mismatch rejects with `CompletionError`.
  3. `thread/start` with:
     - `ephemeral: true`, `cwd`, `sandbox: 'read-only'`, `approvalPolicy: 'never'`;
     - `config`: web search disabled, no MCP servers, no project doc (as the lanes' Codex config turns each off;
       find each key in `codex-session.ts` and `codex-lane-permissions.ts`, never guess a key);
     - `developerInstructions`: "Answer only from the prompt. You have no tools."
  4. `turn/start` with the prompt, `model` and `effort`, shaped as `codex-session.ts` sends it.
  5. **The tool lock:** every tool call the turn tries is refused. Use the same hook path the lanes and the
     Linear reporter use on Codex (the hook socket to a verdict function). Give it a verdict that denies every
     call; nothing reaches the judge. An approval request that arrives anyway is declined.
  6. Read the completed `agentMessage` text and resolve on `turn/completed`.
  7. Reject with `CompletionError` on: a failed turn, any tool call the turn tried (even denied: the answer may
     lean on a refusal), the spec's `signal`, or `timeoutMs` (default 2 minutes, as Claude's).
  8. Always end the process.
- `apps/daemon/src/sessions/codex-adapter.ts`: `complete: (spec) => completeWithCodex(spec, opts)`. Keep
  `CODEX_NO_QUESTIONS` exported: area naming still uses it (that's a follow-up).
- `apps/daemon/src/sessions/AGENTS.md`: a note that a Codex `complete` is an ephemeral, tool-locked turn, and
  how the lock works.

## If the lock can't be made

You may find no way to refuse every tool call before it runs, using the app-server's own hooks or config as
generated in `codex-generated/`. In that case:
- Leave `complete` rejecting.
- Make card 4's writer return `declined: provider` for a Codex harness.
- Report the gap. The coordinator files the follow-up task.

Never ship a Codex `complete` that can run a command.

## Interfaces

Implements `AgentAdapter.complete` for Codex. `CompletionSpec` and `CompletionError` are unchanged.

## Tests

None in CI: Codex is a child process 10db doesn't own, and the fake adapter is the test boundary. Instead:
- Run `pnpm --filter @10db/daemon generate:codex` only if the generated types lack a field you need (on a Mac;
  the `STAMP` must match).
- Report a live check if a signed-in Codex is reachable on this Mac: a question answered, and a prompt that
  asks it to `ls` gets no command run. Otherwise it is QA item 1.

## Done when

The checks in Global Constraints pass, and the report states whether the lock shipped.
