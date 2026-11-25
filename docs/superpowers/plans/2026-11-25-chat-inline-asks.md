# A chat asks, inline, before a command runs outside the sandbox

Size: **Core** (permissions: a chat's command may leave the kernel sandbox). Tasks 0-2 Core, task 3 Feature (UI).
Plan review round 1 (Opus 5.5): six blocking findings, all folded in below.

## Brief

**What changes for you.** In a chat you're in, working Here, a command the sandbox stops no longer dead-ends.
Claude retries it outside the sandbox, and you get one card where you type: the command, a line on why, and
**Yes**, **Yes, for this command in this chat**, **No**. Typing in the card tells Claude what to do instead.
Every ask a chat raises (a limit, a push, a command, now this one) uses that same card, docked in place of the
composer. While the chat is open in a tab, its cards stay in the chat, not the Inbox; a chat with no open tab
keeps its cards in the Inbox so nothing waits unseen. Answered asks leave one quiet line in the transcript.

**What it buys.** Most walls in an ordinary chat become a yes/no, so Full access is for when you want no asks at
all rather than for getting anything done. One look for every ask, in one place.

**What could go wrong, and how we'd know.**
- A yes runs one command with your full rights: it can write anywhere and read any secret. You see the exact
  command first. "For this chat" allows only that exact command again, and is forgotten when the chat's session
  restarts. It is never stored as a project rule.
- 10db's own refusals still stand: a flagged `git push`, `git commit` or a write into 10db's data is refused
  before any card, as it is inside the sandbox.
- An unsandboxed command could write the checkout while a lane uses it. It runs only while the chat's turn
  holds the checkout, checked again at your Yes; otherwise it is refused with the reason.
- Something a command deliberately detaches (`tmux -d`, `docker run -d`, `launchctl`) can outlive the turn, as in a
  terminal. Plain `&`, `nohup` and background runs are refused.
- Claude Code may not pass the flagged retry through 10db's hook as the docs imply. Task 0 checks it live before
  anything is built; if it doesn't, the plan stops and comes back to you.

**Calls you might disagree with.**
- 10db always asks, even in auto mode, where Claude Code lets its classifier decide. Here the sandbox is the
  security boundary, so you decide each one.
- Only a chat working Here gets the hatch. A chat on its own branch has a worktree its sandbox keeps it in;
  outside the sandbox nothing would, so it is refused there with a pointer to Full access.
- Only the chat itself can ask, not its subagents.
- Codex chats get the new card but not the hatch: Codex runs with approvals off by decision
  (`2026-11-12-codex-is-judged-by-10dbs-judge.md`). A Codex chat is told to suggest Full access when the sandbox
  blocks a command. A follow-up task covers Codex escalations.

**What's needed from you:** nothing.

## Global Constraints

- Every non-Full-access Claude chat session gets `allowUnsandboxedCommands: true` in its profile; the hook decides
  each call. Lanes, passes, the gate and MCP servers stay `false`.
- A flagged call (`dangerouslyDisableSandbox` set) goes through the same guard as an unflagged one first; the
  guard's deny stands. Only its allow or ask becomes the unsandboxed ask.
- A flagged call asks only when all hold: the chat's own session (no `agentId`), place `Here`, the folder writable
  and held by this session's turn (`folder.writable && folder.holds()`), and nothing that runs in the background.
  A Branch chat's flagged call is denied with a pointer to Full access.
- A flagged call is the builder's alone: no stored rule, carried allowance, project grant or judge allows it.
  The only remembered yes is the exact call, for the broker's lifetime (one session).
- The Yes re-checks the hold (`mayRun`) before it allows; a lost hold denies with the reason.
- A flagged call counts as a change (`firstChangeOf` → `'edit'`).
- A chat's denial text invites a different approach (the builder's note says what), never "do not retry".
- No migration. No change to lanes', passes' or Plan sessions' behaviour.
- Code style and testing rules: `.claude/rules/code-style.md`, `.claude/rules/testing.md`.

