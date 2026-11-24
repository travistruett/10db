# Card 3: a tool-locked Codex turn for the answer writer

**Spec:** none; this is the provider parity row "ChatGPT/Codex plan" of the index.
**Track:** B, after card 1, alone. Core: the tool lock is a sandbox matter.

## Why

The answer writer (card 4) needs one question answered on Codex and OpenRouter accounts with no tools.
`AgentAdapter.complete` on Codex rejects with `CODEX_NO_QUESTIONS` (`codex-adapter.ts`, the `complete:` line),
and its other callers (pass review in `delivery/pass-review.ts:309`, area naming, hazard assessment) rely on
that today. So this card adds a separate function that only the writer calls, and leaves
`CodexAdapter.complete` rejecting. Moving the other callers is a follow-up.

## Files

- `apps/daemon/src/sessions/codex-complete.ts` (new): `completeWithCodex(spec, opts)`, exported from the
  sessions entry point. One ephemeral `codex app-server` thread with one turn:
  1. Start `codex app-server` with the spec's `env` and `cwd` (the caller's empty folder). Send `initialize`, as
     `openCodexHome` in `codex-mcp-sign-in.ts` does.
  2. Check the account the way `probeAccount` does. A mismatch rejects with `CompletionError`.
  3. `thread/start` with `ephemeral: true`, `cwd`, `approvalPolicy: 'never'`, and the sandbox and permission
     profile the lanes' Codex home uses read-only (read `codex-home.ts`, `codex-session.ts` and
     `codex-lane-permissions.ts`; the home template sets `default_permissions: 'lane'`, so find the pairing that
     is valid with it, never guess a key). `config`: web search off, no MCP servers, no project doc, each by the
     key the lanes use. `developerInstructions`: "Answer only from the prompt. You have no tools."
  4. `turn/start` with the prompt, `model` and `effort`, shaped as `codex-session.ts` sends it.
  5. **The tool lock, in two layers:**
     - The guard hook denies every call. A `complete` call opens its own guard socket (its own
       `$TENDB_GUARD_SOCKET`, as a lane's session does) bound to a verdict that denies everything; it never
       shares a lane's socket or reaches the judge.
     - Because some Codex tools run where the guard can't see them (`codex-home.ts:86-89`), the turn's item
       stream is the backstop: enumerate the item types in `codex-generated/` and end the turn (`turn/interrupt`,
       then kill the process) on the first item that is not an `agentMessage` or a reasoning item. An approval
       request that arrives anyway is declined.
  6. Read the completed `agentMessage` text and resolve on `turn/completed`.
  7. Reject with `CompletionError` on: a failed turn, any tool item the turn started (even if denied: the answer
     may lean on a refusal), the spec's `signal`, or `timeoutMs` (default 2 minutes, as Claude's).
  8. Always end the process.
- `apps/daemon/src/daemon/answer-writer-launch.ts` (made by card 4, so this edit lands after card 4): the Codex
  branch calls `completeWithCodex` instead of declining `provider`, and only after the live test below passes.
  `createAnswerWriter` gains a `codex: CodexCompleteOptions` dep, built in `daemon/start.ts` from what the Codex
  adapter's options already hold.
- `CodexCompleteOptions` (in `codex-complete.ts`): the `codex` binary path, the account homes, the clock and the
  logger, taken from the Codex adapter's options type so the two never drift.
- `apps/daemon/src/sessions/AGENTS.md`: a note that `completeWithCodex` is an ephemeral, tool-locked turn for the
  answer writer only, how the two layers work, and that `CodexAdapter.complete` still rejects.

## If the lock can't be proven

If the live test below can't be made to pass (a tool runs, or an item type can't be told apart before it acts):
- Leave the writer declining `provider` for Codex, and don't export `completeWithCodex`.
- In `apps/desktop/src/views/settings/decision-catalogue.ts`, the `reply_kind` entry's description adds: "On
  Codex projects, questions all come to you for now."
- Report the gap. The coordinator files the follow-up task.

Never ship a Codex turn that can run a command.

## Interfaces

Implements `completeWithCodex(spec: CompletionSpec, opts: CodexCompleteOptions): Promise<string>`.
`CompletionSpec` and `CompletionError` are unchanged. `CodexAdapter.complete` is unchanged.

## Tests

One case in `apps/daemon/test/codex.live.test.ts` (core: the sandbox), using the real `codex app-server` and the
fake Responses server it already runs (`sessions/AGENTS.md`). The fake model answers the turn with, in turn:
- a shell call that would create a marker file, then an MCP tool call, then a web search call.

Assert: the marker file doesn't exist, no MCP server was started, `completeWithCodex` rejects with
`CompletionError`, and the process has exited. A second fake turn that answers in text resolves with that text.
Prove it red first by running the case with the lock's item check removed.

Run `pnpm --filter @10db/daemon generate:codex` only if the generated types lack a field you need (on a Mac; the
`STAMP` must match).

## Done when

The live case passes on this Mac, the checks in Global Constraints pass, and the report states that the lock
shipped (or the fallback above shipped instead).
