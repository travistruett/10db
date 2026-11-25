# Task 1: a chat's flagged command asks the builder

Read the index's brief, Global Constraints, Interfaces, both state tables and Spike answers first. Size: Core.

## Files

- `packages/contracts/src/states.ts`: `PermissionChoice.AllowChat`; regenerate contracts if a schema names it.
  Commit this first, alone, so task 3 can start from it. Then fix every exhaustive use so all packages typecheck:
  `Record<PermissionChoice, …>` in `apps/daemon/src/runner/runner.ts` (~727) and
  `apps/desktop/src/views/inbox/permission-labels.ts` (~18), the switch in
  `apps/desktop/src/conversation/item-entries.ts` (~53), and `ALLOWING` in `inbox/permission-broker.ts` (~176), which must include `AllowChat`.
- `apps/daemon/src/sandbox/profile.ts`: `LaneProfileInput.allowUnsandboxedCommands?: boolean`, default `false`.
- `apps/daemon/src/sandbox/lane-sandbox.ts`: `LaneSessionInput.allowUnsandboxedCommands?` passed down.
- `apps/daemon/src/shape/session-launch.ts`: `ShapePrepareInput.unsandboxedAsk?: { readonly mayRun: () =>
  string | null }`.
- `apps/daemon/src/daemon/shape-session-tools.ts` (~330-400): with `unsandboxedAsk`, the profile gets
  `allowUnsandboxedCommands: true` and the broker's `sandbox.unsandboxed` is `{ mayRun: unsandboxedAsk.mayRun }`.
- `apps/daemon/src/chat/hooks.ts`:
  - `spec()` sets `unsandboxedAsk: { mayRun }` in the prepare input (~610; `folder` is built before it, ~574) for
    every Claude chat session that isn't Full access.
  - The chat's `ShapeAccess` (~729) gets `unsandboxed: 'ask'` on the same condition.
  - `mayRun` reads the live chat: `null` when place is `Here`, the folder is writable and `folder.holds()`;
    otherwise the refusal ("A lane holds the checkout now…", "The turn ended…", "The chat is moving…").
- `apps/daemon/src/chat/confinement.ts` `judgeChatCall`: a flagged call with `call.agentId` set is denied right
  there ("Only the chat itself runs a command outside the sandbox."). Never add `agentId` to the `asSession` call
  `judgeShapeCall` gets: `runsCommands` would then deny every subagent's ordinary command. A flagged call in
  Branch is denied a flagged call in Branch is denied ("A chat on its own branch runs commands inside its
  sandbox. Run it there, or turn on Full access."); and a flagged call with `writable` false or `holds()` false is
  denied with the reason. Pass the call's input to `firstChangeOf`.
- `apps/daemon/src/chat/first-change.ts`: a Bash call with `dangerouslyDisableSandbox` set is `'edit'`.
- `apps/daemon/src/shape/confinement.ts` `judgeCommand` (~146-185): with `access.unsandboxed === 'ask'`, a flagged
  call runs through the same checks and `judgePreToolUse` as an unflagged one (strip the flag for the guard). A
  deny stands. A background run (`run_in_background` or `startsBackgroundJob`, on every judge) is denied. Any
  allow or ask becomes `{ decision: 'ask', reason: UNSANDBOXED_ASK }`. Without `unsandboxed`, the existing deny
  stays.
- `apps/daemon/src/inbox/permission-broker.ts`:
  - `judgeBash`: a flagged call with `sandbox.unsandboxed` set → `Ask { summary, title: 'Run this outside the
    sandbox?', body: <the call's description, then "It runs with your full rights: it can read and write anywhere
    you can.">, chatOnce: true }`. Without it, refuse as today.
  - `askPermission`: a `chatOnce` ask skips stored rules, carried allowances and project grants; options are
    Allow once, `AllowChat` ("For this command in this chat"), Deny. `AllowChat` adds the exact
    `toolName + summary` to a set kept in the broker's closure; the next identical flagged call is allowed from
    it without a card (after `mayRun`). Nothing is written to `permission_rules` or decisions.
  - After any allowing answer to a `chatOnce` card, call `mayRun()`; a refusal denies with it.
  - A chat's denial (`ctx.workstreamId === null && ctx.conversationId` set) uses a chat denial text: "The builder
    said no to this call." plus their note, and "Try another way, or ask them." It never says "do not retry".
  - The card's `detail` keeps `conversationId`, `toolName`, `summary`, and `unsandboxed: true`.
- Daemon start: find whether open conversation cards (`detail.conversationId` set, kind permission or question)
  are withdrawn at start (`daemon/start.ts`, `inbox/`). If not, withdraw them there, before any chat session
  starts, so a card a new session raises is never swept: no session waits on the old ones after a restart. Leave
  every other kind (the work-place `flag` card included).
- If spike answer 5 shows a `TENDB_*` token in an unsandboxed command's environment, stop and report; do not scrub
  the session env (it carries Claude Code's own credentials on Bedrock and API-key accounts).

## State-table rows handled

Every row of both state tables except the UI rows (tab closed, second card, a message while waiting), which are
task 3's.

## Tests (core: permissions, sandbox)

- Extend `shape/confinement.test.ts`'s rule table: flagged + `unsandboxed: 'ask'` asks; flagged `git push` still
  denies; flagged + background denies; flagged without `unsandboxed` denies. Add the chat rows (flagged from a subagent
  denies, unflagged Bash from a subagent still runs as today, Branch, not holding) to `chat/confinement.test.ts`'s
  table. Tables, not a test per row.
- One broker test in `inbox/shape-permissions.test.ts` through the wiring: a flagged call raises a card with the
  three options; `AllowChat` lets the identical call through with no second card and stores no rule; a different
  command asks again; a Yes after `mayRun` turns non-null denies.
- `sandbox/profile.test.ts`: lanes stay `false` (existing assertion); add the chat's `true` to the same test.

Each commit with a test carries the value card from `.claude/rules/testing.md`.

## Done

`vitest related` on the changed files; typecheck and lint of daemon, contracts and desktop. Commit each step with
named paths.