## Provider parity

| Account                       | Hatch | Inline card |
| ----------------------------- | ----- | ----------- |
| Claude plan, Bedrock, API key | Yes: Claude Code's per-command sandbox on every Claude account (task 0 checks Bedrock too) | Yes |
| ChatGPT/Codex                 | No: `approvalPolicy: 'never'` by decision. The Codex chat's instructions say to suggest Full access when the sandbox blocks a command. Follow-up board task: answer Codex escalations with the same card | Yes |

## Interfaces

```ts
// packages/contracts/src/states.ts
export const PermissionChoice = { /* existing */ AllowChat: 'allow_chat' } as const;

// apps/daemon/src/sandbox/profile.ts
interface LaneProfileInput { /* existing */ readonly allowUnsandboxedCommands?: boolean } // default false
// apps/daemon/src/sandbox/lane-sandbox.ts
interface LaneSessionInput { /* existing */ readonly allowUnsandboxedCommands?: boolean } // passed to buildLaneProfile

// apps/daemon/src/shape/session-launch.ts
interface ShapePrepareInput { /* existing */ readonly unsandboxedAsk?: { readonly mayRun: () => string | null } } // set only by a chat, not Full access; passed to the broker's sandbox.unsandboxed

// apps/daemon/src/shape/confinement.ts (ShapeAccess)
readonly unsandboxed?: 'ask'; // absent: a flagged command is denied, as today

// apps/daemon/src/chat/first-change.ts
export function firstChangeOf(call: Pick<ChatCall, 'toolName' | 'input'>): 'edit' | 'git' | null;

// apps/daemon/src/inbox/permission-broker.ts
interface Ask { /* existing */ readonly title?: string; readonly chatOnce?: boolean }
// BrokerContext.sandbox gains:
readonly unsandboxed?: { readonly mayRun: () => string | null }; // null: may run; else the refusal

// apps/desktop/src/conversation/ask-card.tsx
export function AskCard(props: {
  readonly item: InboxItemDto;
  readonly queued: number; // other cards waiting behind this one
  readonly onAnswered?: () => void;
}): JSX.Element | null;
```

## State table: a flagged Bash call (design, not a test list)

| Chat state                                     | Result                                                    |
| ---------------------------------------------- | --------------------------------------------------------- |
| Full access                                    | no sandbox; unchanged                                     |
| from a subagent                                | deny: only the chat itself runs outside the sandbox       |
| guard denies (git write, 10db data, protected) | that deny                                                 |
| reading / choosing                             | deny `WAITING_FOR_CHOICE`, first-change question raised   |
| moving                                         | deny `CHAT_MOVING`                                        |
| Branch                                         | deny: run it inside the sandbox, or turn on Full access   |
| Here, not writable or turn doesn't hold folder | deny with the reason (a lane holds it / the turn ended)   |
| Here, holds, background (flag, `&`, nohup…)    | deny: run it in the foreground                            |
| Here, holds, exact call allowed for this chat  | allow                                                     |
| Here, holds                                    | ask: Yes / Yes for this command in this chat / No         |
| Codex chat                                     | no flag exists; the sandbox refuses as today              |

## State table: a waiting card

| Event while it waits                        | Result                                                          |
| ------------------------------------------- | --------------------------------------------------------------- |
| Yes, hold still held                        | allow                                                           |
| Yes, hold lost (turn ended, move, takeover) | deny with the reason; card closes                               |
| No, or a typed note                         | deny with the chat's denial text and the note                   |
| Stop, archive, Full access toggled          | session ends; card withdrawn (existing `waitOrWithdraw`)        |
| Daemon restart                              | open conversation permission and question cards withdrawn at start, before any chat session starts (task 1 checks there is a sweep; adds one if not) |
| Chat's tab closed                           | session keeps waiting; the card shows in the Inbox again        |
| Second card raised                          | the oldest docks, "1 more waiting" on it; keys go to the docked one |
| Builder sends a message                     | the composer is replaced by the card; typing in the card is the message (a No with the note) |

