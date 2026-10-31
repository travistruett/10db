# Lanes move to auto mode only after the live test proves it, and stay in default mode until then

- **Date:** 2026-10-30
- **Amends:** decision 124 ("auto mode is gone")

## Decision

The builder chose to run lanes in Claude Code's auto mode under the lane sandbox. It takes effect
only once the live test shows that, in auto mode, every call 10db must see still reaches it. Until
then every lane stays in `default` mode, as decision 124 says.

What is built:

- `createClaudeAdapter` takes `lanePermissionMode` (`'default'` or `'auto'`). It applies only to a
  sandboxed session. An unsandboxed one, which only scripted tests start, always runs in `default`.
  When it is unset, the adapter uses `LANE_PERMISSION_MODE` in
  `apps/daemon/src/sessions/claude-adapter.ts`, which is `'default'`. Only the live test sets it.
- In auto mode the guard's PreToolUse hook, the `ask` rules for Claude Code's protected files,
  `disallowedTools` and `canUseTool` (the permission broker) are all still wired. A call Claude
  Code marks as needing a person (`requiresUserInteraction`, or `decisionReasonType: 'classifier'`)
  arrives as `escalated` and always becomes a card: no stored rule or carried allowance answers it,
  as decision 103 described. Unit tests in `apps/daemon/src/inbox/inbox.test.ts` already cover it.
- `apps/daemon/test/lane-sandbox.live.test.ts` has a block, "lane sandbox in auto mode, live", that
  runs the real Claude Code (on sonnet) in auto mode under the lane sandbox:
  1. **Hazards and ask rules.** The lane holds an area but no hazard. A Write into
     `db/migrations/` is refused by the guard. A Write to `.mcp.json` (an `ask` rule) reaches the
     broker and becomes a card. `pnpm add` is refused without the deps claim. No file is written.
  2. **New hosts.** `example.com` and `example.org`, which the project doesn't list, reach
     `canUseTool` as `SandboxNetworkAccess`. They raise exactly one card per host, though
     `example.com` is asked for by two commands.
  3. **Escalation.** A command that posts `.env` to an allowed host reaches the broker marked
     `escalated`, becomes a card and is refused.
  4. **No cards for routine work.** These are the kinds of command that raised cards on
     2026-10-30: a background command watched with Monitor, WebSearch,
     `grep -n 'fixture$' README.md`, `diff3` on files in `$TMPDIR`, and
     `pnpm exec drizzle-kit generate` by a lane holding the migrations hazard. They run with no card
     and no guard refusal.

To run them, on a machine signed in to Claude Code (never in CI or a lane):

```sh
TENDB_LIVE_CLAUDE=1 pnpm --filter @10db/daemon exec vitest run test/lane-sandbox.live.test.ts -t 'auto mode'
```

If all four pass, a follow-up change sets `LANE_PERMISSION_MODE` to `'auto'`, updates the
unit test that expects `'default'`, and records a decision that supersedes 124's "auto mode is
gone" with the results. If case 1 or 2 fails, lanes stay in `default` mode and that decision
records the bypass. If only case 3 fails because the classifier refuses the call outright and no
card is raised, the call still never runs. The builder decides whether that is enough.

## Why

Decision 124 removed auto mode because its classifier approves calls itself, and they never reach
10db's broker. In default mode the guard's allowlist decides everything, so routine commands it
doesn't know each become a card. On 2026-10-30 a dozen such cards stopped lanes, and none was
something 10db needed to stop. The builder trusts the classifier for routine calls, as in their own
sessions. Decision 121 named the way back: auto mode under the sandbox, with `ask` rules for what
must still ask.

Two kinds of call must still reach 10db. One is a hazard hit, so a lane claims migrations, deps or
harness before it touches them. The other is a new network host, one card per host. Hazard hits are
refused by the guard's PreToolUse hook when the lane lacks the claim. A hook's deny should hold in
any mode, but nobody has checked it in auto mode. A new host reaches 10db only through the
sandbox's network prompt to `canUseTool`. Nobody knows whether Claude Code sends that prompt in
auto mode, or how it orders `ask` rules, hook decisions and the classifier. The task required
proof against the real Claude Code before switching.

The lane that built this could not run the proof. Its own sandbox denies `api.anthropic.com`
("deny network-outbound api.anthropic.com:443") and reads of `~/Library/Keychains` and
`/usr/bin/security`, so `claude` cannot sign in there. The live test also nests srt inside that
sandbox. Asked how to proceed, the builder chose: write the tests now, keep lanes in default mode,
and switch in a follow-up once the tests pass on the builder's machine.

Turned down:

- **Switch now and run the tests before merge.** This breaks "prove before switching". If the
  classifier waved a hazard or a host through, every lane would skip 10db until someone noticed.
- **A per-project or env switch.** Decision 124 removed both because a Finder-launched app can't
  reach an env switch, and the builder wants one way to run. The adapter option is for the live
  test only. Nothing in the daemon sets it.
