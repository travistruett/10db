# A Codex chat asks before a command runs outside the sandbox, as a Claude chat does

- **Date:** 2026-11-26
- **Amends:** `decisions/2026-11-25-a-chat-asks-before-a-command-runs-outside-the-sandbox.md` (a Codex chat gets the
  same hatch), `decisions/2026-11-12-codex-is-judged-by-10dbs-judge.md` (for a chat working in the sandbox; every
  other Codex session keeps `never`)

## Decision

- A Codex chat whose sandbox lets a command ask to run outside it (an explore session, not Full access, with
  `allowUnsandboxedCommands`) sends `approvalPolicy: { granular: { sandbox_approval: true } }`, every other
  granular flag `false` (`rules`, `skill_approval`, `request_permissions`, `mcp_elicitations`), and
  `approvalsReviewer: 'user'` on `thread/start`, `thread/resume` and each `turn/start`
  (`ESCALATIONS_TO_BUILDER`, `BUILDER_REVIEWS` in `sessions/codex-protocol.ts`). Lanes, passes, Plan's own
  sessions and a Full access chat keep `approvalPolicy: 'never'` and send no reviewer.
- The session reads the reviewer back from the thread and refuses to start (`sandbox_refused`) unless it is
  `user`: no model reviewer answers an escape from the sandbox.
- 10db answers `item/commandExecution/requestApproval` only in such a chat; anywhere else the request is
  answered `-32601`, which Codex reads as declined. A request that is not a plain command (`humanCommand`,
  `writeStdin`), asks for network access, or names no command is declined with the reason.
- Every other request is judged as a Claude chat's flagged command (`sessions/codex-escalation.ts`): a `Bash` call
  with `dangerouslyDisableSandbox: true`, Codex's reason as its description and the item's id as its
  `toolUseId`, through the chat's own guard (`judgeChatCall`): Here only, the turn holding the checkout, no
  background run, the guard's deny standing. A guard's allow is turned into an ask, so only the builder's yes on
  the same card (`chatOnce` in `inbox/permission-broker.ts`, which names Codex as the agent that asks) lets the
  command out, and the broker reads the hold again at the yes.
- A yes answers `accept`, which runs that one command outside the sandbox. 10db never answers
  `acceptForSession`: whether the same command runs again unasked is `allow_chat`'s, with its limits.
- A no, or any refusal, answers `decline`. Codex's decline tells the model nothing, so 10db steers
  `Note from 10db: <reason>` into the open turn, carrying the builder's note. A request Codex stopped waiting
  on (`serverRequest/resolved`), whose turn completed, or whose session ended is withdrawn and nothing is
  steered.
- `allow_chat` is remembered across Codex's own sandboxed attempt: the guard hook counts that attempt as a change
  just before the escalation for the same item, so the count the broker compares leaves that one increment out.
  A Claude chat's count is unchanged.
- The chat's instructions tell Codex to ask, with a one-line justification, in the builder's checkout, and to
  suggest Full access on its own branch.

### Per provider

- **Claude plan, Bedrock, API key:** unchanged (`decisions/2026-11-25-a-chat-asks-before-a-command-runs-outside-the-sandbox.md`).
- **ChatGPT/Codex plan:** as above. The card's text names Codex. Network escalations and patch approvals are
  still declined; a follow-up covers each that turns out to be needed.

## Why

- The Claude hatch removed most of the reasons to turn Full access on in a chat; leaving Codex without it broke
  provider parity for the one place the builder is there to answer.
- `granular` with only `sandbox_approval` rather than `on-request`: `on-request` would also route exec-policy rule
  prompts, skill and permission requests and MCP elicitations to 10db, none of which this decision answers.
- The reviewer is sent and read back because Codex's `auto_review` would let a model approve a sandbox escape,
  which the trust line keeps the builder's (`decisions/2026-11-12-10db-trusts-the-developer-and-contains-the-agent.md`).
  The earlier record turned down escalations because the guard hook can't tell an escalated call; answering the
  approval request itself, which names the item, gives the guard that call.
- A decline plus a steer, because Codex's decline variant carries no message and a silent refusal leaves the model
  retrying the same command.
- **Known gaps:** a forced `rm` Codex refused itself under `never` may reach the card instead under `granular`; it
  still runs only on the builder's yes. The accept and decline values are written by hand until the generator
  seeds `CommandExecutionRequestApprovalResponse`. Whether Codex's hook runs before the approval, which
  `allow_chat`'s memory relies on, is checked by the manual row in `test/chat-write-codex.live.test.ts`; if it
  does not, the same command asks every time, which is safe.