## Tracks and tasks

One implementer runs 0 → 1 → 2 on the branch. Task 3 starts after task 1's contracts commit.

- **Task 0** (`task-0.md`): live spike; its answers go under "Spike answers" below. Gate for everything else.
- **Task 1** (`task-1.md`): daemon: profile switch, the chat's hook asks, the broker's card, chat-once memory,
  the re-check at Yes, the restart sweep.
- **Task 2** (`task-2.md`): decision record, module notes, the Codex instruction line, Codex follow-up task.
- **Task 3** (`task-3.md`): desktop: `AskCard` docked in place of the composer, a chat's cards off the Inbox while
  it's open, answered asks as one line; extends the chat e2e on the existing judge card. A real flagged call
  first runs against the real daemon in a Dev-window click-through after tasks 1 and 3.

Plan review round 2 (Opus 5.5): three blocking findings (e2e can't produce a flagged card without a sandbox,
`mayRun`'s route to the broker, a subagent row) folded in.

## Spike answers

Live spike on a Claude plan account (Claude Opus 5.5), a Here chat in the Dev window, with the throwaway
`allowUnsandboxedCommands: true` and a hook `ask` for the flag. Evidence: daemon log lines and screenshots in the
session scratchpad `spike/` (`04-*.png`, `06-card.png`, `10.txt`, `11.txt`). The throwaway change is reverted.

1. **Yes, unprompted.** After `mkdir: ...: Operation not permitted`, Claude said it would run the command again
   outside the sandbox and re-issued the same Bash call with `dangerouslyDisableSandbox: true`. It did so in every
   run (4 of 4), in auto mode and in default mode.
2. **Yes.** `chat/hooks.ts` `preToolUse` got the retry with the flag in its input (log, auto mode):
   `SPIKE preToolUse Bash input={"command":"mkdir -p ...","description":"...","dangerouslyDisableSandbox":true} mode=auto`.
   The raw hook input shows `perm=...`, `flag=true`. The first (blocked) call arrives without the flag.
3. **Yes, in both modes.** The hook's `ask` reached `canUseTool` (the broker) with `req.input.dangerouslyDisableSandbox
   === true`: auto mode (`SPIKE canUseTool Bash flag= true`), and default mode (raw hook `perm= default flag= true`,
   then `canUseTool ... flag= true`). Default mode was forced for the run by making `startingJudge` return the
   rules judge; there the broker also asked for the plain first command, as it does today. The card showed
   "Allow Bash?" with Allow Once, Always Allow in This Project ("This command has no safe rule to store, so it can
   only be allowed once") and Deny. Not exercised: a real Bedrock account (see 9).
4. **Yes.** Allow Once ran it outside the sandbox: `~/Library/Caches/10db-spike-3/f` (and -4, -5, -8) exists
   with `hi`. Deny was not exercised. A subagent's retry, allowed, also wrote the file; its sandboxed `cat` of the
   result was blocked as read-denied, so the model reported it unverified.
5. **Environment of an allowed unsandboxed call** (names only; this is the Dev window's daemon env, so
   `VITE_DAEMON_*` and `AWS_PROFILE` may be Dev-window or dev-shell artifacts).
   - Auto mode (`CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=0`, 122 names): `TENDB_SANDBOX`; `ANTHROPIC_*` none;
     `AWS_PROFILE`; `OPENAI_*` none; `GH_PROMPT_DISABLED` (no `GH_TOKEN`, no `GITHUB_*`); `GIT_CONFIG_GLOBAL`,
     `GIT_EDITOR`, `GIT_OPTIONAL_LOCKS`, `GIT_TERMINAL_PROMPT`; `SSH_AUTH_SOCK`; `VITE_DAEMON_TOKEN` and
     `VITE_DAEMON_URL`; `CLAUDE_AGENT_SDK_CLIENT_APP`, `CLAUDE_AGENT_SDK_VERSION`, `CLAUDE_CODE_BRIDGE_SESSION_ID`,
     `CLAUDE_CODE_CHILD_*`, `CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_CODE_EXECPATH`, `CLAUDE_CODE_MESSAGING_SOCKET`,
     `CLAUDE_CODE_MESSAGING_TOKEN`, `CLAUDE_CODE_SESSION_*`, `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB`,
     `CLAUDE_CODE_TMPDIR`, `CLAUDE_ENV_FILE`, `CLAUDE_EFFORT`, `CLAUDE_PID`, `CLAUDE_TMPDIR`, `CLAUDECODE`.
     So tokens for the daemon (`VITE_DAEMON_TOKEN`) and Claude's messaging channel are visible to an unsandboxed
     command in auto mode, because `claude-query-options.ts` sets the scrub to `'0'` there.
   - Default mode (`SCRUB=1`): the same without `CLAUDE_CODE_MESSAGING_TOKEN` and `VITE_DAEMON_TOKEN`; still
     `TENDB_SANDBOX`, `AWS_PROFILE`, `VITE_DAEMON_URL`, `GH_PROMPT_DISABLED` and the other `CLAUDE_*` names.
   - `git config user.email` answered nothing (EMAIL_NO): `GIT_CONFIG_GLOBAL` points at a config without one, so
     a commit from an unsandboxed command has no identity.
6. **Not seen live; the path exists.** My attempts to provoke a classifier refusal were themselves blocked
   by the session's own classifier, so none was run. By code: a classifier denial in an attended session is
   `soft` (`sessions/judge-denial.ts`), and `tool-call-card.tsx` shows "Allow This" for `status 'denied' &&
   deniedBy 'judge' && soft`, and `chat-tab.tsx` passes `onAllow`. So it can show on a Claude chat today; it
   did not in these runs because 10db's hook, not the classifier, was the one asking.
7. **Yes, distinct.** The retry has its own id: blocked call `toolu_01K42B3...`, retry `toolu_01QNqmG...` (subagent
   run), and `toolu_01AWQtX...` then `toolu_019e2zm...` (main agent). `tool_use_id` is on the hook input
   (`claude-session.ts` passes it as `toolUseId` to the judged path).
8. **Yes.** A subagent's flagged call reached the hook with `agent_id=a2f61dcf47bbe632f` and
   `agent_type=general-purpose`, `flag=true`; the main agent's calls have both undefined. It reached `canUseTool`
   and the card too.
9. **Skipped.** No Bedrock account is set up in this Dev window's 10db (one Claude plan account). Default mode,
   which a Bedrock or API-key account runs in, was exercised instead (3).
10. **No such rule, and none is needed.** The options 10db builds (`exploreOptions` in `claude-query-options.ts`)
    pass `permissions.ask` only from `sandbox.askRules` (`lane-sandbox.ts` ~599: protected agent-config paths
    for `Edit`/`Write`), nothing for the flag. Claude Code's `Bash(...)` rules match a command pattern, not an
    input field, so `Bash(dangerouslyDisableSandbox:true)` is not an expressible rule (not tested live). The hook's
    ask already reaches the broker (3), so a rule would add nothing. `preToolUseHook`'s `settleAsk` exists for an
    ask that a Claude deny rule would refuse before `canUseTool`; no deny rule covers the flag.

Gates: 2 and 3 are yes, so Tasks 1 to 3 proceed. For Task 1: in auto mode the unsandboxed environment includes the
daemon and Claude messaging tokens (a); a chat's Bash reaches `judgeCommand` through `judgeChatCall` ->
`judgeShapeCall` (`chat/confinement.ts`), so the one line that denies the flag today (`shape/confinement.ts`) is
also the chat's, and a lane's own refusal (`claude-adapter.ts` `refusedSession`) is separate.
