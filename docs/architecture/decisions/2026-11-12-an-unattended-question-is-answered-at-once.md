# An unattended lane's question is answered at once, and `ask_human` may raise no Inbox item

- **Date:** 2026-11-12

## Decision

A lane nobody watches (a Board task: its trust policy is not attended) never waits on a question to the builder.
`ask_human` and `AskUserQuestion` answer it at once with this exact text:

> The builder is away. Make the call yourself and say in your handoff what you decided and why.

Each question is kept as a `skipped_actions` row (kind `question`, source `question`, one row per question), and the
builder sees it under "Questions it would have asked". It is never approvable.

A question whose category or topic the task's routes send to a named person still goes to that person, as it did
before: the builder chose who answers it. Attended sessions (a pass, Plan) ask as before.

`McpToolOutputs.ask_human.inboxId` is nullable: null when no Inbox item was raised. `PROTOCOL_VERSION` is 11.

## Why

- The trust line's §5 and the builder's standing rule: unattended runs never wait on a card. A question that waits
  `humanWaitMinutes` and then parks the lane stops a run overnight for an answer the agent can usually make itself.
- The answer says what to do instead (decide, and say so in the handoff), and the list tells the builder what was
  decided without them.
- A route to a stakeholder is the builder's own choice of who answers. Answering those at once would quietly undo a
  setting the builder made, so they keep today's path.
- `inboxId` was always present before. A client that read it as an id can now get null, which narrows what it can
  rely on; `packages/contracts/AGENTS.md` treats that as a protocol change, so the version moves.
